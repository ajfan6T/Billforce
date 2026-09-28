/**
 * Books of account, built straight from the ledger so they always agree with
 * account balances: cash book, bank & UPI book, day book, and the ledger of
 * any account or party. Cancelled (void) entries are left out.
 */
import type { Ctx } from '../../context';
import { fail } from '../../errors';
import { getAccount } from '../../accounting/ledger';
import { entrySourceLink } from '../../accounting/links';
import { addDays, describeRange, formatDate } from '../../../shared/dates';
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

/** Most entries in one book; longer periods show a note asking for a shorter one. */
const MAX_ENTRIES = 5000;

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

function groupByEntry(lines: LineRow[]): EntryGroup[] {
  const out: EntryGroup[] = [];
  let cur: EntryGroup | null = null;
  for (const l of lines) {
    if (!cur || cur.id !== l.entry_id) {
      cur = { id: l.entry_id, date: l.date, voucherType: l.voucher_type, voucherNo: l.voucher_no, narration: l.narration, sourceType: l.source_type, sourceId: l.source_id, lines: [] };
      out.push(cur);
    }
    cur.lines.push(l);
  }
  return out;
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

/* ------------------------------ Account books (cash / bank / ledger) ------------------------------ */

interface BookOptions {
  title: string;
  from: string;
  to: string;
  /** Lines that belong to the book. */
  accountIds?: number[];
  party?: { type: PartyType; id: number };
  /** Column labels for debit / credit. */
  inLabel: string;
  outLabel: string;
  balanceType: 'money' | 'drcr';
  /** Show which book account each entry used (when a book covers several accounts). */
  showAccount?: boolean;
  dayTotals?: boolean;
  notes?: string[];
}

export interface BookResult {
  report: ReportData;
  opening: number;
  totalIn: number;
  totalOut: number;
  closing: number;
  entryCount: number;
}

function bookFilter(opts: BookOptions, alias = 'l'): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (opts.accountIds) {
    if (!opts.accountIds.length) return { sql: '0', params: [] };
    parts.push(`${alias}.account_id IN (${inList(opts.accountIds.length)})`);
    params.push(...opts.accountIds);
  }
  if (opts.party) {
    parts.push(`${alias}.party_type = ? AND ${alias}.party_id = ?`);
    params.push(opts.party.type, opts.party.id);
  }
  return { sql: parts.join(' AND ') || '1', params };
}

function accountBook(ctx: Ctx, opts: BookOptions): BookResult {
  const f = bookFilter(opts);
  const opening = ctx.db.value<number>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.is_void = 0 AND e.date < ? AND ${f.sql}`,
    [opts.from, ...f.params],
    0,
  );
  const inner = bookFilter(opts, 'b');
  const entryIds = ctx.db
    .all<{ id: number }>(
      `SELECT e.id FROM journal_entries e WHERE e.is_void = 0 AND e.date >= ? AND e.date <= ?
          AND EXISTS (SELECT 1 FROM journal_lines b WHERE b.entry_id = e.id AND ${inner.sql})
        ORDER BY e.date, e.id LIMIT ?`,
      [opts.from, opts.to, ...inner.params, MAX_ENTRIES + 1],
    )
    .map((r) => r.id);
  const truncated = entryIds.length > MAX_ENTRIES;
  const ids = entryIds.slice(0, MAX_ENTRIES);
  const lines: LineRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    lines.push(...ctx.db.all<LineRow>(`${LINE_SELECT} WHERE l.entry_id IN (${inList(chunk.length)}) ORDER BY e.date, e.id, l.line_no`, chunk));
  }
  const groups = groupByEntry(lines);
  const inBook = (l: LineRow) =>
    (!opts.accountIds || opts.accountIds.includes(l.account_id)) && (!opts.party || (l.party_type === opts.party.type && l.party_id === opts.party.id));

  const columns: ReportColumn[] = [
    { key: 'date', label: 'Date', type: 'date', width: 11 },
    { key: 'voucher', label: 'Voucher', width: 16 },
    { key: 'no', label: 'No', width: 15 },
    ...(opts.showAccount ? [{ key: 'account', label: 'Account', width: 16 } as ReportColumn] : []),
    { key: 'particulars', label: 'Particulars', width: 40 },
    { key: 'in', label: opts.inLabel, type: 'money', width: 14 },
    { key: 'out', label: opts.outLabel, type: 'money', width: 14 },
    { key: 'balance', label: 'Balance', type: opts.balanceType, width: 16 },
  ];
  const rows: ReportRow[] = [
    { cells: { date: opts.from, voucher: null, no: null, account: null, particulars: 'Opening balance', in: null, out: null, balance: opening }, style: 'group' },
  ];
  let running = opening;
  let totalIn = 0;
  let totalOut = 0;
  let dayIn = 0;
  let dayOut = 0;
  let dayCount = 0;
  const flushDay = (date: string) => {
    // Day totals help when a period spans several days; for a single day the closing row says it all.
    if (opts.dayTotals && dayCount > 1 && opts.from !== opts.to) {
      rows.push({
        cells: { date: null, voucher: null, no: null, account: null, particulars: `Total for ${formatDate(date)}`, in: dayIn, out: dayOut, balance: running },
        style: 'subtotal',
      });
    }
    dayIn = 0;
    dayOut = 0;
    dayCount = 0;
  };
  groups.forEach((g, i) => {
    const mine = g.lines.filter(inBook);
    const others = g.lines.filter((l) => !inBook(l));
    const dr = mine.reduce((s, l) => s + l.debit, 0);
    const cr = mine.reduce((s, l) => s + l.credit, 0);
    running += dr - cr;
    totalIn += dr;
    totalOut += cr;
    dayIn += dr;
    dayOut += cr;
    dayCount++;
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
        in: dr || null,
        out: cr || null,
        balance: running,
      },
      link: linkOf(ctx, g),
    });
    const next = groups[i + 1];
    if (!next || next.date !== g.date) flushDay(g.date);
  });
  rows.push({
    cells: { date: opts.to, voucher: null, no: null, account: null, particulars: 'Closing balance', in: totalIn, out: totalOut, balance: running },
    style: 'total',
  });
  const notes = [...(opts.notes ?? [])];
  if (truncated) notes.unshift(`Only the first ${MAX_ENTRIES} entries are shown. Choose a shorter period to see everything.`);
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
        { label: 'Closing balance', value: running, type: opts.balanceType },
      ],
      notes,
      landscape: true,
    },
    opening,
    totalIn,
    totalOut,
    closing: running,
    entryCount: groups.length,
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

function groupBook(ctx: Ctx, group: 'cash' | 'bank', input: { from: string; to: string; accountId?: number | null }) {
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
  const balances = (date: string) =>
    new Map(
      ctx.db
        .all<{ account_id: number; bal: number }>(
          `SELECT l.account_id, SUM(l.debit - l.credit) AS bal FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
            WHERE e.is_void = 0 AND e.date <= ? AND l.account_id IN (${inList(accounts.length || 1)}) GROUP BY l.account_id`,
          [date, ...(accounts.length ? accounts.map((a) => a.id) : [0])],
        )
        .map((r) => [r.account_id, r.bal]),
    );
  const before = balances(addDays(input.from, -1));
  const after = balances(input.to);
  const list: AccountBalanceItem[] = accounts
    .filter((a) => ids.includes(a.id))
    .filter((a) => a.is_active || before.get(a.id) || after.get(a.id))
    .map((a) => ({ id: a.id, name: a.name, isActive: !!a.is_active, opening: before.get(a.id) ?? 0, closing: after.get(a.id) ?? 0 }));
  const book = accountBook(ctx, {
    title,
    from: input.from,
    to: input.to,
    accountIds: ids,
    inLabel: 'Receipts',
    outLabel: 'Payments',
    balanceType: 'money',
    showAccount: !input.accountId && accounts.length > 1,
    dayTotals: true,
    notes: ['Cancelled bills and vouchers are not shown.'],
  });
  return { ...book, accounts: list };
}

export function cashBook(ctx: Ctx, input: { from: string; to: string; accountId?: number | null }) {
  return groupBook(ctx, 'cash', input);
}

export function bankBook(ctx: Ctx, input: { from: string; to: string; accountId?: number | null }) {
  return groupBook(ctx, 'bank', input);
}

/* ------------------------------ Ledger ------------------------------ */

const PARTY_TABLES: Record<PartyType, string> = { customer: 'customers', supplier: 'suppliers', employee: 'employees' };
const PARTY_LABELS: Record<PartyType, string> = { customer: 'Customer', supplier: 'Supplier', employee: 'Employee' };

export interface LedgerInput {
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
    accountIds: account ? [account.id] : undefined,
    party: party ? { type: party.type, id: party.id } : undefined,
    inLabel: 'Debit',
    outLabel: 'Credit',
    balanceType: 'drcr',
    notes,
  });
  return { ...book, title, account, party };
}

/* ------------------------------ Day book ------------------------------ */

export function dayBook(ctx: Ctx, input: { from: string; to: string; voucherType?: VoucherType | null }) {
  checkRange(input);
  const where = ['e.is_void = 0', 'e.date >= ?', 'e.date <= ?'];
  const params: unknown[] = [input.from, input.to];
  if (input.voucherType) {
    where.push('e.voucher_type = ?');
    params.push(input.voucherType);
  }
  const ids = ctx.db
    .all<{ id: number }>(`SELECT e.id FROM journal_entries e WHERE ${where.join(' AND ')} ORDER BY e.date, e.id LIMIT ?`, [...params, MAX_ENTRIES + 1])
    .map((r) => r.id);
  const truncated = ids.length > MAX_ENTRIES;
  const use = ids.slice(0, MAX_ENTRIES);
  const lines: LineRow[] = [];
  for (let i = 0; i < use.length; i += 500) {
    const chunk = use.slice(i, i + 500);
    lines.push(...ctx.db.all<LineRow>(`${LINE_SELECT} WHERE l.entry_id IN (${inList(chunk.length)}) ORDER BY e.date, e.id, l.line_no`, chunk));
  }
  const groups = groupByEntry(lines);
  const rows: ReportRow[] = [];
  let dayDr = 0;
  let dayCr = 0;
  let dayCount = 0;
  let totalDr = 0;
  let totalCr = 0;
  const byType = new Map<VoucherType, number>();
  groups.forEach((g, i) => {
    const link = linkOf(ctx, g);
    const dr = g.lines.reduce((s, l) => s + l.debit, 0);
    const cr = g.lines.reduce((s, l) => s + l.credit, 0);
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
    dayDr += dr;
    dayCr += cr;
    dayCount++;
    totalDr += dr;
    totalCr += cr;
    byType.set(g.voucherType, (byType.get(g.voucherType) ?? 0) + 1);
    const next = groups[i + 1];
    if (!next || next.date !== g.date) {
      rows.push({
        cells: { date: null, voucher: null, no: null, particulars: `Total for ${formatDate(g.date)} (${dayCount} ${dayCount === 1 ? 'voucher' : 'vouchers'})`, debit: dayDr, credit: dayCr },
        style: 'subtotal',
      });
      dayDr = 0;
      dayCr = 0;
      dayCount = 0;
    }
  });
  if (groups.length) rows.push({ cells: { date: null, voucher: null, no: null, particulars: 'Total', debit: totalDr, credit: totalCr }, style: 'total' });
  const notes = ['Cancelled bills and vouchers are not shown.'];
  if (truncated) notes.unshift(`Only the first ${MAX_ENTRIES} vouchers are shown. Choose a shorter period to see everything.`);
  const report: ReportData = {
    title: input.voucherType ? `Day book - ${VOUCHER_TYPE_LABELS[input.voucherType]}` : 'Day book',
    subtitle: describeRange(input),
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 11 },
      { key: 'voucher', label: 'Voucher', width: 18 },
      { key: 'no', label: 'No', width: 15 },
      { key: 'particulars', label: 'Particulars', width: 46 },
      { key: 'debit', label: 'Debit', type: 'money', width: 14 },
      { key: 'credit', label: 'Credit', type: 'money', width: 14 },
    ],
    rows,
    summary: [
      { label: 'Vouchers', value: groups.length, type: 'number' },
      { label: 'Total debit', value: totalDr, type: 'money' },
      { label: 'Total credit', value: totalCr, type: 'money' },
    ],
    notes,
    landscape: true,
  };
  return {
    report,
    voucherCount: groups.length,
    totalDebit: totalDr,
    totalCredit: totalCr,
    byType: [...byType.entries()].map(([type, count]) => ({ type, label: VOUCHER_TYPE_LABELS[type], count })),
  };
}
