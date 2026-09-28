/**
 * Helpers shared by the report services: ledger aggregation per account,
 * period labels, range validation and chart shapes.
 *
 * Financial reports read ONLY non-void journal entries, so they always agree
 * with the books. Every query here takes whole entries (never part of one),
 * which is what guarantees that the trial balance and balance sheet balance.
 */
import type { Ctx } from '../../context';
import { fail } from '../../errors';
import type { AccountType, PartyType } from '../../../shared/constants';
import type { SystemKey } from '../../accounting/chart';
import { addDays, addMonths, diffDays, endOfMonth, formatDate, fyOf, monthLabel, monthsBetween, startOfMonth } from '../../../shared/dates';

export interface AccountMeta {
  id: number;
  code: string | null;
  name: string;
  groupCode: string;
  groupName: string;
  groupSort: number;
  type: AccountType;
  systemKey: SystemKey | null;
  partyType: PartyType | null;
  isActive: boolean;
}

/** Every account with its group, in chart order. */
export function accountsMeta(ctx: Ctx): AccountMeta[] {
  return ctx.db
    .all<{
      id: number;
      code: string | null;
      name: string;
      group_code: string;
      group_name: string;
      sort_order: number;
      type: AccountType;
      system_key: SystemKey | null;
      party_type: PartyType | null;
      is_active: number;
    }>(
      `SELECT a.id, a.code, a.name, a.group_code, g.name AS group_name, g.sort_order, g.type, a.system_key, a.party_type, a.is_active
         FROM accounts a JOIN account_groups g ON g.code = a.group_code
        ORDER BY g.sort_order, COALESCE(a.code, '~'), a.name COLLATE NOCASE`,
    )
    .map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      groupCode: r.group_code,
      groupName: r.group_name,
      groupSort: r.sort_order,
      type: r.type,
      systemKey: r.system_key,
      partyType: r.party_type,
      isActive: !!r.is_active,
    }));
}

export interface LedgerFilter {
  /** Entries dated on or after. */
  from?: string;
  /** Entries dated on or before. */
  to?: string;
  /** Entries dated strictly before (used for opening balances). */
  before?: string;
  /** Leave out every year-end closing entry (P&L style figures). */
  excludeClosing?: boolean;
  /** Leave out closing entries dated on or after this date (the closing entry of the report's own year). */
  excludeClosingFrom?: string;
  /** Only accounts of these types. */
  types?: AccountType[];
}

function filterSql(f: LedgerFilter, params: unknown[]): string {
  let sql = 'e.is_void = 0';
  if (f.from) {
    sql += ' AND e.date >= ?';
    params.push(f.from);
  }
  if (f.to) {
    sql += ' AND e.date <= ?';
    params.push(f.to);
  }
  if (f.before) {
    sql += ' AND e.date < ?';
    params.push(f.before);
  }
  if (f.excludeClosing) sql += " AND e.voucher_type <> 'closing'";
  if (f.excludeClosingFrom) {
    sql += " AND NOT (e.voucher_type = 'closing' AND e.date >= ?)";
    params.push(f.excludeClosingFrom);
  }
  if (f.types?.length) {
    sql += ` AND g.type IN (${f.types.map(() => '?').join(', ')})`;
    params.push(...f.types);
  }
  return sql;
}

export interface Sums {
  debit: number;
  credit: number;
}

/** Total debits and credits per account for the filtered entries. */
export function accountSums(ctx: Ctx, f: LedgerFilter): Map<number, Sums> {
  const params: unknown[] = [];
  const where = filterSql(f, params);
  const rows = ctx.db.all<{ account_id: number; dr: number; cr: number }>(
    `SELECT l.account_id, COALESCE(SUM(l.debit), 0) AS dr, COALESCE(SUM(l.credit), 0) AS cr
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id JOIN account_groups g ON g.code = a.group_code
      WHERE ${where}
      GROUP BY l.account_id`,
    params,
  );
  return new Map(rows.map((r) => [r.account_id, { debit: r.dr, credit: r.cr }]));
}

/** Net balance (debit - credit) per account for the filtered entries. */
export function accountNets(ctx: Ctx, f: LedgerFilter): Map<number, number> {
  const out = new Map<number, number>();
  for (const [id, s] of accountSums(ctx, f)) out.set(id, s.debit - s.credit);
  return out;
}

/** Net balance (debit - credit) of every party on one account: Map(partyId -> balance). */
export function partyNets(ctx: Ctx, accountId: number, f: LedgerFilter): Map<number, number> {
  const params: unknown[] = [accountId];
  const where = filterSql({ ...f, types: undefined }, params);
  const rows = ctx.db.all<{ party_id: number; bal: number }>(
    `SELECT l.party_id, SUM(l.debit - l.credit) AS bal
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ? AND l.party_id IS NOT NULL AND ${where}
      GROUP BY l.party_id`,
    params,
  );
  return new Map(rows.map((r) => [r.party_id, r.bal]));
}

/** Debits and credits of every party on one account. */
export function partySums(ctx: Ctx, accountId: number, f: LedgerFilter): Map<number, Sums> {
  const params: unknown[] = [accountId];
  const where = filterSql({ ...f, types: undefined }, params);
  const rows = ctx.db.all<{ party_id: number; dr: number; cr: number }>(
    `SELECT l.party_id, COALESCE(SUM(l.debit), 0) AS dr, COALESCE(SUM(l.credit), 0) AS cr
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ? AND l.party_id IS NOT NULL AND ${where}
      GROUP BY l.party_id`,
    params,
  );
  return new Map(rows.map((r) => [r.party_id, { debit: r.dr, credit: r.cr }]));
}

const PARTY_TABLE: Record<PartyType, string> = { customer: 'customers', supplier: 'suppliers', employee: 'employees' };

/** Names of parties: Map(id -> name). */
export function partyNames(ctx: Ctx, type: PartyType, ids: number[]): Map<number, string> {
  if (!ids.length) return new Map();
  const rows = ctx.db.all<{ id: number; name: string }>(`SELECT id, name FROM ${PARTY_TABLE[type]} WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Account id of a built-in account. */
export function systemId(ctx: Ctx, key: SystemKey): number {
  const id = ctx.db.value<number | null>('SELECT id FROM accounts WHERE system_key = ?', [key], null);
  if (!id) throw fail.validation(`Built-in account ${key} is missing`);
  return id;
}

/* ------------------------------ Periods ------------------------------ */

/** Throw a friendly error unless from <= to. */
export function assertRange(from: string, to: string): void {
  if (from > to) throw fail.validation('The "from" date must be on or before the "to" date.', { from: 'Must be on or before the "to" date' });
}

/** Throw unless the range is at most `maxDays` long. */
export function assertMaxDays(from: string, to: string, maxDays: number, hint: string): void {
  if (diffDays(from, to) + 1 > maxDays) throw fail.validation(`Choose a period of up to ${maxDays} days. ${hint}`);
}

/** "FY 2025-26", "Sep 2026", "01-09-2026 to 15-09-2026" */
export function periodLabel(from: string, to: string): string {
  const fy = fyOf(from);
  if (from === fy.start && to === fy.end) return `FY ${fy.name}`;
  if (from === startOfMonth(from) && to === endOfMonth(from)) return monthLabel(from.slice(0, 7));
  if (from === to) return formatDate(from);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))}-${Number(to.slice(8))} ${monthLabel(from.slice(0, 7))}`;
  return `${formatDate(from)} to ${formatDate(to)}`;
}

/** Subtitle for a period report. */
export function rangeSubtitle(from: string, to: string): string {
  return from === to ? `For ${formatDate(from)}` : `From ${formatDate(from)} to ${formatDate(to)}`;
}

function shiftDate(date: string, months: number, keepMonthEnd: boolean): string {
  const shifted = addMonths(date, months);
  return keepMonthEnd ? endOfMonth(shifted) : shifted;
}

/**
 * The period to compare with.
 *  previous_year   : the same dates one year earlier.
 *  previous_period : the period of the same length just before. Ranges that start on the
 *                    1st of a month move back by whole months ("1-28 Sep" -> "1-28 Aug").
 */
export function comparePeriod(from: string, to: string, kind: 'previous_period' | 'previous_year'): { from: string; to: string } {
  const toIsMonthEnd = to === endOfMonth(to);
  if (kind === 'previous_year') {
    return { from: shiftDate(from, -12, false), to: shiftDate(to, -12, toIsMonthEnd) };
  }
  if (from === startOfMonth(from)) {
    const months = monthsBetween(from, to).length;
    const pFrom = addMonths(from, -months);
    let pTo = shiftDate(to, -months, toIsMonthEnd);
    if (pTo >= from) pTo = addDays(from, -1);
    return { from: pFrom, to: pTo };
  }
  const days = diffDays(from, to) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

/* ------------------------------ Numbers ------------------------------ */

/** Percentage with one decimal (12.5 = 12.5%); null when the base is zero. */
export function pct(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** Split an integer amount in proportion to weights, exactly (largest remainder). */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!total) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const out = raw.map((r) => Math.trunc(r));
  let left = amount - out.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => ({ i, frac: Math.abs(r - Math.trunc(r)) })).sort((a, b) => b.frac - a.frac);
  const step = Math.sign(left);
  for (let k = 0; left !== 0 && k < order.length * 2; k++) {
    out[order[k % order.length].i] += step;
    left -= step;
  }
  return out;
}

/** Chart data returned with the sales insights (values in paise). */
export interface ChartData {
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
}
