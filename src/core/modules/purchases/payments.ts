/**
 * Payments made to suppliers against what you owe them.
 * Posting: Dr Sundry Creditors (supplier) amount + discount; Cr cash/bank amount; Cr Discount Received discount.
 */
import type { Ctx } from '../../context';
import { currentUserId, now } from '../../context';
import { fail } from '../../errors';
import { listRevisions, logActivity, recordRevision, type RevisionRow } from '../../audit';
import { nextDocNumber } from '../../numbering';
import { getSection } from '../../settings';
import { partyBalance, paymentAccountId, postEntry, replaceEntry, voidEntry, type EntryInput } from '../../accounting/ledger';
import { renderReceiptHtml } from '../../print/receipt';
import { amountInWords, formatINR } from '../../../shared/money';
import { formatDate, formatTime } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS, type SettlementMode } from '../../../shared/constants';
import { advanceWarning, assertSameFinancialYear, balanceThroughEntry, modeText, postingLines, resolveDocDate, type PostingLine } from '../customers/common';
import { getSupplierRow } from '../suppliers/service';

export interface SupplierPaymentInput {
  supplierId: number;
  date?: string | null;
  amount: number;
  /** Settlement discount received from the supplier. */
  discount?: number;
  mode: SettlementMode;
  accountId?: number | null;
  reference?: string | null;
  remarks?: string | null;
}

interface PaymentRow {
  id: number;
  payment_no: string;
  seq: number;
  fy_start: string;
  date: string;
  supplier_id: number;
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

type JoinedRow = PaymentRow & {
  supplier_name: string;
  supplier_phone: string | null;
  account_name: string;
  created_by_name: string | null;
  updated_by_name: string | null;
  cancelled_by_name: string | null;
};

const SELECT = `SELECT sp.*, s.name AS supplier_name, s.phone AS supplier_phone, a.name AS account_name,
    uc.full_name AS created_by_name, uu.full_name AS updated_by_name, ux.full_name AS cancelled_by_name
  FROM supplier_payments sp
  JOIN suppliers s ON s.id = sp.supplier_id
  JOIN accounts a ON a.id = sp.account_id
  LEFT JOIN users uc ON uc.id = sp.created_by
  LEFT JOIN users uu ON uu.id = sp.updated_by
  LEFT JOIN users ux ON ux.id = sp.cancelled_by`;

export interface SupplierPayment {
  id: number;
  paymentNo: string;
  date: string;
  supplierId: number;
  supplierName: string;
  supplierPhone: string | null;
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

export interface SupplierPaymentDetail extends SupplierPayment {
  /** Amount payable to the supplier just before / after this payment (+ = you owe). Null when cancelled. */
  payableBefore: number | null;
  payableAfter: number | null;
  currentPayable: number;
  posting: PostingLine[];
  revisions: RevisionRow[];
}

function toPayment(r: JoinedRow): SupplierPayment {
  return {
    id: r.id,
    paymentNo: r.payment_no,
    date: r.date,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    supplierPhone: r.supplier_phone,
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
  const r = ctx.db.get<JoinedRow>(`${SELECT} WHERE sp.id = ?`, [id]);
  if (!r) throw fail.notFound('Payment');
  return r;
}

export function getSupplierPayment(ctx: Ctx, id: number): SupplierPayment {
  return toPayment(getRow(ctx, id));
}

export function getSupplierPaymentDetail(ctx: Ctx, id: number): SupplierPaymentDetail {
  const r = getRow(ctx, id);
  let payableBefore: number | null = null;
  let payableAfter: number | null = null;
  if (r.status === 'active' && r.journal_entry_id) {
    payableAfter = 0 - balanceThroughEntry(ctx, 'supplier', r.supplier_id, 'AP', r.date, r.journal_entry_id);
    payableBefore = payableAfter + r.amount + r.discount;
  }
  return {
    ...toPayment(r),
    payableBefore,
    payableAfter,
    currentPayable: 0 - partyBalance(ctx, 'supplier', r.supplier_id, { account: 'AP' }),
    posting: postingLines(ctx, r.journal_entry_id),
    revisions: listRevisions(ctx, 'supplier_payment', id),
  };
}

interface Normalized {
  amount: number;
  discount: number;
  mode: SettlementMode;
  accountId: number;
  reference: string | null;
  remarks: string | null;
}

function normalize(ctx: Ctx, input: SupplierPaymentInput, supplierName: string, payableBefore: number): Normalized {
  const discount = input.discount ?? 0;
  if (input.amount + discount <= 0) throw fail.validation('Enter the amount paid', { amount: 'Enter the amount paid' });
  // A discount settles what is left unpaid; it can never turn into an advance.
  const maxDiscount = Math.max(payableBefore - input.amount, 0);
  if (discount > maxDiscount) {
    throw fail.validation(
      payableBefore <= 0
        ? `Nothing is payable to ${supplierName}, so a discount cannot be recorded.`
        : `The discount cannot be more than the amount still payable after this payment (${formatINR(maxDiscount)}).`,
      { discount: `At most ${formatINR(maxDiscount)}` },
    );
  }
  return {
    amount: input.amount,
    discount,
    mode: input.mode,
    accountId: paymentAccountId(ctx, input.mode, input.accountId),
    reference: input.reference?.trim() || null,
    remarks: input.remarks?.trim() || null,
  };
}

function entryFor(id: number, paymentNo: string, date: string, supplier: { id: number; name: string }, v: Normalized): EntryInput {
  return {
    date,
    voucherType: 'payment',
    voucherNo: paymentNo,
    sourceType: 'supplier_payment',
    sourceId: id,
    narration: `Payment to ${supplier.name} (${modeText(v.mode, v.reference)})${v.discount ? `, discount received ${formatINR(v.discount)}` : ''}`,
    lines: [
      { account: 'AP', debit: v.amount + v.discount, partyType: 'supplier', partyId: supplier.id },
      { account: v.accountId, credit: v.amount },
      { account: 'DISCOUNT_RECEIVED', credit: v.discount },
    ],
  };
}

export type SavedSupplierPayment = SupplierPayment & { warnings: string[] };

export function createSupplierPayment(ctx: Ctx, input: SupplierPaymentInput): SavedSupplierPayment {
  const supplier = getSupplierRow(ctx, input.supplierId);
  const date = resolveDocDate(ctx, input.date, { what: 'A payment' });
  const payable = 0 - partyBalance(ctx, 'supplier', supplier.id, { account: 'AP' });
  const v = normalize(ctx, input, supplier.name, payable);
  const num = nextDocNumber(ctx, 'payment', date);
  const id = ctx.db.insert('supplier_payments', {
    payment_no: num.number,
    seq: num.seq,
    fy_start: num.fyStart,
    date,
    supplier_id: supplier.id,
    amount: v.amount,
    discount: v.discount,
    mode: v.mode,
    account_id: v.accountId,
    reference: v.reference,
    remarks: v.remarks,
    created_by: currentUserId(ctx),
    created_at: now(ctx),
  });
  const entryId = postEntry(ctx, entryFor(id, num.number, date, supplier, v));
  ctx.db.update('supplier_payments', id, { journal_entry_id: entryId });
  const saved = getSupplierPayment(ctx, id);
  recordRevision(ctx, 'supplier_payment', id, 'created', saved);
  logActivity(
    ctx,
    'supplier_payment.create',
    `Paid ${formatINR(v.amount)} to ${supplier.name} by ${PAYMENT_MODE_LABELS[v.mode]} - ${num.number}${v.discount ? ` (discount received ${formatINR(v.discount)})` : ''}`,
    { entityType: 'supplier_payment', entityId: id, details: { supplierId: supplier.id, amount: v.amount, discount: v.discount, mode: v.mode, date } },
  );
  const warning = advanceWarning(supplier.name, payable, v.amount + v.discount, 'supplier');
  return { ...saved, warnings: warning ? [warning] : [] };
}

export function updateSupplierPayment(ctx: Ctx, id: number, input: SupplierPaymentInput, reason?: string | null): SavedSupplierPayment {
  const before = getRow(ctx, id);
  if (before.status === 'cancelled') throw fail.validation('This payment was cancelled and cannot be edited.');
  const supplier = getSupplierRow(ctx, input.supplierId);
  const date = resolveDocDate(ctx, input.date, { what: 'A payment', unchangedDate: before.date });
  assertSameFinancialYear(before.date, date, `Payment ${before.payment_no}`);
  const payable =
    0 - partyBalance(ctx, 'supplier', supplier.id, { account: 'AP' }) + (before.supplier_id === supplier.id ? before.amount + before.discount : 0);
  const v = normalize(ctx, input, supplier.name, payable);
  ctx.db.update('supplier_payments', id, {
    date,
    supplier_id: supplier.id,
    amount: v.amount,
    discount: v.discount,
    mode: v.mode,
    account_id: v.accountId,
    reference: v.reference,
    remarks: v.remarks,
    revision: before.revision + 1,
    updated_by: currentUserId(ctx),
    updated_at: now(ctx),
  });
  replaceEntry(ctx, before.journal_entry_id!, entryFor(id, before.payment_no, date, supplier, v));
  const saved = getSupplierPayment(ctx, id);
  recordRevision(ctx, 'supplier_payment', id, 'edited', saved, reason);
  const changes: string[] = [];
  if (before.amount !== v.amount) changes.push(`amount ${formatINR(before.amount)} → ${formatINR(v.amount)}`);
  if (before.discount !== v.discount) changes.push(`discount ${formatINR(before.discount)} → ${formatINR(v.discount)}`);
  if (before.mode !== v.mode) changes.push(`mode ${PAYMENT_MODE_LABELS[before.mode]} → ${PAYMENT_MODE_LABELS[v.mode]}`);
  if (before.date !== date) changes.push(`date ${formatDate(before.date)} → ${formatDate(date)}`);
  if (before.supplier_id !== supplier.id) changes.push(`supplier ${before.supplier_name} → ${supplier.name}`);
  logActivity(
    ctx,
    'supplier_payment.update',
    `Edited payment ${before.payment_no}${changes.length ? ': ' + changes.join(', ') : ''}${reason ? ` (reason: ${reason})` : ''}`,
    { entityType: 'supplier_payment', entityId: id, details: { before: toPayment(before), after: saved, reason: reason ?? null } },
  );
  const warning = advanceWarning(supplier.name, payable, v.amount + v.discount, 'supplier');
  return { ...saved, warnings: warning ? [warning] : [] };
}

export function cancelSupplierPayment(ctx: Ctx, id: number, reason: string): SupplierPayment {
  const r = getRow(ctx, id);
  if (r.status === 'cancelled') throw fail.validation('This payment is already cancelled.');
  const why = reason.trim();
  if (!why) throw fail.validation('Enter the reason for cancelling', { reason: 'Enter a reason' });
  if (r.journal_entry_id) voidEntry(ctx, r.journal_entry_id, `Payment ${r.payment_no} cancelled: ${why}`);
  ctx.db.update('supplier_payments', id, {
    status: 'cancelled',
    revision: r.revision + 1,
    cancelled_by: currentUserId(ctx),
    cancelled_at: now(ctx),
    cancel_reason: why,
  });
  const saved = getSupplierPayment(ctx, id);
  recordRevision(ctx, 'supplier_payment', id, 'cancelled', saved, why);
  logActivity(ctx, 'supplier_payment.cancel', `Cancelled payment ${r.payment_no} of ${formatINR(r.amount)} to ${r.supplier_name}: ${why}`, {
    entityType: 'supplier_payment',
    entityId: id,
    details: { reason: why },
  });
  return saved;
}

export interface SupplierPaymentQuery {
  from?: string | null;
  to?: string | null;
  q?: string | null;
  supplierId?: number | null;
  mode?: SettlementMode | null;
  status?: 'active' | 'cancelled' | null;
}

export function listSupplierPayments(
  ctx: Ctx,
  query: SupplierPaymentQuery,
): { rows: SupplierPayment[]; totals: { count: number; amount: number; discount: number; byMode: Record<SettlementMode, number>; cancelled: number } } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.from) {
    where.push('sp.date >= :from');
    params.from = query.from;
  }
  if (query.to) {
    where.push('sp.date <= :to');
    params.to = query.to;
  }
  if (query.supplierId) {
    where.push('sp.supplier_id = :supplierId');
    params.supplierId = query.supplierId;
  }
  if (query.mode) {
    where.push('sp.mode = :mode');
    params.mode = query.mode;
  }
  if (query.status) {
    where.push('sp.status = :status');
    params.status = query.status;
  }
  const text = query.q?.trim();
  if (text) {
    where.push("(sp.payment_no LIKE :like OR s.name LIKE :like OR REPLACE(s.phone, ' ', '') LIKE :phone OR sp.reference LIKE :like OR sp.remarks LIKE :like)");
    params.like = `%${text}%`;
    params.phone = `%${text.replace(/\s/g, '')}%`;
  }
  const rows = ctx.db
    .all<JoinedRow>(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sp.date DESC, sp.id DESC LIMIT 5000`, params)
    .map(toPayment);
  const totals = { count: 0, amount: 0, discount: 0, byMode: { cash: 0, upi: 0, bank: 0 } as Record<SettlementMode, number>, cancelled: 0 };
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

/* ------------------------------ Voucher printing ------------------------------ */

export function paymentVoucherHtml(ctx: Ctx, id: number): string {
  const p = getSupplierPaymentDetail(ctx, id);
  const business = getSection(ctx, 'business');
  const settings = getSection(ctx, 'receipt');
  const meta: Array<[string, string]> = [
    ['Voucher No', p.paymentNo],
    ['Date', `${formatDate(p.date)}${p.createdAt.slice(0, 10) === p.date ? ' ' + formatTime(p.createdAt) : ''}`],
  ];
  if (settings.showCashier && p.createdBy) meta.push(['Paid by', p.createdBy]);
  const totals = [{ label: 'Amount paid', value: formatINR(p.amount), big: true, bold: false }];
  if (p.discount) {
    totals.push({ label: 'Discount received', value: formatINR(p.discount), big: false, bold: true });
    totals.push({ label: 'Total settled', value: formatINR(p.amount + p.discount), big: false, bold: true });
  }
  const lines = [`Paid by ${modeText(p.mode, p.reference)} from ${p.accountName}`, amountInWords(p.amount)];
  if (p.payableBefore !== null && p.payableAfter !== null) {
    lines.push(`Payable before: ${formatINR(p.payableBefore)}`);
    lines.push(`Payable now: ${p.payableAfter >= 0 ? formatINR(p.payableAfter) : `Nil (advance ${formatINR(-p.payableAfter)})`}`);
  }
  if (p.remarks) lines.push(p.remarks);
  if (p.status === 'cancelled' && p.cancelReason) lines.push(`Cancelled: ${p.cancelReason}`);
  return renderReceiptHtml(
    {
      title: 'PAYMENT VOUCHER',
      duplicate: settings.markDuplicate && p.printCount > 0,
      cancelled: p.status === 'cancelled',
      meta,
      party: { label: 'Paid to', name: p.supplierName, phone: p.supplierPhone },
      totals,
      lines,
      signature: "Receiver's signature",
    },
    business,
    settings,
  );
}

export async function printPaymentVoucher(ctx: Ctx, id: number): Promise<{ printed: boolean; message?: string }> {
  const p = getSupplierPayment(ctx, id);
  const settings = getSection(ctx, 'receipt');
  const html = paymentVoucherHtml(ctx, id);
  const result = await ctx.platform.printHtml(html, {
    printerName: settings.printerName || undefined,
    silent: !!settings.printerName,
    paperWidthMm: settings.paperWidth,
    copies: settings.copies,
  });
  if (result.printed) {
    ctx.db.tx(() => {
      ctx.db.run('UPDATE supplier_payments SET print_count = print_count + 1 WHERE id = ?', [id]);
      logActivity(ctx, 'supplier_payment.print', `${p.printCount > 0 ? 'Reprinted' : 'Printed'} payment voucher ${p.paymentNo}`, {
        entityType: 'supplier_payment',
        entityId: id,
      });
    });
  }
  return result;
}
