/**
 * Purchase bills: goods or services bought from suppliers (or cash purchases
 * without a supplier record). Posting (contract):
 *   Dr purchase account (default "Purchases"; any expense or fixed-asset account)  total
 *   Cr each payment's cash / bank account                                           paid part
 *   Cr Sundry Creditors (supplier)                                                  credit part
 * With GST (regular registration) and input tax credit claimed, the purchase account gets the total
 * less the tax, and the tax goes to Input CGST + SGST (same state) or Input IGST (another state).
 * Without the credit (not claimed, or a supplier without GSTIN) the tax is part of the cost.
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
import { gstConfig, placeOfSupply, useGstAccounts } from '../gst/common';
import { gstinState, hsnProblem, isGstRate, type GstMode } from '../../../shared/gst';
import { shareDiscount } from '../../../shared/billing';
import { removeDocumentMoves, writeDocumentMoves } from '../stock/service';
import { stockEnabled } from '../stock/valuation';

export interface PurchaseItemInput {
  description: string;
  qty: number;
  unit?: string | null;
  /** Rate in paise. */
  rate: number;
  /** GST rate on the supplier's bill (purchases with GST). */
  gstRate?: number | null;
  hsn?: string | null;
  /** Catalogue item bought (stock tracking: the goods come into its stock, in its unit). */
  itemId?: number | null;
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
  /** GST: the supplier's rates include the tax (default: tax added on top). */
  gstInclusive?: boolean | null;
  /** GST: claim input tax credit (default: when the supplier has a GSTIN). */
  itc?: boolean | null;
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
  gst_mode: GstMode;
  gst_inclusive: number;
  itc: number;
  supplier_gstin: string | null;
  place_of_supply: string | null;
  taxable_total: number | null;
  cgst: number;
  sgst: number;
  igst: number;
  stock_tracked: number;
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
  hsn: string | null;
  gstRate: number | null;
  taxable: number | null;
  cgst: number;
  sgst: number;
  igst: number;
  itemId: number | null;
}

/** GST of a purchase (mode 'none' without GST). */
export interface PurchaseGst {
  mode: GstMode;
  inclusive: boolean;
  /** Input tax credit claimed: the tax is in the Input GST accounts instead of the cost. */
  itc: boolean;
  supplierGstin: string | null;
  placeOfSupply: string | null;
  interState: boolean;
  taxable: number | null;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
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
  gst: PurchaseGst;
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
    .all<{
      line_no: number;
      description: string;
      unit: string | null;
      qty: number;
      rate: number;
      amount: number;
      hsn: string | null;
      gst_rate: number | null;
      taxable: number | null;
      cgst: number;
      sgst: number;
      igst: number;
      item_id: number | null;
    }>('SELECT line_no, description, unit, qty, rate, amount, hsn, gst_rate, taxable, cgst, sgst, igst, item_id FROM purchase_items WHERE purchase_id = ? ORDER BY line_no', [r.id])
    .map((i) => ({
      lineNo: i.line_no,
      description: i.description,
      unit: i.unit,
      qty: i.qty,
      rate: i.rate,
      amount: i.amount,
      hsn: i.hsn,
      gstRate: i.gst_rate,
      taxable: i.taxable,
      cgst: i.cgst,
      sgst: i.sgst,
      igst: i.igst,
      itemId: i.item_id,
    }));
  const own = gstConfig(ctx);
  const supplierState = gstinState(r.supplier_gstin) ?? r.place_of_supply;
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
    gst: {
      mode: r.gst_mode ?? 'none',
      inclusive: !!r.gst_inclusive,
      itc: !!r.itc,
      supplierGstin: r.supplier_gstin,
      placeOfSupply: r.place_of_supply,
      interState: r.gst_mode === 'regular' && (r.igst > 0 || (!!supplierState && !!own.stateCode && supplierState !== own.stateCode)),
      taxable: r.taxable_total,
      cgst: r.cgst ?? 0,
      sgst: r.sgst ?? 0,
      igst: r.igst ?? 0,
      tax: (r.cgst ?? 0) + (r.sgst ?? 0) + (r.igst ?? 0),
    },
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

/** What the purchase form needs: allowed accounts, whether totals are rounded by default and the GST settings. */
export function purchaseFormOptions(ctx: Ctx): {
  roundOff: boolean;
  defaultAccountId: number;
  accounts: PurchaseAccountOption[];
  gst: { mode: GstMode; stateCode: string | null; defaultRate: number };
} {
  const def = systemAccountId(ctx, 'PURCHASES');
  const accounts = ctx.db
    .all<{ id: number; name: string; group_name: string }>(
      `SELECT a.id, a.name, g.name AS group_name FROM accounts a JOIN account_groups g ON g.code = a.group_code
        WHERE a.is_active = 1 AND (g.type = 'expense' OR a.group_code = 'fixed_assets')
          AND COALESCE(a.system_key, '') NOT IN ('DISCOUNT_ALLOWED', 'ROUND_OFF', 'SALARY', 'INTEREST_EXPENSE', 'COMPOSITION_TAX')
        ORDER BY CASE WHEN a.id = ? THEN 0 ELSE 1 END, g.sort_order, a.code, a.name COLLATE NOCASE`,
      [def],
    )
    .map((a) => ({ id: a.id, name: a.name, groupName: a.group_name, isDefault: a.id === def }));
  const cfg = gstConfig(ctx);
  return {
    roundOff: getSection(ctx, 'billing').roundOff,
    defaultAccountId: def,
    accounts,
    gst: { mode: cfg.mode === 'regular' ? 'regular' : 'none', stateCode: cfg.stateCode, defaultRate: cfg.defaultRate },
  };
}

/* ------------------------------ Validation ------------------------------ */

interface NormalizedPurchase {
  date: string;
  supplier: { id: number; name: string } | null;
  supplierName: string | null;
  supplierBillNo: string | null;
  supplierBillDate: string | null;
  account: AccountRow;
  items: Array<{
    description: string;
    qty: number;
    unit: string | null;
    rate: number;
    amount: number;
    hsn: string | null;
    gstRate: number | null;
    taxable: number | null;
    cgst: number;
    sgst: number;
    igst: number;
    itemId: number | null;
    /** Cost of the line for stock: after its share of the discount; without the GST claimed back. */
    cost: number;
  }>;
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
  gstMode: GstMode;
  gstInclusive: boolean;
  itc: boolean;
  supplierGstin: string | null;
  placeOfSupply: string | null;
  gst: { taxable: number; cgst: number; sgst: number; igst: number; tax: number } | null;
}

function normalize(ctx: Ctx, input: PurchaseInput, before?: PurchaseRow): NormalizedPurchase {
  const date = resolveDocDate(ctx, input.date, { what: 'A purchase', unchangedDate: before?.date });
  if (before) assertSameFinancialYear(before.date, date, `Purchase ${before.purchase_no}`);

  let supplier: { id: number; name: string; gstin: string | null; state_code: string | null } | null = null;
  if (input.supplierId) {
    const s = getSupplierRow(ctx, input.supplierId);
    if (!s.is_active && s.id !== before?.supplier_id) {
      throw fail.validation(`The supplier "${s.name}" is deactivated. Re-activate the supplier first.`, { supplierId: 'Supplier is deactivated' });
    }
    supplier = { id: s.id, name: s.name, gstin: s.gstin, state_code: s.state_code };
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
  // Lines that name a catalogue item are counted in the item's own unit.
  const items = new Map(
    ctx.db
      .all<{ id: number; name: string; unit: string }>(
        `SELECT id, name, unit FROM items WHERE id IN (${[...new Set(input.items.map((it) => it.itemId).filter((x): x is number => !!x))].join(',') || '0'})`,
      )
      .map((r) => [r.id, r]),
  );
  input.items.forEach((it, i) => {
    if (it.itemId && !items.has(it.itemId)) throw fail.validation(`Line ${i + 1}: the item was not found. Choose it again.`, { [`items.${i}.itemId`]: 'Item not found' });
  });
  const roundOffEnabled = input.roundOff ?? getSection(ctx, 'billing').roundOff;
  /* GST: a purchase keeps the treatment it was entered with; only regular registration records the tax separately. */
  const cfg = gstConfig(ctx);
  const gstMode: GstMode = before ? (before.gst_mode ?? 'none') : cfg.mode === 'regular' ? 'regular' : 'none';
  const withGst = gstMode === 'regular';
  const gstInclusive = withGst ? (input.gstInclusive ?? (before ? !!before.gst_inclusive : false)) : false;
  const supplierGstin = withGst ? (supplier?.gstin ?? null) : null;
  const pos = withGst ? placeOfSupply(cfg, supplier) : null;
  const interState = withGst && !!pos && !!cfg.stateCode && pos !== cfg.stateCode;
  // Input tax credit needs the supplier's GSTIN on their bill. Left out when editing = as saved.
  const itc = withGst && !!supplierGstin && (input.itc ?? (before && before.gst_mode === 'regular' ? !!before.itc : true));
  // GST fields left out of an edit keep the saved values of the line with the same description.
  const savedLines = before
    ? ctx.db.all<{ description: string; gst_rate: number | null; hsn: string | null }>('SELECT description, gst_rate, hsn FROM purchase_items WHERE purchase_id = ? ORDER BY line_no', [before.id])
    : [];
  const savedLine = (description: string) => savedLines.find((l) => l.description.toLowerCase() === description.trim().toLowerCase());
  if (withGst && input.itc && !supplierGstin) {
    throw fail.validation(
      supplier ? `Add the GSTIN of ${supplier.name} to claim the GST on this bill.` : 'Choose the supplier (with their GSTIN) to claim the GST on this bill.',
      { itc: 'Supplier GSTIN needed' },
    );
  }
  const gstRates = input.items.map((it, i) => {
    if (!withGst) return null;
    if (it.gstRate !== undefined && it.gstRate !== null && !isGstRate(it.gstRate)) {
      throw fail.validation(`Line ${i + 1}: choose a GST rate from the list`, { [`items.${i}.gstRate`]: 'Choose a GST rate' });
    }
    const problem = hsnProblem(it.hsn);
    if (problem) throw fail.validation(`Line ${i + 1}: ${problem}`, { [`items.${i}.hsn`]: problem });
    return it.gstRate ?? savedLine(it.description)?.gst_rate ?? cfg.defaultRate;
  });
  const t = purchaseTotals({
    items: input.items.map((it, i) => ({ qty: it.qty, rate: it.rate, gstRate: gstRates[i] })),
    discount: input.discount,
    otherCharges: input.otherCharges,
    roundOff: roundOffEnabled,
    gst: withGst ? { inclusive: gstInclusive, interState } : null,
  });
  if (t.discount > t.subtotal) {
    throw fail.validation(`The discount (${formatINR(t.discount)}) cannot be more than the items total (${formatINR(t.subtotal)}).`, { discount: 'Discount is too large' });
  }
  if (t.total <= 0) throw fail.validation('The purchase total must be more than zero', { items: 'Total must be more than zero' });
  const discountShares = shareDiscount(t.amounts, Math.min(t.discount, t.subtotal));

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
    supplier: supplier ? { id: supplier.id, name: supplier.name } : null,
    supplierName,
    supplierBillNo: input.supplierBillNo?.trim() || null,
    supplierBillDate,
    account: purchaseAccount(ctx, input.expenseAccountId),
    items: input.items.map((it, i) => {
      const g = t.gst?.lines[i];
      const linked = it.itemId ? items.get(it.itemId)! : null;
      return {
        itemId: linked?.id ?? null,
        cost: g ? g.taxable + (itc ? 0 : g.cgst + g.sgst + g.igst) : t.amounts[i] - discountShares[i],
        description: it.description.trim(),
        qty: it.qty,
        unit: linked ? linked.unit : it.unit?.trim() || null,
        rate: it.rate,
        amount: t.amounts[i],
        hsn: withGst ? (it.hsn === undefined ? (savedLine(it.description)?.hsn ?? null) : it.hsn?.trim() || null) : null,
        gstRate: g ? g.gstRate : null,
        taxable: g ? g.taxable : null,
        cgst: g?.cgst ?? 0,
        sgst: g?.sgst ?? 0,
        igst: g?.igst ?? 0,
      };
    }),
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
    gstMode,
    gstInclusive,
    itc,
    supplierGstin,
    placeOfSupply: pos,
    gst: t.gst ? { taxable: t.gst.taxable, cgst: t.gst.cgst, sgst: t.gst.sgst, igst: t.gst.igst, tax: t.gst.tax } : null,
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
  // Input tax credit: the tax is claimed back from the government, so it is not part of the cost.
  const credit = v.itc && v.gst ? v.gst : null;
  const lines: EntryLineInput[] = [{ account: v.account.id, debit: v.total - (credit?.tax ?? 0) }];
  if (credit) {
    if (credit.cgst) lines.push({ account: 'GST_IN_CGST', debit: credit.cgst });
    if (credit.sgst) lines.push({ account: 'GST_IN_SGST', debit: credit.sgst });
    if (credit.igst) lines.push({ account: 'GST_IN_IGST', debit: credit.igst });
  }
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
    ctx.db.insert('purchase_items', {
      purchase_id: id,
      line_no: i + 1,
      description: it.description,
      unit: it.unit,
      qty: it.qty,
      rate: it.rate,
      amount: it.amount,
      hsn: it.hsn,
      gst_rate: it.gstRate,
      taxable: it.taxable,
      cgst: it.cgst,
      sgst: it.sgst,
      igst: it.igst,
      item_id: it.itemId,
    }),
  );
  for (const p of v.payments) {
    ctx.db.insert('purchase_payments', { purchase_id: id, mode: p.mode, account_id: p.accountId, amount: p.amount, reference: p.reference });
  }
}

/** Stock: the items of a purchase made while stock tracking was on come into stock at their cost. */
function writePurchaseStock(ctx: Ctx, id: number, v: NormalizedPurchase): void {
  writeDocumentMoves(
    ctx,
    'purchase',
    id,
    v.date,
    v.items.flatMap((it, i) => (it.itemId ? [{ itemId: it.itemId, qty: it.qty, kind: 'purchase' as const, value: Math.max(0, it.cost), line: i + 1 }] : [])),
  );
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
    gst_mode: v.gstMode,
    gst_inclusive: v.gstInclusive ? 1 : 0,
    itc: v.itc ? 1 : 0,
    supplier_gstin: v.supplierGstin,
    place_of_supply: v.placeOfSupply,
    taxable_total: v.gst ? v.gst.taxable : null,
    cgst: v.gst?.cgst ?? 0,
    sgst: v.gst?.sgst ?? 0,
    igst: v.gst?.igst ?? 0,
  };
}

export type SavedPurchase = Purchase & { warnings: string[] };

export function createPurchase(ctx: Ctx, input: PurchaseInput): SavedPurchase {
  const v = normalize(ctx, input);
  const short = shortfallWarnings(ctx, v);
  const num = nextDocNumber(ctx, 'purchase', v.date);
  const tracked = stockEnabled(ctx);
  const id = ctx.db.insert('purchases', {
    purchase_no: num.number,
    seq: num.seq,
    fy_start: num.fyStart,
    ...columns(v),
    stock_tracked: tracked ? 1 : 0,
    created_by: currentUserId(ctx),
    created_at: now(ctx),
  });
  writeLines(ctx, id, v);
  if (tracked) writePurchaseStock(ctx, id, v);
  if (v.itc && v.gst?.tax) useGstAccounts(ctx);
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
  if (before.stock_tracked) writePurchaseStock(ctx, id, v);
  if (v.itc && v.gst?.tax) useGstAccounts(ctx);
  replaceEntry(ctx, before.journal_entry_id!, entryFor(id, before.purchase_no, v));
  const saved = getPurchase(ctx, id);
  recordRevision(ctx, 'purchase', id, 'edited', saved, reason);
  const changes: string[] = [];
  if (before.total !== v.total) changes.push(`total ${formatINR(before.total)} → ${formatINR(v.total)}`);
  if (before.credit !== v.credit) changes.push(`on credit ${formatINR(before.credit)} → ${formatINR(v.credit)}`);
  if (before.date !== v.date) changes.push(`date ${formatDate(before.date)} → ${formatDate(v.date)}`);
  if ((before.supplier_name ?? '') !== (v.supplierName ?? '')) changes.push(`supplier ${before.supplier_name || '-'} → ${v.supplierName || '-'}`);
  if (before.expense_account_id !== v.account.id) changes.push(`account ${before.account_name} → ${v.account.name}`);
  const taxBefore = before.cgst + before.sgst + before.igst;
  if (taxBefore !== (v.gst?.tax ?? 0)) changes.push(`GST ${formatINR(taxBefore)} → ${formatINR(v.gst?.tax ?? 0)}`);
  if (!!before.itc !== v.itc) changes.push(v.itc ? 'GST credit claimed' : 'GST credit not claimed');
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
  removeDocumentMoves(ctx, 'purchase', id);
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

/**
 * Suggestions while typing a purchase line: past descriptions with their last unit and rate (same supplier
 * first). With stock tracking, items from the item list come too (itemId set), so the goods go into stock.
 */
export function purchaseDescriptions(
  ctx: Ctx,
  q: string,
  supplierId?: number | null,
  limit = 12,
): Array<{ description: string; unit: string | null; rate: number; lastDate: string | null; itemId: number | null }> {
  const text = q.trim();
  const rows = ctx.db.all<{ description: string; unit: string | null; rate: number; date: string; item_id: number | null }>(
    `SELECT pi.description, pi.unit, pi.rate, p.date, pi.item_id FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
      WHERE p.status = 'active' AND pi.description LIKE :like
      ORDER BY CASE WHEN p.supplier_id = :sid THEN 0 ELSE 1 END, CASE WHEN pi.description LIKE :prefix THEN 0 ELSE 1 END, p.date DESC, pi.id DESC
      LIMIT 300`,
    { like: `%${text}%`, prefix: `${text}%`, sid: supplierId ?? 0 },
  );
  const seen = new Set<string>();
  const out: Array<{ description: string; unit: string | null; rate: number; lastDate: string | null; itemId: number | null }> = [];
  if (stockEnabled(ctx)) {
    const items = ctx.db.all<{ id: number; name: string; unit: string; last_rate: number | null; last_date: string | null }>(
      `SELECT i.id, i.name, i.unit,
              (SELECT pi.rate FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id WHERE pi.item_id = i.id AND p.status = 'active' ORDER BY p.date DESC, pi.id DESC LIMIT 1) AS last_rate,
              (SELECT MAX(p.date) FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id WHERE pi.item_id = i.id AND p.status = 'active') AS last_date
         FROM items i WHERE i.is_active = 1 AND i.track_stock = 1 AND (i.name LIKE :like OR i.code = :exact)
        ORDER BY CASE WHEN i.name LIKE :prefix THEN 0 ELSE 1 END, i.use_count DESC, i.name COLLATE NOCASE LIMIT :limit`,
      { like: `%${text}%`, prefix: `${text}%`, exact: text, limit },
    );
    for (const i of items) {
      seen.add(i.name.toLowerCase());
      out.push({ description: i.name, unit: i.unit, rate: i.last_rate ?? 0, lastDate: i.last_date, itemId: i.id });
    }
  }
  for (const r of rows) {
    const key = r.description.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ description: r.description, unit: r.unit, rate: r.rate, lastDate: r.date, itemId: null });
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}
