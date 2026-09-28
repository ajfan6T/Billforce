/**
 * Day-to-day expenses (rent, electricity, tea, transport ...). Posting (contract):
 *   Dr expense head                         amount
 *   Cr cash / UPI / bank account            (paid now)
 *   Cr Sundry Creditors (supplier)          (on credit)
 */
import type { Ctx } from '../../context';
import { currentUserId, now } from '../../context';
import { fail } from '../../errors';
import { listRevisions, logActivity, recordRevision, type RevisionRow } from '../../audit';
import { nextDocNumber } from '../../numbering';
import { paymentAccountId, postEntry, replaceEntry, voidEntry, type EntryLineInput } from '../../accounting/ledger';
import { formatINR } from '../../../shared/money';
import { describeRange } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS, type PaymentMode } from '../../../shared/constants';
import type { ReportData, ReportRow } from '../../../shared/report';
import {
  activeAccount,
  assertClosedAccountsUntouched,
  assertSameYear,
  closedYearReason,
  entryLines,
  outflowWarnings,
  resolveVoucherDate,
  userName,
  type EntryLineView,
} from './common';
import { createAccount } from './chart';

export interface ExpenseInput {
  date?: string | null;
  /** Expense head (an expense-type account). */
  accountId: number;
  amount: number;
  mode: PaymentMode;
  /** Specific cash / bank account; default = the account for the mode. */
  payAccountId?: number | null;
  /** Required when on credit; optional otherwise (who was paid). */
  supplierId?: number | null;
  payee?: string | null;
  reference?: string | null;
  remarks?: string | null;
}

interface ExpenseRow {
  id: number;
  expense_no: string;
  seq: number;
  fy_start: string;
  date: string;
  account_id: number;
  amount: number;
  mode: PaymentMode;
  pay_account_id: number | null;
  supplier_id: number | null;
  payee: string | null;
  reference: string | null;
  remarks: string | null;
  status: 'active' | 'cancelled';
  revision: number;
  journal_entry_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_by: number | null;
  updated_at: string | null;
  cancelled_by: number | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

type JoinedRow = ExpenseRow & { account_name: string; group_name: string; pay_account_name: string | null; supplier_name: string | null };

const SELECT = `SELECT x.*, a.name AS account_name, g.name AS group_name, p.name AS pay_account_name, s.name AS supplier_name
  FROM expenses x
  JOIN accounts a ON a.id = x.account_id
  JOIN account_groups g ON g.code = a.group_code
  LEFT JOIN accounts p ON p.id = x.pay_account_id
  LEFT JOIN suppliers s ON s.id = x.supplier_id`;

export interface Expense {
  id: number;
  expenseNo: string;
  date: string;
  accountId: number;
  accountName: string;
  groupName: string;
  amount: number;
  mode: PaymentMode;
  payAccountId: number | null;
  payAccountName: string | null;
  supplierId: number | null;
  supplierName: string | null;
  payee: string | null;
  reference: string | null;
  remarks: string | null;
  status: 'active' | 'cancelled';
  revision: number;
  journalEntryId: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

function toExpense(ctx: Ctx, r: JoinedRow): Expense {
  return {
    id: r.id,
    expenseNo: r.expense_no,
    date: r.date,
    accountId: r.account_id,
    accountName: r.account_name,
    groupName: r.group_name,
    amount: r.amount,
    mode: r.mode,
    payAccountId: r.pay_account_id,
    payAccountName: r.pay_account_name,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    payee: r.payee,
    reference: r.reference,
    remarks: r.remarks,
    status: r.status,
    revision: r.revision,
    journalEntryId: r.journal_entry_id,
    createdBy: userName(ctx, r.created_by),
    createdAt: r.created_at,
    updatedBy: userName(ctx, r.updated_by),
    updatedAt: r.updated_at,
    cancelledBy: userName(ctx, r.cancelled_by),
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
  };
}

function row(ctx: Ctx, id: number): JoinedRow {
  const r = ctx.db.get<JoinedRow>(`${SELECT} WHERE x.id = ?`, [id]);
  if (!r) throw fail.notFound('Expense');
  return r;
}

export function getExpenseSimple(ctx: Ctx, id: number): Expense {
  return toExpense(ctx, row(ctx, id));
}

export interface ExpenseDetail extends Expense {
  posting: EntryLineView[];
  revisions: RevisionRow[];
  /** Why the expense can no longer be edited or cancelled (closed financial year); null = it can. */
  lockedReason: string | null;
}

export function getExpense(ctx: Ctx, id: number): ExpenseDetail {
  const e = getExpenseSimple(ctx, id);
  return {
    ...e,
    posting: e.journalEntryId ? entryLines(ctx, e.journalEntryId) : [],
    revisions: listRevisions(ctx, 'expense', id),
    lockedReason: closedYearReason(ctx, e.date),
  };
}

interface Resolved {
  date: string;
  account: { id: number; name: string };
  amount: number;
  mode: PaymentMode;
  payAccount: { id: number; name: string } | null;
  supplier: { id: number; name: string } | null;
  payee: string | null;
  reference: string | null;
  remarks: string | null;
}

function resolve(ctx: Ctx, input: ExpenseInput, keepDate?: string): Resolved {
  const date = resolveVoucherDate(ctx, input.date || keepDate, 'An expense');
  const acct = activeAccount(ctx, input.accountId, 'expense head');
  if (acct.type !== 'expense') {
    throw fail.validation(`"${acct.name}" is not an expense head. Choose one like Rent, Electricity or Transport.`, { accountId: 'Choose an expense head' });
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw fail.validation('Enter the amount spent', { amount: 'Enter the amount' });
  let supplier: Resolved['supplier'] = null;
  if (input.supplierId) {
    supplier = ctx.db.get<{ id: number; name: string }>('SELECT id, name FROM suppliers WHERE id = ?', [input.supplierId]) ?? null;
    if (!supplier) throw fail.validation('The supplier was not found. Please choose again.', { supplierId: 'Supplier not found' });
  }
  let payAccount: Resolved['payAccount'] = null;
  if (input.mode === 'credit') {
    if (!supplier) throw fail.validation('Choose the supplier you owe for this expense (on credit)', { supplierId: 'Choose a supplier' });
  } else {
    const payId = paymentAccountId(ctx, input.mode, input.payAccountId);
    payAccount = activeAccount(ctx, payId, `${PAYMENT_MODE_LABELS[input.mode]} account`);
  }
  return {
    date,
    account: acct,
    amount: input.amount,
    mode: input.mode,
    payAccount,
    supplier,
    payee: input.payee?.trim() || null,
    reference: input.reference?.trim() || null,
    remarks: input.remarks?.trim() || null,
  };
}

function narrationOf(r: Resolved): string {
  const parts = [r.account.name];
  const who = r.payee ?? r.supplier?.name;
  if (r.mode === 'credit') parts.push(`on credit from ${r.supplier!.name}`);
  else if (who) parts.push(`paid to ${who}`);
  let text = parts.join(' - ');
  if (r.remarks) text += ` (${r.remarks})`;
  return text;
}

function linesOf(r: Resolved): EntryLineInput[] {
  return [
    { account: r.account.id, debit: r.amount },
    r.mode === 'credit'
      ? { account: 'AP', credit: r.amount, partyType: 'supplier', partyId: r.supplier!.id }
      : { account: r.payAccount!.id, credit: r.amount },
  ];
}

function howPaid(r: Resolved): string {
  return r.mode === 'credit' ? `on credit from ${r.supplier!.name}` : `by ${PAYMENT_MODE_LABELS[r.mode]}`;
}

/** An expense just saved, with warnings to show (e.g. cash going below zero). */
export type SavedExpense = ExpenseDetail & { warnings: string[] };

export function createExpense(ctx: Ctx, input: ExpenseInput): SavedExpense {
  const r = resolve(ctx, input);
  // Paying more than the cash / bank account holds is allowed (a receipt may not be entered yet) but the user is told.
  const warnings = outflowWarnings(ctx, linesOf(r), r.date);
  const no = nextDocNumber(ctx, 'expense', r.date);
  const ts = now(ctx);
  const id = ctx.db.insert('expenses', {
    expense_no: no.number,
    seq: no.seq,
    fy_start: no.fyStart,
    date: r.date,
    account_id: r.account.id,
    amount: r.amount,
    mode: r.mode,
    pay_account_id: r.payAccount?.id ?? null,
    supplier_id: r.supplier?.id ?? null,
    payee: r.payee,
    reference: r.reference,
    remarks: r.remarks,
    created_by: currentUserId(ctx),
    created_at: ts,
  });
  const entryId = postEntry(ctx, {
    date: r.date,
    voucherType: 'expense',
    voucherNo: no.number,
    sourceType: 'expense',
    sourceId: id,
    narration: narrationOf(r),
    lines: linesOf(r),
  });
  ctx.db.update('expenses', id, { journal_entry_id: entryId });
  const snap = getExpenseSimple(ctx, id);
  recordRevision(ctx, 'expense', id, 'created', { ...snap, posting: entryLines(ctx, entryId) });
  logActivity(ctx, 'expense.create', `Recorded expense ${no.number}: ${r.account.name} ${formatINR(r.amount)} ${howPaid(r)}`, {
    entityType: 'expense',
    entityId: id,
  });
  return { ...getExpense(ctx, id), warnings };
}

export function updateExpense(ctx: Ctx, id: number, input: ExpenseInput & { reason?: string | null }): SavedExpense {
  const before = getExpenseSimple(ctx, id);
  if (before.status === 'cancelled') throw fail.validation('This expense is cancelled and cannot be edited.');
  const r = resolve(ctx, input, before.date);
  assertSameYear(before.date, r.date, `Expense ${before.expenseNo}`);
  assertClosedAccountsUntouched(ctx, before.journalEntryId!, linesOf(r), 'change');
  const warnings = outflowWarnings(ctx, linesOf(r), r.date, before.journalEntryId!);
  replaceEntry(ctx, before.journalEntryId!, {
    date: r.date,
    voucherType: 'expense',
    voucherNo: before.expenseNo,
    sourceType: 'expense',
    sourceId: id,
    narration: narrationOf(r),
    lines: linesOf(r),
  });
  ctx.db.update('expenses', id, {
    date: r.date,
    account_id: r.account.id,
    amount: r.amount,
    mode: r.mode,
    pay_account_id: r.payAccount?.id ?? null,
    supplier_id: r.supplier?.id ?? null,
    payee: r.payee,
    reference: r.reference,
    remarks: r.remarks,
    revision: before.revision + 1,
    updated_by: currentUserId(ctx),
    updated_at: now(ctx),
  });
  const after = getExpenseSimple(ctx, id);
  const reason = input.reason?.trim() || null;
  recordRevision(ctx, 'expense', id, 'edited', { ...after, posting: entryLines(ctx, after.journalEntryId!) }, reason);
  const changes: string[] = [];
  if (before.amount !== after.amount) changes.push(`amount ${formatINR(before.amount)} → ${formatINR(after.amount)}`);
  if (before.accountId !== after.accountId) changes.push(`head ${before.accountName} → ${after.accountName}`);
  if (before.mode !== after.mode || before.payAccountId !== after.payAccountId || before.supplierId !== after.supplierId) changes.push(`now paid ${howPaid(r)}`);
  if (before.date !== after.date) changes.push('date changed');
  logActivity(ctx, 'expense.update', `Edited expense ${before.expenseNo}${changes.length ? ': ' + changes.join(', ') : ''}${reason ? ` (${reason})` : ''}`, {
    entityType: 'expense',
    entityId: id,
    details: { before, after, reason },
  });
  return { ...getExpense(ctx, id), warnings };
}

export function cancelExpense(ctx: Ctx, id: number, reason: string): ExpenseDetail {
  const before = getExpenseSimple(ctx, id);
  if (before.status === 'cancelled') throw fail.validation('This expense is already cancelled.');
  const why = reason.trim();
  if (!why) throw fail.validation('Enter the reason for cancelling', { reason: 'Enter a reason' });
  if (before.journalEntryId) {
    assertClosedAccountsUntouched(ctx, before.journalEntryId, null, 'cancel');
    voidEntry(ctx, before.journalEntryId, `Expense cancelled: ${why}`);
  }
  ctx.db.update('expenses', id, {
    status: 'cancelled',
    revision: before.revision + 1,
    cancelled_by: currentUserId(ctx),
    cancelled_at: now(ctx),
    cancel_reason: why,
  });
  const after = getExpenseSimple(ctx, id);
  recordRevision(ctx, 'expense', id, 'cancelled', { ...after, posting: before.journalEntryId ? entryLines(ctx, before.journalEntryId) : [] }, why);
  logActivity(ctx, 'expense.cancel', `Cancelled expense ${before.expenseNo} (${before.accountName} ${formatINR(before.amount)}): ${why}`, {
    entityType: 'expense',
    entityId: id,
  });
  return getExpense(ctx, id);
}

/* ------------------------------ Lists & summary ------------------------------ */

export interface ExpenseListQuery {
  from: string;
  to: string;
  accountId?: number | null;
  q?: string | null;
  status?: 'active' | 'cancelled' | null;
  mode?: PaymentMode | null;
}

export interface ExpenseTotals {
  count: number;
  amount: number;
  cash: number;
  upi: number;
  bank: number;
  credit: number;
  cancelled: number;
}

export function listExpenses(ctx: Ctx, query: ExpenseListQuery): { rows: Expense[]; totals: ExpenseTotals } {
  const where = ['x.date >= ?', 'x.date <= ?'];
  const params: unknown[] = [query.from, query.to];
  if (query.accountId) {
    where.push('x.account_id = ?');
    params.push(query.accountId);
  }
  if (query.status) {
    where.push('x.status = ?');
    params.push(query.status);
  }
  if (query.mode) {
    where.push('x.mode = ?');
    params.push(query.mode);
  }
  const q = query.q?.trim();
  if (q) {
    const like = `%${q}%`;
    where.push('(x.expense_no LIKE ? OR a.name LIKE ? OR x.payee LIKE ? OR x.remarks LIKE ? OR x.reference LIKE ? OR s.name LIKE ?)');
    params.push(like, like, like, like, like, like);
  }
  const rows = ctx.db.all<JoinedRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY x.date DESC, x.id DESC`, params).map((r) => toExpense(ctx, r));
  const totals: ExpenseTotals = { count: 0, amount: 0, cash: 0, upi: 0, bank: 0, credit: 0, cancelled: 0 };
  for (const r of rows) {
    if (r.status === 'cancelled') {
      totals.cancelled++;
      continue;
    }
    totals.count++;
    totals.amount += r.amount;
    totals[r.mode] += r.amount;
  }
  return { rows, totals };
}

export function expenseSummary(ctx: Ctx, range: { from: string; to: string }): ReportData {
  const heads = ctx.db.all<{ account_id: number; name: string; group_name: string; n: number; amount: number }>(
    `SELECT x.account_id, a.name, g.name AS group_name, COUNT(*) AS n, SUM(x.amount) AS amount
       FROM expenses x JOIN accounts a ON a.id = x.account_id JOIN account_groups g ON g.code = a.group_code
      WHERE x.status = 'active' AND x.date >= ? AND x.date <= ?
      GROUP BY x.account_id ORDER BY amount DESC, a.name COLLATE NOCASE`,
    [range.from, range.to],
  );
  const total = heads.reduce((s, h) => s + h.amount, 0);
  const count = heads.reduce((s, h) => s + h.n, 0);
  const byMode = ctx.db.all<{ mode: PaymentMode; amount: number }>(
    "SELECT mode, SUM(amount) AS amount FROM expenses WHERE status = 'active' AND date >= ? AND date <= ? GROUP BY mode",
    [range.from, range.to],
  );
  const modeAmt = (m: PaymentMode) => byMode.find((b) => b.mode === m)?.amount ?? 0;
  const rows: ReportRow[] = heads.map((h) => ({
    cells: { head: h.name, group: h.group_name, count: h.n, amount: h.amount, share: total ? Math.round((h.amount / total) * 1000) / 10 : 0 },
    link: { kind: 'account', id: h.account_id },
  }));
  if (heads.length) rows.push({ cells: { head: 'Total', group: null, count, amount: total, share: 100 }, style: 'total' });
  return {
    title: 'Expenses by head',
    subtitle: describeRange(range),
    columns: [
      { key: 'head', label: 'Expense head', width: 30 },
      { key: 'group', label: 'Group', width: 20 },
      { key: 'count', label: 'Entries', type: 'number', width: 9 },
      { key: 'amount', label: 'Amount', type: 'money', width: 15 },
      { key: 'share', label: 'Share', type: 'percent', width: 9 },
    ],
    rows,
    summary: [
      { label: 'Total expenses', value: total, type: 'money' },
      { label: 'Cash', value: modeAmt('cash'), type: 'money' },
      { label: 'UPI', value: modeAmt('upi'), type: 'money' },
      { label: 'Bank', value: modeAmt('bank'), type: 'money' },
      { label: 'On credit', value: modeAmt('credit'), type: 'money' },
    ],
    notes: ['Only expenses entered on the Expenses page. Purchases and salaries are in their own reports; Profit & loss shows every cost.'],
  };
}

/** Add a new expense head from the expense form. */
export function addExpenseHead(ctx: Ctx, input: { name: string; groupCode?: 'indirect_expenses' | 'direct_expenses' }): { id: number; name: string } {
  const a = createAccount(ctx, { name: input.name, groupCode: input.groupCode ?? 'indirect_expenses' });
  return { id: a.id, name: a.name };
}
