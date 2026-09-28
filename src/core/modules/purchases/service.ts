/**
 * Purchase bills: goods or services bought from suppliers (or cash purchases
 * without a supplier record). Posting (contract):
 *   Dr purchase account (default "Purchases"; any expense or fixed-asset account)  total
 *   Cr each payment's cash / bank account                                           paid part
 *   Cr Sundry Creditors (supplier)                                                  credit part
 */
import type { Ctx } from '../../context';
import { currentUserId, now } from '../../context';
import { fail } from '../../errors';
import { listRevisions, logActivity, recordRevision, type RevisionRow } from '../../audit';
import { nextDocNumber } from '../../numbering';
import { getSection } from '../../settings';
import {
  getAccount,
  negativeBalanceWarning,
  partyBalance,
  paymentAccountId,
  postEntry,
  replaceEntry,
  systemAccountId,
  voidEntry,
  type AccountRow,
  type EntryInput,
  type EntryLineInput,
} from '../../accounting/ledger';
import { formatDate, isValidISODate } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import { purchaseTotals } from '../../../shared/purchase';
import type { SettlementMode } from '../../../shared/constants';
import { assertCancelKeepsClosedAccounts } from '../accounting/common';
import { assertSameFinancialYear, itemsSummary, postingLines, resolveDocDate, type PostingLine } from '../customers/common';
import { getSupplierRow } from '../suppliers/service';

export interface PurchaseItemInput {
  description: string;
  qty: number;
  unit?: string | null;
  /** Rate in paise. */
  rate: number;
}

export interface PurchasePaymentInput {
  mode: SettlementMode;
  amount: number;
  accountId?: number | null;
  reference?: string | null;
}

export interface PurchaseInput {
  date?: string | null;
  supplierId?: number | null;
  /** For cash purchases without a supplier record. */
  supplierName?: string | null;
  supplierBillNo?: string | null;
  supplierBillDate?: string | null;
  /** Default "Purchases". Any expense account or a fixed-asset account. */
  expenseAccountId?: number | null;
  items: PurchaseItemInput[];
  discount?: number;
  /** Freight, loading, packing... added to the bill. */
  otherCharges?: number;
  /** Round the total to the nearest rupee; defaults to the billing setting. */
  roundOff?: boolean;
  /** Money paid now. Whatever is not paid is added to the amount payable to the supplier. */
  payments?: PurchasePaymentInput[];
  remarks?: string | null;
}

type PaymentModeColumn = SettlementMode | 'credit' | 'split';

interface PurchaseRow {
  id: number;
  purchase_no: string;
  seq: number;
  fy_start: string;
  date: string;
  supplier_id: number | null;
  supplier_name: string | null;
  supplier_bill_no: string | null;
  supplier_bill_date: string | null;
  expense_account_id: number;
  subtotal: number;
  discount: number;
  other_charges: number;
  round_off: number;
  total: number;
  paid: number;
  credit: number;
  payment_mode: PaymentModeColumn;
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

type JoinedRow = PurchaseRow & {
  account_name: string;
  supplier_phone: string | null;
  created_by_name: string | null;
  updated_by_name: string | null;
  cancelled_by_name: string | null;
};

const SELECT = `SELECT p.*, a.name AS account_name, s.phone AS supplier_phone,
    uc.full_name AS created_by_name, uu.full_name AS updated_by_name, ux.full_name AS cancelled_by_name
  FROM purchases p
  JOIN accounts a ON a.id = p.expense_account_id
  LEFT JOIN suppliers s ON s.id = p.supplier_id
  LEFT JOIN users uc ON uc.id = p.created_by
  LEFT JOIN users uu ON uu.id = p.updated_by
  LEFT JOIN users ux ON ux.id = p.cancelled_by`;

export interface PurchaseLine {
  lineNo: number;
  description: string;
  unit: string | null;
  qty: number;
  rate: number;
  amount: number;
}

export interface PurchasePayment {
  mode: SettlementMode;
  accountId: number;
  accountName: string;
  amount: number;
  reference: string | null;
}

export interface Purchase {
  id: number;
  purchaseNo: string;
  date: string;
  supplierId: number | null;
  supplierName: string | null;
  supplierPhone: string | null;
  supplierBillNo: string | null;
  supplierBillDate: string | null;
  expenseAccountId: number;
  expenseAccountName: string;
  items: PurchaseLine[];
  subtotal: number;
  discount: number;
  otherCharges: number;
  roundOff: number;
  total: number;
  paid: number;
  credit: number;
  paymentMode: PaymentModeColumn;
  payments: PurchasePayment[];
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

export interface PurchaseDetail extends Purchase {
  /** Supplier's current payable (+ = you owe). */
  supplierPayable: number | null;
  posting: PostingLine[];
  revisions: RevisionRow[];
}

function getRow(ctx: Ctx, id: number): JoinedRow {
  const r = ctx.db.get<JoinedRow>(`${SELECT} WHERE p.id = ?`, [id]);
  if (!r) throw fail.notFound('Purchase bill');
  return r;
}

function toPurchase(ctx: Ctx, r: JoinedRow): Purchase {
  const items = ctx.db
    .all<{ line_no: number; description: string; unit: string | null; qty: number; rate: number; amount: number }>(
      'SELECT line_no, description, unit, qty, rate, amount FROM purchase_items WHERE purchase_id = ? ORDER BY line_no',
      [r.id],
    )
    .map((i) => ({ lineNo: i.line_no, description: i.description, unit: i.unit, qty: i.qty, rate: i.rate, amount: i.amount }));
  const payments = ctx.db
    .all<{ mode: SettlementMode; account_id: number; account_name: string; amount: number; reference: string | null }>(
      `SELECT pp.mode, pp.account_id, a.name AS account_name, pp.amount, pp.reference
         FROM purchase_payments pp JOIN accounts a ON a.id = pp.account_id WHERE pp.purchase_id = ? ORDER BY pp.id`,
      [r.id],
    )
    .map((p) => ({ mode: p.mode, accountId: p.account_id, accountName: p.account_name, amount: p.amount, reference: p.reference }));
  return {
    id: r.id,
    purchaseNo: r.purchase_no,
    date: r.date,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    supplierPhone: r.supplier_phone,
    supplierBillNo: r.supplier_bill_no,
    supplierBillDate: r.supplier_bill_date,
    expenseAccountId: r.expense_account_id,
    expenseAccountName: r.account_name,
    items,
    subtotal: r.subtotal,
    discount: r.discount,
    otherCharges: r.other_charges,
    roundOff: r.round_off,
    total: r.total,
    paid: r.paid,
    credit: r.credit,
    paymentMode: r.payment_mode,
    payments,
    remarks: r.remarks,
    status: r.status,
    revision: r.revision,
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

export function getPurchase(ctx: Ctx, id: number): Purchase {
  return toPurchase(ctx, getRow(ctx, id));
}

export function getPurchaseDetail(ctx: Ctx, id: number): PurchaseDetail {
  const p = getPurchase(ctx, id);
  return {
    ...p,
    supplierPayable: p.supplierId ? 0 - partyBalance(ctx, 'supplier', p.supplierId, { account: 'AP' }) : null,
    posting: postingLines(ctx, p.journalEntryId),
    revisions: listRevisions(ctx, 'purchase', id),
  };
}

/* ------------------------------ Accounts ------------------------------ */

function isPurchaseAccount(a: Pick<AccountRow, 'type' | 'group_code'>): boolean {
  return a.type === 'expense' || a.group_code === 'fixed_assets';
}

function purchaseAccount(ctx: Ctx, id: number | null | undefined): AccountRow {
  if (!id) return getAccount(ctx, systemAccountId(ctx, 'PURCHASES'));
  const a = ctx.db.get<AccountRow>(
    'SELECT a.id, a.code, a.name, a.group_code, a.system_key, a.party_type, a.is_active, g.type FROM accounts a JOIN account_groups g ON g.code = a.group_code WHERE a.id = ?',
    [id],
  );
  if (!a) throw fail.validation('Choose the account to record this purchase in', { expenseAccountId: 'Choose an account' });
  if (!isPurchaseAccount(a)) {
    throw fail.validation(
      `A purchase can only be recorded in an expense account (such as "Purchases") or a fixed asset account. "${a.name}" is not one of these.`,
      { expenseAccountId: 'Choose an expense or fixed asset account' },
    );
  }
  if (!a.is_active) throw fail.validation(`The account "${a.name}" is deactivated. Choose another account.`, { expenseAccountId: 'Account is deactivated' });
  return a;
}

export interface PurchaseAccountOption {
  id: number;
  name: string;
  groupName: string;
  isDefault: boolean;
}

/** What the purchase form needs: allowed accounts and whether totals are rounded by default. */
export function purchaseFormOptions(ctx: Ctx): { roundOff: boolean; defaultAccountId: number; accounts: PurchaseAccountOption[] } {
  const def = systemAccountId(ctx, 'PURCHASES');
  const accounts = ctx.db
    .all<{ id: number; name: string; group_name: string }>(
      `SELECT a.id, a.name, g.name AS group_name FROM accounts a JOIN account_groups g ON g.code = a.group_code
        WHERE a.is_active = 1 AND (g.type = 'expense' OR a.group_code = 'fixed_assets')
          AND COALESCE(a.system_key, '') NOT IN ('DISCOUNT_ALLOWED', 'ROUND_OFF', 'SALARY', 'INTEREST_EXPENSE')
        ORDER BY CASE WHEN a.id = ? THEN 0 ELSE 1 END, g.sort_order, a.code, a.name COLLATE NOCASE`,
      [def],
    )
    .map((a) => ({ id: a.id, name: a.name, groupName: a.group_name, isDefault: a.id === def }));
  return { roundOff: getSection(ctx, 'billing').roundOff, defaultAccountId: def, accounts };
}

/* ------------------------------ Validation ------------------------------ */

interface NormalizedPurchase {
  date: string;
  supplier: { id: number; name: string } | null;
  supplierName: string | null;
  supplierBillNo: string | null;
  supplierBillDate: string | null;
  account: AccountRow;
  items: Array<{ description: string; qty: number; unit: string | null; rate: number; amount: number }>;
  subtotal: number;
  discount: number;
  otherCharges: number;
  roundOff: number;
  total: number;
  payments: Array<{ mode: SettlementMode; accountId: number; amount: number; reference: string | null }>;
  paid: number;
  credit: number;
  paymentMode: PaymentModeColumn;
  remarks: string | null;
}

function normalize(ctx: Ctx, input: PurchaseInput, before?: PurchaseRow): NormalizedPurchase {
  const date = resolveDocDate(ctx, input.date, { what: 'A purchase', unchangedDate: before?.date });
  if (before) assertSameFinancialYear(before.date, date, `Purchase ${before.purchase_no}`);

  let supplier: { id: number; name: string } | null = null;
  if (input.supplierId) {
    const s = getSupplierRow(ctx, input.supplierId);
    if (!s.is_active && s.id !== before?.supplier_id) {
      throw fail.validation(`The supplier "${s.name}" is deactivated. Re-activate the supplier first.`, { supplierId: 'Supplier is deactivated' });
    }
    supplier = { id: s.id, name: s.name };
  }
  const supplierName = supplier ? supplier.name : input.supplierName?.trim() || null;

  const supplierBillDate = input.supplierBillDate || null;
  if (supplierBillDate && !isValidISODate(supplierBillDate)) {
    throw fail.validation('Enter a valid supplier bill date', { supplierBillDate: 'Enter a valid date' });
  }
  if (supplierBillDate && supplierBillDate > date) {
    throw fail.validation(`The supplier's bill date (${formatDate(supplierBillDate)}) cannot be after the purchase date (${formatDate(date)}).`, {
      supplierBillDate: 'Bill date is after the purchase date',
    });
  }

  if (!input.items.length) throw fail.validation('Add at least one item to the purchase', { items: 'Add at least one item' });
  input.items.forEach((it, i) => {
    if (!it.description.trim()) throw fail.validation(`Line ${i + 1}: enter what was bought`, { [`items.${i}.description`]: 'Enter a description' });
  });
  const roundOffEnabled = input.roundOff ?? getSection(ctx, 'billing').roundOff;
  const t = purchaseTotals({ items: input.items, discount: input.discount, otherCharges: input.otherCharges, roundOff: roundOffEnabled });
  if (t.discount > t.subtotal) {
    throw fail.validation(`The discount (${formatINR(t.discount)}) cannot be more than the items total (${formatINR(t.subtotal)}).`, { discount: 'Discount is too large' });
  }
  if (t.total <= 0) throw fail.validation('The purchase total must be more than zero', { items: 'Total must be more than zero' });

  const payments = (input.payments ?? []).map((p) => ({
    mode: p.mode,
    accountId: paymentAccountId(ctx, p.mode, p.accountId),
    amount: p.amount,
    reference: p.reference?.trim() || null,
  }));
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  if (paid > t.total) {
    throw fail.validation(`The amount paid (${formatINR(paid)}) is more than the purchase total (${formatINR(t.total)}).`, { payments: 'Paid more than the total' });
  }
  const credit = t.total - paid;
  if (credit > 0 && !supplier) {
    throw fail.validation(
      `${formatINR(credit)} is unpaid. Choose the supplier to buy on credit, or record the full amount as paid.`,
      { supplierId: 'Choose a supplier for a credit purchase' },
    );
  }
  const paymentMode: PaymentModeColumn = payments.length === 0 ? 'credit' : payments.length === 1 && credit === 0 ? payments[0].mode : 'split';

  return {
    date,
    supplier,
    supplierName,
    supplierBillNo: input.supplierBillNo?.trim() || null,
    supplierBillDate,
    account: purchaseAccount(ctx, input.expenseAccountId),
    items: input.items.map((it, i) => ({
      description: it.description.trim(),
      qty: it.qty,
      unit: it.unit?.trim() || null,
      rate: it.rate,
      amount: t.amounts[i],
    })),
    subtotal: t.subtotal,
    discount: t.discount,
    otherCharges: t.otherCharges,
    roundOff: t.roundOff,
    total: t.total,
    payments,
    paid,
    credit,
    paymentMode,
    remarks: input.remarks?.trim() || null,
  };
}

function duplicateWarning(ctx: Ctx, v: NormalizedPurchase, exceptId: number): string | null {
  if (!v.supplier || !v.supplierBillNo) return null;
  const dup = ctx.db.get<{ purchase_no: string; date: string }>(
    "SELECT purchase_no, date FROM purchases WHERE supplier_id = ? AND supplier_bill_no = ? COLLATE NOCASE AND status = 'active' AND id <> ? ORDER BY id LIMIT 1",
    [v.supplier.id, v.supplierBillNo, exceptId],
  );
  if (!dup) return null;
  return `Bill no. ${v.supplierBillNo} from ${v.supplier.name} was already entered as ${dup.purchase_no} on ${formatDate(dup.date)}. Please check it is not entered twice.`;
}

/**
 * "Cash in hand will be short by ..." for each cash / bank account the purchase is paid from.
 * Call before posting; `already` = what the saved version of this purchase already paid out of each
 * account (still in the balances when editing), so only the extra outflow is checked.
 */
function shortfallWarnings(ctx: Ctx, v: NormalizedPurchase, already: Array<{ account_id: number; amount: number }> = []): string[] {
  const out = new Map<number, number>();
  for (const p of v.payments) out.set(p.accountId, (out.get(p.accountId) ?? 0) + p.amount);
  for (const p of already) if (out.has(p.account_id)) out.set(p.account_id, out.get(p.account_id)! - p.amount);
  const warnings: string[] = [];
  for (const [accountId, amount] of out) {
    const w = negativeBalanceWarning(ctx, accountId, amount, v.date);
    if (w) warnings.push(w);
  }
  return warnings;
}

/** Check a supplier bill number before saving (the form warns about possible duplicates). */
export function findDuplicateBill(ctx: Ctx, supplierId: number, supplierBillNo: string, excludeId?: number | null): { id: number; purchaseNo: string; date: string; total: number } | null {
  const no = supplierBillNo.trim();
  if (!no) return null;
  const r = ctx.db.get<{ id: number; purchase_no: string; date: string; total: number }>(
    "SELECT id, purchase_no, date, total FROM purchases WHERE supplier_id = ? AND supplier_bill_no = ? COLLATE NOCASE AND status = 'active' AND id <> ? ORDER BY id LIMIT 1",
    [supplierId, no, excludeId ?? 0],
  );
  return r ? { id: r.id, purchaseNo: r.purchase_no, date: r.date, total: r.total } : null;
}

function entryFor(id: number, purchaseNo: string, v: NormalizedPurchase): EntryInput {
  const who = v.supplierName ?? 'cash purchase';
  const lines: EntryLineInput[] = [{ account: v.account.id, debit: v.total }];
  for (const p of v.payments) lines.push({ account: p.accountId, credit: p.amount, memo: p.reference });
  if (v.credit > 0 && v.supplier) lines.push({ account: 'AP', credit: v.credit, partyType: 'supplier', partyId: v.supplier.id });
  return {
    date: v.date,
    voucherType: 'purchase',
    voucherNo: purchaseNo,
    sourceType: 'purchase',
    sourceId: id,
    narration: `Purchase from ${who}${v.supplierBillNo ? `, bill ${v.supplierBillNo}` : ''}`,
    lines,
  };
}

function writeLines(ctx: Ctx, id: number, v: NormalizedPurchase): void {
  ctx.db.run('DELETE FROM purchase_items WHERE purchase_id = ?', [id]);
  ctx.db.run('DELETE FROM purchase_payments WHERE purchase_id = ?', [id]);
  v.items.forEach((it, i) =>
    ctx.db.insert('purchase_items', { purchase_id: id, line_no: i + 1, description: it.description, unit: it.unit, qty: it.qty, rate: it.rate, amount: it.amount }),
  );
  for (const p of v.payments) {
    ctx.db.insert('purchase_payments', { purchase_id: id, mode: p.mode, account_id: p.accountId, amount: p.amount, reference: p.reference });
  }
}

function columns(v: NormalizedPurchase) {
  return {
    date: v.date,
    supplier_id: v.supplier?.id ?? null,
    supplier_name: v.supplierName,
    supplier_bill_no: v.supplierBillNo,
    supplier_bill_date: v.supplierBillDate,
    expense_account_id: v.account.id,
    subtotal: v.subtotal,
    discount: v.discount,
    other_charges: v.otherCharges,
    round_off: v.roundOff,
    total: v.total,
    paid: v.paid,
    credit: v.credit,
    payment_mode: v.paymentMode,
    remarks: v.remarks,
  };
}

export type SavedPurchase = Purchase & { warnings: string[] };

export function createPurchase(ctx: Ctx, input: PurchaseInput): SavedPurchase {
  const v = normalize(ctx, input);
  const short = shortfallWarnings(ctx, v);
  const num = nextDocNumber(ctx, 'purchase', v.date);
  const id = ctx.db.insert('purchases', {
    purchase_no: num.number,
    seq: num.seq,
    fy_start: num.fyStart,
    ...columns(v),
    created_by: currentUserId(ctx),
    created_at: now(ctx),
  });
  writeLines(ctx, id, v);
  const entryId = postEntry(ctx, entryFor(id, num.number, v));
  ctx.db.update('purchases', id, { journal_entry_id: entryId });
  const saved = getPurchase(ctx, id);
  recordRevision(ctx, 'purchase', id, 'created', saved);
  logActivity(
    ctx,
    'purchase.create',
    `Entered purchase ${num.number} of ${formatINR(v.total)}${v.supplierName ? ` from ${v.supplierName}` : ''}${v.credit ? ` (${formatINR(v.credit)} on credit)` : ''}`,
    { entityType: 'purchase', entityId: id, details: { total: v.total, paid: v.paid, credit: v.credit, supplierId: v.supplier?.id ?? null } },
  );
  const warning = duplicateWarning(ctx, v, id);
  return { ...saved, warnings: [...(warning ? [warning] : []), ...short] };
}

export function updatePurchase(ctx: Ctx, id: number, input: PurchaseInput, reason?: string | null): SavedPurchase {
  const before = getRow(ctx, id);
  if (before.status === 'cancelled') throw fail.validation('This purchase was cancelled and cannot be edited.');
  const beforeDoc = toPurchase(ctx, before);
  const v = normalize(ctx, input, before);
  const short = shortfallWarnings(ctx, v, beforeDoc.payments.map((p) => ({ account_id: p.accountId, amount: p.amount })));
  ctx.db.update('purchases', id, {
    ...columns(v),
    revision: before.revision + 1,
    updated_by: currentUserId(ctx),
    updated_at: now(ctx),
  });
  writeLines(ctx, id, v);
  replaceEntry(ctx, before.journal_entry_id!, entryFor(id, before.purchase_no, v));
  const saved = getPurchase(ctx, id);
  recordRevision(ctx, 'purchase', id, 'edited', saved, reason);
  const changes: string[] = [];
  if (before.total !== v.total) changes.push(`total ${formatINR(before.total)} → ${formatINR(v.total)}`);
  if (before.credit !== v.credit) changes.push(`on credit ${formatINR(before.credit)} → ${formatINR(v.credit)}`);
  if (before.date !== v.date) changes.push(`date ${formatDate(before.date)} → ${formatDate(v.date)}`);
  if ((before.supplier_name ?? '') !== (v.supplierName ?? '')) changes.push(`supplier ${before.supplier_name || '-'} → ${v.supplierName || '-'}`);
  if (before.expense_account_id !== v.account.id) changes.push(`account ${before.account_name} → ${v.account.name}`);
  logActivity(
    ctx,
    'purchase.update',
    `Edited purchase ${before.purchase_no}${changes.length ? ': ' + changes.join(', ') : ''}${reason ? ` (reason: ${reason})` : ''}`,
    { entityType: 'purchase', entityId: id, details: { before: beforeDoc, after: saved, reason: reason ?? null } },
  );
  const warning = duplicateWarning(ctx, v, id);
  return { ...saved, warnings: [...(warning ? [warning] : []), ...short] };
}

export function cancelPurchase(ctx: Ctx, id: number, reason: string): Purchase {
  const r = getRow(ctx, id);
  if (r.status === 'cancelled') throw fail.validation('This purchase is already cancelled.');
  const why = reason.trim();
  if (!why) throw fail.validation('Enter the reason for cancelling', { reason: 'Enter a reason' });
  assertCancelKeepsClosedAccounts(ctx, r.journal_entry_id, 'this purchase');
  if (r.journal_entry_id) voidEntry(ctx, r.journal_entry_id, `Purchase ${r.purchase_no} cancelled: ${why}`);
  ctx.db.update('purchases', id, {
    status: 'cancelled',
    revision: r.revision + 1,
    cancelled_by: currentUserId(ctx),
    cancelled_at: now(ctx),
    cancel_reason: why,
  });
  const saved = getPurchase(ctx, id);
  recordRevision(ctx, 'purchase', id, 'cancelled', saved, why);
  logActivity(ctx, 'purchase.cancel', `Cancelled purchase ${r.purchase_no} of ${formatINR(r.total)}${r.supplier_name ? ` from ${r.supplier_name}` : ''}: ${why}`, {
    entityType: 'purchase',
    entityId: id,
    details: { reason: why },
  });
  return saved;
}

/* ------------------------------ Lists ------------------------------ */

export interface PurchaseListRow {
  id: number;
  purchaseNo: string;
  date: string;
  supplierId: number | null;
  supplierName: string | null;
  supplierBillNo: string | null;
  accountName: string;
  items: string;
  total: number;
  paid: number;
  credit: number;
  paymentMode: PaymentModeColumn;
  status: 'active' | 'cancelled';
}

export interface PurchaseListQuery {
  from?: string | null;
  to?: string | null;
  q?: string | null;
  supplierId?: number | null;
  status?: 'active' | 'cancelled' | null;
}

export function listPurchases(ctx: Ctx, query: PurchaseListQuery): { rows: PurchaseListRow[]; totals: { count: number; total: number; paid: number; credit: number; cancelled: number } } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (query.from) {
    where.push('p.date >= :from');
    params.from = query.from;
  }
  if (query.to) {
    where.push('p.date <= :to');
    params.to = query.to;
  }
  if (query.supplierId) {
    where.push('p.supplier_id = :supplierId');
    params.supplierId = query.supplierId;
  }
  if (query.status) {
    where.push('p.status = :status');
    params.status = query.status;
  }
  const text = query.q?.trim();
  if (text) {
    where.push(
      `(p.purchase_no LIKE :like OR p.supplier_name LIKE :like OR p.supplier_bill_no LIKE :like OR p.remarks LIKE :like
        OR EXISTS (SELECT 1 FROM purchase_items pi WHERE pi.purchase_id = p.id AND pi.description LIKE :like))`,
    );
    params.like = `%${text}%`;
  }
  const raw = ctx.db.all<PurchaseRow & { account_name: string }>(
    `SELECT p.*, a.name AS account_name FROM purchases p JOIN accounts a ON a.id = p.expense_account_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.date DESC, p.id DESC LIMIT 5000`,
    params,
  );
  const rows = raw.map((r) => ({
    id: r.id,
    purchaseNo: r.purchase_no,
    date: r.date,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    supplierBillNo: r.supplier_bill_no,
    accountName: r.account_name,
    items: itemsSummary(ctx.db.all<{ name: string; qty: number; unit: string | null }>('SELECT description AS name, qty, unit FROM purchase_items WHERE purchase_id = ? ORDER BY line_no', [r.id])),
    total: r.total,
    paid: r.paid,
    credit: r.credit,
    paymentMode: r.payment_mode,
    status: r.status,
  }));
  const totals = { count: 0, total: 0, paid: 0, credit: 0, cancelled: 0 };
  for (const r of rows) {
    if (r.status === 'cancelled') {
      totals.cancelled++;
      continue;
    }
    totals.count++;
    totals.total += r.total;
    totals.paid += r.paid;
    totals.credit += r.credit;
  }
  return { rows, totals };
}

/** Past purchase line descriptions for type-ahead, with the last unit and rate (same supplier first). */
export function purchaseDescriptions(ctx: Ctx, q: string, supplierId?: number | null, limit = 12): Array<{ description: string; unit: string | null; rate: number; lastDate: string }> {
  const text = q.trim();
  const rows = ctx.db.all<{ description: string; unit: string | null; rate: number; date: string }>(
    `SELECT pi.description, pi.unit, pi.rate, p.date FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
      WHERE p.status = 'active' AND pi.description LIKE :like
      ORDER BY CASE WHEN p.supplier_id = :sid THEN 0 ELSE 1 END, CASE WHEN pi.description LIKE :prefix THEN 0 ELSE 1 END, p.date DESC, pi.id DESC
      LIMIT 300`,
    { like: `%${text}%`, prefix: `${text}%`, sid: supplierId ?? 0 },
  );
  const seen = new Set<string>();
  const out: Array<{ description: string; unit: string | null; rate: number; lastDate: string }> = [];
  for (const r of rows) {
    const key = r.description.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ description: r.description, unit: r.unit, rate: r.rate, lastDate: r.date });
    if (out.length >= limit) break;
  }
  return out;
}
