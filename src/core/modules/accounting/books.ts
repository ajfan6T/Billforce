/**
 * Books of account, built straight from the ledger so they always agree with
 * account balances: cash book, bank & UPI book, day book, and the ledger of
 * any account or party. Cancelled (void) entries are left out.
 *
 * Opening balance, totals and closing balance are always worked out over the
 * whole period. Only the rows shown on screen are split into pages; exports
 * ask for every row (`all`).
 *
 * Opening-balance vouchers (dated the books start) count towards the opening
 * balance, as in the cash flow and trial balance, not as money in or out.
 * Income and expense accounts start every financial year at zero, like the
 * trial balance; balance-sheet accounts and parties carry their balance forward.
 *
 * Speed: SQLite runs in the app's main process, so a slow book freezes
 * everything. Each query below either walks the entries of the period (by
 * date, looking up their lines by entry) or walks the lines of the book's
 * accounts / party (by account or party, looking up their entry) - whichever
 * touches fewer rows - and never both nested (that was quadratic).
 */
import type { Ctx } from '../../context';
import { fail } from '../../errors';
import { getAccount } from '../../accounting/ledger';
import { entrySourceLink } from '../../accounting/links';
import { addDays, describeRange, formatDate, fyOf } from '../../../shared/dates';
import { VOUCHER_TYPE_LABELS, type PartyType, type VoucherType } from '../../../shared/constants';
import type { ReportColumn, ReportData, ReportRow } from '../../../shared/report';
import { inList, joinNames, voucherLabel } from './common';

interface LineRow {
  entry_id: number;
  date: string;
  voucher_type: VoucherType;
  voucher_no: string | null;
  narration: string | null;
  source_type: string | null;
  source_id: number | null;
  account_id: number;
  account_name: string;
  party_type: PartyType | null;
  party_id: number | null;
  party_name: string | null;
  debit: number;
  credit: number;
}

const PARTY_NAME = `CASE l.party_type WHEN 'customer' THEN (SELECT name FROM customers WHERE id = l.party_id)
                                      WHEN 'supplier' THEN (SELECT name FROM suppliers WHERE id = l.party_id)
                                      WHEN 'employee' THEN (SELECT name FROM employees WHERE id = l.party_id) END`;

const LINE_SELECT = `SELECT l.entry_id, e.date, e.voucher_type, e.voucher_no, e.narration, e.source_type, e.source_id,
       l.account_id, a.name AS account_name, l.party_type, l.party_id, ${PARTY_NAME} AS party_name, l.debit, l.credit
  FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id`;

/** Entries per page of a cash / bank book or ledger on screen. */
export const BOOK_PAGE_SIZE = 2000;
/** Vouchers per page of the day book on screen (each voucher takes several rows). */
export const DAY_BOOK_PAGE_SIZE = 1000;

export interface PageInput {
  /** Page of rows to show (1 = first). Opening, totals and closing are always for the whole period. */
  page?: number | null;
  /** Every row of the period on one page (for Excel / CSV / PDF / print). */
  all?: boolean | null;
}

export interface PageInfo {
  page: number;
  pageCount: number;
  pageSize: number;
  /** Position (1-based) of the first and last entry shown; 0 when there are none. */
  firstShown: number;
  lastShown: number;
}

function pageOf(total: number, input: PageInput, size: number): PageInfo & { start: number; end: number } {
  if (input.all || total <= size) return { page: 1, pageCount: 1, pageSize: Math.max(size, total), firstShown: total ? 1 : 0, lastShown: total, start: 0, end: total };
  const pageCount = Math.ceil(total / size);
  const page = Math.min(Math.max(1, Math.floor(input.page ?? 1)), pageCount);
  const start = (page - 1) * size;
  const end = Math.min(total, start + size);
  return { page, pageCount, pageSize: size, firstShown: start + 1, lastShown: end, start, end };
}

function pageNote(p: PageInfo, total: number, what: string): string | null {
  if (p.pageCount <= 1) return null;
  return `Showing ${what} ${p.firstShown.toLocaleString('en-IN')}–${p.lastShown.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} (page ${p.page} of ${p.pageCount}). Opening balance, totals and closing balance are for the whole period.`;
}

interface EntryGroup {
  id: number;
  date: string;
  voucherType: VoucherType;
  voucherNo: string | null;
  narration: string | null;
  sourceType: string | null;
  sourceId: number | null;
  lines: LineRow[];
}

/** Lines of the given entries, grouped by entry in the order of `ids`. */
function entryGroups(ctx: Ctx, ids: number[]): EntryGroup[] {
  const byId = new Map<number, EntryGroup>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const l of ctx.db.all<LineRow>(`${LINE_SELECT} WHERE l.entry_id IN (${inList(chunk.length)}) ORDER BY l.entry_id, l.line_no`, chunk)) {
      let g = byId.get(l.entry_id);
      if (!g) {
        g = { id: l.entry_id, date: l.date, voucherType: l.voucher_type, voucherNo: l.voucher_no, narration: l.narration, sourceType: l.source_type, sourceId: l.source_id, lines: [] };
        byId.set(l.entry_id, g);
      }
      g.lines.push(l);
    }
  }
  return ids.map((id) => byId.get(id)).filter((g): g is EntryGroup => !!g);
}

function partyLabel(l: Pick<LineRow, 'account_name' | 'party_name'>): string {
  return l.party_name ?? l.account_name;
}

/** "Sales, Discount Allowed - Bill to Anita". Names already in the narration are not repeated. */
function particulars(names: string[], narration: string | null): string {
  const text = narration?.trim() ?? '';
  const lower = text.toLowerCase();
  const who = joinNames(text ? names.filter((n) => !lower.includes(n.toLowerCase())) : names);
  if (who && text) return `${who} - ${text}`;
  return who || text;
}

function linkOf(ctx: Ctx, g: EntryGroup) {
  return entrySourceLink(ctx, { id: g.id, source_type: g.sourceType, source_id: g.sourceId });
}

/* ------------------------------ Which lines belong to a book ------------------------------ */

interface Scope {
  accountIds?: number[];
  party?: { type: PartyType; id: number };
}

/**
 * SQL condition on journal_lines alias `l` for the book's lines. With `byEntry`
 * the columns get a unary + so SQLite finds the lines of each entry through the
 * entry index instead of walking the account's whole history once per entry.
 */
function scopeSql(s: Scope, byEntry: boolean): { sql: string; params: unknown[] } {
  const p = byEntry ? '+' : '';
  const parts: string[] = [];
  const params: unknown[] = [];
  if (s.accountIds) {
    if (!s.accountIds.length) return { sql: '0', params: [] };
    parts.push(`${p}l.account_id IN (${inList(s.accountIds.length)})`);
    params.push(...s.accountIds);
  }
  if (s.party) {
    parts.push(`${p}l.party_type = ? AND ${p}l.party_id = ?`);
    params.push(s.party.type, s.party.id);
  }
  return { sql: parts.join(' AND ') || '1', params };
}

/**
 * Walk the book's lines (via the account / party index) when there are fewer
 * of them than entries dated in [from, to]; otherwise walk those entries.
 */
function walkLines(ctx: Ctx, s: Scope, from: string | null, to: string): boolean {
  if (!s.accountIds && !s.party) return false;
  const f = scopeSql(s, false);
  const lines = ctx.db.value<number>(`SELECT COUNT(*) FROM journal_lines l WHERE ${f.sql}`, f.params, 0);
  const entries = from
    ? ctx.db.value<number>('SELECT COUNT(*) FROM journal_entries WHERE date >= ? AND date <= ?', [from, to], 0)
    : ctx.db.value<number>('SELECT COUNT(*) FROM journal_entries WHERE date <= ?', [to], 0);
  return lines <= entries * 2;
}

/** Net (debit - credit) of the book's lines on non-void entries matching `cond` (on alias e), dated in [from, to]. */
function scopeNet(ctx: Ctx, s: Scope, from: string | null, to: string, cond = '1', condParams: unknown[] = []): number {
  const dates = from ? 'e.date >= ? AND e.date <= ?' : 'e.date <= ?';
  const dateParams = from ? [from, to] : [to];
  if (walkLines(ctx, s, from, to)) {
    const f = scopeSql(s, false);
    return ctx.db.value<number>(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l CROSS JOIN journal_entries e ON e.id = l.entry_id
        WHERE ${f.sql} AND e.is_void = 0 AND ${dates} AND ${cond}`,
      [...f.params, ...dateParams, ...condParams],
      0,
    );
  }
  const f = scopeSql(s, true);
  return ctx.db.value<number>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_entries e CROSS JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.is_void = 0 AND ${dates} AND ${cond} AND ${f.sql}`,
    [...dateParams, ...condParams, ...f.params],
    0,
  );
}

interface Movement {
  id: number;
  date: string;
  dr: number;
  cr: number;
}

/** Debit and credit of the book's lines per entry in the period (opening vouchers left out), in date order. */
function movements(ctx: Ctx, s: Scope, from: string, to: string): Movement[] {
  const entryCond = "e.is_void = 0 AND e.date >= ? AND e.date <= ? AND e.voucher_type <> 'opening'";
  // GROUP BY date, id follows the date index, so no sorting is needed when walking entries.
  if (walkLines(ctx, s, from, to)) {
    const f = scopeSql(s, false);
    return ctx.db.all<Movement>(
      `SELECT e.id, e.date, SUM(l.debit) AS dr, SUM(l.credit) AS cr FROM journal_lines l CROSS JOIN journal_entries e ON e.id = l.entry_id
        WHERE ${f.sql} AND ${entryCond} GROUP BY e.date, e.id ORDER BY e.date, e.id`,
      [...f.params, from, to],
    );
  }
  const f = scopeSql(s, true);
  return ctx.db.all<Movement>(
    `SELECT e.id, e.date, SUM(l.debit) AS dr, SUM(l.credit) AS cr FROM journal_entries e CROSS JOIN journal_lines l ON l.entry_id = e.id
      WHERE ${entryCond} AND ${f.sql} GROUP BY e.date, e.id ORDER BY e.date, e.id`,
    [from, to, ...f.params],
  );
}

/**
 * Balance of the book at the start of `from`: everything before it, plus
 * opening-balance vouchers dated up to `to`. For income / expense accounts
 * only this financial year counts (they start every year at zero).
 */
function openingBalance(ctx: Ctx, s: Scope, from: string, to: string, profitAndLoss: boolean): number {
  const before = profitAndLoss ? scopeNet(ctx, s, fyOf(from).start, addDays(from, -1)) : scopeNet(ctx, s, null, addDays(from, -1));
  const openingVouchers = scopeNet(ctx, s, from, to, "e.voucher_type = 'opening'");
  return before + openingVouchers;
}

/* ------------------------------ Account books (cash / bank / ledger) ------------------------------ */

interface BookOptions extends PageInput {
  title: string;
  from: string;
  to: string;
  /** Lines that belong to the book. */
  accountIds?: number[];
  party?: { type: PartyType; id: number };
  /** Income / expense account: starts every financial year at zero. */
  profitAndLoss?: boolean;
  /** Column labels for debit / credit. */
  inLabel: string;
  outLabel: string;
  balanceType: 'money' | 'drcr';
  /** Show which book account each entry used (when a book covers several accounts). */
  showAccount?: boolean;
  dayTotals?: boolean;
  notes?: string[];
}

export interface BookResult extends PageInfo {
  report: ReportData;
  from: string;
  to: string;
  opening: number;
  totalIn: number;
  totalOut: number;
  closing: number;
  /** Entries in the whole period (the report may show one page of them). */
  entryCount: number;
}

function accountBook(ctx: Ctx, opts: BookOptions): BookResult {
  const scope: Scope = { accountIds: opts.accountIds, party: opts.party };
  const pl = !!opts.profitAndLoss;
  const opening = openingBalance(ctx, scope, opts.from, opts.to, pl);
  const moves = movements(ctx, scope, opts.from, opts.to);

  // Running balance before each entry, over the whole period. Income / expense accounts restart at zero each April.
  const before: number[] = new Array(moves.length);
  const restarts = new Set<number>();
  const days = new Map<string, { in: number; out: number; count: number }>();
  let running = opening;
  let fy = fyOf(opts.from).start;
  let totalIn = 0;
  let totalOut = 0;
  moves.forEach((m, i) => {
    if (pl && fyOf(m.date).start !== fy) {
      fy = fyOf(m.date).start;
      running = 0;
      restarts.add(i);
    }
    before[i] = running;
    running += m.dr - m.cr;
    totalIn += m.dr;
    totalOut += m.cr;
    const d = days.get(m.date) ?? { in: 0, out: 0, count: 0 };
    d.in += m.dr;
    d.out += m.cr;
    d.count++;
    days.set(m.date, d);
  });
  const endFy = fyOf(opts.to).start;
  const restartsAtEnd = pl && endFy !== fy;
  const closing = restartsAtEnd ? 0 : running;

  const p = pageOf(moves.length, opts, BOOK_PAGE_SIZE);
  const groups = entryGroups(
    ctx,
    moves.slice(p.start, p.end).map((m) => m.id),
  );
  const inBook = (l: LineRow) =>
    (!opts.accountIds || opts.accountIds.includes(l.account_id)) && (!opts.party || (l.party_type === opts.party.type && l.party_id === opts.party.id));

  const columns: ReportColumn[] = [
    { key: 'date', label: 'Date', type: 'date', width: 11 },
    { key: 'voucher', label: 'Voucher', width: 16 },
    { key: 'no', label: 'No', width: 15, nowrap: true },
    ...(opts.showAccount ? [{ key: 'account', label: 'Account', width: 16 } as ReportColumn] : []),
    { key: 'particulars', label: 'Particulars', width: 40 },
    { key: 'in', label: opts.inLabel, type: 'money', width: 14 },
    { key: 'out', label: opts.outLabel, type: 'money', width: 14 },
    { key: 'balance', label: 'Balance', type: opts.balanceType, width: 16 },
  ];
  const blank = { voucher: null, no: null, account: null };
  const cumulative = (upTo: number) => moves.slice(0, upTo).reduce((s, m) => ({ in: s.in + m.dr, out: s.out + m.cr }), { in: 0, out: 0 });
  const restartRow = (date: string): ReportRow => ({
    cells: { date, ...blank, particulars: `Opening balance of financial year ${fyOf(date).name} (income and expense accounts start each year at zero)`, in: null, out: null, balance: 0 },
    style: 'group',
  });

  const rows: ReportRow[] = [];
  if (p.start === 0) {
    rows.push({ cells: { date: opts.from, ...blank, particulars: 'Opening balance', in: null, out: null, balance: opening }, style: 'group' });
  } else {
    const c = cumulative(p.start);
    const prev = restarts.has(p.start) ? before[p.start - 1] + moves[p.start - 1].dr - moves[p.start - 1].cr : before[p.start];
    rows.push({ cells: { date: moves[p.start].date, ...blank, particulars: 'Brought forward from the previous page', in: c.in, out: c.out, balance: prev }, style: 'group' });
  }
  groups.forEach((g, gi) => {
    const i = p.start + gi;
    const m = moves[i];
    if (restarts.has(i)) rows.push(restartRow(fyOf(m.date).start));
    const bal = before[i] + m.dr - m.cr;
    const mine = g.lines.filter(inBook);
    const others = g.lines.filter((l) => !inBook(l));
    // Particulars: the other side of the entry; for control-account ledgers, the party on this line comes first.
    const ownParty = !opts.party ? mine.filter((l) => l.party_name).map((l) => l.party_name!) : [];
    const otherNames = others.length ? others.map(partyLabel) : mine.map((l) => l.account_name);
    rows.push({
      cells: {
        date: g.date,
        voucher: voucherLabel(g.voucherType),
        no: g.voucherNo,
        account: opts.showAccount ? joinNames(mine.map((l) => l.account_name)) : null,
        particulars: particulars([...ownParty, ...otherNames.filter((n) => !ownParty.includes(n))], g.narration),
        in: m.dr || null,
        out: m.cr || null,
        balance: bal,
      },
      link: linkOf(ctx, g),
    });
    // Day totals (for the whole day, even when it starts on the previous page) help when a period spans several days.
    const day = days.get(m.date)!;
    const lastOfDay = moves[i + 1]?.date !== m.date;
    if (opts.dayTotals && lastOfDay && day.count > 1 && opts.from !== opts.to) {
      rows.push({ cells: { date: null, ...blank, particulars: `Total for ${formatDate(m.date)}`, in: day.in, out: day.out, balance: bal }, style: 'subtotal' });
    }
  });
  if (p.end < moves.length) {
    const c = cumulative(p.end);
    const bal = before[p.end - 1] + moves[p.end - 1].dr - moves[p.end - 1].cr;
    rows.push({ cells: { date: moves[p.end - 1].date, ...blank, particulars: 'Carried forward to the next page', in: c.in, out: c.out, balance: bal }, style: 'subtotal' });
  } else {
    if (restartsAtEnd) rows.push(restartRow(endFy));
    rows.push({ cells: { date: opts.to, ...blank, particulars: 'Closing balance', in: totalIn, out: totalOut, balance: closing }, style: 'total' });
  }

  const notes = [...(opts.notes ?? [])];
  const paged = pageNote(p, moves.length, 'entries');
  if (paged) notes.unshift(paged);
  if (pl) {
    notes.push(
      fyOf(opts.from).start !== endFy
        ? `Income and expense accounts start every financial year at zero, so the closing balance is for ${fyOf(opts.to).name} only. Earlier years' result is in Profit & loss (previous years), or in capital once the year is closed.`
        : "Income and expense accounts start every financial year at zero. Earlier years' result is in Profit & loss (previous years), or in capital once the year is closed.",
    );
  }
  return {
    report: {
      title: opts.title,
      subtitle: describeRange({ from: opts.from, to: opts.to }),
      columns,
      rows,
      summary: [
        { label: 'Opening balance', value: opening, type: opts.balanceType },
        { label: opts.inLabel, value: totalIn, type: 'money' },
        { label: opts.outLabel, value: totalOut, type: 'money' },
        { label: 'Closing balance', value: closing, type: opts.balanceType },
      ],
      notes,
      landscape: true,
    },
    from: opts.from,
    to: opts.to,
    opening,
    totalIn,
    totalOut,
    closing,
    entryCount: moves.length,
    page: p.page,
    pageCount: p.pageCount,
    pageSize: p.pageSize,
    firstShown: p.firstShown,
    lastShown: p.lastShown,
  };
}

function checkRange(range: { from: string; to: string }): void {
  if (range.from > range.to) throw fail.validation('The "from" date must be on or before the "to" date', { from: 'Check the dates' });
}

export interface AccountBalanceItem {
  id: number;
  name: string;
  isActive: boolean;
  opening: number;
  closing: number;
}

export interface BookInput extends PageInput {
  from: string;
  to: string;
  accountId?: number | null;
}

function groupBook(ctx: Ctx, group: 'cash' | 'bank', input: BookInput) {
  checkRange(input);
  const accounts = ctx.db.all<{ id: number; name: string; is_active: number }>(
    'SELECT id, name, is_active FROM accounts WHERE group_code = ? ORDER BY code, name COLLATE NOCASE',
    [group],
  );
  let ids = accounts.map((a) => a.id);
  let title = group === 'cash' ? 'Cash book' : 'Bank & UPI book';
  if (input.accountId) {
    const acct = getAccount(ctx, input.accountId);
    if (acct.group_code !== group) {
      throw fail.validation(group === 'cash' ? `"${acct.name}" is not a cash account` : `"${acct.name}" is not a bank / UPI account`, { accountId: 'Choose another account' });
    }
    ids = [acct.id];
    title = `${title} - ${acct.name}`;
  }
  // Opening (same rule as the book: opening vouchers up to "to" count as opening) and closing of each account, in one pass.
  const sums = new Map(
    (accounts.length
      ? ctx.db.all<{ account_id: number; opening: number; closing: number }>(
          `SELECT l.account_id,
                  SUM(CASE WHEN e.date < ? OR e.voucher_type = 'opening' THEN l.debit - l.credit ELSE 0 END) AS opening,
                  SUM(l.debit - l.credit) AS closing
             FROM journal_lines l CROSS JOIN journal_entries e ON e.id = l.entry_id
            WHERE l.account_id IN (${inList(accounts.length)}) AND e.is_void = 0 AND e.date <= ?
            GROUP BY l.account_id`,
          [input.from, ...accounts.map((a) => a.id), input.to],
        )
      : []
    ).map((r) => [r.account_id, r]),
  );
  const list: AccountBalanceItem[] = accounts
    .filter((a) => ids.includes(a.id))
    .filter((a) => a.is_active || sums.get(a.id)?.opening || sums.get(a.id)?.closing)
    .map((a) => ({ id: a.id, name: a.name, isActive: !!a.is_active, opening: sums.get(a.id)?.opening ?? 0, closing: sums.get(a.id)?.closing ?? 0 }));
  const book = accountBook(ctx, {
    title,
    from: input.from,
    to: input.to,
    page: input.page,
    all: input.all,
    accountIds: ids,
    inLabel: 'Receipts',
    outLabel: 'Payments',
    balanceType: 'money',
    showAccount: !input.accountId && accounts.length > 1,
    dayTotals: true,
    notes: ['Cancelled bills and vouchers are not shown.'],
  });
  return { ...book, accountId: input.accountId ?? null, accounts: list };
}

export function cashBook(ctx: Ctx, input: BookInput) {
  return groupBook(ctx, 'cash', input);
}

export function bankBook(ctx: Ctx, input: BookInput) {
  return groupBook(ctx, 'bank', input);
}

/* ------------------------------ Ledger ------------------------------ */

const PARTY_TABLES: Record<PartyType, string> = { customer: 'customers', supplier: 'suppliers', employee: 'employees' };
const PARTY_LABELS: Record<PartyType, string> = { customer: 'Customer', supplier: 'Supplier', employee: 'Employee' };

export interface LedgerInput extends PageInput {
  from: string;
  to: string;
  accountId?: number | null;
  partyType?: PartyType | null;
  partyId?: number | null;
}

export function ledger(ctx: Ctx, input: LedgerInput) {
  checkRange(input);
  let account: { id: number; name: string; code: string | null; groupName: string; type: string; partyType: PartyType | null } | null = null;
  let party: { type: PartyType; id: number; name: string; phone: string | null } | null = null;
  if (input.accountId) {
    const a = getAccount(ctx, input.accountId);
    account = {
      id: a.id,
      name: a.name,
      code: a.code,
      groupName: ctx.db.value<string>('SELECT name FROM account_groups WHERE code = ?', [a.group_code], a.group_code),
      type: a.type,
      partyType: a.party_type,
    };
  }
  if (input.partyType || input.partyId) {
    if (!input.partyType || !input.partyId) throw fail.validation('Choose the customer, supplier or employee');
    const p = ctx.db.get<{ id: number; name: string; phone: string | null }>(`SELECT id, name, phone FROM ${PARTY_TABLES[input.partyType]} WHERE id = ?`, [input.partyId]);
    if (!p) throw fail.notFound(PARTY_LABELS[input.partyType]);
    party = { type: input.partyType, ...p };
  }
  if (!account && !party) throw fail.validation('Choose an account, customer, supplier or employee to see its ledger');
  const title = party ? `${party.name} (${PARTY_LABELS[party.type].toLowerCase()})${account ? ` - ${account.name}` : ''}` : account!.name;
  const notes: string[] = [];
  if (party?.type === 'employee' && !account) notes.push('Advances given and salary payable are shown together: a debit balance means the employee owes you.');
  if (account?.partyType && !party) notes.push('This account holds the total of every party; open a customer or supplier for their own ledger.');
  const book = accountBook(ctx, {
    title: `Ledger: ${title}`,
    from: input.from,
    to: input.to,
    page: input.page,
    all: input.all,
    accountIds: account ? [account.id] : undefined,
    party: party ? { type: party.type, id: party.id } : undefined,
    profitAndLoss: !party && (account?.type === 'income' || account?.type === 'expense'),
    inLabel: 'Debit',
    outLabel: 'Credit',
    balanceType: 'drcr',
    notes,
  });
  return { ...book, title, account, party };
}

/* ------------------------------ Day book ------------------------------ */

export function dayBook(ctx: Ctx, input: { from: string; to: string; voucherType?: VoucherType | null } & PageInput) {
  checkRange(input);
  const where = ['e.is_void = 0', 'e.date >= ?', 'e.date <= ?'];
  const params: unknown[] = [input.from, input.to];
  if (input.voucherType) {
    where.push('e.voucher_type = ?');
    params.push(input.voucherType);
  }
  // Every voucher of the period with its totals (for the summary and day totals); lines only for the page shown.
  const vouchers = ctx.db.all<{ id: number; date: string; voucher_type: VoucherType; dr: number; cr: number }>(
    `SELECT e.id, e.date, e.voucher_type, SUM(l.debit) AS dr, SUM(l.credit) AS cr
       FROM journal_entries e CROSS JOIN journal_lines l ON l.entry_id = e.id
      WHERE ${where.join(' AND ')} GROUP BY e.date, e.id ORDER BY e.date, e.id`,
    params,
  );
  let totalDr = 0;
  let totalCr = 0;
  const byType = new Map<VoucherType, number>();
  const days = new Map<string, { dr: number; cr: number; count: number }>();
  for (const v of vouchers) {
    totalDr += v.dr;
    totalCr += v.cr;
    byType.set(v.voucher_type, (byType.get(v.voucher_type) ?? 0) + 1);
    const d = days.get(v.date) ?? { dr: 0, cr: 0, count: 0 };
    d.dr += v.dr;
    d.cr += v.cr;
    d.count++;
    days.set(v.date, d);
  }
  const p = pageOf(vouchers.length, input, DAY_BOOK_PAGE_SIZE);
  const groups = entryGroups(
    ctx,
    vouchers.slice(p.start, p.end).map((v) => v.id),
  );
  const rows: ReportRow[] = [];
  groups.forEach((g, gi) => {
    const i = p.start + gi;
    const link = linkOf(ctx, g);
    rows.push({
      cells: { date: g.date, voucher: voucherLabel(g.voucherType), no: g.voucherNo, particulars: g.narration ?? '', debit: null, credit: null },
      style: 'group',
      link,
    });
    for (const l of g.lines) {
      rows.push({
        cells: {
          date: null,
          voucher: null,
          no: null,
          particulars: l.party_name ? `${l.account_name} - ${l.party_name}` : l.account_name,
          debit: l.debit || null,
          credit: l.credit || null,
        },
        indent: 1,
        link,
      });
    }
    // The whole day's total, even when the day starts on the previous page.
    if (vouchers[i + 1]?.date !== g.date) {
      const d = days.get(g.date)!;
      rows.push({
        cells: { date: null, voucher: null, no: null, particulars: `Total for ${formatDate(g.date)} (${d.count} ${d.count === 1 ? 'voucher' : 'vouchers'})`, debit: d.dr, credit: d.cr },
        style: 'subtotal',
      });
    }
  });
  if (vouchers.length && p.end === vouchers.length) rows.push({ cells: { date: null, voucher: null, no: null, particulars: 'Total', debit: totalDr, credit: totalCr }, style: 'total' });
  const notes = ['Cancelled bills and vouchers are not shown.'];
  const paged = pageNote(p, vouchers.length, 'vouchers');
  if (paged) notes.unshift(paged.replace('Opening balance, totals and closing balance are', 'The totals are'));
  const report: ReportData = {
    title: input.voucherType ? `Day book - ${VOUCHER_TYPE_LABELS[input.voucherType]}` : 'Day book',
    subtitle: describeRange(input),
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 11 },
      { key: 'voucher', label: 'Voucher', width: 18 },
      { key: 'no', label: 'No', width: 15, nowrap: true },
      { key: 'particulars', label: 'Particulars', width: 46 },
      { key: 'debit', label: 'Debit', type: 'money', width: 14 },
      { key: 'credit', label: 'Credit', type: 'money', width: 14 },
    ],
    rows,
    summary: [
      { label: 'Vouchers', value: vouchers.length, type: 'number' },
      { label: 'Total debit', value: totalDr, type: 'money' },
      { label: 'Total credit', value: totalCr, type: 'money' },
    ],
    notes,
    landscape: true,
  };
  return {
    report,
    from: input.from,
    to: input.to,
    voucherType: input.voucherType ?? null,
    voucherCount: vouchers.length,
    totalDebit: totalDr,
    totalCredit: totalCr,
    byType: [...byType.entries()].map(([type, count]) => ({ type, label: VOUCHER_TYPE_LABELS[type], count })),
    page: p.page,
    pageCount: p.pageCount,
    pageSize: p.pageSize,
    firstShown: p.firstShown,
    lastShown: p.lastShown,
  };
}
