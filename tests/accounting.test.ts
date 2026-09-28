import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance, type TestApp } from './helpers';
import { accountBalance, partyBalance, paymentAccountId, postEntry, systemAccountId } from '../src/core/accounting/ledger';
import { BOOK_PAGE_SIZE, DAY_BOOK_PAGE_SIZE } from '../src/core/modules/accounting/books';
import { addDays } from '../src/shared/dates';

const acctId = (t: TestApp, name: string) => t.app.db.value<number>('SELECT id FROM accounts WHERE name = ?', [name]);
const sysId = (t: TestApp, key: Parameters<typeof systemAccountId>[1]) => systemAccountId(t.app.ctx(), key);
const bal = (t: TestApp, id: number, to?: string) => accountBalance(t.app.ctx(), id, to ? { to } : {});
const addSupplier = (t: TestApp, name: string) => t.app.db.insert('suppliers', { name, created_at: '2026-09-01 10:00:00' });
const addCustomer = (t: TestApp, name: string) => t.app.db.insert('customers', { name, created_at: '2026-09-01 10:00:00' });
const addEmployee = (t: TestApp, name: string) => t.app.db.insert('employees', { name, created_at: '2026-09-01 10:00:00' });
const revisions = (t: TestApp, docType: string, id: number) =>
  t.app.db.all<{ revision: number; action: string; reason: string | null }>('SELECT revision, action, reason FROM document_revisions WHERE doc_type = ? AND doc_id = ? ORDER BY revision', [
    docType,
    id,
  ]);
const activity = (t: TestApp, action: string) => t.app.db.all<{ summary: string; entity_id: number | null }>('SELECT summary, entity_id FROM activity_log WHERE action = ? ORDER BY id', [action]);

describe('chart of accounts', () => {
  it('adds accounts with automatic codes and an opening balance', async () => {
    const t = await createTestApp();
    const petty = await t.call('accounts.create', { name: 'Petty Cash', groupCode: 'cash', openingBalance: { amount: 250000, side: 'debit' } });
    expect(petty).toMatchObject({ code: '1002', groupCode: 'cash', isSystem: false, isActive: true, openingBalance: 250000, balance: 250000, entryCount: 1 });
    const hdfc = await t.call('accounts.create', { name: 'HDFC Current A/c', groupCode: 'bank' });
    expect(hdfc.code).toBe('1103'); // 1101 Bank Account and 1102 UPI Account are taken
    const rent2 = await t.call('accounts.create', { name: 'Godown Rent', groupCode: 'indirect_expenses', description: 'Second godown' });
    expect(rent2.code).toBe('6005'); // 6001-6004 are system accounts
    const custom = await t.call('accounts.create', { name: 'Scooter', groupCode: 'fixed_assets', code: 'FA-9' });
    expect(custom.code).toBe('FA-9');

    const opening = t.app.db.get<any>("SELECT * FROM journal_entries WHERE voucher_type = 'opening' AND source_id = ?", [petty.id]);
    expect(opening).toMatchObject({ date: '2026-04-01', source_type: 'opening', narration: 'Opening balance - Petty Cash' });
    expect(systemBalance(t.app, 'OPENING_EQUITY')).toBe(-250000);
    expect(activity(t, 'account.create').map((a) => a.summary)).toContain('Added account "Petty Cash" (1002) under Cash-in-Hand with opening balance ₹2,500.00 Dr');

    // A liability with a credit opening balance.
    const dep = await t.call('accounts.create', { name: 'Customer Deposits', groupCode: 'current_liabilities', openingBalance: { amount: 100000, side: 'credit' } });
    expect(dep.balance).toBe(-100000);
    expect(systemBalance(t.app, 'OPENING_EQUITY')).toBe(-150000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('enforces group, name, code and opening-balance rules', async () => {
    const t = await createTestApp();
    expect((await t.fails('accounts.create', { name: 'Ramesh', groupCode: 'receivables' })).message).toMatch(/Customers are added from the Customers page/);
    expect((await t.fails('accounts.create', { name: 'Gupta', groupCode: 'payables' })).message).toMatch(/Suppliers are added/);
    expect((await t.fails('accounts.create', { name: 'X', groupCode: 'nope' })).message).toMatch(/Choose the group/);
    expect((await t.fails('accounts.create', { name: 'rent', groupCode: 'indirect_expenses' })).message).toMatch(/An account named "Rent" already exists/);
    expect((await t.fails('accounts.create', { name: 'Shop Van', groupCode: 'fixed_assets', code: '1001' })).message).toMatch(/Code 1001 is already used by "Cash in Hand"/);
    expect((await t.fails('accounts.create', { name: 'Shop Van', groupCode: 'fixed_assets', code: 'bad code!' })).message).toMatch(/letters, numbers and dashes/);
    expect((await t.fails('accounts.create', { name: 'Commission', groupCode: 'indirect_income', openingBalance: { amount: 100, side: 'credit' } })).message).toMatch(
      /start every year at zero/,
    );
    expect((await t.fails('accounts.create', { name: '', groupCode: 'cash' })).code).toBe('VALIDATION');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('protects built-in accounts', async () => {
    const t = await createTestApp();
    const cash = sysId(t, 'CASH');
    const d = await t.call('accounts.get', { id: cash });
    expect(d).toMatchObject({ isSystem: true, canDelete: false, canDeactivate: false, canChangeGroup: false, defaultFor: ['cash'] });
    expect((await t.fails('accounts.setActive', { id: cash, active: false })).message).toMatch(/Built-in accounts/);
    expect((await t.fails('accounts.remove', { id: cash })).message).toMatch(/Built-in accounts/);
    expect((await t.fails('accounts.update', { id: cash, name: 'Cash in Hand', groupCode: 'bank' })).message).toMatch(/Built-in accounts always stay/);
    // Renaming and re-coding is allowed.
    const renamed = await t.call('accounts.update', { id: cash, name: 'Cash Counter', code: '1001' });
    expect(renamed.name).toBe('Cash Counter');
    expect(t.app.db.value('SELECT system_key FROM accounts WHERE id = ?', [cash])).toBe('CASH');
  });

  it('deletes only unused accounts and deactivates only zero balances', async () => {
    const t = await createTestApp();
    const unused = await t.call('accounts.create', { name: 'Office Plants', groupCode: 'indirect_expenses' });
    expect((await t.call('accounts.remove', { id: unused.id })).deleted).toBe(true);
    expect(t.app.db.value('SELECT COUNT(*) FROM accounts WHERE id = ?', [unused.id])).toBe(0);
    expect(activity(t, 'account.delete')).toHaveLength(1);

    const van = await t.call('accounts.create', { name: 'Delivery Van', groupCode: 'fixed_assets' });
    await t.call('journals.create', { narration: 'Bought van', lines: [{ accountId: van.id, debit: 5000000 }, { accountId: sysId(t, 'CAPITAL'), credit: 5000000 }] });
    const d = await t.call('accounts.get', { id: van.id });
    expect(d).toMatchObject({ canDelete: false, canDeactivate: false, entryCount: 1, balance: 5000000 });
    expect((await t.fails('accounts.remove', { id: van.id })).message).toMatch(/has 1 entry/);
    expect((await t.fails('accounts.setActive', { id: van.id, active: false })).message).toMatch(/balance of ₹50,000.00 Dr/);
    expect((await t.fails('accounts.update', { id: van.id, name: 'Delivery Van', groupCode: 'current_assets' })).message).toMatch(/before the account has any entries/);

    // Sell it: balance back to zero -> can be deactivated (but still not deleted).
    await t.call('journals.create', { narration: 'Sold van', lines: [{ accountId: sysId(t, 'CASH'), debit: 5000000 }, { accountId: van.id, credit: 5000000 }] });
    const off = await t.call('accounts.setActive', { id: van.id, active: false });
    expect(off.isActive).toBe(false);
    expect((await t.fails('journals.create', { narration: 'x', lines: [{ accountId: van.id, debit: 100 }, { accountId: sysId(t, 'CASH'), credit: 100 }] })).message).toMatch(/inactive/);
    const list = await t.call('accounts.list', {});
    expect(list.some((a) => a.id === van.id)).toBe(false);
    expect((await t.call('accounts.list', { includeInactive: true })).some((a) => a.id === van.id)).toBe(true);
    expect((await t.call('accounts.setActive', { id: van.id, active: true })).isActive).toBe(true);

    // Unused account can move to another group.
    const moved = await t.call('accounts.create', { name: 'Advance Rent', groupCode: 'indirect_expenses' });
    const after = await t.call('accounts.update', { id: moved.id, name: 'Advance Rent', groupCode: 'current_assets', code: moved.code });
    expect(after).toMatchObject({ groupCode: 'current_assets', groupName: 'Other Current Assets' });
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('changes and removes opening balances, including the one entered at setup', async () => {
    const t = await createTestApp({ openingCash: 500000 });
    const cash = sysId(t, 'CASH');
    expect((await t.call('accounts.get', { id: cash })).openingBalance).toBe(500000);
    const d = await t.call('accounts.update', { id: cash, name: 'Cash in Hand', openingBalance: { amount: 750000, side: 'debit' } });
    expect(d.openingBalance).toBe(750000);
    expect(systemBalance(t.app, 'CASH')).toBe(750000);
    expect(t.app.db.value("SELECT COUNT(*) FROM journal_entries WHERE voucher_type = 'opening' AND is_void = 0")).toBe(1);
    const removed = await t.call('accounts.update', { id: cash, name: 'Cash in Hand', openingBalance: null });
    expect(removed.openingBalance).toBe(0);
    expect(systemBalance(t.app, 'CASH')).toBe(0);
    expect(systemBalance(t.app, 'OPENING_EQUITY')).toBe(0);
    const back = await t.call('accounts.update', { id: cash, name: 'Cash in Hand', openingBalance: { amount: 1000, side: 'debit' } });
    expect(back.openingBalance).toBe(1000);
    expect(t.app.db.value("SELECT COUNT(*) FROM journal_entries WHERE voucher_type = 'opening'")).toBe(1);
    expect(activity(t, 'account.update').at(-1)?.summary).toMatch(/opening balance ₹0.00 → ₹10.00 Dr/);
    // Renaming keeps the opening entry's narration in step.
    await t.call('accounts.update', { id: cash, name: 'Galla (Cash)', openingBalance: { amount: 1000, side: 'debit' } });
    expect(t.app.db.value("SELECT narration FROM journal_entries WHERE voucher_type = 'opening' AND is_void = 0")).toBe('Opening balance - Galla (Cash)');
    // Opening balances are not allowed on control accounts.
    const ar = await t.call('accounts.get', { id: sysId(t, 'AR') });
    expect(ar.openingBalance).toBeNull();
    expect((await t.fails('accounts.update', { id: sysId(t, 'AR'), name: 'Sundry Debtors', openingBalance: { amount: 100, side: 'debit' } })).message).toMatch(/own pages/);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('chooses the accounts used by Cash / UPI / Bank payments', async () => {
    const t = await createTestApp();
    const hdfc = await t.call('accounts.create', { name: 'HDFC Current', groupCode: 'bank' });
    const counter = await t.call('accounts.create', { name: 'Counter Cash', groupCode: 'cash' });
    expect((await t.fails('accounts.setPaymentDefaults', { cashAccountId: hdfc.id, upiAccountId: sysId(t, 'UPI'), bankAccountId: hdfc.id })).message).toMatch(
      /not a cash account/,
    );
    expect((await t.fails('accounts.setPaymentDefaults', { cashAccountId: counter.id, upiAccountId: counter.id, bankAccountId: hdfc.id })).message).toMatch(
      /not a bank \/ UPI account/,
    );
    await t.call('accounts.setPaymentDefaults', { cashAccountId: counter.id, upiAccountId: hdfc.id, bankAccountId: hdfc.id });
    const ctx = t.app.ctx();
    expect(paymentAccountId(ctx, 'cash')).toBe(counter.id);
    expect(paymentAccountId(ctx, 'upi')).toBe(hdfc.id);
    const pa = await t.call('accounts.paymentAccounts');
    expect(pa.defaults).toEqual({ cash: counter.id, upi: hdfc.id, bank: hdfc.id });
    expect((await t.call('accounts.get', { id: hdfc.id })).defaultFor).toEqual(['upi', 'bank']);
    expect((await t.fails('accounts.setActive', { id: hdfc.id, active: false })).message).toMatch(/used for UPI \/ Bank payments/);
    expect((await t.fails('accounts.remove', { id: hdfc.id })).message).toMatch(/used for UPI \/ Bank payments/);
    expect(activity(t, 'account.payment_defaults')[0].summary).toBe('Payment accounts: Cash → Counter Cash, UPI → HDFC Current, Bank → HDFC Current');
  });

  it('shows the chart as a tree with balances that agree', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    await t.call('accounts.capital', { amount: 200000, mode: 'bank' });
    const tree = await t.call('accounts.chart', {});
    expect(tree.types.map((x) => x.type)).toEqual(['asset', 'liability', 'equity', 'income', 'expense']);
    const assets = tree.types[0];
    const cashGroup = assets.groups.find((g) => g.code === 'cash')!;
    expect(cashGroup.accounts[0]).toMatchObject({ name: 'Cash in Hand', isSystem: true, balance: 1000000, entryCount: 1, defaultFor: ['cash'] });
    expect(assets.balance).toBe(1200000);
    expect(tree.totalDebit).toBe(tree.totalCredit);
    expect(assets.groups.find((g) => g.code === 'receivables')!.allowUserAccounts).toBe(false);
    const groups = await t.call('accounts.groups');
    expect(groups.find((g) => g.code === 'cash')).toMatchObject({ allowUserAccounts: true, nextCode: '1002', typeLabel: 'Assets' });
  });

  it('checks permissions', async () => {
    const t = await createTestApp();
    await t.loginAs('cashier');
    expect((await t.fails('accounts.create', { name: 'X', groupCode: 'cash' })).code).toBe('FORBIDDEN');
    expect((await t.fails('accounts.chart', {})).code).toBe('FORBIDDEN');
    expect((await t.fails('books.cashBook', { from: '2026-04-01', to: '2026-09-28' })).code).toBe('FORBIDDEN');
    expect((await t.fails('journals.list', { from: '2026-04-01', to: '2026-09-28' })).code).toBe('FORBIDDEN');
    expect((await t.fails('expenses.create', { accountId: 1, amount: 100, mode: 'cash' })).code).toBe('FORBIDDEN');
    // Pickers still work for everyone, without balances.
    const list = await t.call('accounts.list', { groups: ['cash'], withBalances: true });
    expect(list[0].balance).toBeUndefined();
    await t.loginAs('manager');
    // Managers can view the chart and keep the books, but not edit the chart or close the year.
    expect((await t.call('accounts.chart', {})).types).toHaveLength(5);
    expect((await t.fails('accounts.create', { name: 'X', groupCode: 'cash' })).code).toBe('FORBIDDEN');
    expect((await t.fails('accounts.setPaymentDefaults', { cashAccountId: 1, upiAccountId: 2, bankAccountId: 2 })).code).toBe('FORBIDDEN');
    expect((await t.fails('yearEnd.list')).code).toBe('FORBIDDEN');
    const head = await t.call('expenses.addHead', { name: 'Security Guard' });
    expect(t.app.db.value('SELECT group_code FROM accounts WHERE id = ?', [head.id])).toBe('indirect_expenses');
  });
});

describe('view-only access to the books', () => {
  it('lets a user with accounts.view read everything but change nothing', async () => {
    const t = await createTestApp({ openingCash: 100000 });
    const e = await t.call('journals.create', { narration: 'Rent', lines: [{ accountId: acctId(t, 'Rent'), debit: 5000 }, { accountId: sysId(t, 'CASH'), credit: 5000 }] });
    const x = await t.call('expenses.create', { accountId: acctId(t, 'Rent'), amount: 1000, mode: 'cash' });
    t.app.db.run("DELETE FROM role_permissions WHERE role = 'manager' AND permission IN ('accounts.manage', 'expenses.manage')");
    await t.loginAs('manager', 'viewer');
    const view = await t.call('journals.get', { entryId: e.id });
    expect(view).toMatchObject({ editable: true, canEdit: false });
    expect((await t.call('books.cashBook', { from: '2026-04-01', to: '2026-09-28' })).closing).toBe(94000);
    expect((await t.call('expenses.get', { id: x.id })).amount).toBe(1000);
    expect((await t.call('expenses.list', { from: '2026-04-01', to: '2026-09-28' })).totals.amount).toBe(1000);
    expect((await t.call('loans.list', {})).rows).toEqual([]);
    const lines = [
      { accountId: sysId(t, 'CASH'), debit: 100 },
      { accountId: sysId(t, 'CAPITAL'), credit: 100 },
    ];
    expect((await t.fails('journals.create', { narration: 'x', lines })).code).toBe('FORBIDDEN');
    expect((await t.fails('journals.cancel', { entryId: e.id, reason: 'x' })).code).toBe('FORBIDDEN');
    expect((await t.fails('expenses.cancel', { id: x.id, reason: 'x' })).code).toBe('FORBIDDEN');
    expect((await t.fails('accounts.capital', { amount: 100, mode: 'cash' })).code).toBe('FORBIDDEN');
    expect((await t.fails('accounts.transfer', { fromAccountId: sysId(t, 'CASH'), toAccountId: sysId(t, 'BANK'), amount: 100 })).code).toBe('FORBIDDEN');
    expect((await t.fails('expenses.addHead', { name: 'X' })).code).toBe('FORBIDDEN');
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('journal vouchers', () => {
  it('posts balanced journals with numbers, revisions and activity', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const e = await t.call('journals.create', {
      date: '2026-09-20',
      narration: 'Shop rent for September',
      lines: [
        { accountId: acctId(t, 'Rent'), debit: 1500000, memo: 'September' },
        { accountId: sysId(t, 'CASH'), credit: 1000000 },
        { accountId: sysId(t, 'BANK'), credit: 500000 },
      ],
    });
    expect(e).toMatchObject({ voucherNo: 'JV/26-27/0001', voucherType: 'journal', sourceType: 'manual', editable: true, canEdit: true, totalDebit: 1500000, totalCredit: 1500000, fromDocument: false });
    expect(e.link).toEqual({ kind: 'journal', id: e.id });
    expect(e.lines.map((l) => [l.accountName, l.debit, l.credit, l.memo])).toEqual([
      ['Rent', 1500000, 0, 'September'],
      ['Cash in Hand', 0, 1000000, null],
      ['Bank Account', 0, 500000, null],
    ]);
    expect(e.revisions.map((r) => r.action)).toEqual(['created']);
    expect(systemBalance(t.app, 'CASH')).toBe(0);
    expect(activity(t, 'journal.create')[0].summary).toBe('Entered journal JV/26-27/0001 for ₹15,000.00: Shop rent for September');
    const second = await t.call('journals.create', { narration: 'x', lines: [{ accountId: sysId(t, 'BANK'), debit: 100 }, { accountId: sysId(t, 'CAPITAL'), credit: 100 }] });
    expect(second.voucherNo).toBe('JV/26-27/0002');
    expect(second.date).toBe('2026-09-28');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('rejects unbalanced or incomplete journals', async () => {
    const t = await createTestApp();
    const cash = sysId(t, 'CASH');
    const cap = sysId(t, 'CAPITAL');
    expect((await t.fails('journals.create', { narration: 'x', lines: [{ accountId: cash, debit: 1000 }, { accountId: cap, credit: 900 }] })).message).toBe(
      'Total debit ₹10.00 and total credit ₹9.00 must be equal (difference ₹1.00).',
    );
    expect((await t.fails('journals.create', { narration: 'x', lines: [{ accountId: cash, debit: 1000 }] })).message).toMatch(/at least two lines/);
    expect((await t.fails('journals.create', { narration: 'x', lines: [{ accountId: cash, debit: 1000 }, { accountId: cap, debit: 0, credit: 0 }] })).message).toMatch(
      /at least one debit line and one credit line/,
    );
    expect((await t.fails('journals.create', { narration: 'x', lines: [{ accountId: cash, debit: 1000, credit: 1000 }, { accountId: cap, credit: 1000 }] })).message).toMatch(
      /either a debit or a credit/,
    );
    expect((await t.fails('journals.create', { narration: '  ', lines: [{ accountId: cash, debit: 1000 }, { accountId: cap, credit: 1000 }] })).message).toMatch(/narration/);
    expect((await t.fails('journals.create', { date: '2026-10-01', narration: 'x', lines: [{ accountId: cash, debit: 1000 }, { accountId: cap, credit: 1000 }] })).message).toMatch(
      /later than today/,
    );
    expect((await t.fails('journals.create', { date: '2026-03-31', narration: 'x', lines: [{ accountId: cash, debit: 1000 }, { accountId: cap, credit: 1000 }] })).message).toMatch(
      /before your books start/,
    );
    expect((await t.fails('journals.create', { narration: 'x', lines: [{ accountId: 99999, debit: 1000 }, { accountId: cap, credit: 1000 }] })).message).toMatch(/not found/);
    expect(t.app.db.value('SELECT COUNT(*) FROM journal_entries')).toBe(0);
    expect(t.app.db.value("SELECT COUNT(*) FROM sequences WHERE key = 'journal'")).toBe(0);
  });

  it('requires a party on customer, supplier and employee accounts', async () => {
    const t = await createTestApp();
    const anita = addCustomer(t, 'Anita Sharma');
    const gupta = addSupplier(t, 'Gupta Traders');
    const raju = addEmployee(t, 'Raju');
    const ar = sysId(t, 'AR');
    expect((await t.fails('journals.create', { narration: 'Bad debt', lines: [{ accountId: acctId(t, 'Miscellaneous Expenses'), debit: 500 }, { accountId: ar, credit: 500 }] })).message).toBe(
      'Choose a customer for the "Sundry Debtors" line',
    );
    await t.call('journals.create', {
      narration: 'Old dues from Anita',
      lines: [
        { accountId: ar, debit: 20000, partyType: 'customer', partyId: anita },
        { accountId: sysId(t, 'OTHER_INCOME'), credit: 20000 },
      ],
    });
    expect(partyBalance(t.app.ctx(), 'customer', anita)).toBe(20000);
    // Supplier set-off and employee advance through a journal.
    await t.call('journals.create', {
      narration: 'Advance adjusted',
      lines: [
        { accountId: sysId(t, 'EMP_ADV'), debit: 3000, partyType: 'employee', partyId: raju },
        { accountId: sysId(t, 'AP'), credit: 3000, partyType: 'supplier', partyId: gupta },
      ],
    });
    expect(partyBalance(t.app.ctx(), 'supplier', gupta)).toBe(-3000);
    expect(partyBalance(t.app.ctx(), 'employee', raju)).toBe(3000);
    // A party on a normal account is ignored (not stored).
    const e = await t.call('journals.create', {
      narration: 'x',
      lines: [
        { accountId: sysId(t, 'CASH'), debit: 100, partyType: 'customer', partyId: anita },
        { accountId: sysId(t, 'CAPITAL'), credit: 100 },
      ],
    });
    expect(e.lines[0].partyId).toBeNull();
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('edits and cancels manual journals with a full audit trail', async () => {
    const t = await createTestApp();
    const rent = acctId(t, 'Rent');
    const cash = sysId(t, 'CASH');
    const e = await t.call('journals.create', { date: '2026-09-10', narration: 'Rent', lines: [{ accountId: rent, debit: 1000000 }, { accountId: cash, credit: 1000000 }] });
    const edited = await t.call('journals.update', {
      entryId: e.id,
      date: '2026-09-11',
      narration: 'Rent (corrected)',
      reason: 'Typed wrong amount',
      lines: [
        { accountId: rent, debit: 1200000 },
        { accountId: cash, credit: 1200000 },
      ],
    });
    expect(edited).toMatchObject({ date: '2026-09-11', narration: 'Rent (corrected)', voucherNo: e.voucherNo, totalDebit: 1200000 });
    expect(bal(t, rent)).toBe(1200000);
    expect(revisions(t, 'journal', e.id)).toEqual([
      { revision: 1, action: 'created', reason: null },
      { revision: 2, action: 'edited', reason: 'Typed wrong amount' },
    ]);
    expect(activity(t, 'journal.update')[0].summary).toBe(`Edited journal ${e.voucherNo}: amount ₹10,000.00 → ₹12,000.00, date changed (Typed wrong amount)`);
    const snap = JSON.parse(t.app.db.value<string>("SELECT snapshot FROM document_revisions WHERE doc_type = 'journal' AND revision = 2"));
    expect(snap.lines[0]).toMatchObject({ account: 'Rent', debit: 1200000 });

    expect((await t.fails('journals.update', { entryId: e.id, date: '2027-04-02', narration: 'x', lines: [{ accountId: rent, debit: 1 }, { accountId: cash, credit: 1 }] })).message).toMatch(
      /later than today/,
    );
    expect((await t.fails('journals.cancel', { entryId: e.id, reason: '' })).code).toBe('VALIDATION');
    const cancelled = await t.call('journals.cancel', { entryId: e.id, reason: 'Duplicate entry' });
    expect(cancelled).toMatchObject({ isVoid: true, voidReason: 'Duplicate entry', editable: false });
    expect(bal(t, rent)).toBe(0);
    expect(revisions(t, 'journal', e.id).map((r) => r.action)).toEqual(['created', 'edited', 'cancelled']);
    expect(activity(t, 'journal.cancel')[0].summary).toBe(`Cancelled journal ${e.voucherNo} of ₹12,000.00: Duplicate entry`);
    expect((await t.fails('journals.cancel', { entryId: e.id, reason: 'again' })).message).toMatch(/already cancelled/);
    expect((await t.fails('journals.update', { entryId: e.id, narration: 'x', lines: [{ accountId: rent, debit: 1 }, { accountId: cash, credit: 1 }] })).message).toMatch(/already cancelled/);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('keeps vouchers within their financial year when edited', async () => {
    const t = await createTestApp({ booksStart: '2025-04-01' });
    const e = await t.call('journals.create', { date: '2026-03-20', narration: 'x', lines: [{ accountId: sysId(t, 'CASH'), debit: 100 }, { accountId: sysId(t, 'CAPITAL'), credit: 100 }] });
    expect(e.voucherNo).toBe('JV/25-26/0001');
    expect(
      (await t.fails('journals.update', { entryId: e.id, date: '2026-04-02', narration: 'x', lines: [{ accountId: sysId(t, 'CASH'), debit: 100 }, { accountId: sysId(t, 'CAPITAL'), credit: 100 }] }))
        .message,
    ).toMatch(/belongs to financial year 2025-26/);
  });

  it('shows entries made by documents but refuses to change them here', async () => {
    const t = await createTestApp();
    const anita = addCustomer(t, 'Anita');
    const billEntry = postEntry(t.app.ctx(), {
      date: '2026-09-15',
      voucherType: 'sale',
      voucherNo: 'INV/26-27/0007',
      sourceType: 'bill',
      sourceId: 7,
      narration: 'Bill INV/26-27/0007 - Anita',
      lines: [
        { account: 'AR', debit: 45000, partyType: 'customer', partyId: anita },
        { account: 'SALES', credit: 45000 },
      ],
    });
    const d = await t.call('journals.get', { entryId: billEntry });
    expect(d).toMatchObject({ editable: false, canEdit: false, fromDocument: true, sourceLabel: 'Sales bill', link: { kind: 'bill', id: 7 }, revisions: [] });
    expect(d.lockedReason).toMatch(/made automatically from a sales bill. Open the bill/);
    expect(d.lines[0]).toMatchObject({ accountName: 'Sundry Debtors', partyName: 'Anita', partyType: 'customer' });
    const lines = [
      { accountId: sysId(t, 'CASH'), debit: 45000 },
      { accountId: sysId(t, 'SALES'), credit: 45000 },
    ];
    expect((await t.fails('journals.update', { entryId: billEntry, narration: 'x', lines })).message).toMatch(/Open the bill to edit or cancel it/);
    expect((await t.fails('journals.cancel', { entryId: billEntry, reason: 'x' })).message).toMatch(/Open the bill/);

    const exp = await t.call('expenses.create', { accountId: acctId(t, 'Electricity'), amount: 230000, mode: 'cash' });
    expect((await t.fails('journals.cancel', { entryId: exp.journalEntryId!, reason: 'x' })).message).toMatch(/Open the expense/);
    const expEntry = await t.call('journals.get', { entryId: exp.journalEntryId! });
    expect(expEntry.link).toEqual({ kind: 'expense', id: exp.id });

    // Opening balances are changed from their account / party.
    const op = await t.call('accounts.create', { name: 'Old Deposit', groupCode: 'current_assets', openingBalance: { amount: 100, side: 'debit' } });
    const opEntry = t.app.db.value<number>("SELECT id FROM journal_entries WHERE voucher_type = 'opening' AND source_id = ?", [op.id]);
    expect((await t.fails('journals.cancel', { entryId: opEntry, reason: 'x' })).message).toMatch(/Opening balances are changed from/);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('lists every entry with filters and search', async () => {
    const t = await createTestApp({ openingCash: 500000 });
    const g = addSupplier(t, 'Gupta Traders');
    await t.call('journals.create', { date: '2026-09-01', narration: 'Shop painting', lines: [{ accountId: acctId(t, 'Repairs & Maintenance'), debit: 800000 }, { accountId: sysId(t, 'CASH'), credit: 800000 }] });
    await t.call('expenses.create', { date: '2026-09-02', accountId: acctId(t, 'Transport & Delivery'), amount: 45000, mode: 'credit', supplierId: g });
    const cap = await t.call('accounts.capital', { date: '2026-09-03', amount: 1000000, mode: 'cash' });
    await t.call('journals.cancel', { entryId: cap.id, reason: 'Wrong' });

    const all = await t.call('journals.list', { from: '2026-04-01', to: '2026-09-28' });
    expect(all.total).toBe(4); // opening + journal + expense + cancelled capital
    expect(all.rows[0]).toMatchObject({ voucherType: 'capital', isVoid: true, editable: false });
    expect(all.totalAmount).toBe(500000 + 800000 + 45000);
    const exp = all.rows.find((r) => r.voucherType === 'expense')!;
    expect(exp).toMatchObject({ sourceLabel: 'Expense', debitNames: 'Transport & Delivery', creditNames: 'Gupta Traders', editable: false, link: { kind: 'expense' } });

    expect((await t.call('journals.list', { from: '2026-04-01', to: '2026-09-28', voucherType: 'journal' })).rows.map((r) => r.narration)).toEqual(['Shop painting']);
    expect((await t.call('journals.list', { from: '2026-04-01', to: '2026-09-28', q: 'gupta' })).total).toBe(1);
    expect((await t.call('journals.list', { from: '2026-04-01', to: '2026-09-28', q: '8,000' })).rows[0].narration).toBe('Shop painting');
    expect((await t.call('journals.list', { from: '2026-04-01', to: '2026-09-28', q: 'painting' })).total).toBe(1);
    expect((await t.call('journals.list', { from: '2026-04-01', to: '2026-09-28', accountId: sysId(t, 'CASH') })).total).toBe(3);
    expect((await t.call('journals.list', { from: '2026-04-01', to: '2026-09-28', status: 'cancelled' })).total).toBe(1);
    expect((await t.call('journals.list', { from: '2026-09-02', to: '2026-09-02' })).total).toBe(1);
    const limited = await t.call('journals.list', { from: '2026-04-01', to: '2026-09-28', limit: 2 });
    expect(limited).toMatchObject({ total: 4, truncated: true });
    expect(limited.rows).toHaveLength(2);
  });
});

describe('expenses', () => {
  it('records cash, UPI and bank expenses', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const rent = acctId(t, 'Rent');
    const x = await t.call('expenses.create', { date: '2026-09-05', accountId: rent, amount: 1200000, mode: 'cash', payee: 'Mr. Kulkarni', remarks: 'September rent' });
    expect(x).toMatchObject({ expenseNo: 'EXP/26-27/0001', status: 'active', accountName: 'Rent', payAccountName: 'Cash in Hand', payee: 'Mr. Kulkarni', revision: 1 });
    expect(x.posting.map((l) => [l.accountName, l.debit, l.credit])).toEqual([
      ['Rent', 1200000, 0],
      ['Cash in Hand', 0, 1200000],
    ]);
    const entry = t.app.db.get<any>('SELECT * FROM journal_entries WHERE id = ?', [x.journalEntryId]);
    expect(entry).toMatchObject({ voucher_type: 'expense', voucher_no: 'EXP/26-27/0001', source_type: 'expense', source_id: x.id, narration: 'Rent - paid to Mr. Kulkarni (September rent)' });
    expect(systemBalance(t.app, 'CASH')).toBe(-200000);
    expect(x.revisions.map((r) => r.action)).toEqual(['created']);
    expect(activity(t, 'expense.create')[0].summary).toBe('Recorded expense EXP/26-27/0001: Rent ₹12,000.00 by Cash');

    const upi = await t.call('expenses.create', { accountId: acctId(t, 'Electricity'), amount: 345000, mode: 'upi', reference: 'UTR 4455' });
    expect(upi.payAccountName).toBe('UPI Account');
    expect(systemBalance(t.app, 'UPI')).toBe(-345000);

    const hdfc = await t.call('accounts.create', { name: 'HDFC Current', groupCode: 'bank' });
    const bank = await t.call('expenses.create', { accountId: acctId(t, 'Bank Charges'), amount: 11800, mode: 'bank', payAccountId: hdfc.id });
    expect(bank.payAccountName).toBe('HDFC Current');
    expect(bal(t, hdfc.id)).toBe(-11800);
    expect((await t.fails('expenses.create', { accountId: rent, amount: 100, mode: 'cash', payAccountId: hdfc.id })).message).toMatch(/must go to a cash account/);
    expect((await t.fails('expenses.create', { accountId: sysId(t, 'CASH'), amount: 100, mode: 'cash' })).message).toMatch(/not an expense head/);
    expect((await t.fails('expenses.create', { accountId: rent, amount: 0, mode: 'cash' })).code).toBe('VALIDATION');
    expect((await t.fails('expenses.create', { accountId: rent, amount: 100, mode: 'cash', date: '2026-09-29' })).message).toMatch(/later than today/);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('records expenses on credit against the supplier', async () => {
    const t = await createTestApp();
    const g = addSupplier(t, 'Mehta Transport');
    expect((await t.fails('expenses.create', { accountId: acctId(t, 'Transport & Delivery'), amount: 50000, mode: 'credit' })).message).toMatch(/Choose the supplier/);
    const x = await t.call('expenses.create', { accountId: acctId(t, 'Transport & Delivery'), amount: 50000, mode: 'credit', supplierId: g });
    expect(x).toMatchObject({ supplierName: 'Mehta Transport', payAccountId: null });
    expect(x.posting.map((l) => [l.accountName, l.partyName, l.debit, l.credit])).toEqual([
      ['Transport & Delivery', null, 50000, 0],
      ['Sundry Creditors', 'Mehta Transport', 0, 50000],
    ]);
    expect(partyBalance(t.app.ctx(), 'supplier', g)).toBe(-50000);
    expect(t.app.db.value('SELECT narration FROM journal_entries WHERE id = ?', [x.journalEntryId])).toBe('Transport & Delivery - on credit from Mehta Transport');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('edits and cancels expenses with revisions', async () => {
    const t = await createTestApp();
    const g = addSupplier(t, 'Sai Electricals');
    const repairs = acctId(t, 'Repairs & Maintenance');
    const x = await t.call('expenses.create', { date: '2026-09-20', accountId: repairs, amount: 150000, mode: 'cash' });
    const e = await t.call('expenses.update', { id: x.id, accountId: repairs, amount: 180000, mode: 'credit', supplierId: g, reason: 'Bill came later' });
    expect(e).toMatchObject({ amount: 180000, mode: 'credit', supplierName: 'Sai Electricals', revision: 2, date: '2026-09-20', payAccountId: null });
    expect(systemBalance(t.app, 'CASH')).toBe(0);
    expect(partyBalance(t.app.ctx(), 'supplier', g)).toBe(-180000);
    expect(t.app.db.value('SELECT COUNT(*) FROM journal_entries')).toBe(1);
    expect(activity(t, 'expense.update')[0].summary).toBe(`Edited expense ${x.expenseNo}: amount ₹1,500.00 → ₹1,800.00, now paid on credit from Sai Electricals (Bill came later)`);

    expect((await t.fails('expenses.cancel', { id: x.id, reason: ' ' })).code).toBe('VALIDATION');
    const c = await t.call('expenses.cancel', { id: x.id, reason: 'Paid by owner personally' });
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Paid by owner personally', revision: 3, cancelledBy: 'Ravi Sharma' });
    expect(partyBalance(t.app.ctx(), 'supplier', g)).toBe(0);
    expect(bal(t, repairs)).toBe(0);
    expect(t.app.db.value('SELECT is_void FROM journal_entries WHERE id = ?', [x.journalEntryId])).toBe(1);
    expect(c.revisions.map((r) => [r.revision, r.action, r.reason])).toEqual([
      [1, 'created', null],
      [2, 'edited', 'Bill came later'],
      [3, 'cancelled', 'Paid by owner personally'],
    ]);
    expect((await t.fails('expenses.update', { id: x.id, accountId: repairs, amount: 1, mode: 'cash' })).message).toMatch(/cancelled/);
    expect((await t.fails('expenses.cancel', { id: x.id, reason: 'x' })).message).toMatch(/already cancelled/);
    expect(activity(t, 'expense.cancel')).toHaveLength(1);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('lists expenses with totals and summarises them by head', async () => {
    const t = await createTestApp();
    const tea = acctId(t, 'Tea & Refreshments');
    const rent = acctId(t, 'Rent');
    const g = addSupplier(t, 'Gupta');
    await t.call('expenses.create', { date: '2026-09-01', accountId: tea, amount: 4000, mode: 'cash', payee: 'Chaiwala' });
    await t.call('expenses.create', { date: '2026-09-02', accountId: tea, amount: 6000, mode: 'upi' });
    await t.call('expenses.create', { date: '2026-09-03', accountId: rent, amount: 1000000, mode: 'bank' });
    await t.call('expenses.create', { date: '2026-09-04', accountId: rent, amount: 50000, mode: 'credit', supplierId: g });
    const gone = await t.call('expenses.create', { date: '2026-09-05', accountId: tea, amount: 9999, mode: 'cash' });
    await t.call('expenses.cancel', { id: gone.id, reason: 'Duplicate' });

    const list = await t.call('expenses.list', { from: '2026-09-01', to: '2026-09-30' });
    expect(list.rows).toHaveLength(5);
    expect(list.totals).toEqual({ count: 4, amount: 1060000, cash: 4000, upi: 6000, bank: 1000000, credit: 50000, cancelled: 1 });
    expect((await t.call('expenses.list', { from: '2026-09-01', to: '2026-09-30', accountId: tea })).totals.amount).toBe(10000);
    expect((await t.call('expenses.list', { from: '2026-09-01', to: '2026-09-30', q: 'chai' })).rows).toHaveLength(1);
    expect((await t.call('expenses.list', { from: '2026-09-01', to: '2026-09-30', q: 'gupta' })).rows).toHaveLength(1);
    expect((await t.call('expenses.list', { from: '2026-09-01', to: '2026-09-30', status: 'cancelled' })).rows).toHaveLength(1);

    const s = await t.call('expenses.summary', { from: '2026-09-01', to: '2026-09-30' });
    expect(s.rows.map((r) => [r.cells.head, r.cells.count, r.cells.amount, r.cells.share])).toEqual([
      ['Rent', 2, 1050000, 99.1],
      ['Tea & Refreshments', 2, 10000, 0.9],
      ['Total', 4, 1060000, 100],
    ]);
    expect(s.rows[0].link).toEqual({ kind: 'account', id: rent });
    expect(s.summary?.find((x) => x.label === 'On credit')?.value).toBe(50000);
  });
});

describe('capital, drawings and transfers', () => {
  it('posts capital and drawings as per the contract', async () => {
    const t = await createTestApp({ openingCash: 100000 });
    const c = await t.call('accounts.capital', { date: '2026-09-01', amount: 5000000, mode: 'bank' });
    expect(c).toMatchObject({ voucherType: 'capital', voucherNo: 'JV/26-27/0001', sourceType: 'manual', narration: 'Capital introduced by owner (Bank)' });
    expect(systemBalance(t.app, 'BANK')).toBe(5000000);
    expect(systemBalance(t.app, 'CAPITAL')).toBe(-5000000);
    expect((await t.fails('accounts.capital', { amount: 100, mode: 'cash', capitalAccountId: sysId(t, 'OPENING_EQUITY') })).message).toMatch(/only for opening balances/);
    expect((await t.fails('accounts.capital', { amount: 100, mode: 'cash', capitalAccountId: sysId(t, 'SALES') })).message).toMatch(/not a capital account/);
    const partner = await t.call('accounts.create', { name: 'Capital - Sunita', groupCode: 'capital' });
    await t.call('accounts.capital', { amount: 200000, mode: 'cash', capitalAccountId: partner.id, narration: 'Sunita brought cash' });
    expect(bal(t, partner.id)).toBe(-200000);

    const d = await t.call('accounts.drawings', { date: '2026-09-10', amount: 300000, mode: 'cash' });
    expect(d.lines.map((l) => [l.accountName, l.debit, l.credit])).toEqual([
      ['Drawings', 300000, 0],
      ['Cash in Hand', 0, 300000],
    ]);
    const goods = await t.call('accounts.drawings', { amount: 25000, goods: true });
    expect(goods.lines.map((l) => [l.accountName, l.debit, l.credit])).toEqual([
      ['Drawings', 25000, 0],
      ['Purchases', 0, 25000],
    ]);
    expect(goods.narration).toBe('Goods taken by owner for personal use');
    expect(systemBalance(t.app, 'DRAWINGS')).toBe(325000);
    expect((await t.fails('accounts.drawings', { amount: 100 })).message).toMatch(/Choose how the money was taken/);
    expect(activity(t, 'capital.add')).toHaveLength(2);
    expect(activity(t, 'drawings.add')[1].summary).toBe(`Recorded drawings of ₹250.00 goods (${goods.voucherNo})`);

    // Cancel through journals.cancel.
    await t.call('journals.cancel', { entryId: d.id, reason: 'Entered twice' });
    expect(systemBalance(t.app, 'DRAWINGS')).toBe(25000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('summarises the owner capital account', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    await t.call('accounts.capital', { date: '2026-05-01', amount: 500000, mode: 'cash' });
    await t.call('accounts.drawings', { date: '2026-06-01', amount: 200000, mode: 'cash' });
    await t.call('accounts.capital', { date: '2026-09-01', amount: 100000, mode: 'bank' });
    await t.call('expenses.create', { date: '2026-06-10', accountId: acctId(t, 'Rent'), amount: 50000, mode: 'cash' });
    const s = await t.call('accounts.capitalSummary', { from: '2026-06-01', to: '2026-09-28' });
    // Opening = opening balance adjustment 10,000 + capital 5,000 (before June).
    expect(s).toMatchObject({ opening: 1500000, capitalAdded: 100000, drawings: 200000, profitTransferred: 0, closing: 1400000, unclosedProfit: -50000 });
    expect(s.closing).toBe(-(systemBalance(t.app, 'CAPITAL') + systemBalance(t.app, 'OPENING_EQUITY') + systemBalance(t.app, 'DRAWINGS')));
    expect(s.entries.map((e) => [e.voucherType, e.amount])).toEqual([
      ['drawings', -200000],
      ['capital', 100000],
    ]);
    const rows = s.report.rows;
    expect(rows[0].cells).toMatchObject({ particulars: 'Opening balance', balance: 1500000 });
    expect(rows.at(-1)!.cells).toMatchObject({ particulars: 'Closing balance', added: 100000, withdrawn: 200000, balance: 1400000 });
    expect(s.report.notes?.[1]).toMatch(/Loss of ₹500.00/);
  });

  it('transfers between cash, bank and UPI accounts', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const cash = sysId(t, 'CASH');
    const bank = sysId(t, 'BANK');
    const upi = sysId(t, 'UPI');
    const dep = await t.call('accounts.transfer', { fromAccountId: cash, toAccountId: bank, amount: 800000 });
    expect(dep.entry).toMatchObject({ voucherType: 'contra', narration: 'Cash deposited in Bank Account', voucherNo: 'JV/26-27/0001' });
    expect(dep.warnings).toEqual([]);
    expect(systemBalance(t.app, 'CASH')).toBe(200000);
    expect(systemBalance(t.app, 'BANK')).toBe(800000);
    const w = await t.call('accounts.transfer', { fromAccountId: bank, toAccountId: cash, amount: 50000 });
    expect(w.entry.narration).toBe('Cash withdrawn from Bank Account');
    const u = await t.call('accounts.transfer', { fromAccountId: upi, toAccountId: bank, amount: 30000 });
    expect(u.entry.narration).toBe('Transfer from UPI Account to Bank Account');
    expect(u.warnings[0]).toMatch(/UPI Account will be short by ₹300.00/);

    expect((await t.fails('accounts.transfer', { fromAccountId: cash, toAccountId: cash, amount: 100 })).message).toMatch(/two different accounts/);
    expect((await t.fails('accounts.transfer', { fromAccountId: cash, toAccountId: acctId(t, 'Rent'), amount: 100 })).message).toMatch(/not a cash, bank or UPI account/);
    const list = await t.call('accounts.transfers', { from: '2026-09-01', to: '2026-09-30' });
    expect(list.rows).toHaveLength(3);
    expect(list.rows.find((r) => r.id === dep.entry.id)).toMatchObject({ fromAccount: 'Cash in Hand', toAccount: 'Bank Account', amount: 800000, isVoid: false, createdBy: 'Ravi Sharma' });
    await t.call('journals.cancel', { entryId: u.entry.id, reason: 'Wrong' });
    const after = await t.call('accounts.transfers', { from: '2026-09-01', to: '2026-09-30' });
    expect(after.total).toBe(850000);
    expect(activity(t, 'transfer.create')).toHaveLength(3);
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('loans', () => {
  it('handles a loan taken with repayments and interest', async () => {
    const t = await createTestApp();
    const loan = await t.call('loans.create', {
      name: 'HDFC Bank',
      direction: 'taken',
      principal: 50000000,
      interestRate: 10.5,
      startDate: '2026-05-01',
      disburse: { mode: 'bank', amount: 50000000 },
    });
    expect(loan).toMatchObject({ accountName: 'Loan - HDFC Bank', outstanding: 50000000, disbursed: 50000000, repaid: 0, interestToDate: 0, isActive: true });
    const acct = await t.call('accounts.get', { id: loan.accountId });
    expect(acct).toMatchObject({ groupCode: 'loans', code: '2201', loan: { id: loan.id, name: 'HDFC Bank' }, canDelete: false, canDeactivate: false });
    expect(systemBalance(t.app, 'BANK')).toBe(50000000);
    expect(bal(t, loan.accountId)).toBe(-50000000);
    const disb = t.app.db.get<any>("SELECT * FROM journal_entries WHERE voucher_type = 'loan'");
    expect(disb).toMatchObject({ date: '2026-05-01', source_type: 'loan', source_id: loan.id, narration: 'Loan received from HDFC Bank' });

    const r = await t.call('loans.transaction', { loanId: loan.id, date: '2026-06-01', kind: 'repay', principal: 1000000, interest: 437500, mode: 'bank' });
    expect(r.entry.lines.map((l) => [l.accountName, l.debit, l.credit])).toEqual([
      ['Loan - HDFC Bank', 1000000, 0],
      ['Interest Paid', 437500, 0],
      ['Bank Account', 0, 1437500],
    ]);
    expect(r.entry.narration).toBe('Loan repayment to HDFC Bank (principal ₹10,000.00, interest ₹4,375.00)');
    expect(r.loan).toMatchObject({ outstanding: 49000000, interestToDate: 437500, repaid: 1000000 });
    expect(systemBalance(t.app, 'INTEREST_EXPENSE')).toBe(437500);
    // Interest only (bank debits interest).
    const io = await t.call('loans.transaction', { loanId: loan.id, date: '2026-07-01', kind: 'repay', principal: 0, interest: 420000, mode: 'bank' });
    expect(io.entry.narration).toBe('Interest paid to HDFC Bank');
    expect(io.loan.interestToDate).toBe(857500);

    expect((await t.fails('loans.transaction', { loanId: loan.id, kind: 'repay', principal: 49000001, interest: 0, mode: 'bank' })).message).toMatch(/more than the outstanding ₹4,90,000.00/);
    expect((await t.fails('loans.transaction', { loanId: loan.id, kind: 'receive', principal: 100, interest: 5, mode: 'bank' })).message).toMatch(/Interest is entered with repayments/);
    expect((await t.fails('loans.transaction', { loanId: loan.id, kind: 'collect', principal: 100, mode: 'bank' })).message).toMatch(/For a loan taken/);
    expect((await t.fails('loans.transaction', { loanId: loan.id, kind: 'repay', principal: 0, interest: 0, mode: 'bank' })).message).toMatch(/Enter the principal/);

    const d = await t.call('loans.get', { id: loan.id });
    expect(d.transactions.map((x) => [x.kindLabel, x.principalIn, x.principalOut, x.interest, x.balance])).toEqual([
      ['Interest paid', 0, 0, 420000, 49000000],
      ['Repayment', 0, 1000000, 437500, 49000000],
      ['Loan received', 50000000, 0, 0, 50000000],
    ]);
    expect(d.ledger.rows.at(-1)!.cells).toMatchObject({ particulars: 'Outstanding', taken: 50000000, repaid: 1000000, interest: 857500, balance: 49000000 });
    expect(d.transactions[0].link).toEqual({ kind: 'journal', id: io.entry.id });

    // Loan transactions can be edited / cancelled from the journal.
    const edited = await t.call('journals.update', {
      entryId: r.entry.id,
      narration: 'June EMI',
      lines: [
        { accountId: loan.accountId, debit: 1200000 },
        { accountId: sysId(t, 'INTEREST_EXPENSE'), debit: 237500 },
        { accountId: sysId(t, 'BANK'), credit: 1437500 },
      ],
    });
    expect(edited.loan).toEqual({ id: loan.id, name: 'HDFC Bank' });
    expect(
      (await t.fails('journals.update', { entryId: r.entry.id, narration: 'x', lines: [{ accountId: sysId(t, 'INTEREST_EXPENSE'), debit: 100 }, { accountId: sysId(t, 'BANK'), credit: 100 }] })).message,
    ).toMatch(/must keep a line on "Loan - HDFC Bank"/);
    await t.call('journals.cancel', { entryId: io.entry.id, reason: 'Bank reversed the charge' });
    const after = (await t.call('loans.list', {})).rows[0];
    expect(after).toMatchObject({ outstanding: 48800000, interestToDate: 237500 });
    expect(activity(t, 'loan.transaction_cancel')).toHaveLength(1);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('handles a loan given and collected back with interest', async () => {
    const t = await createTestApp({ openingCash: 5000000 });
    const loan = await t.call('loans.create', { name: 'Ramesh Kumar', direction: 'given', principal: 2000000, interestRate: 12, startDate: '2026-06-01', disburse: { mode: 'cash', amount: 2000000 } });
    expect(loan).toMatchObject({ accountName: 'Loan given - Ramesh Kumar', outstanding: 2000000 });
    expect(t.app.db.value('SELECT group_code FROM accounts WHERE id = ?', [loan.accountId])).toBe('loans_advances');
    expect(systemBalance(t.app, 'CASH')).toBe(3000000);
    const c = await t.call('loans.transaction', { loanId: loan.id, date: '2026-09-01', kind: 'collect', principal: 500000, interest: 60000, mode: 'upi' });
    expect(c.entry.lines.map((l) => [l.accountName, l.debit, l.credit])).toEqual([
      ['UPI Account', 560000, 0],
      ['Loan given - Ramesh Kumar', 0, 500000],
      ['Interest Received', 0, 60000],
    ]);
    expect(c.loan).toMatchObject({ outstanding: 1500000, interestToDate: 60000 });
    expect(systemBalance(t.app, 'INTEREST_INCOME')).toBe(-60000);
    const more = await t.call('loans.transaction', { loanId: loan.id, kind: 'give', principal: 100000, mode: 'cash' });
    expect(more.loan.outstanding).toBe(1600000);
    const list = await t.call('loans.list', {});
    expect(list.totals).toMatchObject({ taken: 0, given: 1600000, interestReceived: 60000 });

    // Close only when fully repaid.
    expect((await t.fails('loans.update', { id: loan.id, name: 'Ramesh Kumar', isActive: false })).message).toMatch(/₹16,000.00 is still outstanding/);
    await t.call('loans.transaction', { loanId: loan.id, kind: 'collect', principal: 1600000, interest: 0, mode: 'cash' });
    const closed = await t.call('loans.update', { id: loan.id, name: 'Ramesh K.', isActive: false, notes: 'Settled' });
    expect(closed).toMatchObject({ isActive: false, name: 'Ramesh K.', accountName: 'Loan given - Ramesh K.', notes: 'Settled', outstanding: 0 });
    expect(t.app.db.value('SELECT is_active FROM accounts WHERE id = ?', [loan.accountId])).toBe(0);
    expect((await t.fails('loans.transaction', { loanId: loan.id, kind: 'give', principal: 100, mode: 'cash' })).message).toMatch(/is closed/);
    expect((await t.call('loans.list', {})).rows).toHaveLength(0);
    expect((await t.call('loans.list', { includeClosed: true })).rows).toHaveLength(1);
    expect(activity(t, 'loan.update')[0].summary).toBe('Updated loan "Ramesh K.": renamed from "Ramesh Kumar", closed');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('brings in loans that started before the books', async () => {
    const t = await createTestApp();
    expect((await t.fails('loans.create', { name: 'SBI', direction: 'taken', principal: 100, startDate: '2026-05-01', openingOutstanding: 100 })).message).toMatch(/started before your books start/);
    const loan = await t.call('loans.create', { name: 'SBI Mudra', direction: 'taken', principal: 100000000, interestRate: 9, startDate: '2024-01-15', openingOutstanding: 60000000 });
    expect(loan.outstanding).toBe(60000000);
    expect(systemBalance(t.app, 'OPENING_EQUITY')).toBe(60000000);
    expect(loan.transactions[0]).toMatchObject({ kind: 'opening', kindLabel: 'Opening balance', date: '2026-04-01', principalIn: 60000000 });
    expect((await t.call('accounts.get', { id: loan.accountId })).openingBalance).toBe(-60000000);
    expect((await t.fails('loans.create', { name: 'SBI Mudra', direction: 'taken', principal: 1, startDate: '2026-05-01' })).message).toMatch(/already exists/);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('needs accounts.manage to record loans', async () => {
    const t = await createTestApp();
    await t.loginAs('cashier');
    expect((await t.fails('loans.create', { name: 'X', direction: 'taken', principal: 1, startDate: '2026-05-01' })).code).toBe('FORBIDDEN');
    expect((await t.fails('loans.list', {})).code).toBe('FORBIDDEN');
  });
});

describe('books', () => {
  async function seeded() {
    const t = await createTestApp({ openingCash: 1000000 });
    const hdfc = await t.call('accounts.create', { name: 'HDFC Current', groupCode: 'bank' });
    const g = addSupplier(t, 'Gupta Traders');
    const anita = addCustomer(t, 'Anita Sharma');
    t.setToday('2026-08-31');
    await t.call('expenses.create', { date: '2026-08-10', accountId: acctId(t, 'Rent'), amount: 500000, mode: 'cash' }); // before the period
    t.setToday('2026-09-28');
    await t.call('expenses.create', { date: '2026-09-02', accountId: acctId(t, 'Tea & Refreshments'), amount: 5000, mode: 'cash' });
    await t.call('accounts.transfer', { date: '2026-09-02', fromAccountId: sysId(t, 'CASH'), toAccountId: hdfc.id, amount: 200000 });
    postEntry(t.app.ctx(), {
      date: '2026-09-03',
      voucherType: 'sale',
      voucherNo: 'INV/26-27/0001',
      sourceType: 'bill',
      sourceId: 1,
      narration: 'Bill INV/26-27/0001 - Anita Sharma',
      lines: [
        { account: 'CASH', debit: 30000 },
        { account: 'AR', debit: 20000, partyType: 'customer', partyId: anita },
        { account: 'SALES', credit: 50000 },
      ],
    });
    const gone = await t.call('expenses.create', { date: '2026-09-04', accountId: acctId(t, 'Electricity'), amount: 99900, mode: 'cash' });
    await t.call('expenses.cancel', { id: gone.id, reason: 'Duplicate' });
    await t.call('expenses.create', { date: '2026-09-05', accountId: acctId(t, 'Transport & Delivery'), amount: 7000, mode: 'credit', supplierId: g });
    await t.call('expenses.create', { date: '2026-09-06', accountId: acctId(t, 'Bank Charges'), amount: 1180, mode: 'bank', payAccountId: hdfc.id });
    await t.call('expenses.create', { date: '2026-09-06', accountId: acctId(t, 'Electricity'), amount: 150000, mode: 'upi' });
    return { t, hdfc, g, anita };
  }

  it('builds the cash book with opening, running and closing balances', async () => {
    const { t } = await seeded();
    const cash = sysId(t, 'CASH');
    const b = await t.call('books.cashBook', { from: '2026-09-01', to: '2026-09-30' });
    expect(b.opening).toBe(1000000 - 500000);
    expect(b.opening).toBe(bal(t, cash, '2026-08-31'));
    expect(b.closing).toBe(bal(t, cash, '2026-09-30'));
    expect(b.totalIn).toBe(30000);
    expect(b.totalOut).toBe(5000 + 200000);
    expect(b.entryCount).toBe(3); // the cancelled electricity expense is left out
    const rows = b.report.rows;
    expect(rows[0].cells).toMatchObject({ particulars: 'Opening balance', balance: 500000 });
    const normal = rows.filter((r) => !r.style || r.style === 'normal');
    expect(normal.map((r) => [r.cells.date, r.cells.voucher, r.cells.in, r.cells.out, r.cells.balance])).toEqual([
      ['2026-09-02', 'Expense', null, 5000, 495000],
      ['2026-09-02', 'Cash / Bank Transfer', null, 200000, 295000],
      ['2026-09-03', 'Sales Bill', 30000, null, 325000],
    ]);
    expect(normal[0].cells.particulars).toBe('Tea & Refreshments');
    expect(normal[1].cells.particulars).toBe('Cash deposited in HDFC Current');
    expect(normal[2].cells.particulars).toBe('Sales - Bill INV/26-27/0001 - Anita Sharma');
    expect(normal[2].link).toEqual({ kind: 'bill', id: 1 });
    // Day total after the two entries of 2 Sep.
    const sub = rows.find((r) => r.style === 'subtotal')!;
    expect(sub.cells).toMatchObject({ particulars: 'Total for 02-09-2026', in: 0, out: 205000, balance: 295000 });
    expect(rows.at(-1)!.cells).toMatchObject({ particulars: 'Closing balance', in: 30000, out: 205000, balance: 325000 });
    expect(b.accounts).toEqual([{ id: cash, name: 'Cash in Hand', isActive: true, opening: 500000, closing: 325000 }]);
    expect(b.report.columns.some((c) => c.key === 'account')).toBe(false);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('builds the bank & UPI book for all accounts or one', async () => {
    const { t, hdfc } = await seeded();
    const all = await t.call('books.bankBook', { from: '2026-09-01', to: '2026-09-30' });
    expect(all.report.columns.some((c) => c.key === 'account')).toBe(true);
    expect(all.opening).toBe(0);
    expect(all.totalIn).toBe(200000);
    expect(all.totalOut).toBe(1180 + 150000);
    expect(all.closing).toBe(bal(t, hdfc.id) + systemBalance(t.app, 'UPI') + systemBalance(t.app, 'BANK'));
    expect(all.accounts.map((a) => [a.name, a.closing])).toEqual([
      ['Bank Account', 0],
      ['UPI Account', -150000],
      ['HDFC Current', 198820],
    ]);
    const one = await t.call('books.bankBook', { from: '2026-09-01', to: '2026-09-30', accountId: hdfc.id });
    expect(one.report.title).toBe('Bank & UPI book - HDFC Current');
    expect(one.closing).toBe(198820);
    expect(one.entryCount).toBe(2);
    expect((await t.fails('books.bankBook', { from: '2026-09-01', to: '2026-09-30', accountId: sysId(t, 'CASH') })).message).toMatch(/not a bank/);
    expect((await t.fails('books.cashBook', { from: '2026-09-30', to: '2026-09-01' })).message).toMatch(/"from" date/);
  });

  it('shows the ledger of any account or party', async () => {
    const { t, g, anita } = await seeded();
    const rent = acctId(t, 'Rent');
    const l = await t.call('books.ledger', { accountId: rent, from: '2026-09-01', to: '2026-09-30' });
    expect(l.opening).toBe(500000);
    expect(l.closing).toBe(bal(t, rent, '2026-09-30'));
    expect(l.report.summary?.[0]).toMatchObject({ type: 'drcr', value: 500000 });

    const sales = await t.call('books.ledger', { accountId: sysId(t, 'SALES'), from: '2026-04-01', to: '2026-09-30' });
    expect(sales.closing).toBe(-50000);
    expect(sales.report.rows.at(-1)!.cells).toMatchObject({ in: 0, out: 50000, balance: -50000 });

    const sup = await t.call('books.ledger', { partyType: 'supplier', partyId: g, from: '2026-04-01', to: '2026-09-30' });
    expect(sup.title).toBe('Gupta Traders (supplier)');
    expect(sup.closing).toBe(partyBalance(t.app.ctx(), 'supplier', g));
    expect(sup.closing).toBe(-7000);
    const cust = await t.call('books.ledger', { partyType: 'customer', partyId: anita, from: '2026-04-01', to: '2026-09-30' });
    expect(cust.closing).toBe(20000);
    expect(cust.party).toMatchObject({ type: 'customer', id: anita, name: 'Anita Sharma' });
    // The debtors control account names the party on each line.
    const ar = await t.call('books.ledger', { accountId: sysId(t, 'AR'), from: '2026-04-01', to: '2026-09-30' });
    expect(ar.report.rows[1].cells.particulars).toBe('Cash in Hand, Sales - Bill INV/26-27/0001 - Anita Sharma');

    // Opening + movements = closing, for every account, over any period.
    for (const a of await t.call('accounts.list', { includeInactive: true })) {
      const x = await t.call('books.ledger', { accountId: a.id, from: '2026-09-03', to: '2026-09-05' });
      expect(x.opening + x.totalIn - x.totalOut).toBe(x.closing);
      expect(x.closing).toBe(bal(t, a.id, '2026-09-05'));
    }
    expect((await t.fails('books.ledger', { from: '2026-04-01', to: '2026-09-30' })).message).toMatch(/Choose an account/);
    expect((await t.fails('books.ledger', { partyType: 'customer', partyId: 9999, from: '2026-04-01', to: '2026-09-30' })).code).toBe('NOT_FOUND');
  });

  it('lists every voucher in the day book with daily totals', async () => {
    const { t } = await seeded();
    const d = await t.call('books.dayBook', { from: '2026-09-02', to: '2026-09-06' });
    expect(d.voucherCount).toBe(6);
    expect(d.totalDebit).toBe(d.totalCredit);
    expect(d.totalDebit).toBe(5000 + 200000 + 50000 + 7000 + 1180 + 150000);
    const subs = d.report.rows.filter((r) => r.style === 'subtotal');
    expect(subs.map((r) => [r.cells.particulars, r.cells.debit])).toEqual([
      ['Total for 02-09-2026 (2 vouchers)', 205000],
      ['Total for 03-09-2026 (1 voucher)', 50000],
      ['Total for 05-09-2026 (1 voucher)', 7000],
      ['Total for 06-09-2026 (2 vouchers)', 151180],
    ]);
    const header = d.report.rows.find((r) => r.style === 'group' && r.cells.voucher === 'Sales Bill')!;
    expect(header.link).toEqual({ kind: 'bill', id: 1 });
    const lines = d.report.rows.filter((r) => r.indent === 1);
    expect(lines.find((r) => r.cells.particulars === 'Sundry Debtors - Anita Sharma')?.cells.debit).toBe(20000);
    expect(d.report.rows.at(-1)!.cells).toMatchObject({ particulars: 'Total', debit: d.totalDebit, credit: d.totalCredit });
    const onlyExp = await t.call('books.dayBook', { from: '2026-09-01', to: '2026-09-30', voucherType: 'expense' });
    expect(onlyExp.voucherCount).toBe(4);
    expect(onlyExp.report.title).toBe('Day book - Expense');
    expect(d.byType.find((x) => x.type === 'expense')?.count).toBe(4);
  });
});

/* ------------------------------ Long periods, speed, and the rules found in review ------------------------------ */

/**
 * Many sales written straight into the ledger tables (thousands of postEntry calls would make the
 * test slow): Dr cash or UPI, Cr Sales, spread evenly over `days` days from `from`.
 */
function bulkSales(t: TestApp, opts: { count: number; from: string; days: number; cashShare?: number }): { cash: number; upi: number } {
  const cash = sysId(t, 'CASH');
  const upi = sysId(t, 'UPI');
  const sales = sysId(t, 'SALES');
  const share = opts.cashShare ?? 1;
  const sums = { cash: 0, upi: 0 };
  t.app.db.tx(() => {
    for (let i = 0; i < opts.count; i++) {
      const date = addDays(opts.from, Math.floor((i * opts.days) / opts.count));
      const amount = 1000 + (i % 7) * 100;
      const toCash = i % 100 < share * 100;
      const id = t.app.db.insert('journal_entries', { date, voucher_type: 'sale', voucher_no: `INV/${i + 1}`, narration: `Bill ${i + 1}`, created_at: `${date} 10:00:00` });
      t.app.db.run('INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit) VALUES (?, 1, ?, ?, 0), (?, 2, ?, 0, ?)', [id, toCash ? cash : upi, amount, id, sales, amount]);
      sums[toCash ? 'cash' : 'upi'] += amount;
    }
  });
  return sums;
}

const plain = <R extends { style?: string }>(rows: R[]) => rows.filter((r) => !r.style || r.style === 'normal');

describe('books over long periods', () => {
  it('computes opening, totals and closing over the whole period and shows the rows a page at a time', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const cash = sysId(t, 'CASH');
    const count = 5200; // more than the old 5,000-entry cut-off
    const sums = bulkSales(t, { count, from: '2026-04-01', days: 170 });
    await t.call('expenses.create', { date: '2026-09-25', accountId: acctId(t, 'Rent'), amount: 250000, mode: 'cash' });
    const range = { from: '2026-04-01', to: '2026-09-28' };

    const p1 = await t.call('books.cashBook', range);
    expect(p1.entryCount).toBe(count + 1);
    expect(p1).toMatchObject({ page: 1, pageCount: Math.ceil((count + 1) / BOOK_PAGE_SIZE), firstShown: 1, lastShown: BOOK_PAGE_SIZE });
    expect(p1.opening).toBe(1000000);
    expect(p1.totalIn).toBe(sums.cash);
    expect(p1.totalOut).toBe(250000);
    expect(p1.closing).toBe(bal(t, cash, '2026-09-28'));
    expect(p1.opening + p1.totalIn - p1.totalOut).toBe(p1.closing);
    expect(p1.report.summary?.at(-1)).toMatchObject({ label: 'Closing balance', value: p1.closing });
    expect(p1.report.notes?.[0]).toMatch(/^Showing entries 1–2,000 of 5,201 \(page 1 of 3\)\. Opening balance, totals and closing balance are for the whole period\./);
    expect(plain(p1.report.rows)).toHaveLength(BOOK_PAGE_SIZE);
    expect(p1.report.rows[0].cells).toMatchObject({ particulars: 'Opening balance', balance: 1000000 });
    const cf1 = p1.report.rows.at(-1)!;
    expect(cf1.cells.particulars).toBe('Carried forward to the next page');
    expect(p1.report.rows.some((r) => r.cells.particulars === 'Closing balance')).toBe(false);

    const p2 = await t.call('books.cashBook', { ...range, page: 2 });
    expect(p2).toMatchObject({ page: 2, firstShown: BOOK_PAGE_SIZE + 1, lastShown: 2 * BOOK_PAGE_SIZE, closing: p1.closing, totalIn: p1.totalIn });
    expect(p2.report.rows[0].cells).toMatchObject({ particulars: 'Brought forward from the previous page', in: cf1.cells.in, out: cf1.cells.out, balance: cf1.cells.balance });
    // The running balance continues across the page break.
    const firstOf2 = plain(p2.report.rows)[0].cells;
    expect(firstOf2.balance).toBe((cf1.cells.balance as number) + ((firstOf2.in as number) ?? 0) - ((firstOf2.out as number) ?? 0));

    const last = await t.call('books.cashBook', { ...range, page: 99 }); // past the end: the last page
    expect(last.page).toBe(3);
    expect(last.report.rows.at(-1)!.cells).toMatchObject({ date: '2026-09-28', particulars: 'Closing balance', in: sums.cash, out: 250000, balance: p1.closing });

    // Every row, for exports: one page, same figures, every entry.
    const all = await t.call('books.cashBook', { ...range, all: true });
    expect(all).toMatchObject({ page: 1, pageCount: 1, entryCount: count + 1, closing: p1.closing });
    expect(plain(all.report.rows)).toHaveLength(count + 1);
    expect(all.report.notes?.some((n) => /Showing entries/.test(n))).toBe(false);
    expect(plain(all.report.rows).at(-1)!.cells.balance).toBe(p1.closing);
    // Day totals are for the whole day, even for a day split between two pages.
    const subtotals = (rows: typeof all.report.rows) => rows.filter((r) => String(r.cells.particulars ?? '').startsWith('Total for')).map((r) => r.cells);
    expect([...subtotals(p1.report.rows), ...subtotals(p2.report.rows), ...subtotals(last.report.rows)]).toEqual(subtotals(all.report.rows));

    // Day book and ledger follow the same rule.
    const day = await t.call('books.dayBook', range);
    expect(day.voucherCount).toBe(count + 2); // + the opening-balance voucher
    expect(day.totalDebit).toBe(sums.cash + 250000 + 1000000);
    expect(day.pageCount).toBe(Math.ceil((count + 2) / DAY_BOOK_PAGE_SIZE));
    expect(day.report.rows.some((r) => r.cells.particulars === 'Total')).toBe(false);
    const dayLast = await t.call('books.dayBook', { ...range, page: day.pageCount });
    expect(dayLast.report.rows.at(-1)!.cells).toMatchObject({ particulars: 'Total', debit: day.totalDebit, credit: day.totalDebit });
    const sales = await t.call('books.ledger', { ...range, accountId: sysId(t, 'SALES') });
    expect(sales).toMatchObject({ entryCount: count, totalOut: sums.cash, closing: -sums.cash, pageCount: 3 });

    // The journal list pages through everything; the export asks for all of it.
    const j1 = await t.call('journals.list', range);
    expect(j1).toMatchObject({ total: count + 2, page: 1, pageCount: Math.ceil((count + 2) / 500), firstShown: 1, lastShown: 500, truncated: true });
    const j2 = await t.call('journals.list', { ...range, page: 2 });
    expect(j2.firstShown).toBe(501);
    expect(j2.rows[0].date <= j1.rows.at(-1)!.date).toBe(true);
    expect(new Set([...j1.rows, ...j2.rows].map((r) => r.id)).size).toBe(1000);
    const jAll = await t.call('journals.list', { ...range, all: true });
    expect(jAll.rows).toHaveLength(count + 2);
    expect(jAll.truncated).toBe(false);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  async function busyShop(oldIndexes: boolean) {
    const t = await createTestApp({ booksStart: '2025-04-01', openingCash: 1000000 });
    // Two years of a busy shop: 36,000 sales, 40% of them in cash.
    bulkSales(t, { count: 36000, from: '2025-04-01', days: 546, cashShare: 0.4 });
    if (oldIndexes) {
      // A data file created before the covering indexes were added.
      t.app.db.exec(`DROP INDEX idx_jl_account_entry; DROP INDEX idx_jl_party;
        CREATE INDEX idx_jl_account ON journal_lines (account_id); CREATE INDEX idx_jl_party ON journal_lines (party_type, party_id);`);
    }
    return t;
  }

  for (const oldIndexes of [false, true]) {
    it(`stays fast on two years of a busy shop${oldIndexes ? ' (data file from before the new indexes)' : ''}`, async () => {
      const t = await busyShop(oldIndexes);
      const cash = sysId(t, 'CASH');
      // The old query walked every line of the account once per entry of the period: 10-60 s on data like this,
      // with the whole app frozen meanwhile. Now each takes well under 200 ms; the limit is generous for slow machines.
      const LIMIT_MS = 1500;
      const checks: Array<[string, () => Promise<unknown>]> = [
        ['cash book, this month', () => t.call('books.cashBook', { from: '2026-09-01', to: '2026-09-28' })],
        ['cash book, this financial year', () => t.call('books.cashBook', { from: '2026-04-01', to: '2027-03-31' })],
        ['cash book, last financial year, page 3', () => t.call('books.cashBook', { from: '2025-04-01', to: '2026-03-31', page: 3 })],
        ['cash ledger, two years', () => t.call('books.ledger', { from: '2025-04-01', to: '2026-09-28', accountId: cash })],
        ['sales ledger, this financial year', () => t.call('books.ledger', { from: '2026-04-01', to: '2027-03-31', accountId: sysId(t, 'SALES') })],
        ['UPI book, this financial year', () => t.call('books.bankBook', { from: '2026-04-01', to: '2027-03-31', accountId: sysId(t, 'UPI') })],
        ['day book, this financial year', () => t.call('books.dayBook', { from: '2026-04-01', to: '2027-03-31' })],
        ['journal list filtered by cash, this financial year', () => t.call('journals.list', { from: '2026-04-01', to: '2027-03-31', accountId: cash })],
        ['cash book for export, this financial year', () => t.call('books.cashBook', { from: '2026-04-01', to: '2027-03-31', all: true })],
      ];
      for (const [label, fn] of checks) {
        const start = performance.now();
        await fn();
        const ms = performance.now() - start;
        expect(ms, `${label} took ${Math.round(ms)} ms`).toBeLessThan(LIMIT_MS);
      }
      const fy = await t.call('books.cashBook', { from: '2026-04-01', to: '2027-03-31' });
      expect(fy.closing).toBe(bal(t, cash));
      expect(fy.opening).toBe(bal(t, cash, '2026-03-31'));
      const month = await t.call('journals.list', { from: '2026-09-01', to: '2026-09-30', accountId: cash });
      expect(month.total).toBe(
        t.app.db.value<number>("SELECT COUNT(DISTINCT l.entry_id) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.date >= '2026-09-01'", [cash]),
      );
    }, 60000);
  }
});

describe('ledger opening balances', () => {
  it('starts income and expense ledgers at zero each financial year; balance-sheet ledgers carry forward', async () => {
    const t = await createTestApp({ booksStart: '2025-04-01', openingCash: 0 });
    const sale = (date: string, amount: number) =>
      postEntry(t.app.ctx(), { date, voucherType: 'sale', narration: `Sale ${date}`, lines: [{ account: 'CASH', debit: amount }, { account: 'SALES', credit: amount }] });
    sale('2026-03-20', 500000);
    sale('2026-04-15', 100000);
    const salesId = sysId(t, 'SALES');
    // FY 2025-26 is not closed, yet April's Sales ledger opens at zero, like the trial balance.
    const april = await t.call('books.ledger', { accountId: salesId, from: '2026-04-01', to: '2026-04-15' });
    expect(april).toMatchObject({ opening: 0, totalOut: 100000, closing: -100000 });
    expect(april.report.notes?.some((n) => /start every financial year at zero/.test(n))).toBe(true);
    const tb = await t.call('reports.trialBalance', { from: '2026-04-01', to: '2026-04-15' });
    expect(tb.rows.find((r) => r.cells.account === 'Sales' && r.link)!.cells).toMatchObject({ openingCr: null, closingCr: 100000 });
    // Mid-year, the year's own earlier entries count.
    expect((await t.call('books.ledger', { accountId: salesId, from: '2026-04-16', to: '2026-04-30' })).opening).toBe(-100000);
    // Across the year end, the new year restarts at zero.
    const both = await t.call('books.ledger', { accountId: salesId, from: '2025-04-01', to: '2026-04-15' });
    expect(both).toMatchObject({ opening: 0, totalOut: 600000, closing: -100000 });
    const restart = both.report.rows.findIndex((r) => String(r.cells.particulars ?? '').startsWith('Opening balance of financial year 2026-27'));
    expect(restart).toBeGreaterThan(0);
    expect(both.report.rows[restart - 1].cells.balance).toBe(-500000);
    expect(both.report.rows[restart].cells.balance).toBe(0);
    expect(both.report.rows.at(-1)!.cells).toMatchObject({ particulars: 'Closing balance', balance: -100000 });
    expect(both.report.notes?.some((n) => /closing balance is for 2026-27 only/.test(n))).toBe(true);
    // A new year without entries of its own still starts at zero.
    expect((await t.call('books.ledger', { accountId: salesId, from: '2026-03-01', to: '2026-04-10' })).closing).toBe(0);
    // Cash (an asset) carries its balance forward.
    expect(await t.call('books.ledger', { accountId: sysId(t, 'CASH'), from: '2026-04-01', to: '2026-04-15' })).toMatchObject({ opening: 500000, closing: 600000 });
  });

  it('counts opening-balance vouchers as the opening balance in the cash book, ledger, trial balance and cash flow', async () => {
    const t = await createTestApp({ openingCash: 1000000 }); // books start 01-04-2026
    postEntry(t.app.ctx(), { date: '2026-04-05', voucherType: 'sale', narration: 'Cash sale', lines: [{ account: 'CASH', debit: 50000 }, { account: 'SALES', credit: 50000 }] });
    const range = { from: '2026-04-01', to: '2026-09-28' };
    const cb = await t.call('books.cashBook', range);
    expect(cb).toMatchObject({ opening: 1000000, totalIn: 50000, totalOut: 0, closing: 1050000, entryCount: 1 });
    expect(cb.accounts[0]).toMatchObject({ opening: 1000000, closing: 1050000 });
    expect(plain(cb.report.rows).map((r) => r.cells.voucher)).toEqual(['Sales Bill']);
    const flow = await t.call('reports.cashFlow', range);
    expect(flow.figures.opening).toBe(cb.opening);
    const tb = await t.call('reports.trialBalance', range);
    const cell = (name: string) => tb.rows.find((r) => r.cells.account === name && r.link)!.cells;
    expect(cell('Cash in Hand')).toMatchObject({ openingDr: 1000000, debit: 50000, closingDr: 1050000 });
    expect(cell('Opening Balance Adjustment')).toMatchObject({ openingCr: 1000000, credit: null, closingCr: 1000000 });
    const eq = await t.call('books.ledger', { ...range, accountId: sysId(t, 'OPENING_EQUITY') });
    expect(eq).toMatchObject({ opening: -1000000, entryCount: 0, closing: -1000000 });
    // Later periods: the voucher is simply part of the history before "from".
    expect((await t.call('books.cashBook', { from: '2026-05-01', to: '2026-09-28' })).opening).toBe(1050000);
  });
});

describe('money going out of cash and bank', () => {
  it('warns (but saves) when an expense, drawings, loan or journal leaves cash or bank below zero', async () => {
    const t = await createTestApp({ openingCash: 1000000 }); // ₹10,000 in cash, nothing in the bank or UPI
    const cash = sysId(t, 'CASH');
    const rent = acctId(t, 'Rent');
    const x = await t.call('expenses.create', { accountId: rent, amount: 800000, mode: 'cash' });
    expect(x.warnings).toEqual([]);
    // An edit counts the new amount once (the old version is replaced, not added to it).
    const e1 = await t.call('expenses.update', { id: x.id, accountId: rent, amount: 900000, mode: 'cash' });
    expect(e1.warnings).toEqual([]);
    expect(bal(t, cash)).toBe(100000);
    const e2 = await t.call('expenses.update', { id: x.id, accountId: rent, amount: 1200000, mode: 'cash' });
    expect(e2.warnings).toEqual(['Cash in Hand will be short by ₹2,000.00 after this payment. Check that all money received has been entered.']);
    expect(e2.amount).toBe(1200000);
    expect(t.app.db.value('SELECT is_void FROM journal_entries WHERE id = ?', [e2.journalEntryId])).toBe(0);
    expect(bal(t, cash)).toBe(-200000);

    const upi = await t.call('expenses.create', { accountId: acctId(t, 'Electricity'), amount: 50000, mode: 'upi' });
    expect(upi.warnings[0]).toMatch(/^UPI Account will be short by ₹500.00/);
    expect((await t.call('expenses.create', { accountId: rent, amount: 50000, mode: 'credit', supplierId: addSupplier(t, 'Landlord') })).warnings).toEqual([]);

    const d = await t.call('accounts.drawings', { amount: 100000, mode: 'cash' });
    expect(d.warnings[0]).toMatch(/^Cash in Hand will be short by ₹3,000.00/);
    expect((await t.call('accounts.drawings', { amount: 100000, goods: true })).warnings).toEqual([]);
    expect((await t.call('accounts.capital', { amount: 100000, mode: 'bank' })).warnings).toEqual([]);

    const j = await t.call('journals.create', { narration: 'Tea', lines: [{ accountId: acctId(t, 'Tea & Refreshments'), debit: 1000 }, { accountId: cash, credit: 1000 }] });
    expect(j.warnings[0]).toMatch(/^Cash in Hand will be short by ₹3,010.00/);

    const loan = await t.call('loans.create', { name: 'Mama ji', direction: 'taken', principal: 500000, startDate: '2026-09-01', disburse: { mode: 'bank', amount: 500000 } });
    expect(loan.warnings).toEqual([]);
    const repay = await t.call('loans.transaction', { loanId: loan.id, kind: 'repay', principal: 500000, interest: 110000, mode: 'bank' });
    expect(repay.warnings[0]).toMatch(/^Bank Account will be short by ₹100.00/);
    const given = await t.call('loans.create', { name: 'Ramesh', direction: 'given', principal: 20000, startDate: '2026-09-01', disburse: { mode: 'cash', amount: 20000 } });
    expect(given.warnings[0]).toMatch(/^Cash in Hand will be short by ₹3,210.00/);
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('closed loans and inactive accounts', () => {
  it('refuses to cancel or change an entry of a closed loan until it is re-opened', async () => {
    const t = await createTestApp();
    const loan = await t.call('loans.create', { name: 'HDFC', direction: 'taken', principal: 1000000, startDate: '2026-09-01', disburse: { mode: 'bank', amount: 1000000 } });
    const repay = await t.call('loans.transaction', { loanId: loan.id, kind: 'repay', principal: 1000000, interest: 0, mode: 'bank' });
    await t.call('loans.update', { id: loan.id, name: 'HDFC', isActive: false });
    // The voucher and the loan page say so up front.
    expect(await t.call('journals.get', { entryId: repay.entry.id })).toMatchObject({
      canEdit: false,
      lockedReason: 'The loan "HDFC" is closed. Re-open it from Accounts > Loans to change this entry.',
    });
    expect((await t.call('loans.get', { id: loan.id })).transactions.every((x) => !x.editable)).toBe(true);
    const err = await t.fails('journals.cancel', { entryId: repay.entry.id, reason: 'Entered twice' });
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('The loan "HDFC" is closed. Re-open it from Accounts > Loans before cancelling this entry.');
    const half = repay.entry.lines.map((l) => ({ accountId: l.accountId, debit: l.debit / 2, credit: l.credit / 2 }));
    expect((await t.fails('journals.update', { entryId: repay.entry.id, narration: 'Half', lines: half })).message).toMatch(/closed\. Re-open it .* before changing this entry/);
    expect((await t.call('loans.get', { id: loan.id })).outstanding).toBe(0);
    await t.call('loans.update', { id: loan.id, name: 'HDFC', isActive: true });
    await t.call('journals.cancel', { entryId: repay.entry.id, reason: 'Entered twice' });
    expect((await t.call('loans.get', { id: loan.id })).outstanding).toBe(1000000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('refuses a cancel that would give an inactive cash or bank account a balance', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const cash = sysId(t, 'CASH');
    const petty = await t.call('accounts.create', { name: 'Petty Cash', groupCode: 'cash' });
    const out = await t.call('accounts.transfer', { fromAccountId: cash, toAccountId: petty.id, amount: 50000 });
    const spent = await t.call('expenses.create', { accountId: acctId(t, 'Tea & Refreshments'), amount: 50000, mode: 'cash', payAccountId: petty.id });
    await t.call('accounts.setActive', { id: petty.id, active: false });
    const e1 = await t.fails('journals.cancel', { entryId: out.entry.id, reason: 'Wrong' });
    expect(e1.message).toBe('"Petty Cash" is inactive — activate it first in Accounts > Chart of accounts. Cancelling this entry would give it a balance of ₹500.00 Cr.');
    expect((await t.fails('expenses.cancel', { id: spent.id, reason: 'Wrong' })).message).toMatch(/"Petty Cash" is inactive/);
    expect(bal(t, petty.id)).toBe(0);
    // Inactive income / expense heads may keep a balance, so their entries can still be cancelled.
    await t.call('accounts.setActive', { id: acctId(t, 'Tea & Refreshments'), active: false });
    await t.call('accounts.setActive', { id: petty.id, active: true });
    await t.call('expenses.cancel', { id: spent.id, reason: 'Wrong' });
    await t.call('journals.cancel', { entryId: out.entry.id, reason: 'Wrong' });
    expect(bal(t, petty.id)).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('lets an income or expense head be deactivated with a balance, but not a balance-sheet account', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const rent = acctId(t, 'Rent');
    await t.call('expenses.create', { accountId: rent, amount: 900000, mode: 'cash' });
    const hdfc = await t.call('accounts.create', { name: 'HDFC Current', groupCode: 'bank' });
    await t.call('accounts.transfer', { fromAccountId: sysId(t, 'CASH'), toAccountId: hdfc.id, amount: 10000 });
    expect((await t.call('accounts.get', { id: rent })).canDeactivate).toBe(true);
    expect(await t.call('accounts.setActive', { id: rent, active: false })).toMatchObject({ isActive: false, balance: 900000 });
    expect((await t.fails('expenses.create', { accountId: rent, amount: 100, mode: 'cash' })).message).toMatch(/"Rent" is inactive/);
    // It still shows in the chart with its balance, so the totals agree.
    const chart = await t.call('accounts.chart', {});
    const rentRow = chart.types.flatMap((x) => x.groups).flatMap((g) => g.accounts).find((a) => a.id === rent);
    expect(rentRow).toMatchObject({ isActive: false, balance: 900000 });
    expect(chart.totalDebit).toBe(chart.totalCredit);
    expect((await t.fails('accounts.setActive', { id: hdfc.id, active: false })).message).toMatch(/balance of ₹100.00 Dr/);
  });
});

describe('an inactive account never gains a balance', () => {
  it('refuses to cancel a bill, payment, purchase, advance, return or salary paid through an inactive cash or bank account', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const cash = sysId(t, 'CASH');
    const hdfc = await t.call('accounts.create', { name: 'HDFC Current', groupCode: 'bank' });
    const petty = await t.call('accounts.create', { name: 'Petty Cash', groupCode: 'cash' });
    // Money into and out of HDFC: +500 bill, +300 payment received, -200 purchase, -100 supplier payment.
    const bill = await t.call('sales.create', { items: [{ itemName: 'Rice', qty: 1, rate: 50000 }], payments: [{ mode: 'bank', amount: 50000, accountId: hdfc.id }] });
    const cust = await t.call('customers.create', { name: 'Ravi', openingBalance: { amount: 30000, direction: 'receivable' } } as any);
    const receipt = await t.call('receipts.create', { customerId: cust.id, amount: 30000, mode: 'bank', accountId: hdfc.id } as any);
    const sup = await t.call('suppliers.create', { name: 'Gupta Traders' } as any);
    const purchase = await t.call('purchases.create', { supplierId: sup.id, items: [{ description: 'Stock', qty: 1, rate: 20000 }], payments: [{ mode: 'bank', amount: 20000, accountId: hdfc.id }] } as any);
    const supPay = await t.call('supplierPayments.create', { supplierId: sup.id, amount: 10000, mode: 'bank', accountId: hdfc.id } as any);
    await t.call('accounts.transfer', { fromAccountId: hdfc.id, toAccountId: cash, amount: 50000 });
    // Petty cash: +1,000 in, -300 advance, -200 salary, -100 refund.
    await t.call('accounts.transfer', { fromAccountId: cash, toAccountId: petty.id, amount: 100000 });
    const emp = await t.call('employees.create', { name: 'Raju', salaryType: 'monthly', salaryAmount: 1500000, joinDate: '2026-04-01' } as any);
    const advance = await t.call('advances.create', { employeeId: emp.id, amount: 30000, mode: 'cash', accountId: petty.id } as any);
    const slip = await t.call('salary.process', { employeeId: emp.id, month: '2026-08', advanceRecovery: 0 });
    const paid = await t.call('salary.pay', { salaryId: slip.id, amount: 20000, mode: 'cash', accountId: petty.id });
    const sold = await t.call('sales.create', { items: [{ itemName: 'Soap', qty: 1, rate: 10000 }], payments: [{ mode: 'cash', amount: 10000 }] });
    const ret = await t.call('returns.create', { kind: 'return', billId: sold.id, items: [{ billItemId: sold.items[0].id, qty: 1 }], refundMode: 'cash', refundAccountId: petty.id });
    await t.call('accounts.transfer', { fromAccountId: petty.id, toAccountId: cash, amount: 40000 });
    expect([bal(t, hdfc.id), bal(t, petty.id)]).toEqual([0, 0]);
    await t.call('accounts.setActive', { id: hdfc.id, active: false });
    await t.call('accounts.setActive', { id: petty.id, active: false });

    const refused = async (route: string, input: unknown) => (await t.fails(route, input)).message;
    expect(await refused('sales.cancel', { id: bill.id, reason: 'Wrong' })).toBe(
      '"HDFC Current" is inactive — activate it first in Accounts > Chart of accounts. Cancelling this bill would give it a balance of ₹500.00 Cr.',
    );
    expect(await refused('receipts.cancel', { id: receipt.id, reason: 'Bounced' })).toMatch(/^"HDFC Current" is inactive — activate it first.*Cancelling this payment would give it a balance of ₹300.00 Cr/);
    expect(await refused('purchases.cancel', { id: purchase.id, reason: 'Wrong' })).toMatch(/^"HDFC Current" is inactive.*Cancelling this purchase would give it a balance of ₹200.00 Dr/);
    expect(await refused('supplierPayments.cancel', { id: supPay.id, reason: 'Wrong' })).toMatch(/^"HDFC Current" is inactive.*Cancelling this payment/);
    expect(await refused('advances.cancel', { id: advance.id, reason: 'Wrong' })).toBe(
      '"Petty Cash" is inactive — activate it first in Accounts > Chart of accounts. Cancelling this advance would give it a balance of ₹300.00 Dr.',
    );
    expect(await refused('salary.cancelPayment', { paymentId: paid.payments[0].id, reason: 'Wrong' })).toMatch(/^"Petty Cash" is inactive.*Cancelling this payment/);
    expect(await refused('salary.cancel', { salaryId: slip.id, reason: 'Wrong' })).toMatch(/^"Petty Cash" is inactive.*Cancelling this salary slip/);
    expect(await refused('returns.cancel', { id: ret.id, reason: 'Wrong' })).toMatch(/^"Petty Cash" is inactive.*Cancelling this return would give it a balance of ₹100.00 Dr/);
    // Nothing changed.
    expect([bal(t, hdfc.id), bal(t, petty.id)]).toEqual([0, 0]);
    expect((await t.call('sales.get', { id: bill.id })).status).toBe('active');

    // Once re-activated, the documents can be cancelled (the account then shows the balance in its book).
    await t.call('accounts.setActive', { id: petty.id, active: true });
    await t.call('advances.cancel', { id: advance.id, reason: 'Wrong' });
    expect(bal(t, petty.id)).toBe(30000);
    // A document that does not touch the inactive account is not affected.
    const cashBill = await t.call('sales.create', { items: [{ itemName: 'Tea', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    await t.call('sales.cancel', { id: cashBill.id, reason: 'Test' });
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('refuses to change the opening balance of an inactive account', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const old = await t.call('accounts.create', { name: 'Old Current A/c', groupCode: 'bank' });
    await t.call('accounts.setActive', { id: old.id, active: false });
    const err = await t.fails('accounts.update', { id: old.id, name: 'Old Current A/c', openingBalance: { amount: 500000, side: 'debit' } });
    expect(err.message).toBe('"Old Current A/c" is inactive — activate it first to change its opening balance.');
    expect(err.fields).toMatchObject({ openingBalance: expect.stringMatching(/inactive/) });
    expect(bal(t, old.id)).toBe(0);
    // Renaming (the opening balance unchanged) is still fine.
    expect(await t.call('accounts.update', { id: old.id, name: 'Old SBI A/c' })).toMatchObject({ name: 'Old SBI A/c', isActive: false, balance: 0, openingBalance: 0 });
    // Re-activated, the opening balance can be entered.
    await t.call('accounts.setActive', { id: old.id, active: true });
    expect(await t.call('accounts.update', { id: old.id, name: 'Old SBI A/c', openingBalance: { amount: 500000, side: 'debit' } })).toMatchObject({ openingBalance: 500000, balance: 500000 });
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('lets an old expense or journal on a head deactivated since be edited, but not a new line on an inactive account', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const diesel = await t.call('accounts.create', { name: 'Generator diesel', groupCode: 'indirect_expenses' });
    const x = await t.call('expenses.create', { date: '2026-08-10', accountId: diesel.id, amount: 500000, mode: 'cash' });
    const jv = await t.call('journals.create', {
      date: '2026-08-12',
      narration: 'Diesel bought by owner',
      lines: [
        { accountId: diesel.id, debit: 100000 },
        { accountId: sysId(t, 'CAPITAL'), credit: 100000 },
      ],
    });
    await t.call('accounts.setActive', { id: diesel.id, active: false });
    // Same head: the amount can be corrected.
    expect(await t.call('expenses.update', { id: x.id, date: '2026-08-10', accountId: diesel.id, amount: 450000, mode: 'cash' })).toMatchObject({ amount: 450000, accountId: diesel.id });
    const edited = await t.call('journals.update', {
      entryId: jv.id,
      narration: 'Diesel bought by owner',
      lines: [
        { accountId: diesel.id, debit: 90000 },
        { accountId: sysId(t, 'CAPITAL'), credit: 90000 },
      ],
    });
    expect(edited.totalDebit).toBe(90000);
    // A new expense, or moving another expense or a new journal line onto the inactive head, is refused.
    expect((await t.fails('expenses.create', { accountId: diesel.id, amount: 100, mode: 'cash' })).message).toMatch(/"Generator diesel" is inactive/);
    const rentX = await t.call('expenses.create', { accountId: acctId(t, 'Rent'), amount: 1000, mode: 'cash' });
    expect((await t.fails('expenses.update', { id: rentX.id, accountId: diesel.id, amount: 1000, mode: 'cash' })).message).toMatch(/"Generator diesel" is inactive/);
    const rentJv = await t.call('journals.create', { narration: 'Rent by owner', lines: [{ accountId: acctId(t, 'Rent'), debit: 1000 }, { accountId: sysId(t, 'CAPITAL'), credit: 1000 }] });
    const moved = await t.fails('journals.update', { entryId: rentJv.id, narration: 'Rent by owner', lines: [{ accountId: diesel.id, debit: 1000 }, { accountId: sysId(t, 'CAPITAL'), credit: 1000 }] });
    expect(moved.message).toMatch(/"Generator diesel" is inactive/);
    expect(bal(t, diesel.id)).toBe(450000 + 90000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('lets an expense paid from a cash account deactivated since be edited while that account stays at zero', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const petty = await t.call('accounts.create', { name: 'Petty Cash', groupCode: 'cash' });
    await t.call('accounts.transfer', { fromAccountId: sysId(t, 'CASH'), toAccountId: petty.id, amount: 50000 });
    const x = await t.call('expenses.create', { accountId: acctId(t, 'Tea & Refreshments'), amount: 50000, mode: 'cash', payAccountId: petty.id });
    await t.call('accounts.setActive', { id: petty.id, active: false });
    const same = { id: x.id, accountId: acctId(t, 'Tea & Refreshments'), amount: 50000, mode: 'cash' as const, payAccountId: petty.id };
    expect(await t.call('expenses.update', { ...same, remarks: 'Tea for the week' })).toMatchObject({ remarks: 'Tea for the week', payAccountId: petty.id });
    expect((await t.fails('expenses.update', { ...same, amount: 40000 })).message).toMatch(/^"Petty Cash" is inactive — activate it first.*Changing this entry would give it a balance of ₹100.00 Dr/);
    expect(bal(t, petty.id)).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('chart of accounts balances by financial year', () => {
  it('shows income and expense accounts for this financial year, like the trial balance and their ledger', async () => {
    const t = await createTestApp({ booksStart: '2025-04-01', openingCash: 1000000 });
    const ctx = t.app.ctx();
    postEntry(ctx, { date: '2026-03-10', voucherType: 'sale', narration: 'Last year', lines: [{ account: 'CASH', debit: 500000 }, { account: 'SALES', credit: 500000 }] });
    postEntry(ctx, { date: '2026-03-15', voucherType: 'journal', narration: 'Last year rent', lines: [{ account: acctId(t, 'Rent'), debit: 100000 }, { account: 'CASH', credit: 100000 }] });
    postEntry(ctx, { date: '2026-09-10', voucherType: 'sale', narration: 'This year', lines: [{ account: 'CASH', debit: 200000 }, { account: 'SALES', credit: 200000 }] });
    const salesId = sysId(t, 'SALES');
    const chart = await t.call('accounts.chart', {});
    const row = (id: number) => chart.types.flatMap((x) => x.groups).flatMap((g) => g.accounts).find((a) => a.id === id);
    expect(row(salesId)?.balance).toBe(-200000);
    expect(row(acctId(t, 'Rent'))?.balance ?? 0).toBe(0);
    expect(chart.financialYear).toEqual({ start: '2026-04-01', name: '2026-27' });
    // Last year's profit (not closed yet) is one line under capital, so the totals still agree.
    expect(chart.previousYears).toBe(-400000);
    expect(chart.types.find((x) => x.type === 'equity')!.balance).toBe(-1000000 - 400000);
    expect(chart.totalDebit).toBe(chart.totalCredit);
    expect(chart.totalDebit).toBe(1000000 + 500000 - 100000 + 200000);
    // The ledger the row opens and the account page agree with it.
    const ledger = await t.call('books.ledger', { accountId: salesId, from: '2026-04-01', to: '2026-09-28' });
    expect(ledger.closing).toBe(row(salesId)!.balance);
    expect(await t.call('accounts.get', { id: salesId })).toMatchObject({ balance: -200000, balanceFrom: '2026-04-01' });
    expect(await t.call('accounts.get', { id: sysId(t, 'CASH') })).toMatchObject({ balance: 1000000 + 500000 - 100000 + 200000, balanceFrom: null });
    const tb = await t.call('reports.trialBalance', { to: '2026-09-28' });
    expect(tb.rows.find((r) => r.cells.account === 'Sales' && r.link)?.cells.closingCr).toBe(200000);
    // accounts.list with balances follows the same rule.
    const list = await t.call('accounts.list', { types: ['income'], withBalances: true });
    expect(list.find((a) => a.id === salesId)?.balance).toBe(-200000);

    // Once last year is closed, its result is in capital and the previous-years line goes away.
    await t.call('yearEnd.close', { fyStart: '2025-04-01', transferDrawings: true });
    const after = await t.call('accounts.chart', {});
    expect(after.previousYears).toBe(0);
    expect(after.totalDebit).toBe(after.totalCredit);
    expect(after.types.find((x) => x.type === 'equity')!.balance).toBe(-1000000 - 400000);
    // As on the last day of the closed year: that year's figures, without its closing entry counted twice.
    const march = await t.call('accounts.chart', { asOf: '2026-03-31' });
    const mRow = (id: number) => march.types.flatMap((x) => x.groups).flatMap((g) => g.accounts).find((a) => a.id === id);
    expect(mRow(salesId)?.balance).toBe(-500000);
    expect(march.previousYears).toBe(0);
    expect(march.totalDebit).toBe(march.totalCredit);
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('checking a payment before it is saved', () => {
  it('gives the balance on the date and the warning the payment would get, leaving out the version being edited', async () => {
    const t = await createTestApp({ openingCash: 800000 });
    const check = await t.call('accounts.paymentCheck', { mode: 'cash', amount: 1230645, date: '2026-09-28' });
    expect(check).toMatchObject({ accountId: sysId(t, 'CASH'), accountName: 'Cash in Hand', date: '2026-09-28', balance: 800000 });
    expect(check.warning).toBe('Cash in Hand will be short by ₹4,306.45 after this payment. Check that all money received has been entered.');
    expect((await t.call('accounts.paymentCheck', { mode: 'cash', amount: 500000 })).warning).toBeNull();
    // Editing an expense of ₹5,000: its own ₹5,000 is not counted twice.
    const x = await t.call('expenses.create', { accountId: acctId(t, 'Rent'), amount: 500000, mode: 'cash' });
    expect((await t.call('accounts.paymentCheck', { mode: 'cash', amount: 700000 })).warning).toMatch(/short by ₹4,000.00/);
    const edit = await t.call('accounts.paymentCheck', { mode: 'cash', amount: 700000, entryId: x.journalEntryId });
    expect(edit).toMatchObject({ balance: 800000, warning: null });
    // Without "View books" the balance is hidden but the warning (the same text shown after saving) is given.
    t.app.db.run("DELETE FROM role_permissions WHERE role = 'manager' AND permission = 'accounts.view'");
    await t.loginAs('manager');
    const m = await t.call('accounts.paymentCheck', { mode: 'cash', amount: 400000 });
    expect(m).toMatchObject({ balance: null, warning: expect.stringMatching(/short by ₹1,000.00/) });
    await t.loginAs('cashier');
    expect((await t.fails('accounts.paymentCheck', { mode: 'cash', amount: 100 })).code).toBe('FORBIDDEN');
  });

  it('warns when a backdated payment takes a day in between below zero', async () => {
    const t = await createTestApp({ openingCash: 10000 }); // ₹100 on 01-04
    const rent = acctId(t, 'Rent');
    await t.call('expenses.create', { date: '2026-09-10', accountId: rent, amount: 9000, mode: 'cash' }); // ₹10 left from 10-09
    postEntry(t.app.ctx(), { date: '2026-09-20', voucherType: 'sale', narration: 'Sale', lines: [{ account: 'CASH', debit: 100000 }, { account: 'SALES', credit: 100000 }] });
    // ₹50 on 05-09: enough on 05-09 (₹100) and today (₹960), but 10-09 to 19-09 would be -₹40.
    const x = await t.call('expenses.create', { date: '2026-09-05', accountId: rent, amount: 5000, mode: 'cash' });
    expect(x.warnings).toEqual(['Cash in Hand will be short by ₹40.00 on 10-09-2026 after this payment. Check that all money received has been entered.']);
    // Short on its own date: the usual message.
    const y = await t.call('expenses.create', { date: '2026-09-06', accountId: rent, amount: 10000, mode: 'cash' });
    expect(y.warnings).toEqual(['Cash in Hand will be short by ₹50.00 after this payment. Check that all money received has been entered.']);
    const ok = await t.call('expenses.create', { date: '2026-09-25', accountId: rent, amount: 1000, mode: 'cash' });
    expect(ok.warnings).toEqual([]);
  });
});
