import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance, type TestApp } from './helpers';
import { accountBalance, systemAccountId } from '../src/core/accounting/ledger';

const acctId = (t: TestApp, name: string) => t.app.db.value<number>('SELECT id FROM accounts WHERE name = ?', [name]);
const sysId = (t: TestApp, key: Parameters<typeof systemAccountId>[1]) => systemAccountId(t.app.ctx(), key);

/** Income and expense balance of a year including its closing entry (0 once closed). */
function pnlBalance(t: TestApp, from: string, to: string): number {
  return t.app.db.value<number>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id JOIN account_groups g ON g.code = a.group_code
      WHERE e.is_void = 0 AND g.type IN ('income', 'expense') AND e.date >= ? AND e.date <= ?`,
    [from, to],
    0,
  );
}

/**
 * Books from 01-04-2025, today 28-09-2026. FY 2025-26 has:
 *   sales 1,00,000 (cash) | sales returns 2,000 | rent 30,000 | tea 1,000 | drawings 10,000 | capital 50,000
 * Net profit = 100000 - 2000 - 30000 - 1000 = 67,000.
 */
async function withLastYear() {
  const t = await createTestApp({ booksStart: '2025-04-01', openingCash: 2000000 });
  t.setToday('2026-03-31');
  const cash = sysId(t, 'CASH');
  await t.call('journals.create', { date: '2025-06-01', narration: 'Cash sales (summary)', lines: [{ accountId: cash, debit: 10000000 }, { accountId: sysId(t, 'SALES'), credit: 10000000 }] });
  await t.call('journals.create', { date: '2025-06-15', narration: 'Returns', lines: [{ accountId: sysId(t, 'SALES_RETURNS'), debit: 200000 }, { accountId: cash, credit: 200000 }] });
  const rent = await t.call('expenses.create', { date: '2025-07-01', accountId: acctId(t, 'Rent'), amount: 3000000, mode: 'cash' });
  await t.call('expenses.create', { date: '2025-08-01', accountId: acctId(t, 'Tea & Refreshments'), amount: 100000, mode: 'cash' });
  const drawings = await t.call('accounts.drawings', { date: '2025-09-01', amount: 1000000, mode: 'cash' });
  await t.call('accounts.capital', { date: '2025-10-01', amount: 5000000, mode: 'bank' });
  t.setToday('2026-09-28');
  // Current year activity.
  await t.call('expenses.create', { date: '2026-05-10', accountId: acctId(t, 'Electricity'), amount: 250000, mode: 'cash' });
  return { t, rent, drawings };
}

describe('year-end closing', () => {
  it('lists the financial years with profit and what can be closed', async () => {
    const { t } = await withLastYear();
    const years = await t.call('yearEnd.list');
    expect(years.map((y) => [y.name, y.status, y.canClose])).toEqual([
      ['2026-27', 'current', false],
      ['2025-26', 'open', true],
    ]);
    const last = years[1];
    expect(last).toMatchObject({ income: 9800000, expenses: 3100000, netProfit: 6700000, drawings: 1000000, isClosed: false, canReopen: false });
    expect(years[0].closeBlockedReason).toBe('The year ends on 31-03-2027. It can be closed after that date.');
    expect(years[0]).toMatchObject({ netProfit: -250000, expenses: 250000 });
  });

  it('previews the closing entry', async () => {
    const { t } = await withLastYear();
    const p = await t.call('yearEnd.preview', { fyStart: '2025-04-01', transferDrawings: true });
    expect(p.entryDate).toBe('2026-03-31');
    expect(p.lines.map((l) => [l.accountName, l.debit, l.credit])).toEqual([
      ['Sales', 10000000, 0],
      ['Sales Returns', 0, 200000],
      ['Rent', 0, 3000000],
      ['Tea & Refreshments', 0, 100000],
      ["Owner's Capital", 0, 6700000],
      ['Drawings', 0, 1000000],
      ["Owner's Capital", 1000000, 0],
    ]);
    expect(p).toMatchObject({ netProfit: 6700000, drawingsTransferred: 1000000, drawingsBalance: 1000000, totalDebit: 11000000, totalCredit: 11000000 });
    const noDrawings = await t.call('yearEnd.preview', { fyStart: '2025-04-01', transferDrawings: false });
    expect(noDrawings.lines).toHaveLength(5);
    expect(noDrawings.drawingsTransferred).toBe(0);
    // Preview does not change anything.
    expect(t.app.db.value("SELECT COUNT(*) FROM journal_entries WHERE voucher_type = 'closing'")).toBe(0);
  });

  it('closes the year: zeroes income and expenses, moves profit and drawings to capital, locks the year', async () => {
    const { t, rent, drawings } = await withLastYear();
    const capitalBefore = systemBalance(t.app, 'CAPITAL');
    const r = await t.call('yearEnd.close', { fyStart: '2025-04-01', transferDrawings: true });
    expect(r.year).toMatchObject({ name: '2025-26', isClosed: true, status: 'closed', closedBy: 'Ravi Sharma', canClose: false, canReopen: true });
    expect(r.closingEntryId).toBeGreaterThan(0);

    // Safety backup written before closing.
    expect(fs.existsSync(r.backup.path)).toBe(true);
    const backup = t.app.db.get<any>('SELECT * FROM backup_history ORDER BY id DESC LIMIT 1');
    expect(backup).toMatchObject({ kind: 'safety', note: 'Before closing financial year 2025-26' });

    const entry = t.app.db.get<any>('SELECT * FROM journal_entries WHERE id = ?', [r.closingEntryId]);
    expect(entry).toMatchObject({ voucher_type: 'closing', source_type: 'closing', date: '2026-03-31', voucher_no: 'YE/25-26', is_void: 0 });
    expect(entry.narration).toBe("Year-end closing 2025-26: net profit ₹67,000.00 transferred to Owner's Capital; drawings ₹10,000.00 transferred");

    expect(pnlBalance(t, '2025-04-01', '2026-03-31')).toBe(0);
    expect(systemBalance(t.app, 'CAPITAL')).toBe(capitalBefore - 6700000 + 1000000);
    expect(systemBalance(t.app, 'DRAWINGS')).toBe(0);
    const fy = t.app.db.get<any>("SELECT * FROM financial_years WHERE name = '2025-26'");
    expect(fy).toMatchObject({ is_closed: 1, closing_entry_id: r.closingEntryId, closed_at: '2026-09-28 10:00:00' });
    expect(t.app.db.value("SELECT COUNT(*) FROM financial_years WHERE name = '2026-27'")).toBe(1);
    expect(t.app.db.get<any>("SELECT summary FROM activity_log WHERE action = 'year.close'")?.summary).toBe(
      "Closed financial year 2025-26: net profit ₹67,000.00 transferred to Owner's Capital, drawings ₹10,000.00 transferred",
    );

    // Year is read-only now.
    const cash = sysId(t, 'CASH');
    const lines = [
      { accountId: cash, debit: 100 },
      { accountId: sysId(t, 'CAPITAL'), credit: 100 },
    ];
    const late = await t.fails('journals.create', { date: '2025-12-01', narration: 'late', lines });
    expect(late.code).toBe('PERIOD_CLOSED');
    expect(late.message).toMatch(/Financial year 2025-26 is closed/);
    expect((await t.fails('expenses.update', { id: rent.id, accountId: acctId(t, 'Rent'), amount: 1, mode: 'cash' })).code).toBe('PERIOD_CLOSED');
    expect((await t.fails('expenses.cancel', { id: rent.id, reason: 'x' })).code).toBe('PERIOD_CLOSED');
    expect((await t.fails('journals.cancel', { entryId: drawings.id, reason: 'x' })).code).toBe('PERIOD_CLOSED');
    expect((await t.fails('journals.cancel', { entryId: r.closingEntryId!, reason: 'x' })).message).toMatch(/Re-open the financial year/);
    expect((await t.fails('yearEnd.close', { fyStart: '2025-04-01', transferDrawings: true })).message).toMatch(/already closed/);

    // The pages show the lock instead of Edit / Cancel buttons.
    const oldEntry = await t.call('journals.get', { entryId: drawings.id });
    expect(oldEntry).toMatchObject({ editable: false, canEdit: false });
    expect(oldEntry.lockedReason).toMatch(/2025-26 is closed/);
    expect((await t.call('expenses.get', { id: rent.id })).lockedReason).toMatch(/2025-26 is closed/);
    const oldList = await t.call('journals.list', { from: '2025-04-01', to: '2026-03-31', voucherType: 'drawings' });
    expect(oldList.rows[0].editable).toBe(false);

    // Later years are unaffected.
    const ok = await t.call('journals.create', { date: '2026-05-01', narration: 'new year', lines });
    expect(ok.voucherNo).toBe('JV/26-27/0001');
    const years = await t.call('yearEnd.list');
    expect(years[0]).toMatchObject({ name: '2026-27', netProfit: -250000 });
    expect(years[1]).toMatchObject({ name: '2025-26', netProfit: 6700000 }); // profit excludes the closing entry

    // Books still show the year: the P&L accounts' ledgers end at zero after closing.
    const salesLedger = await t.call('books.ledger', { accountId: sysId(t, 'SALES'), from: '2025-04-01', to: '2026-03-31' });
    expect(salesLedger.closing).toBe(0);
    expect(accountBalance(t.app.ctx(), sysId(t, 'SALES'))).toBe(0);
    // The capital summary shows the profit transferred.
    const cap = await t.call('accounts.capitalSummary', { from: '2025-04-01', to: '2026-03-31' });
    expect(cap).toMatchObject({ opening: 0, profitTransferred: 6700000, drawings: 1000000, capitalAdded: 5000000, openingBalances: 2000000 });
    expect(cap.closing).toBe(2000000 + 5000000 + 6700000 - 1000000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('can leave drawings in their own account', async () => {
    const { t } = await withLastYear();
    await t.call('yearEnd.close', { fyStart: '2025-04-01', transferDrawings: false });
    expect(systemBalance(t.app, 'DRAWINGS')).toBe(1000000);
    expect(pnlBalance(t, '2025-04-01', '2026-03-31')).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('moves a loss to capital', async () => {
    const t = await createTestApp({ booksStart: '2025-04-01' });
    t.setToday('2025-10-01');
    await t.call('journals.create', { date: '2025-09-01', narration: 'sales', lines: [{ accountId: sysId(t, 'CASH'), debit: 100000 }, { accountId: sysId(t, 'SALES'), credit: 100000 }] });
    await t.call('expenses.create', { date: '2025-09-02', accountId: acctId(t, 'Rent'), amount: 400000, mode: 'bank' });
    t.setToday('2026-04-02');
    const p = await t.call('yearEnd.preview', { fyStart: '2025-04-01', transferDrawings: true });
    expect(p.netProfit).toBe(-300000);
    expect(p.lines.find((l) => l.accountName === "Owner's Capital")).toMatchObject({ debit: 300000, credit: 0, memo: 'Net loss for 2025-26' });
    await t.call('yearEnd.close', { fyStart: '2025-04-01', transferDrawings: true });
    expect(systemBalance(t.app, 'CAPITAL')).toBe(300000);
    expect(pnlBalance(t, '2025-04-01', '2026-03-31')).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('closes years in order and re-opens only the latest', async () => {
    const t = await createTestApp({ booksStart: '2025-04-01' });
    t.setToday('2025-06-01');
    await t.call('expenses.create', { date: '2025-06-01', accountId: acctId(t, 'Rent'), amount: 100000, mode: 'cash' });
    t.setToday('2026-06-01');
    await t.call('expenses.create', { date: '2026-06-01', accountId: acctId(t, 'Rent'), amount: 200000, mode: 'cash' });
    t.setToday('2027-06-01');
    let years = await t.call('yearEnd.list');
    expect(years.map((y) => [y.name, y.canClose, y.closeBlockedReason])).toEqual([
      ['2027-28', false, 'The year ends on 31-03-2028. It can be closed after that date.'],
      ['2026-27', false, 'Close 2025-26 first: years are closed in order.'],
      ['2025-26', true, null],
    ]);
    expect((await t.fails('yearEnd.close', { fyStart: '2026-04-01', transferDrawings: true })).message).toMatch(/Close 2025-26 first/);
    await t.call('yearEnd.close', { fyStart: '2025-04-01', transferDrawings: true });
    await t.call('yearEnd.close', { fyStart: '2026-04-01', transferDrawings: true });
    expect(systemBalance(t.app, 'CAPITAL')).toBe(300000);
    years = await t.call('yearEnd.list');
    expect(years.map((y) => [y.name, y.isClosed, y.canReopen])).toEqual([
      ['2027-28', false, false],
      ['2026-27', true, true],
      ['2025-26', true, false],
    ]);
    expect(years[2].reopenBlockedReason).toBe('Re-open 2026-27 first: only the latest closed year can be re-opened.');
    expect((await t.fails('yearEnd.reopen', { fyStart: '2025-04-01' })).message).toMatch(/Re-open 2026-27 first/);

    // Re-open restores the year exactly as it was.
    const closingId = t.app.db.value<number>("SELECT closing_entry_id FROM financial_years WHERE name = '2026-27'");
    const r = await t.call('yearEnd.reopen', { fyStart: '2026-04-01', reason: 'Forgot a bill' });
    expect(r.year).toMatchObject({ isClosed: false, canClose: true, closedBy: null, closingEntryId: null });
    expect(t.app.db.get<any>('SELECT is_void, void_reason FROM journal_entries WHERE id = ?', [closingId])).toEqual({ is_void: 1, void_reason: 'Forgot a bill' });
    expect(pnlBalance(t, '2026-04-01', '2027-03-31')).toBe(200000);
    expect(systemBalance(t.app, 'CAPITAL')).toBe(100000);
    expect(t.app.db.value("SELECT COUNT(*) FROM backup_history WHERE kind = 'safety'")).toBe(3);
    expect(t.app.db.get<any>("SELECT summary FROM activity_log WHERE action = 'year.reopen'")?.summary).toBe('Re-opened financial year 2026-27: Forgot a bill');
    // Entries can be added again, then the year closed again with the new figures.
    await t.call('expenses.create', { date: '2027-03-15', accountId: acctId(t, 'Electricity'), amount: 5000, mode: 'cash' });
    const again = await t.call('yearEnd.close', { fyStart: '2026-04-01', transferDrawings: true });
    expect(again.closingEntryId).not.toBe(closingId);
    expect(systemBalance(t.app, 'CAPITAL')).toBe(305000);
    expect((await t.fails('yearEnd.reopen', { fyStart: '2027-04-01' })).message).toMatch(/This year is open/);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('locks a year that has no entries without a closing entry', async () => {
    const t = await createTestApp({ booksStart: '2025-04-01' });
    t.setToday('2026-06-01');
    const r = await t.call('yearEnd.close', { fyStart: '2025-04-01', transferDrawings: true });
    expect(r.closingEntryId).toBeNull();
    expect(r.year.isClosed).toBe(true);
    expect((await t.fails('journals.create', { date: '2025-05-01', narration: 'x', lines: [{ accountId: sysId(t, 'CASH'), debit: 1 }, { accountId: sysId(t, 'CAPITAL'), credit: 1 }] })).code).toBe(
      'PERIOD_CLOSED',
    );
    const back = await t.call('yearEnd.reopen', { fyStart: '2025-04-01' });
    expect(back.year.isClosed).toBe(false);
  });

  it('needs the year-end permission', async () => {
    const { t } = await withLastYear();
    await t.loginAs('manager');
    expect((await t.fails('yearEnd.list')).code).toBe('FORBIDDEN');
    expect((await t.fails('yearEnd.close', { fyStart: '2025-04-01', transferDrawings: true })).code).toBe('FORBIDDEN');
    expect((await t.fails('yearEnd.reopen', { fyStart: '2025-04-01' })).code).toBe('FORBIDDEN');
    expect(t.app.db.value('SELECT COUNT(*) FROM backup_history')).toBe(0);
    expect((await t.fails('yearEnd.preview', { fyStart: '2025-04-01', transferDrawings: true })).code).toBe('FORBIDDEN');
  });
});

describe('after the first year is closed', () => {
  it('no longer offers opening balances, with a clear reason instead of a closed-period error', async () => {
    const { t } = await withLastYear();
    const cash = sysId(t, 'CASH');
    expect((await t.call('accounts.get', { id: cash })).openingLockedReason).toBeNull();
    expect((await t.call('loans.list', {})).openingLockedReason).toBeNull();
    await t.call('yearEnd.close', { fyStart: '2025-04-01', transferDrawings: true });
    const reason = /Financial year 2025-26, when your books start, is closed, so opening balances can no longer be added or changed/;

    const chart = await t.call('accounts.chart', {});
    expect(chart.openingLockedReason).toMatch(reason);
    const cashDetail = await t.call('accounts.get', { id: cash });
    expect(cashDetail).toMatchObject({ openingBalance: 2000000 });
    expect(cashDetail.openingLockedReason).toMatch(reason);
    // Income / expense accounts never have an opening balance, so nothing is locked for them.
    expect((await t.call('accounts.get', { id: acctId(t, 'Rent') })).openingLockedReason).toBeNull();

    const add = await t.fails('accounts.create', { name: 'ICICI Current', groupCode: 'bank', openingBalance: { amount: 2500000, side: 'debit' } });
    expect(add.code).toBe('VALIDATION');
    expect(add.message).toMatch(reason);
    expect(t.app.db.value("SELECT COUNT(*) FROM accounts WHERE name = 'ICICI Current'")).toBe(0);
    expect((await t.call('accounts.create', { name: 'ICICI Current', groupCode: 'bank' })).openingLockedReason).toMatch(reason);

    // Renaming an account that has an opening balance still works (the closed year's entry is left alone) ...
    expect((await t.call('accounts.update', { id: cash, name: 'Galla Cash' })).name).toBe('Galla Cash');
    // ... but changing the amount is refused.
    const change = await t.fails('accounts.update', { id: cash, name: 'Galla Cash', openingBalance: { amount: 100, side: 'debit' } });
    expect(change.code).toBe('VALIDATION');
    expect(change.message).toMatch(reason);

    const loanReason = /Financial year 2025-26, when your books start, is closed, so an older loan can no longer be brought in with an opening balance\. Save it with a start date from 01-04-2025/;
    const loans = await t.call('loans.list', {});
    expect(loans.openingLockedReason).toMatch(loanReason);
    const old = await t.fails('loans.create', { name: 'SBI', direction: 'taken', principal: 50000000, startDate: '2024-06-01', openingOutstanding: 20000000 });
    expect(old.code).toBe('VALIDATION');
    expect(old.message).toMatch(loanReason);
    expect(t.app.db.value("SELECT COUNT(*) FROM loans WHERE name = 'SBI'")).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('shows income and expense ledgers of the new year from zero, before and after closing', async () => {
    const { t } = await withLastYear();
    const rent = acctId(t, 'Rent');
    await t.call('expenses.create', { date: '2026-04-10', accountId: rent, amount: 100000, mode: 'cash' });
    const before = await t.call('books.ledger', { accountId: rent, from: '2026-04-01', to: '2026-09-28' });
    expect(before).toMatchObject({ opening: 0, closing: 100000 });
    await t.call('yearEnd.close', { fyStart: '2025-04-01', transferDrawings: true });
    const after = await t.call('books.ledger', { accountId: rent, from: '2026-04-01', to: '2026-09-28' });
    expect(after).toMatchObject({ opening: 0, closing: 100000 });
    // The closed year's own ledger ends at zero with the closing entry.
    const last = await t.call('books.ledger', { accountId: rent, from: '2025-04-01', to: '2026-03-31' });
    expect(last).toMatchObject({ opening: 0, totalIn: 3000000, totalOut: 3000000, closing: 0 });
  });
});
