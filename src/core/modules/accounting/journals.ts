/**
 * Journal vouchers entered by hand, plus the generic journal-entry view and
 * list used for every entry in the books (including those posted
 * automatically by bills, purchases, salaries ...).
 *
 * Entries made from the Accounts pages (source_type 'manual': journal,
 * capital, drawings, contra; and 'loan' transactions) can be edited and
 * cancelled here. Entries that belong to a document must be changed from
 * that document.
 */
import type { Ctx } from '../../context';
import { can } from '../../context';
import { fail } from '../../errors';
import { listRevisions, logActivity, recordRevision, type RevisionRow } from '../../audit';
import { nextDocNumber } from '../../numbering';
import { getEntry, postEntry, replaceEntry, voidEntry, type EntryLineInput } from '../../accounting/ledger';
import { entrySourceLink, type DocLink } from '../../accounting/links';
import { formatINR } from '../../../shared/money';
import { fyOf } from '../../../shared/dates';
import type { PartyType, VoucherType } from '../../../shared/constants';
import {
  activeAccount,
  assertClosedAccountsUntouched,
  assertEditableEntry,
  assertLoanOpen,
  assertSameYear,
  entryLines,
  entrySnapshot,
  inList,
  lineName,
  joinNames,
  lockReason,
  closedYearReason,
  outflowWarnings,
  resolveVoucherDate,
  savedAccount,
  SOURCE_LABELS,
  userName,
  voucherLabel,
  type EntryLineView,
} from './common';

export interface JournalLineInput {
  accountId: number;
  debit?: number;
  credit?: number;
  partyType?: PartyType | null;
  partyId?: number | null;
  memo?: string | null;
}

export interface JournalInput {
  date?: string | null;
  narration: string;
  lines: JournalLineInput[];
}

/**
 * Validate hand-entered lines and turn them into ledger lines (zero lines are dropped).
 * `savedAccountIds`: when editing, the accounts already on the entry. They stay allowed after
 * being deactivated; a new line on an inactive account is refused.
 */
export function toLedgerLines(ctx: Ctx, lines: JournalLineInput[], savedAccountIds?: ReadonlySet<number>): EntryLineInput[] {
  const out: EntryLineInput[] = [];
  lines.forEach((l, i) => {
    const debit = l.debit ?? 0;
    const credit = l.credit ?? 0;
    if (debit > 0 && credit > 0) throw fail.validation(`Line ${i + 1}: enter either a debit or a credit, not both`, { [`lines.${i}`]: 'Debit or credit, not both' });
    if (!debit && !credit) return;
    const acct = savedAccountIds?.has(l.accountId) ? savedAccount(ctx, l.accountId) : activeAccount(ctx, l.accountId);
    // Stock in Hand follows the stock itself (the reports value it from the stock movements).
    if (acct.system_key === 'STOCK' && !savedAccountIds?.has(acct.id)) {
      throw fail.validation(
        `"${acct.name}" changes with your stock: enter purchases, stock counts or adjustments, or the opening stock (Stock > Opening stock), not a journal entry.`,
        { [`lines.${i}.accountId`]: 'Not allowed in a journal' },
      );
    }
    out.push({
      account: acct.id,
      debit,
      credit,
      partyType: acct.party_type ? (l.partyType ?? null) : null,
      partyId: acct.party_type ? (l.partyId ?? null) : null,
      memo: l.memo?.trim() || null,
    });
  });
  if (out.length < 2) throw fail.validation('A journal entry needs at least one debit line and one credit line', { lines: 'Add at least two lines' });
  const dr = out.reduce((s, l) => s + (l.debit ?? 0), 0);
  const cr = out.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (!dr || !cr) throw fail.validation('A journal entry needs at least one debit line and one credit line', { lines: 'Add a debit and a credit' });
  if (dr !== cr) {
    throw fail.validation(`Total debit ${formatINR(dr)} and total credit ${formatINR(cr)} must be equal (difference ${formatINR(Math.abs(dr - cr))}).`, {
      lines: 'Debits and credits are not equal',
    });
  }
  return out;
}

export interface ManualPosting {
  date: string;
  voucherType: VoucherType;
  narration: string | null;
  lines: EntryLineInput[];
  sourceType?: 'manual' | 'loan';
  sourceId?: number | null;
}

/**
 * Post a voucher entered from the Accounts pages: takes the next "JV" number,
 * posts the entry, records revision 1 and logs the activity. Returns the entry
 * id and warnings when money paid out would leave a cash / bank account below zero.
 */
export function postManualVoucher(
  ctx: Ctx,
  p: ManualPosting,
  activity: { action: string; summary: (voucherNo: string) => string; entityType?: string; entityId?: number },
): { id: number; warnings: string[] } {
  const warnings = outflowWarnings(ctx, p.lines, p.date);
  const no = nextDocNumber(ctx, 'journal', p.date);
  const id = postEntry(ctx, {
    date: p.date,
    voucherType: p.voucherType,
    voucherNo: no.number,
    sourceType: p.sourceType ?? 'manual',
    sourceId: p.sourceId ?? null,
    narration: p.narration,
    lines: p.lines,
  });
  recordRevision(ctx, 'journal', id, 'created', entrySnapshot(ctx, id));
  logActivity(ctx, activity.action, activity.summary(no.number), {
    entityType: activity.entityType ?? 'journal',
    entityId: activity.entityId ?? id,
    details: { entryId: id, voucherNo: no.number },
  });
  return { id, warnings };
}

function entryTotal(lines: EntryLineInput[]): number {
  return lines.reduce((s, l) => s + (l.debit ?? 0), 0);
}

/** An entry just saved, with warnings to show (e.g. cash going below zero). */
export type SavedEntry = EntryDetail & { warnings: string[] };

export function createJournal(ctx: Ctx, input: JournalInput): SavedEntry {
  const date = resolveVoucherDate(ctx, input.date, 'A journal entry');
  const narration = input.narration.trim();
  if (!narration) throw fail.validation('Write a narration: what is this entry for?', { narration: 'Enter a narration' });
  const lines = toLedgerLines(ctx, input.lines);
  const { id, warnings } = postManualVoucher(
    ctx,
    { date, voucherType: 'journal', narration, lines },
    { action: 'journal.create', summary: (no) => `Entered journal ${no} for ${formatINR(entryTotal(lines))}: ${narration}` },
  );
  return { ...getEntryDetail(ctx, id), warnings };
}

export function updateJournal(ctx: Ctx, entryId: number, input: JournalInput & { reason?: string | null }): SavedEntry {
  const e = assertEditableEntry(ctx, entryId);
  assertLoanOpen(ctx, e, 'change');
  const before = entrySnapshot(ctx, entryId);
  const date = resolveVoucherDate(ctx, input.date || e.date, 'A journal entry');
  assertSameYear(e.date, date, `Voucher ${e.voucher_no ?? '#' + e.id}`);
  const narration = input.narration.trim();
  if (!narration && e.voucher_type === 'journal') throw fail.validation('Write a narration: what is this entry for?', { narration: 'Enter a narration' });
  const saved = new Set(ctx.db.all<{ account_id: number }>('SELECT DISTINCT account_id FROM journal_lines WHERE entry_id = ?', [entryId]).map((r) => r.account_id));
  const lines = toLedgerLines(ctx, input.lines, saved);
  if (e.source_type === 'loan' && e.source_id) {
    const loan = ctx.db.get<{ account_id: number; name: string }>('SELECT account_id, name FROM loans WHERE id = ?', [e.source_id]);
    const hadLoanLine = !!loan && ctx.db.value<number>('SELECT COUNT(*) FROM journal_lines WHERE entry_id = ? AND account_id = ?', [entryId, loan.account_id], 0) > 0;
    if (loan && hadLoanLine && !lines.some((l) => l.account === loan.account_id)) {
      const acctName = ctx.db.value<string>('SELECT name FROM accounts WHERE id = ?', [loan.account_id], 'the loan account');
      throw fail.validation(`This is a loan entry, so it must keep a line on "${acctName}".`, { lines: 'Keep the loan account' });
    }
  }
  assertClosedAccountsUntouched(ctx, entryId, lines, 'change');
  const warnings = outflowWarnings(ctx, lines, date, entryId);
  replaceEntry(ctx, entryId, {
    date,
    voucherType: e.voucher_type,
    voucherNo: e.voucher_no,
    sourceType: e.source_type,
    sourceId: e.source_id,
    narration: narration || null,
    lines,
  });
  const after = entrySnapshot(ctx, entryId);
  const reason = input.reason?.trim() || null;
  recordRevision(ctx, 'journal', entryId, 'edited', after, reason);
  const changes: string[] = [];
  if (before.total !== after.total) changes.push(`amount ${formatINR(before.total as number)} → ${formatINR(after.total as number)}`);
  if (before.date !== after.date) changes.push(`date changed`);
  logActivity(
    ctx,
    e.source_type === 'loan' ? 'loan.transaction_edit' : 'journal.update',
    `Edited ${voucherLabel(e.voucher_type).toLowerCase()} ${e.voucher_no ?? '#' + e.id}${changes.length ? ': ' + changes.join(', ') : ''}${reason ? ` (${reason})` : ''}`,
    { entityType: 'journal', entityId: entryId, details: { before, after, reason } },
  );
  return { ...getEntryDetail(ctx, entryId), warnings };
}

/** Cancel a voucher entered from the Accounts pages (journal, capital, drawings, transfer, loan transaction). */
export function cancelEntry(ctx: Ctx, entryId: number, reason: string): EntryDetail {
  const e = assertEditableEntry(ctx, entryId);
  const why = reason.trim();
  if (!why) throw fail.validation('Enter the reason for cancelling', { reason: 'Enter a reason' });
  assertClosedAccountsUntouched(ctx, entryId, null, 'cancel');
  voidEntry(ctx, entryId, why);
  const snap = entrySnapshot(ctx, entryId);
  recordRevision(ctx, 'journal', entryId, 'cancelled', snap, why);
  logActivity(
    ctx,
    e.source_type === 'loan' ? 'loan.transaction_cancel' : 'journal.cancel',
    `Cancelled ${voucherLabel(e.voucher_type).toLowerCase()} ${e.voucher_no ?? '#' + e.id} of ${formatINR(snap.total as number)}: ${why}`,
    { entityType: 'journal', entityId: entryId, details: { reason: why } },
  );
  return getEntryDetail(ctx, entryId);
}

/* ------------------------------ Entry view ------------------------------ */

export interface EntryDetail {
  id: number;
  date: string;
  voucherType: VoucherType;
  voucherLabel: string;
  voucherNo: string | null;
  narration: string | null;
  isVoid: boolean;
  voidReason: string | null;
  sourceType: string | null;
  sourceLabel: string;
  sourceId: number | null;
  /** The document this entry came from (or the entry itself for manual ones). */
  link: DocLink;
  /** True when the entry belongs to a document on another page. */
  fromDocument: boolean;
  lines: EntryLineView[];
  totalDebit: number;
  totalCredit: number;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Can be edited / cancelled from the Accounts pages (by someone with accounts.manage). */
  editable: boolean;
  canEdit: boolean;
  lockedReason: string | null;
  loan: { id: number; name: string } | null;
  revisions: RevisionRow[];
}

export function getEntryDetail(ctx: Ctx, entryId: number): EntryDetail {
  const e = getEntry(ctx, entryId);
  const lines = entryLines(ctx, entryId);
  const loanRow =
    e.source_type === 'loan' && e.source_id ? (ctx.db.get<{ id: number; name: string; is_active: number }>('SELECT id, name, is_active FROM loans WHERE id = ?', [e.source_id]) ?? null) : null;
  const loan = loanRow ? { id: loanRow.id, name: loanRow.name } : null;
  const loanClosed = loanRow && !loanRow.is_active ? `The loan "${loanRow.name}" is closed. Re-open it from Accounts > Loans to change this entry.` : null;
  const reason = lockReason(e) ?? closedYearReason(ctx, e.date) ?? loanClosed;
  const link = entrySourceLink(ctx, e);
  const ownRevisions = e.source_type === 'manual' || e.source_type === 'loan';
  return {
    id: e.id,
    date: e.date,
    voucherType: e.voucher_type,
    voucherLabel: voucherLabel(e.voucher_type),
    voucherNo: e.voucher_no,
    narration: e.narration,
    isVoid: !!e.is_void,
    voidReason: e.void_reason,
    sourceType: e.source_type,
    sourceLabel: SOURCE_LABELS[e.source_type ?? ''] ?? voucherLabel(e.voucher_type),
    sourceId: e.source_id,
    link,
    fromDocument: link.kind !== 'journal',
    lines,
    totalDebit: lines.reduce((s, l) => s + l.debit, 0),
    totalCredit: lines.reduce((s, l) => s + l.credit, 0),
    createdBy: userName(ctx, e.created_by),
    createdAt: e.created_at,
    updatedBy: userName(ctx, e.updated_by),
    updatedAt: e.updated_at,
    editable: !reason,
    canEdit: !reason && can(ctx, 'accounts.manage'),
    lockedReason: e.is_void ? null : reason,
    loan,
    revisions: ownRevisions ? listRevisions(ctx, 'journal', e.id) : [],
  };
}

/* ------------------------------ Entry list ------------------------------ */

export interface EntryListRow {
  id: number;
  date: string;
  voucherType: VoucherType;
  voucherLabel: string;
  voucherNo: string | null;
  narration: string | null;
  amount: number;
  debitNames: string;
  creditNames: string;
  sourceType: string | null;
  sourceLabel: string;
  link: DocLink;
  isVoid: boolean;
  editable: boolean;
}

export interface EntryListQuery {
  from: string;
  to: string;
  voucherType?: VoucherType | null;
  q?: string | null;
  accountId?: number | null;
  status?: 'all' | 'active' | 'cancelled';
  /** Rows per page (default 500). */
  limit?: number;
  /** Page of rows (1 = the latest entries). */
  page?: number | null;
  /** Every matching entry on one page (for exports). */
  all?: boolean | null;
}

export interface EntryListResult {
  rows: EntryListRow[];
  /** Entries matching the filters in the whole period. */
  total: number;
  /** True when only some of them are on this page. */
  truncated: boolean;
  /** Total amount of the active matching entries in the whole period. */
  totalAmount: number;
  page: number;
  pageCount: number;
  pageSize: number;
  /** Position (1-based, newest first) of the first and last row shown; 0 when none. */
  firstShown: number;
  lastShown: number;
}

export function listEntries(ctx: Ctx, query: EntryListQuery): EntryListResult {
  const where = ['e.date >= ?', 'e.date <= ?'];
  const params: unknown[] = [query.from, query.to];
  if (query.voucherType) {
    where.push('e.voucher_type = ?');
    params.push(query.voucherType);
  }
  if (query.accountId) {
    // "+" makes SQLite look up each entry's own lines instead of walking the account's whole history per entry.
    where.push('EXISTS (SELECT 1 FROM journal_lines x WHERE x.entry_id = e.id AND +x.account_id = ?)');
    params.push(query.accountId);
  }
  const status = query.status ?? 'all';
  if (status === 'active') where.push('e.is_void = 0');
  if (status === 'cancelled') where.push('e.is_void = 1');
  const q = query.q?.trim();
  if (q) {
    const like = `%${q}%`;
    const any = [
      'e.voucher_no LIKE ?',
      'e.narration LIKE ?',
      `EXISTS (SELECT 1 FROM journal_lines x JOIN accounts a ON a.id = x.account_id
         LEFT JOIN customers c ON x.party_type = 'customer' AND c.id = x.party_id
         LEFT JOIN suppliers s ON x.party_type = 'supplier' AND s.id = x.party_id
         LEFT JOIN employees m ON x.party_type = 'employee' AND m.id = x.party_id
        WHERE x.entry_id = e.id AND (a.name LIKE ? OR c.name LIKE ? OR s.name LIKE ? OR m.name LIKE ? OR x.memo LIKE ?))`,
    ];
    params.push(like, like, like, like, like, like, like);
    // Typing an amount ("1500" or "1,500.50") finds entries of exactly that total.
    const amount = /^[₹\d,.\s]+$/.test(q) ? Number(q.replace(/[₹,\s]/g, '')) : NaN;
    if (Number.isFinite(amount) && amount > 0) {
      any.push('(SELECT SUM(y.debit) FROM journal_lines y WHERE y.entry_id = e.id) = ?');
      params.push(Math.round(amount * 100));
    }
    where.push(`(${any.join(' OR ')})`);
  }
  const whereSql = where.join(' AND ');
  const total = ctx.db.value<number>(`SELECT COUNT(*) FROM journal_entries e WHERE ${whereSql}`, params, 0);
  const totalAmount = ctx.db.value<number>(
    `SELECT COALESCE(SUM(l.debit), 0) FROM journal_entries e CROSS JOIN journal_lines l ON l.entry_id = e.id WHERE ${whereSql} AND e.is_void = 0`,
    params,
    0,
  );
  const size = query.all ? Math.max(total, 1) : (query.limit ?? 500);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, Math.floor(query.page ?? 1)), pageCount);
  const offset = (page - 1) * size;
  const entries = ctx.db.all<{
    id: number;
    date: string;
    voucher_type: VoucherType;
    voucher_no: string | null;
    narration: string | null;
    source_type: string | null;
    source_id: number | null;
    is_void: number;
  }>(
    `SELECT e.id, e.date, e.voucher_type, e.voucher_no, e.narration, e.source_type, e.source_id, e.is_void
       FROM journal_entries e WHERE ${whereSql} ORDER BY e.date DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset],
  );
  const lines = new Map<number, Array<{ account_name: string; party_name: string | null; debit: number; credit: number }>>();
  if (entries.length) {
    const ids = entries.map((e) => e.id);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = ctx.db.all<{ entry_id: number; account_name: string; party_name: string | null; debit: number; credit: number }>(
        `SELECT l.entry_id, a.name AS account_name, l.debit, l.credit,
                CASE l.party_type WHEN 'customer' THEN (SELECT name FROM customers WHERE id = l.party_id)
                                  WHEN 'supplier' THEN (SELECT name FROM suppliers WHERE id = l.party_id)
                                  WHEN 'employee' THEN (SELECT name FROM employees WHERE id = l.party_id) END AS party_name
           FROM journal_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.entry_id IN (${inList(chunk.length)}) ORDER BY l.entry_id, l.line_no`,
        chunk,
      );
      for (const r of rows) {
        const list = lines.get(r.entry_id) ?? [];
        list.push(r);
        lines.set(r.entry_id, list);
      }
    }
  }
  // One closed-year check per financial year, not per row.
  const closedYears = new Map<string, boolean>();
  const inClosedYear = (date: string) => {
    const fy = fyOf(date).start;
    if (!closedYears.has(fy)) closedYears.set(fy, !!closedYearReason(ctx, date));
    return closedYears.get(fy)!;
  };
  const rows = entries.map((e) => {
    const ls = lines.get(e.id) ?? [];
    return {
      id: e.id,
      date: e.date,
      voucherType: e.voucher_type,
      voucherLabel: voucherLabel(e.voucher_type),
      voucherNo: e.voucher_no,
      narration: e.narration,
      amount: ls.reduce((s, l) => s + l.debit, 0),
      debitNames: joinNames(ls.filter((l) => l.debit > 0).map(lineName)),
      creditNames: joinNames(ls.filter((l) => l.credit > 0).map(lineName)),
      sourceType: e.source_type,
      sourceLabel: SOURCE_LABELS[e.source_type ?? ''] ?? voucherLabel(e.voucher_type),
      link: entrySourceLink(ctx, e),
      isVoid: !!e.is_void,
      editable: !lockReason(e) && !inClosedYear(e.date),
    };
  });
  return {
    rows,
    total,
    truncated: total > rows.length,
    totalAmount,
    page,
    pageCount,
    pageSize: size,
    firstShown: rows.length ? offset + 1 : 0,
    lastShown: offset + rows.length,
  };
}
