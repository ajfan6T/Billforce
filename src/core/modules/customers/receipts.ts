/**
 * Payments received from customers (money coming in against their dues).
 * Posting: Dr cash/bank (amount), Dr Discount Allowed (discount), Cr Sundry Debtors (customer) amount + discount.
 */
import type { Ctx } from '../../context';
import { assertCan, currentUserId, now } from '../../context';
import { fail } from '../../errors';
import { logActivity, listRevisions, recordRevision, type RevisionRow } from '../../audit';
import { nextDocNumber } from '../../numbering';
import { getSection } from '../../settings';
import { partyBalance, paymentAccountId, postEntry, replaceEntry, voidEntry, type EntryInput } from '../../accounting/ledger';
import { renderReceiptHtml } from '../../print/receipt';
import { amountInWords, formatDrCr, formatINR } from '../../../shared/money';
import { formatDate, formatTime } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS, type SettlementMode } from '../../../shared/constants';
import { assertCancelKeepsClosedAccounts } from '../accounting/common';
import { advanceWarning, assertSameFinancialYear, balanceThroughEntry, modeText, postingLines, resolveDocDate, type PostingLine } from './common';
import { getCustomerRow } from './service';

export interface ReceiptInput {
  customerId: number;
  /** Defaults to today; another date needs the "past date" permission. */
  date?: string | null;
  /** Amount received in paise. */
  amount: number;
  /** Settlement discount allowed in paise. */
  discount?: number;
  mode: SettlementMode;
  /** Specific cash / bank account; default account for the mode when omitted. */
  accountId?: number | null;
  /** UPI transaction id, cheque number... */
  reference?: string | null;
  remarks?: string | null;
}

interface ReceiptRow {
  id: number;
  receipt_no: string;
  seq: number;
  fy_start: string;
  date: string;
  customer_id: number;
  amount: number;
  discount: number;
  mode: SettlementMode;
  account_id: number;
  reference: string | null;
  remarks: string | null;
  status: 'active' | 'cancelled';
  revision: number;
  print_count: number;
  journal_entry_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_by: number | null;
  updated_at: string | null;
  cancelled_by: number | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

export interface Receipt {
  id: number;
  receiptNo: string;
  date: string;
  customerId: number;
  customerName: string;
  customerPhone: string | null;
  amount: number;
  discount: number;
  mode: SettlementMode;
  accountId: number;
  accountName: string;
  reference: string | null;
  remarks: string | null;
  status: 'active' | 'cancelled';
  revision: number;
  printCount: number;
  journalEntryId: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface ReceiptDetail extends Receipt {
  /** Customer balance just before / after this payment (null when cancelled). */
  balanceBefore: number | null;
  balanceAfter: number | null;
  /** Customer's balance today. */
  currentBalance: number;
  posting: PostingLine[];
  revisions: RevisionRow[];
}

const SELECT = `SELECT r.*, c.name AS customer_name, c.phone AS customer_phone, a.name AS account_name,
    uc.full_name AS created_by_name, uu.full_name AS updated_by_name, ux.full_name AS cancelled_by_name
  FROM customer_receipts r
  JOIN customers c ON c.id = r.customer_id
  JOIN accounts a ON a.id = r.account_id
  LEFT JOIN users uc ON uc.id = r.created_by
  LEFT JOIN users uu ON uu.id = r.updated_by
  LEFT JOIN users ux ON ux.id = r.cancelled_by`;

type JoinedRow = ReceiptRow & {
  customer_name: string;
  customer_phone: string | null;
  account_name: string;
  created_by_name: string | null;
  updated_by_name: string | null;
  cancelled_by_name: string | null;
};

function toReceipt(r: JoinedRow): Receipt {
  return {
    id: r.id,
    receiptNo: r.receipt_no,
    date: r.date,
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    amount: r.amount,
    discount: r.discount,
    mode: r.mode,
    accountId: r.account_id,
    accountName: r.account_name,
    reference: r.reference,
    remarks: r.remarks,
    status: r.status,
    revision: r.revision,
    printCount: r.print_count,
    journalEntryId: r.journal_entry_id,
    createdBy: r.created_by_name,
    createdAt: r.created_at,
    updatedBy: r.updated_by_name,
    updatedAt: r.updated_at,
    cancelledBy: r.cancelled_by_name,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
  };
}

function getRow(ctx: Ctx, id: number): JoinedRow {
  const r = ctx.db.get<JoinedRow>(`${SELECT} WHERE r.id = ?`, [id]);
  if (!r) throw fail.notFound('Payment');
  return r;
}

export function getReceipt(ctx: Ctx, id: number): Receipt {
  return toReceipt(getRow(ctx, id));
}

export function getReceiptDetail(ctx: Ctx, id: number): ReceiptDetail {
  const r = getRow(ctx, id);
  let balanceBefore: number | null = null;
  let balanceAfter: number | null = null;
  if (r.status === 'active' && r.journal_entry_id) {
    balanceAfter = balanceThroughEntry(ctx, 'customer', r.customer_id, 'AR', r.date, r.journal_entry_id);
    balanceBefore = balanceAfter + r.amount + r.discount;
  }
  return {
    ...toReceipt(r),
    balanceBefore,
    balanceAfter,
    currentBalance: partyBalance(ctx, 'customer', r.customer_id, { account: 'AR' }),
    posting: postingLines(ctx, r.journal_entry_id),
    revisions: listRevisions(ctx, 'receipt', id),
  };
}

function entryFor(receiptId: number, receiptNo: string, date: string, customer: { id: number; name: string }, v: NormalizedReceipt): EntryInput {
  return {
    date,
    voucherType: 'receipt',
    voucherNo: receiptNo,
    sourceType: 'receipt',
    sourceId: receiptId,
    narration: `Payment received from ${customer.name} (${modeText(v.mode, v.reference)})${v.discount ? `, discount ${formatINR(v.discount)}` : ''}`,
    lines: [
      { account: v.accountId, debit: v.amount },
      { account: 'DISCOUNT_ALLOWED', debit: v.discount },
      { account: 'AR', credit: v.amount + v.discount, partyType: 'customer', partyId: customer.id },
    ],
  };
}

interface NormalizedReceipt {
  amount: number;
  discount: number;
  mode: SettlementMode;
  accountId: number;
  reference: string | null;
  remarks: string | null;
}

const DISCOUNT_DENIED = 'You are not allowed to give discounts. Ask the owner or manager to allow "Give discounts", or record the payment without a discount.';

/**
 * Validate amounts against what the customer owes (dueBefore excludes the receipt being edited).
 * A settlement discount writes off part of the dues, so it needs "Give discounts" (billing.discount),
 * like a discount on a bill. `allowedDiscount` is what the user may keep without it (the saved discount, when editing).
 */
function normalize(ctx: Ctx, input: ReceiptInput, customerName: string, dueBefore: number, allowedDiscount = 0): NormalizedReceipt {
  const amount = input.amount;
  const discount = input.discount ?? 0;
  if (amount + discount <= 0) throw fail.validation('Enter the amount received', { amount: 'Enter the amount received' });
  if (discount > allowedDiscount) assertCan(ctx, 'billing.discount', DISCOUNT_DENIED);
  // A discount settles what is left unpaid; it can never turn into an advance.
  const maxDiscount = Math.max(dueBefore - amount, 0);
  if (discount > maxDiscount) {
    throw fail.validation(
      dueBefore <= 0
        ? `${customerName} has nothing due, so a discount cannot be given.`
        : `The discount cannot be more than the amount still due after this payment (${formatINR(maxDiscount)}).`,
      { discount: `At most ${formatINR(maxDiscount)}` },
    );
  }
  return {
    amount,
    discount,
    mode: input.mode,
    accountId: paymentAccountId(ctx, input.mode, input.accountId),
    reference: input.reference?.trim() || null,
    remarks: input.remarks?.trim() || null,
  };
}

export type SavedReceipt = Receipt & { warnings: string[] };

export function createReceipt(ctx: Ctx, input: ReceiptInput): SavedReceipt {
  const customer = getCustomerRow(ctx, input.customerId);
  const date = resolveDocDate(ctx, input.date, { what: 'A payment', backdatePermission: 'billing.backdate' });
  const due = partyBalance(ctx, 'customer', customer.id, { account: 'AR' });
  const v = normalize(ctx, input, customer.name, due);
  const num = nextDocNumber(ctx, 'receipt', date);
  const id = ctx.db.insert('customer_receipts', {
    receipt_no: num.number,
    seq: num.seq,
    fy_start: num.fyStart,
    date,
    customer_id: customer.id,
    amount: v.amount,
    discount: v.discount,
    mode: v.mode,
    account_id: v.accountId,
    reference: v.reference,
    remarks: v.remarks,
    created_by: currentUserId(ctx),
    created_at: now(ctx),
  });
  const entryId = postEntry(ctx, entryFor(id, num.number, date, customer, v));
  ctx.db.update('customer_receipts', id, { journal_entry_id: entryId });
  const saved = getReceipt(ctx, id);
  recordRevision(ctx, 'receipt', id, 'created', saved);
  logActivity(
    ctx,
    'receipt.create',
    `Received ${formatINR(v.amount)} from ${customer.name} by ${PAYMENT_MODE_LABELS[v.mode]} - ${num.number}${v.discount ? ` (discount ${formatINR(v.discount)})` : ''}`,
    { entityType: 'receipt', entityId: id, details: { customerId: customer.id, amount: v.amount, discount: v.discount, mode: v.mode, date } },
  );
  const warning = advanceWarning(customer.name, due, v.amount + v.discount, 'customer');
  return { ...saved, warnings: warning ? [warning] : [] };
}

export function updateReceipt(ctx: Ctx, id: number, input: ReceiptInput, reason?: string | null): SavedReceipt {
  assertCan(ctx, 'billing.edit', 'You do not have permission to change saved payments. Ask the owner or manager.');
  const before = getRow(ctx, id);
  if (before.status === 'cancelled') throw fail.validation('This payment was cancelled and cannot be edited.');
  const customer = getCustomerRow(ctx, input.customerId);
  const date = resolveDocDate(ctx, input.date, { what: 'A payment', backdatePermission: 'billing.backdate', unchangedDate: before.date });
  assertSameFinancialYear(before.date, date, `Payment ${before.receipt_no}`);
  const due =
    partyBalance(ctx, 'customer', customer.id, { account: 'AR' }) + (before.customer_id === customer.id ? before.amount + before.discount : 0);
  // Keeping (or lowering) the saved discount for the same customer is fine; a bigger or moved discount needs permission.
  const v = normalize(ctx, input, customer.name, due, before.customer_id === customer.id ? before.discount : 0);
  const revision = before.revision + 1;
  ctx.db.update('customer_receipts', id, {
    date,
    customer_id: customer.id,
    amount: v.amount,
    discount: v.discount,
    mode: v.mode,
    account_id: v.accountId,
    reference: v.reference,
    remarks: v.remarks,
    revision,
    updated_by: currentUserId(ctx),
    updated_at: now(ctx),
  });
  replaceEntry(ctx, before.journal_entry_id!, entryFor(id, before.receipt_no, date, customer, v));
  const saved = getReceipt(ctx, id);
  recordRevision(ctx, 'receipt', id, 'edited', saved, reason);
  const changes: string[] = [];
  if (before.amount !== v.amount) changes.push(`amount ${formatINR(before.amount)} → ${formatINR(v.amount)}`);
  if (before.discount !== v.discount) changes.push(`discount ${formatINR(before.discount)} → ${formatINR(v.discount)}`);
  if (before.mode !== v.mode) changes.push(`mode ${PAYMENT_MODE_LABELS[before.mode]} → ${PAYMENT_MODE_LABELS[v.mode]}`);
  if (before.date !== date) changes.push(`date ${formatDate(before.date)} → ${formatDate(date)}`);
  if (before.customer_id !== customer.id) changes.push(`customer ${before.customer_name} → ${customer.name}`);
  logActivity(
    ctx,
    'receipt.update',
    `Edited payment ${before.receipt_no}${changes.length ? ': ' + changes.join(', ') : ''}${reason ? ` (reason: ${reason})` : ''}`,
    { entityType: 'receipt', entityId: id, details: { before: toReceipt(before), after: saved, reason: reason ?? null } },
  );
  const warning = advanceWarning(customer.name, due, v.amount + v.discount, 'customer');
  return { ...saved, warnings: warning ? [warning] : [] };
}

export function cancelReceipt(ctx: Ctx, id: number, reason: string): Receipt {
  assertCan(ctx, 'billing.cancel', 'You do not have permission to cancel saved payments. Ask the owner or manager.');
  const r = getRow(ctx, id);
  if (r.status === 'cancelled') throw fail.validation('This payment is already cancelled.');
  const why = reason.trim();
  if (!why) throw fail.validation('Enter the reason for cancelling', { reason: 'Enter a reason' });
  assertCancelKeepsClosedAccounts(ctx, r.journal_entry_id, 'this payment');
  if (r.journal_entry_id) voidEntry(ctx, r.journal_entry_id, `Payment ${r.receipt_no} cancelled: ${why}`);
  ctx.db.update('customer_receipts', id, {
    status: 'cancelled',
    revision: r.revision + 1,
    cancelled_by: currentUserId(ctx),
    cancelled_at: now(ctx),
    cancel_reason: why,
  });
  const saved = getReceipt(ctx, id);
  recordRevision(ctx, 'receipt', id, 'cancelled', saved, why);
  logActivity(ctx, 'receipt.cancel', `Cancelled payment ${r.receipt_no} of ${formatINR(r.amount)} from ${r.customer_name}: ${why}`, {
    entityType: 'receipt',
    entityId: id,
    details: { reason: why },
  });
  return saved;
}

export interface ReceiptListQuery {
  from?: string | null;
  to?: string | null;
  q?: string | null;
  customerId?: number | null;
  mode?: SettlementMode | null;
  status?: 'active' | 'cancelled' | null;
}

export interface ReceiptTotals {
  count: number;
  amount: number;
  discount: number;
  byMode: Record<SettlementMode, number>;
  cancelled: number;
}

export function listReceipts(ctx: Ctx, query: ReceiptListQuery): { rows: Receipt[]; totals: ReceiptTotals } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.from) {
    where.push('r.date >= :from');
    params.from = query.from;
  }
  if (query.to) {
    where.push('r.date <= :to');
    params.to = query.to;
  }
  if (query.customerId) {
    where.push('r.customer_id = :customerId');
    params.customerId = query.customerId;
  }
  if (query.mode) {
    where.push('r.mode = :mode');
    params.mode = query.mode;
  }
  if (query.status) {
    where.push('r.status = :status');
    params.status = query.status;
  }
  const text = query.q?.trim();
  if (text) {
    where.push("(r.receipt_no LIKE :like OR c.name LIKE :like OR REPLACE(c.phone, ' ', '') LIKE :phone OR r.reference LIKE :like OR r.remarks LIKE :like)");
    params.like = `%${text}%`;
    params.phone = `%${text.replace(/\s/g, '')}%`;
  }
  const rows = ctx.db
    .all<JoinedRow>(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.date DESC, r.id DESC LIMIT 5000`, params)
    .map(toReceipt);
  const totals: ReceiptTotals = { count: 0, amount: 0, discount: 0, byMode: { cash: 0, upi: 0, bank: 0 }, cancelled: 0 };
  for (const r of rows) {
    if (r.status === 'cancelled') {
      totals.cancelled++;
      continue;
    }
    totals.count++;
    totals.amount += r.amount;
    totals.discount += r.discount;
    totals.byMode[r.mode] += r.amount;
  }
  return { rows, totals };
}

/* ------------------------------ Printing ------------------------------ */

export function receiptHtml(ctx: Ctx, id: number, opts: { duplicate?: boolean } = {}): string {
  const r = getReceiptDetail(ctx, id);
  const business = getSection(ctx, 'business');
  const settings = getSection(ctx, 'receipt');
  const duplicate = opts.duplicate ?? (settings.markDuplicate && r.printCount > 0);
  const meta: Array<[string, string]> = [
    ['Receipt No', r.receiptNo],
    ['Date', `${formatDate(r.date)}${r.createdAt.slice(0, 10) === r.date ? ' ' + formatTime(r.createdAt) : ''}`],
  ];
  if (settings.showCashier && r.createdBy) meta.push(['Received by', r.createdBy]);
  const totals = [{ label: 'Amount received', value: formatINR(r.amount), big: true }];
  if (r.discount) {
    totals.push({ label: 'Discount allowed', value: formatINR(r.discount), big: false });
    totals.push({ label: 'Total adjusted', value: formatINR(r.amount + r.discount), big: false });
  }
  const lines = [`Paid by ${modeText(r.mode, r.reference)}`, amountInWords(r.amount)];
  if (r.balanceBefore !== null && r.balanceAfter !== null) {
    lines.push(`Previous balance: ${formatDrCr(r.balanceBefore)}`);
    lines.push(`Balance now: ${r.balanceAfter > 0 ? `${formatINR(r.balanceAfter)} due` : r.balanceAfter < 0 ? `${formatINR(-r.balanceAfter)} advance` : 'Nil'}`);
  }
  if (r.remarks) lines.push(r.remarks);
  if (r.status === 'cancelled' && r.cancelReason) lines.push(`Cancelled: ${r.cancelReason}`);
  return renderReceiptHtml(
    {
      title: 'PAYMENT RECEIPT',
      duplicate,
      cancelled: r.status === 'cancelled',
      meta,
      party: { label: 'Received from', name: r.customerName, phone: r.customerPhone },
      totals: totals.map((t) => ({ ...t, bold: !t.big })),
      lines,
      signature: 'Signature',
    },
    business,
    settings,
  );
}

/**
 * Print on the receipt printer. Not a transaction (printing is async); the print count is updated afterwards.
 * Same rule as bills: the first print is the original; printing again is a reprint, which needs
 * "Reprint bills" (billing.reprint), is marked DUPLICATE (receipt setting) and prints one copy.
 */
export async function printReceipt(ctx: Ctx, id: number): Promise<{ printed: boolean; duplicate: boolean; message?: string }> {
  const r = getReceipt(ctx, id);
  const reprint = r.printCount > 0;
  if (reprint) assertCan(ctx, 'billing.reprint', 'This payment receipt was already printed. You are not allowed to reprint it. Ask the owner for permission.');
  const settings = getSection(ctx, 'receipt');
  const duplicate = reprint && settings.markDuplicate;
  const html = receiptHtml(ctx, id, { duplicate });
  const printerName = settings.printerName?.trim() || undefined;
  const result = await ctx.platform.printHtml(html, {
    printerName,
    silent: !!printerName,
    paperWidthMm: settings.paperWidth,
    copies: reprint ? 1 : Math.max(1, settings.copies || 1),
  });
  if (result.printed) {
    ctx.db.tx(() => {
      ctx.db.run('UPDATE customer_receipts SET print_count = print_count + 1 WHERE id = ?', [id]);
      logActivity(ctx, 'receipt.print', `${reprint ? 'Reprinted' : 'Printed'} payment receipt ${r.receiptNo}${duplicate ? ' marked DUPLICATE' : ''}`, {
        entityType: 'receipt',
        entityId: id,
        details: { printCount: r.printCount + 1 },
      });
    });
  }
  return { ...result, duplicate };
}

