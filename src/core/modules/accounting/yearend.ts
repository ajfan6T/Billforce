/**
 * Year-end closing. Closing a financial year posts one entry dated the last
 * day of the year (voucher 'closing', source 'closing') that
 *   - reverses the year's balance of every income and expense account
 *     (closing entries excluded), moving the net profit / loss to CAPITAL, and
 *   - with stock tracking, sets "Stock in Hand" to the closing stock (average cost) and adds the change
 *     in stock to the profit moved to CAPITAL (cost of goods sold = opening + purchases - closing),
 *   - optionally moves the balance of the drawings accounts into CAPITAL,
 * and then locks the year: the ledger engine refuses any change dated in it.
 * A safety backup is always taken first. The latest closed year can be
 * re-opened, which voids the closing entry.
 */
import type { Ctx } from '../../context';
import { currentUserId, now, today } from '../../context';
import { AppError, fail } from '../../errors';
import { logActivity } from '../../audit';
import { getSection } from '../../settings';
import { postEntry, systemAccountId, voidEntry } from '../../accounting/ledger';
import { ensureFinancialYear, type FinancialYearRow } from '../../accounting/periods';
import { addDays, formatDate, fyOf, type FinancialYear } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import { createBackup, type BackupInfo } from '../data/backup';
import { userName } from './common';
import { closingStock, yearStock } from '../stock/accounting';

export interface YearInfo {
  name: string;
  start: string;
  end: string;
  status: 'closed' | 'open' | 'current';
  isClosed: boolean;
  income: number;
  expenses: number;
  /** Income - expenses of the year (closing entries excluded), plus the change in stock with stock tracking. Negative = loss. */
  netProfit: number;
  /** Stock tracking: closing stock of the year at average cost (null without stock tracking). */
  closingStock: number | null;
  drawings: number;
  entryCount: number;
  canClose: boolean;
  closeBlockedReason: string | null;
  canReopen: boolean;
  reopenBlockedReason: string | null;
  closedBy: string | null;
  closedAt: string | null;
  closingEntryId: number | null;
}

function fyRow(ctx: Ctx, start: string): FinancialYearRow | undefined {
  return ctx.db.get<FinancialYearRow>('SELECT * FROM financial_years WHERE start_date = ?', [start]);
}

function yearFigures(ctx: Ctx, fy: FinancialYear) {
  const r = ctx.db.get<{ income: number; expenses: number; drawings: number }>(
    `SELECT COALESCE(SUM(CASE WHEN g.type = 'income' THEN l.credit - l.debit END), 0) AS income,
            COALESCE(SUM(CASE WHEN g.type = 'expense' THEN l.debit - l.credit END), 0) AS expenses,
            COALESCE(SUM(CASE WHEN a.group_code = 'drawings' THEN l.debit - l.credit END), 0) AS drawings
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id JOIN account_groups g ON g.code = a.group_code
      WHERE e.is_void = 0 AND e.voucher_type <> 'closing' AND e.date >= ? AND e.date <= ?`,
    [fy.start, fy.end],
  )!;
  const entryCount = ctx.db.value<number>(
    "SELECT COUNT(*) FROM journal_entries WHERE is_void = 0 AND voucher_type <> 'closing' AND date >= ? AND date <= ?",
    [fy.start, fy.end],
    0,
  );
  return { ...r, netProfit: r.income - r.expenses, entryCount };
}

/** Every financial year from the books start to today (latest first). */
export function listYears(ctx: Ctx): YearInfo[] {
  const booksStart = getSection(ctx, 'accounts').booksStartDate;
  const t = today(ctx);
  const starts = new Set<string>();
  for (let fy = fyOf(booksStart); fy.start <= fyOf(t).start; fy = fyOf(addDays(fy.end, 1))) starts.add(fy.start);
  for (const r of ctx.db.all<{ start_date: string }>('SELECT start_date FROM financial_years')) {
    if (r.start_date >= fyOf(booksStart).start) starts.add(r.start_date);
  }
  const ordered = [...starts].sort();
  const rows = new Map(ordered.map((s) => [s, fyRow(ctx, s)]));
  const latestClosed = ordered.filter((s) => rows.get(s)?.is_closed).pop() ?? null;
  const figures = new Map(ordered.map((s) => [s, yearFigures(ctx, fyOf(s))]));
  const stock = new Map(ordered.map((s) => [s, yearStock(ctx, fyOf(s), rows.get(s)?.is_closed ? (rows.get(s)?.closing_entry_id ?? null) : null)]));
  const out: YearInfo[] = ordered.map((s, i) => {
    const fy = fyOf(s);
    const row = rows.get(s);
    const f = figures.get(s)!;
    const closed = !!row?.is_closed;
    let closeBlocked: string | null = null;
    if (closed) closeBlocked = 'This year is already closed.';
    else if (fy.end >= t) closeBlocked = `The year ends on ${formatDate(fy.end)}. It can be closed after that date.`;
    else {
      const pending = ordered.slice(0, i).find((p) => !rows.get(p)?.is_closed && figures.get(p)!.entryCount > 0);
      if (pending) closeBlocked = `Close ${fyOf(pending).name} first: years are closed in order.`;
    }
    let reopenBlocked: string | null = null;
    if (!closed) reopenBlocked = 'This year is open.';
    else if (s !== latestClosed) reopenBlocked = `Re-open ${fyOf(latestClosed!).name} first: only the latest closed year can be re-opened.`;
    return {
      name: fy.name,
      start: fy.start,
      end: fy.end,
      status: closed ? 'closed' : t >= fy.start && t <= fy.end ? 'current' : 'open',
      isClosed: closed,
      income: f.income,
      expenses: f.expenses,
      netProfit: f.netProfit + (stock.get(s)?.change ?? 0),
      closingStock: stock.get(s)?.value ?? null,
      drawings: f.drawings,
      entryCount: f.entryCount,
      canClose: !closeBlocked,
      closeBlockedReason: closeBlocked,
      canReopen: !reopenBlocked,
      reopenBlockedReason: reopenBlocked,
      closedBy: userName(ctx, row?.closed_by),
      closedAt: row?.closed_at ?? null,
      closingEntryId: row?.closing_entry_id ?? null,
    };
  });
  return out.reverse();
}

function yearInfo(ctx: Ctx, fyStart: string): YearInfo {
  const y = listYears(ctx).find((x) => x.start === fyStart);
  if (!y) throw fail.validation('Choose a financial year between your books start and today');
  return y;
}

export interface ClosingLine {
  accountId: number;
  accountName: string;
  groupName: string;
  debit: number;
  credit: number;
  memo: string | null;
}

export interface ClosingPreview {
  year: YearInfo;
  lines: ClosingLine[];
  totalDebit: number;
  totalCredit: number;
  netProfit: number;
  /** Drawings balance that will be moved into capital (0 when not transferring). */
  drawingsTransferred: number;
  /** Drawings balance available to transfer. */
  drawingsBalance: number;
  /** Stock tracking: closing stock and its change from the opening stock (part of netProfit). */
  stock: { value: number; change: number } | null;
  capitalAccountName: string;
  entryDate: string;
}

function closingLines(ctx: Ctx, fy: FinancialYear, transferDrawings: boolean): Omit<ClosingPreview, 'year'> {
  const balances = ctx.db.all<{ account_id: number; name: string; group_name: string; type: string; bal: number }>(
    `SELECT l.account_id, a.name, g.name AS group_name, g.type, SUM(l.debit - l.credit) AS bal
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id JOIN account_groups g ON g.code = a.group_code
      WHERE e.is_void = 0 AND e.voucher_type <> 'closing' AND e.date >= ? AND e.date <= ? AND g.type IN ('income', 'expense')
      GROUP BY l.account_id HAVING bal <> 0
      ORDER BY g.sort_order DESC, a.code, a.name COLLATE NOCASE`,
    [fy.start, fy.end],
  );
  const capitalId = systemAccountId(ctx, 'CAPITAL');
  const capitalName = ctx.db.value<string>('SELECT name FROM accounts WHERE id = ?', [capitalId], "Owner's Capital");
  const lines: ClosingLine[] = [];
  // Income accounts first (debited), then expenses (credited).
  const ordered = [...balances.filter((b) => b.type === 'income'), ...balances.filter((b) => b.type === 'expense')];
  for (const b of ordered) {
    lines.push({
      accountId: b.account_id,
      accountName: b.name,
      groupName: b.group_name,
      debit: b.bal < 0 ? -b.bal : 0,
      credit: b.bal > 0 ? b.bal : 0,
      memo: b.type === 'income' ? 'Income for the year closed' : 'Expense for the year closed',
    });
  }
  // Stock tracking: Stock in Hand goes to the closing stock; the change is part of the year's result.
  const stock = closingStock(ctx, fy);
  if (stock && stock.change !== 0) {
    lines.push({
      accountId: stock.accountId,
      accountName: ctx.db.value<string>('SELECT name FROM accounts WHERE id = ?', [stock.accountId], 'Stock in Hand'),
      groupName: 'Other Current Assets',
      debit: stock.change > 0 ? stock.change : 0,
      credit: stock.change < 0 ? -stock.change : 0,
      memo: `Closing stock ${formatINR(stock.value)} at average cost`,
    });
  }
  const netProfit = 0 - balances.reduce((s, b) => s + b.bal, 0) + (stock?.change ?? 0);
  if (netProfit !== 0) {
    lines.push({
      accountId: capitalId,
      accountName: capitalName,
      groupName: 'Capital Account',
      debit: netProfit < 0 ? -netProfit : 0,
      credit: netProfit > 0 ? netProfit : 0,
      memo: netProfit > 0 ? `Net profit for ${fy.name}` : `Net loss for ${fy.name}`,
    });
  }
  const drawings = ctx.db.all<{ account_id: number; name: string; bal: number }>(
    `SELECT l.account_id, a.name, SUM(l.debit - l.credit) AS bal FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE e.is_void = 0 AND e.date <= ? AND a.group_code = 'drawings' GROUP BY l.account_id HAVING bal <> 0`,
    [fy.end],
  );
  const drawingsBalance = drawings.reduce((s, d) => s + d.bal, 0);
  let drawingsTransferred = 0;
  if (transferDrawings && drawingsBalance !== 0) {
    for (const d of drawings) {
      lines.push({
        accountId: d.account_id,
        accountName: d.name,
        groupName: 'Drawings',
        debit: d.bal < 0 ? -d.bal : 0,
        credit: d.bal > 0 ? d.bal : 0,
        memo: 'Drawings moved to capital',
      });
    }
    lines.push({
      accountId: capitalId,
      accountName: capitalName,
      groupName: 'Capital Account',
      debit: drawingsBalance > 0 ? drawingsBalance : 0,
      credit: drawingsBalance < 0 ? -drawingsBalance : 0,
      memo: `Drawings up to ${formatDate(fy.end)}`,
    });
    drawingsTransferred = drawingsBalance;
  }
  return {
    lines,
    totalDebit: lines.reduce((s, l) => s + l.debit, 0),
    totalCredit: lines.reduce((s, l) => s + l.credit, 0),
    netProfit,
    drawingsTransferred,
    drawingsBalance,
    stock: stock ? { value: stock.value, change: stock.change } : null,
    capitalAccountName: capitalName,
    entryDate: fy.end,
  };
}

export function previewClosing(ctx: Ctx, fyStart: string, transferDrawings: boolean): ClosingPreview {
  const year = yearInfo(ctx, fyStart);
  return { year, ...closingLines(ctx, fyOf(fyStart), transferDrawings) };
}

export interface CloseResult {
  year: YearInfo;
  closingEntryId: number | null;
  backup: BackupInfo;
}

function safetyBackup(ctx: Ctx, note: string, what: string): BackupInfo {
  try {
    return createBackup(ctx, 'safety', { note });
  } catch (e) {
    throw new AppError('VALIDATION', `Could not take a safety backup, so the year was not ${what}. ${(e as Error).message}`);
  }
}

/** Close a financial year. Must be called OUTSIDE a transaction (it takes a backup first). */
export function closeYear(ctx: Ctx, fyStart: string, transferDrawings: boolean): CloseResult {
  const fy = fyOf(fyStart);
  const before = yearInfo(ctx, fy.start);
  if (!before.canClose) throw fail.validation(before.closeBlockedReason ?? 'This year cannot be closed');
  const backup = safetyBackup(ctx, `Before closing financial year ${fy.name}`, 'closed');
  return ctx.db.tx(() => {
    const check = yearInfo(ctx, fy.start);
    if (!check.canClose) throw fail.validation(check.closeBlockedReason ?? 'This year cannot be closed');
    const plan = closingLines(ctx, fy, transferDrawings);
    const row = ensureFinancialYear(ctx, fy.start);
    let entryId: number | null = null;
    if (plan.lines.length) {
      entryId = postEntry(ctx, {
        date: fy.end,
        voucherType: 'closing',
        voucherNo: `YE/${fy.short}`,
        sourceType: 'closing',
        sourceId: row.id,
        narration:
          `Year-end closing ${fy.name}: ${plan.netProfit >= 0 ? 'net profit' : 'net loss'} ${formatINR(Math.abs(plan.netProfit))} transferred to ${plan.capitalAccountName}` +
          (plan.drawingsTransferred ? `; drawings ${formatINR(plan.drawingsTransferred)} transferred` : ''),
        lines: plan.lines.map((l) => ({ account: l.accountId, debit: l.debit, credit: l.credit, memo: l.memo })),
      });
    }
    const ts = now(ctx);
    ctx.db.update('financial_years', row.id, { is_closed: 1, closed_at: ts, closed_by: currentUserId(ctx), closing_entry_id: entryId });
    // Earlier years without any entries are locked too, so nothing can slip into them later.
    const booksFy = fyOf(getSection(ctx, 'accounts').booksStartDate).start;
    for (let p = fyOf(booksFy); p.start < fy.start; p = fyOf(addDays(p.end, 1))) {
      const r = ensureFinancialYear(ctx, p.start);
      if (!r.is_closed) ctx.db.update('financial_years', r.id, { is_closed: 1, closed_at: ts, closed_by: currentUserId(ctx), closing_entry_id: null });
    }
    ensureFinancialYear(ctx, addDays(fy.end, 1));
    logActivity(
      ctx,
      'year.close',
      `Closed financial year ${fy.name}: ${plan.netProfit >= 0 ? 'net profit' : 'net loss'} ${formatINR(Math.abs(plan.netProfit))} transferred to ${plan.capitalAccountName}` +
        (plan.drawingsTransferred ? `, drawings ${formatINR(plan.drawingsTransferred)} transferred` : ''),
      { entityType: 'financial_year', entityId: row.id, details: { closingEntryId: entryId, netProfit: plan.netProfit, drawings: plan.drawingsTransferred, backup: backup.path } },
    );
    return { year: yearInfo(ctx, fy.start), closingEntryId: entryId, backup };
  });
}

/** Re-open the latest closed year: voids its closing entry and unlocks it. Must be called OUTSIDE a transaction. */
export function reopenYear(ctx: Ctx, fyStart: string, reason?: string | null): { year: YearInfo; backup: BackupInfo } {
  const fy = fyOf(fyStart);
  const before = yearInfo(ctx, fy.start);
  if (!before.canReopen) throw fail.validation(before.reopenBlockedReason ?? 'This year cannot be re-opened');
  const backup = safetyBackup(ctx, `Before re-opening financial year ${fy.name}`, 're-opened');
  return ctx.db.tx(() => {
    const row = fyRow(ctx, fy.start)!;
    const check = yearInfo(ctx, fy.start);
    if (!check.canReopen) throw fail.validation(check.reopenBlockedReason ?? 'This year cannot be re-opened');
    const why = reason?.trim() || 'Financial year re-opened';
    if (row.closing_entry_id) voidEntry(ctx, row.closing_entry_id, why, { allowClosedPeriod: true });
    ctx.db.update('financial_years', row.id, { is_closed: 0, closed_at: null, closed_by: null, closing_entry_id: null });
    logActivity(ctx, 'year.reopen', `Re-opened financial year ${fy.name}${reason?.trim() ? `: ${reason.trim()}` : ''}`, {
      entityType: 'financial_year',
      entityId: row.id,
      details: { voidedClosingEntryId: row.closing_entry_id, backup: backup.path },
    });
    return { year: yearInfo(ctx, fy.start), backup };
  });
}
