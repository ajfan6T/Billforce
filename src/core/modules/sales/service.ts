/**
 * Sales bills: create, edit, cancel, list, print and quick repeat.
 *
 * Posting (voucher "sale", source "bill"), per docs/ARCHITECTURE.md:
 *   Dr each payment's cash / bank account (paid part)
 *   Dr AR(customer) for the credit part
 *   Dr DISCOUNT_ALLOWED for item + bill discounts
 *   Dr ROUND_OFF if rounded down        Cr ROUND_OFF if rounded up
 *   Cr SALES gross (sum of qty x rate)
 * Bills with GST (regular registration) credit SALES and debit DISCOUNT_ALLOWED without the tax,
 * and credit the tax to Output CGST + SGST (same state) or Output IGST (another state).
 */
import type { Ctx } from '../../context';
import { canSeeCustomerBalances } from '../customers/service';
import { assertCan, can, currentUserId, now, requireSession, today } from '../../context';
import { AppError, fail } from '../../errors';
import { listRevisions, logActivity, recordRevision } from '../../audit';
import { nextDocNumber, peekDocNumber } from '../../numbering';
import { getSection } from '../../settings';
import { partyBalance, paymentAccountId, postEntry, replaceEntry, voidEntry, type EntryInput, type EntryLineInput } from '../../accounting/ledger';
import { assertDateOpen } from '../../accounting/periods';
import { touchItemUsage } from '../items/service';
import { renderReceiptHtml, upiLink, type ReceiptDoc, type ReceiptTotal } from '../../print/receipt';
import { billPaymentLabel, billPaymentMode, calcBill, roundQty, type BillGstTotals, type BillPaymentMode } from '../../../shared/billing';
import { formatRate, gstinState, hsnProblem, isGstRate, stateLabel, type GstMode } from '../../../shared/gst';
import { gstConfig, gstTable, placeOfSupply, useGstAccounts } from '../gst/common';
import { removeDocumentMoves, shortStockWarnings, writeDocumentMoves, type MoveInput } from '../stock/service';
import { recipeMoves } from '../menu/service';
import { stockEnabled } from '../stock/valuation';
import { amountInWords, formatAmount, formatINR, formatQty } from '../../../shared/money';
import { formatDate, formatTime, fyOf, isValidISODate } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS, type PaymentMode, type SettlementMode } from '../../../shared/constants';
import { assertCancelKeepsClosedAccounts } from '../accounting/common';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface BillLineInput {
  itemId?: number | null;
  itemName: string;
  unit?: string | null;
  qty: number;
  /** Rate in paise. */
  rate: number;
  /** Line discount in paise. */
  discount?: number | null;
  /** Line discount as a percentage (0-100); wins over `discount`. */
  discountPct?: number | null;
  /** GST rate of a one-time line (catalogue items use the item's rate). */
  gstRate?: number | null;
  /** HSN / SAC of a one-time line. */
  hsn?: string | null;
}

export interface BillPaymentInput {
  mode: SettlementMode;
  amount: number;
  accountId?: number | null;
  reference?: string | null;
}

export interface BillInput {
  date?: string | null;
  customerId?: number | null;
  customerName?: string | null;
  customerPhone?: string | null;
  items: BillLineInput[];
  billDiscount?: number | null;
  billDiscountPct?: number | null;
  /** Money received now. Anything left of the total goes on the customer's credit. */
  payments: BillPaymentInput[];
  remarks?: string | null;
}

export interface BillRow {
  id: number;
  bill_no: string;
  seq: number;
  fy_start: string;
  date: string;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  subtotal: number;
  item_discount: number;
  bill_discount: number;
  bill_discount_pct: number | null;
  round_off: number;
  total: number;
  paid: number;
  credit: number;
  payment_mode: BillPaymentMode;
  remarks: string | null;
  status: 'active' | 'cancelled';
  revision: number;
  print_count: number;
  printed_revision: number | null;
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
  seller_gstin: string | null;
  customer_gstin: string | null;
  place_of_supply: string | null;
  taxable_total: number | null;
  cgst: number;
  sgst: number;
  igst: number;
  /** Made while stock tracking was on: the bill takes its items out of stock. */
  stock_tracked: number;
}

interface BillItemRow {
  id: number;
  bill_id: number;
  line_no: number;
  item_id: number | null;
  item_name: string;
  unit: string | null;
  qty: number;
  rate: number;
  discount: number;
  discount_pct: number | null;
  amount: number;
  hsn: string | null;
  gst_rate: number | null;
  taxable: number | null;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface BillItem {
  id: number;
  lineNo: number;
  itemId: number | null;
  itemName: string;
  unit: string | null;
  qty: number;
  rate: number;
  /** qty x rate */
  gross: number;
  discount: number;
  discountPct: number | null;
  /** gross - discount */
  amount: number;
  hsn: string | null;
  /** GST rate; null on bills without GST. */
  gstRate: number | null;
  /** Taxable value after the bill discount; null on bills without GST. */
  taxable: number | null;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface BillPayment {
  id: number;
  mode: SettlementMode;
  accountId: number;
  accountName: string;
  amount: number;
  reference: string | null;
}

export interface BillCustomer {
  id: number;
  name: string;
  phone: string | null;
  /** Current balance: + = customer owes you. */
  balance: number;
  creditLimit: number | null;
  isActive: boolean;
  /** The user may not see customer balances: balance is 0 and creditLimit null. */
  balanceHidden?: boolean;
  /** GST details (place of supply). */
  gstin: string | null;
  stateCode: string | null;
}

export interface BillCreditNoteRef {
  id: number;
  cnNo: string;
  date: string;
  kind: 'return' | 'adjustment';
  total: number;
  refundMode: PaymentMode;
  status: 'active' | 'cancelled';
}

export interface RevisionSummary {
  revision: number;
  action: string;
  reason: string | null;
  username: string | null;
  at: string;
}

/** GST details of a bill (mode 'none' for bills without GST). */
export interface BillGst {
  mode: GstMode;
  /** Rates included the tax. */
  inclusive: boolean;
  sellerGstin: string | null;
  customerGstin: string | null;
  placeOfSupply: string | null;
  interState: boolean;
  taxable: number | null;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
}

export interface BillDetail {
  id: number;
  billNo: string;
  date: string;
  fyStart: string;
  customerId: number | null;
  customerName: string | null;
  customerPhone: string | null;
  subtotal: number;
  itemDiscount: number;
  billDiscount: number;
  billDiscountPct: number | null;
  roundOff: number;
  total: number;
  paid: number;
  credit: number;
  paymentMode: BillPaymentMode;
  remarks: string | null;
  status: 'active' | 'cancelled';
  revision: number;
  printCount: number;
  /** True when the current version was already printed (the next print is a duplicate). */
  printedCurrent: boolean;
  journalEntryId: number | null;
  createdAt: string;
  createdById: number | null;
  createdByName: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  items: BillItem[];
  payments: BillPayment[];
  customer: BillCustomer | null;
  creditNotes: BillCreditNoteRef[];
  /** Total of active returns / credit notes against this bill. */
  returnedTotal: number;
  revisions: RevisionSummary[];
  gst: BillGst;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export function getBillRow(ctx: Ctx, id: number): BillRow {
  const row = ctx.db.get<BillRow>('SELECT * FROM bills WHERE id = ?', [id]);
  if (!row) throw fail.notFound('Bill');
  return row;
}

function userName(ctx: Ctx, id: number | null): string | null {
  if (!id) return null;
  return ctx.db.value<string | null>('SELECT full_name FROM users WHERE id = ?', [id], null);
}

interface CustomerRow {
  id: number;
  name: string;
  phone: string | null;
  credit_limit: number | null;
  is_active: number;
  gstin: string | null;
  state_code: string | null;
}

function customerRow(ctx: Ctx, id: number): CustomerRow | undefined {
  return ctx.db.get<CustomerRow>('SELECT id, name, phone, credit_limit, is_active, gstin, state_code FROM customers WHERE id = ?', [id]);
}

export function customerSummary(ctx: Ctx, id: number): BillCustomer {
  const c = customerRow(ctx, id);
  if (!c) throw fail.notFound('Customer');
  // Same rule as customers.search: balances only for users who may see them.
  if (!canSeeCustomerBalances(ctx)) {
    return { id: c.id, name: c.name, phone: c.phone, balance: 0, creditLimit: null, isActive: !!c.is_active, balanceHidden: true, gstin: c.gstin, stateCode: c.state_code };
  }
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    balance: partyBalance(ctx, 'customer', c.id, { account: 'AR' }),
    creditLimit: c.credit_limit,
    isActive: !!c.is_active,
    gstin: c.gstin,
    stateCode: c.state_code,
  };
}

function toBillItem(r: BillItemRow): BillItem {
  return {
    id: r.id,
    lineNo: r.line_no,
    itemId: r.item_id,
    itemName: r.item_name,
    unit: r.unit,
    qty: r.qty,
    rate: r.rate,
    gross: r.amount + r.discount,
    discount: r.discount,
    discountPct: r.discount_pct,
    amount: r.amount,
    hsn: r.hsn,
    gstRate: r.gst_rate,
    taxable: r.taxable,
    cgst: r.cgst,
    sgst: r.sgst,
    igst: r.igst,
  };
}

export function billGst(b: BillRow): BillGst {
  const seller = gstinState(b.seller_gstin);
  return {
    mode: b.gst_mode ?? 'none',
    inclusive: !!b.gst_inclusive,
    sellerGstin: b.seller_gstin,
    customerGstin: b.customer_gstin,
    placeOfSupply: b.place_of_supply,
    interState: !!seller && !!b.place_of_supply && seller !== b.place_of_supply,
    taxable: b.taxable_total,
    cgst: b.cgst ?? 0,
    sgst: b.sgst ?? 0,
    igst: b.igst ?? 0,
    tax: (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0),
  };
}

export function getBillItems(ctx: Ctx, billId: number): BillItem[] {
  return ctx.db.all<BillItemRow>('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY line_no', [billId]).map(toBillItem);
}

function getBillPayments(ctx: Ctx, billId: number): BillPayment[] {
  return ctx.db
    .all<{ id: number; mode: SettlementMode; account_id: number; account_name: string; amount: number; reference: string | null }>(
      `SELECT p.id, p.mode, p.account_id, a.name AS account_name, p.amount, p.reference
         FROM bill_payments p JOIN accounts a ON a.id = p.account_id WHERE p.bill_id = ? ORDER BY p.id`,
      [billId],
    )
    .map((p) => ({ id: p.id, mode: p.mode, accountId: p.account_id, accountName: p.account_name, amount: p.amount, reference: p.reference }));
}

export function creditNotesForBill(ctx: Ctx, billId: number): BillCreditNoteRef[] {
  return ctx.db
    .all<{ id: number; cn_no: string; date: string; kind: 'return' | 'adjustment'; total: number; refund_mode: PaymentMode; status: 'active' | 'cancelled' }>(
      'SELECT id, cn_no, date, kind, total, refund_mode, status FROM credit_notes WHERE bill_id = ? ORDER BY date, id',
      [billId],
    )
    .map((r) => ({ id: r.id, cnNo: r.cn_no, date: r.date, kind: r.kind, total: r.total, refundMode: r.refund_mode, status: r.status }));
}

export function getBill(ctx: Ctx, id: number): BillDetail {
  const b = getBillRow(ctx, id);
  const creditNotes = creditNotesForBill(ctx, id);
  let customer: BillCustomer | null = null;
  if (b.customer_id) {
    try {
      customer = customerSummary(ctx, b.customer_id);
    } catch {
      customer = null;
    }
  }
  return {
    id: b.id,
    billNo: b.bill_no,
    date: b.date,
    fyStart: b.fy_start,
    customerId: b.customer_id,
    customerName: b.customer_name,
    customerPhone: b.customer_phone,
    subtotal: b.subtotal,
    itemDiscount: b.item_discount,
    billDiscount: b.bill_discount,
    billDiscountPct: b.bill_discount_pct,
    roundOff: b.round_off,
    total: b.total,
    paid: b.paid,
    credit: b.credit,
    paymentMode: b.payment_mode,
    remarks: b.remarks,
    status: b.status,
    revision: b.revision,
    printCount: b.print_count,
    printedCurrent: b.printed_revision !== null && b.printed_revision === b.revision,
    journalEntryId: b.journal_entry_id,
    createdAt: b.created_at,
    createdById: b.created_by,
    createdByName: userName(ctx, b.created_by),
    updatedAt: b.updated_at,
    updatedByName: userName(ctx, b.updated_by),
    cancelledAt: b.cancelled_at,
    cancelledByName: userName(ctx, b.cancelled_by),
    cancelReason: b.cancel_reason,
    items: getBillItems(ctx, id),
    payments: getBillPayments(ctx, id),
    customer,
    creditNotes,
    returnedTotal: creditNotes.filter((c) => c.status === 'active').reduce((s, c) => s + c.total, 0),
    revisions: listRevisions(ctx, 'bill', id).map((r) => ({ revision: r.revision, action: r.action, reason: r.reason, username: r.username, at: r.at })),
    gst: billGst(b),
  };
}

/** Users without "View bills (all days)" may only open today's bills. */
export function assertBillVisible(ctx: Ctx, bill: { date: string; created_by?: number | null }, opts: { allowOwn?: boolean } = {}): void {
  requireSession(ctx);
  if (can(ctx, 'billing.view')) return;
  if (bill.date === today(ctx)) return;
  if (opts.allowOwn && bill.created_by && bill.created_by === currentUserId(ctx)) return;
  throw new AppError('FORBIDDEN', "You can only open today's bills. Ask the owner for permission to view older bills.");
}

/* ------------------------------------------------------------------ */
/* Validation & computation                                            */
/* ------------------------------------------------------------------ */

interface PreparedLine {
  itemId: number | null;
  itemName: string;
  unit: string | null;
  qty: number;
  rate: number;
  discount: number;
  discountPct: number | null;
  amount: number;
  hsn: string | null;
  gstRate: number | null;
  taxable: number | null;
  cgst: number;
  sgst: number;
  igst: number;
}

interface PreparedPayment {
  mode: SettlementMode;
  accountId: number;
  amount: number;
  reference: string | null;
}

interface PreparedBill {
  date: string;
  customer: CustomerRow | null;
  customerName: string | null;
  customerPhone: string | null;
  lines: PreparedLine[];
  subtotal: number;
  itemDiscount: number;
  billDiscount: number;
  billDiscountPct: number | null;
  roundOff: number;
  total: number;
  paid: number;
  credit: number;
  paymentMode: BillPaymentMode;
  payments: PreparedPayment[];
  remarks: string | null;
  warnings: string[];
  /** Catalogue items billed at other than their list rate (for the activity log). */
  rateChanges: Array<{ itemName: string; listRate: number; rate: number }>;
  /** One-time (free-text) lines added with a typed rate (for the activity log details). */
  oneTimeLines: Array<{ itemName: string; qty: number; rate: number }>;
  gstMode: GstMode;
  gstInclusive: boolean;
  sellerGstin: string | null;
  customerGstin: string | null;
  placeOfSupply: string | null;
  /** Tax totals (regular GST bills only). */
  gst: BillGstTotals | null;
}

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t ? t : null;
};

function hasAtMost3Decimals(q: number): boolean {
  return Math.abs(Math.round(q * 1000) - q * 1000) < 1e-6;
}

function prepareBill(ctx: Ctx, input: BillInput, existing: BillRow | null): PreparedBill {
  requireSession(ctx);
  const t = today(ctx);
  const warnings: string[] = [];

  /* Date */
  const date = input.date || (existing ? existing.date : t);
  if (!isValidISODate(date)) throw fail.validation('Enter a valid bill date', { date: 'Enter a valid date' });
  if (date > t) throw fail.validation('The bill date cannot be in the future.', { date: 'Date is in the future' });
  const dateChanged = !existing || date !== existing.date;
  if (dateChanged && date !== t && !can(ctx, 'billing.backdate')) {
    throw new AppError('FORBIDDEN', "You are not allowed to make bills for a past date. Use today's date or ask the owner for permission.", {
      date: 'Past dates need permission',
    });
  }
  if (existing && fyOf(date).start !== existing.fy_start) {
    const fy = fyOf(existing.date);
    throw fail.validation(
      `Bill ${existing.bill_no} belongs to financial year ${fy.name}, so its date must stay between ${formatDate(fy.start)} and ${formatDate(fy.end)}. Cancel it and make a new bill instead.`,
      { date: `Must be within FY ${fy.name}` },
    );
  }
  assertDateOpen(ctx, date, 'This bill');

  /* Customer */
  let customer: CustomerRow | null = null;
  if (input.customerId) {
    customer = customerRow(ctx, input.customerId) ?? null;
    if (!customer) throw fail.validation('The chosen customer was not found. Please pick the customer again.', { customerId: 'Customer not found' });
    if (!customer.is_active && existing?.customer_id !== customer.id) {
      throw fail.validation(`${customer.name} is marked inactive. Re-activate the customer before billing them.`, { customerId: 'Customer is inactive' });
    }
  }
  const customerName = customer ? customer.name : clean(input.customerName);
  const customerPhone = customer ? customer.phone : clean(input.customerPhone);

  /* Lines */
  if (!input.items?.length) throw fail.validation('Add at least one item to the bill.', { items: 'Add an item' });
  const base: Array<
    Omit<PreparedLine, 'discount' | 'discountPct' | 'amount' | 'taxable' | 'cgst' | 'sgst' | 'igst'> & { inDiscount: number | null; inPct: number | null }
  > = [];
  const rateChanges: PreparedBill['rateChanges'] = [];
  const oneTimeLines: PreparedBill['oneTimeLines'] = [];
  const canChangeRate = can(ctx, 'billing.rate');
  // Rates already saved on the bill being edited may stay as they are without the permission
  // (catalogue lines by item, one-time lines by name and rate).
  const savedRates = existing
    ? ctx.db.all<{ item_id: number | null; item_name: string; rate: number; gst_rate: number | null; hsn: string | null }>(
        'SELECT item_id, item_name, rate, gst_rate, hsn FROM bill_items WHERE bill_id = ?',
        [existing.id],
      )
    : [];
  /* GST: a bill keeps the GST treatment it was made with (bills from before registering stay without GST). */
  const cfg = gstConfig(ctx);
  const gstMode: GstMode = existing ? (existing.gst_mode ?? 'none') : cfg.mode;
  const gstInclusive = existing ? !!existing.gst_inclusive : cfg.inclusive;
  const sellerGstin = existing ? existing.seller_gstin : cfg.gstin;
  const charged = gstMode === 'regular';
  input.items.forEach((l, i) => {
    const name = (l.itemName ?? '').trim();
    if (!name) throw fail.validation(`Enter the item name on line ${i + 1}.`, { [`items.${i}.itemName`]: 'Enter the item name' });
    if (!(l.qty > 0)) throw fail.validation(`Quantity of "${name}" must be more than zero.`, { [`items.${i}.qty`]: 'Must be more than zero' });
    if (!hasAtMost3Decimals(l.qty)) throw fail.validation(`Quantity of "${name}" can have at most 3 decimal places.`, { [`items.${i}.qty`]: 'Up to 3 decimals' });
    if (!Number.isInteger(l.rate) || l.rate < 0) throw fail.validation(`Enter a valid rate for "${name}".`, { [`items.${i}.rate`]: 'Invalid rate' });
    let unit = clean(l.unit);
    let itemId: number | null = null;
    let gstRate: number | null = null;
    let hsn: string | null = null;
    if (l.itemId) {
      const item = ctx.db.get<{ id: number; unit: string; rate: number; gst_rate: number | null; hsn: string | null }>(
        'SELECT id, unit, rate, gst_rate, hsn FROM items WHERE id = ?',
        [l.itemId],
      );
      if (!item) throw fail.validation(`Item "${name}" was not found in the item list. Remove the line and add it again.`, { [`items.${i}.itemId`]: 'Item not found' });
      itemId = item.id;
      unit = unit ?? item.unit;
      // A catalogue item is billed at its list rate unless the user may change rates. Items without
      // a list rate (0) take the rate typed at the counter.
      if (item.rate > 0 && l.rate !== item.rate) {
        const saved = savedRates.some((r) => r.item_id === item.id && r.rate === l.rate);
        if (!canChangeRate && !saved) {
          throw new AppError('FORBIDDEN', `You are not allowed to change the rate of "${name}" (list rate ${formatINR(item.rate)}). Bill it at the list rate or ask the owner for permission.`, {
            [`items.${i}.rate`]: 'Rate changes need permission',
          });
        }
        if (!saved) rateChanges.push({ itemName: name, listRate: item.rate, rate: l.rate });
      }
      if (charged) {
        // An item already on the bill being edited keeps the rate it was billed at (rates can change later).
        const savedLine = savedRates.find((r) => r.item_id === item.id && r.gst_rate !== null);
        gstRate = savedLine ? savedLine.gst_rate : (item.gst_rate ?? cfg.defaultRate);
        hsn = savedLine ? savedLine.hsn : item.hsn;
      }
    } else {
      // A one-time (free-text) line sets its own price, so it needs "Change rates". Without it, only a
      // one-time line already saved on the bill being edited may stay (same name and rate); a catalogue
      // line cannot be turned into one.
      const saved = savedRates.some((r) => r.item_id === null && r.item_name.toLowerCase() === name.toLowerCase() && r.rate === l.rate);
      if (!canChangeRate && !saved) {
        throw new AppError('FORBIDDEN', `"${name}" is not in the item list. Choose the item from the item list — your role cannot set prices.`, {
          [`items.${i}.itemName`]: 'Choose an item from the list',
        });
      }
      if (!saved) oneTimeLines.push({ itemName: name, qty: roundQty(l.qty), rate: l.rate });
      if (charged) {
        if (l.gstRate !== undefined && l.gstRate !== null && !isGstRate(l.gstRate)) {
          throw fail.validation(`Choose a GST rate from the list for "${name}".`, { [`items.${i}.gstRate`]: 'Choose a GST rate' });
        }
        const savedLine = savedRates.find((r) => r.item_id === null && r.item_name.toLowerCase() === name.toLowerCase());
        gstRate = l.gstRate ?? savedLine?.gst_rate ?? cfg.defaultRate;
        hsn = clean(l.hsn) ?? savedLine?.hsn ?? null;
        const problem = hsnProblem(hsn);
        if (problem) throw fail.validation(`"${name}": ${problem}.`, { [`items.${i}.hsn`]: problem });
      }
    }
    base.push({ itemId, itemName: name, unit, qty: roundQty(l.qty), rate: l.rate, inDiscount: l.discount ?? null, inPct: l.discountPct ?? null, gstRate, hsn });
  });

  const customerGstin = charged || gstMode === 'composition' ? (customer?.gstin ?? null) : null;
  const pos = gstMode === 'none' ? null : placeOfSupply({ ...cfg, stateCode: gstinState(sellerGstin) }, customer);
  const interState = charged && !!pos && pos !== gstinState(sellerGstin);

  const roundOffOn = getSection(ctx, 'billing').roundOff;
  const calc = calcBill({
    lines: base.map((b) => ({ qty: b.qty, rate: b.rate, discount: b.inDiscount, discountPct: b.inPct, gstRate: b.gstRate })),
    billDiscount: input.billDiscount,
    billDiscountPct: input.billDiscountPct,
    roundOff: roundOffOn,
    gst: charged ? { inclusive: gstInclusive, interState } : null,
  });
  for (const p of calc.problems) {
    if (p.line !== null) {
      const l = calc.lines[p.line];
      throw fail.validation(
        `Discount on "${base[p.line].itemName}" (${formatINR(l.discount)}) is more than its amount (${formatINR(l.gross)}).`,
        { [`items.${p.line}.discount`]: p.message },
      );
    }
    throw fail.validation(`The bill discount (${formatINR(calc.billDiscount)}) is more than the bill amount (${formatINR(calc.afterItemDiscount)}).`, {
      billDiscount: p.message,
    });
  }
  const lines: PreparedLine[] = base.map((b, i) => {
    const t = calc.gst?.lines[i];
    return {
      itemId: b.itemId,
      itemName: b.itemName,
      unit: b.unit,
      qty: b.qty,
      rate: b.rate,
      discount: calc.lines[i].discount,
      discountPct: calc.lines[i].discountPct,
      amount: calc.lines[i].amount,
      hsn: b.hsn,
      gstRate: t ? t.gstRate : null,
      taxable: t ? t.taxable : null,
      cgst: t?.cgst ?? 0,
      sgst: t?.sgst ?? 0,
      igst: t?.igst ?? 0,
    };
  });

  const totalDiscount = calc.itemDiscount + calc.billDiscount;
  const discountBefore = existing ? existing.item_discount + existing.bill_discount : 0;
  if (totalDiscount > discountBefore && !can(ctx, 'billing.discount')) {
    throw new AppError('FORBIDDEN', 'You are not allowed to give discounts. Remove the discount or ask the owner for permission.', {
      billDiscount: 'Discounts need permission',
    });
  }
  if (calc.total <= 0) throw fail.validation('The bill total must be more than zero. Check the rates and discounts.', { total: 'Total is zero' });

  /* Payments */
  // Editing: a payment row sent without an account keeps the account (and reference) it was saved with
  // when its mode and amount are unchanged, so an edit never moves old receipts to today's default account.
  const oldPayments = existing
    ? ctx.db.all<{ mode: SettlementMode; account_id: number; amount: number; reference: string | null }>(
        'SELECT mode, account_id, amount, reference FROM bill_payments WHERE bill_id = ? ORDER BY id',
        [existing.id],
      )
    : [];
  const payments: PreparedPayment[] = (input.payments ?? []).map((p, i) => {
    if (!Number.isInteger(p.amount) || p.amount <= 0) {
      throw fail.validation(`Payment ${i + 1}: amount must be more than zero.`, { [`payments.${i}.amount`]: 'Must be more than zero' });
    }
    let accountId = p.accountId ?? null;
    let reference = clean(p.reference);
    const same = oldPayments.findIndex((o) => o.mode === p.mode && o.amount === p.amount && (!accountId || o.account_id === accountId));
    if (same >= 0) {
      accountId = accountId ?? oldPayments[same].account_id;
      reference = reference ?? oldPayments[same].reference;
      oldPayments.splice(same, 1);
    }
    return { mode: p.mode, accountId: paymentAccountId(ctx, p.mode, accountId), amount: p.amount, reference };
  });
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  if (paid > calc.total) {
    throw fail.validation(
      `Payments (${formatINR(paid)}) are more than the bill total (${formatINR(calc.total)}). Enter only the bill amount; give the rest back as change.`,
      { payments: 'More than the bill total' },
    );
  }
  const credit = calc.total - paid;
  if (credit > 0 && !customer) {
    throw fail.validation(`Choose a customer to keep ${formatINR(credit)} on credit, or take the full payment now.`, {
      customerId: 'Choose a customer for credit',
    });
  }

  /* Credit limit */
  const increasesCredit = !existing || existing.customer_id !== customer?.id || credit > existing.credit;
  const enforceLimit = getSection(ctx, 'billing').enforceCreditLimit;
  if (customer && credit > 0 && customer.credit_limit !== null && customer.credit_limit > 0) {
    let balance = partyBalance(ctx, 'customer', customer.id, { account: 'AR' });
    if (existing && existing.status === 'active' && existing.customer_id === customer.id) balance -= existing.credit;
    const after = balance + credit;
    if (after > customer.credit_limit && increasesCredit) {
      // Users who may not see customer balances get no figures (the limit and dues stay hidden).
      const msg = canSeeCustomerBalances(ctx)
        ? `${customer.name}'s credit limit is ${formatINR(customer.credit_limit)}; with this bill they would owe ${formatINR(after)}.`
        : `${customer.name} would go over their credit limit with this bill.`;
      if (enforceLimit) {
        throw fail.validation(`${msg} Take a payment now or ask the owner to raise the limit.`, { customerId: 'Credit limit exceeded' });
      }
      warnings.push(msg);
    }
  } else if (customer && credit > 0 && enforceLimit && increasesCredit && !can(ctx, 'customers.credit')) {
    // With limits enforced, a customer without a limit gets credit only from users who may set limits,
    // so adding the same person again as a new customer (who has no limit) cannot get round the limit.
    throw fail.validation(
      `${customer.name} has no credit limit set. Ask the owner to set a credit limit for this customer first, or take the full payment now.`,
      { customerId: 'No credit limit set' },
    );
  }

  return {
    date,
    customer,
    customerName,
    customerPhone,
    lines,
    subtotal: calc.subtotal,
    itemDiscount: calc.itemDiscount,
    billDiscount: calc.billDiscount,
    billDiscountPct: calc.billDiscountPct,
    roundOff: calc.roundOff,
    total: calc.total,
    paid,
    credit,
    paymentMode: billPaymentMode(calc.total, payments),
    payments,
    remarks: clean(input.remarks),
    warnings,
    rateChanges,
    oneTimeLines,
    gstMode,
    gstInclusive: charged ? gstInclusive : false,
    sellerGstin: gstMode === 'none' ? null : sellerGstin,
    customerGstin,
    placeOfSupply: pos,
    gst: calc.gst,
  };
}

function buildEntry(p: PreparedBill, billId: number, billNo: string): EntryInput {
  const lines: EntryLineInput[] = [];
  for (const pay of p.payments) {
    lines.push({ account: pay.accountId, debit: pay.amount, memo: `${PAYMENT_MODE_LABELS[pay.mode]}${pay.reference ? ` ref ${pay.reference}` : ''}` });
  }
  if (p.credit > 0) lines.push({ account: 'AR', debit: p.credit, partyType: 'customer', partyId: p.customer!.id, memo: 'On credit' });
  // With GST, Sales and Discount Allowed are without the tax; the tax is owed to the government.
  const discount = p.gst ? p.gst.discountEx : p.itemDiscount + p.billDiscount;
  if (discount > 0) lines.push({ account: 'DISCOUNT_ALLOWED', debit: discount });
  if (p.roundOff < 0) lines.push({ account: 'ROUND_OFF', debit: -p.roundOff });
  lines.push({ account: 'SALES', credit: p.gst ? p.gst.grossEx : p.subtotal });
  if (p.gst) {
    if (p.gst.cgst) lines.push({ account: 'GST_OUT_CGST', credit: p.gst.cgst });
    if (p.gst.sgst) lines.push({ account: 'GST_OUT_SGST', credit: p.gst.sgst });
    if (p.gst.igst) lines.push({ account: 'GST_OUT_IGST', credit: p.gst.igst });
  }
  if (p.roundOff > 0) lines.push({ account: 'ROUND_OFF', credit: p.roundOff });
  return {
    date: p.date,
    voucherType: 'sale',
    voucherNo: billNo,
    sourceType: 'bill',
    sourceId: billId,
    narration: `Bill ${billNo}${p.customerName ? ` - ${p.customerName}` : ''}`,
    lines,
  };
}

function billColumns(p: PreparedBill): Record<string, unknown> {
  return {
    date: p.date,
    customer_id: p.customer?.id ?? null,
    customer_name: p.customerName,
    customer_phone: p.customerPhone,
    subtotal: p.subtotal,
    item_discount: p.itemDiscount,
    bill_discount: p.billDiscount,
    bill_discount_pct: p.billDiscountPct,
    round_off: p.roundOff,
    total: p.total,
    paid: p.paid,
    credit: p.credit,
    payment_mode: p.paymentMode,
    remarks: p.remarks,
    gst_mode: p.gstMode,
    gst_inclusive: p.gstInclusive ? 1 : 0,
    seller_gstin: p.sellerGstin,
    customer_gstin: p.customerGstin,
    place_of_supply: p.placeOfSupply,
    taxable_total: p.gst ? p.gst.taxable : null,
    cgst: p.gst?.cgst ?? 0,
    sgst: p.gst?.sgst ?? 0,
    igst: p.gst?.igst ?? 0,
  };
}

function writeLinesAndPayments(ctx: Ctx, billId: number, p: PreparedBill): void {
  p.lines.forEach((l, i) => {
    ctx.db.insert('bill_items', {
      bill_id: billId,
      line_no: i + 1,
      item_id: l.itemId,
      item_name: l.itemName,
      unit: l.unit,
      qty: l.qty,
      rate: l.rate,
      discount: l.discount,
      discount_pct: l.discountPct,
      amount: l.amount,
      hsn: l.hsn,
      gst_rate: l.gstRate,
      taxable: l.taxable,
      cgst: l.cgst,
      sgst: l.sgst,
      igst: l.igst,
    });
  });
  for (const pay of p.payments) {
    ctx.db.insert('bill_payments', { bill_id: billId, mode: pay.mode, account_id: pay.accountId, amount: pay.amount, reference: pay.reference });
  }
}

/** Stock: the items of a bill made while stock tracking was on leave the stock on the bill date. */
const lineRefs = (p: PreparedBill) => p.lines.map((l, i) => ({ itemId: l.itemId, qty: l.qty, lineNo: i + 1, name: l.itemName }));

/**
 * Goods a bill takes out of stock: the items sold, and the ingredients of dishes (restaurant menu on).
 * `recipe`: the ingredient movements to use instead of reading the recipes now (edits, see editedRecipeMoves).
 */
function billStockMoves(ctx: Ctx, p: PreparedBill, recipe?: MoveInput[]): MoveInput[] {
  const own = lineRefs(p).flatMap((l) => (l.itemId ? [{ itemId: l.itemId, qty: -l.qty, kind: 'sale' as const, line: l.lineNo }] : []));
  return [...own, ...(recipe ?? recipeMoves(ctx, lineRefs(p)))];
}

/**
 * Ingredient movements of an edited bill: kept as recorded while its dishes and their quantities are the
 * same (fixing the customer or the payment never re-reads a recipe changed since), otherwise from today's
 * recipes. A bill that took ingredients out keeps doing so after the menu is turned off.
 * Recorded ingredient movements are the bill's movements with a note ("Butter Chicken x 2").
 */
function editedRecipeMoves(ctx: Ctx, billId: number, p: PreparedBill): MoveInput[] {
  const recorded = ctx.db.all<{ item_id: number; qty: number; source_line: number | null; note: string }>(
    "SELECT item_id, qty, source_line, note FROM stock_moves WHERE source_type = 'bill' AND source_id = ? AND note IS NOT NULL ORDER BY id",
    [billId],
  );
  const oldLines = ctx.db.all<{ item_id: number | null; qty: number }>('SELECT item_id, qty FROM bill_items WHERE bill_id = ? ORDER BY line_no', [billId]);
  const ids = [...new Set([...oldLines.map((l) => l.item_id), ...p.lines.map((l) => l.itemId)].filter((x): x is number => !!x))];
  const dishes = new Set(ids.length ? ctx.db.all<{ id: number }>(`SELECT id FROM items WHERE menu = 1 AND id IN (${ids.join(',')})`).map((r) => r.id) : []);
  const signature = (ls: Array<{ itemId: number | null; qty: number }>) =>
    ls
      .filter((l) => l.itemId && dishes.has(l.itemId))
      .map((l) => `${l.itemId}:${l.qty}`)
      .sort()
      .join('|');
  if (recorded.length && signature(oldLines.map((l) => ({ itemId: l.item_id, qty: l.qty }))) === signature(p.lines)) {
    return recorded.map((r) => ({ itemId: r.item_id, qty: r.qty, kind: 'sale' as const, line: r.source_line, note: r.note }));
  }
  return recipeMoves(ctx, lineRefs(p), { force: recorded.length > 0 });
}

/** `before`: the items (and dish ingredients) on the bill before an edit; see writeDocumentMoves. */
function writeBillStock(ctx: Ctx, billId: number, p: PreparedBill, opts: { before?: number[]; recipe?: MoveInput[] } = {}): void {
  writeDocumentMoves(ctx, 'bill', billId, p.date, billStockMoves(ctx, p, opts.recipe), { before: opts.before });
}

/** Items a saved bill has, with the ingredients of its dishes. */
function billStockItems(ctx: Ctx, billId: number): number[] {
  const lines = ctx.db.all<{ item_id: number | null; qty: number; line_no: number; item_name: string }>('SELECT item_id, qty, line_no, item_name FROM bill_items WHERE bill_id = ?', [billId]);
  return [
    ...lines.flatMap((l) => (l.item_id ? [l.item_id] : [])),
    ...recipeMoves(
      ctx,
      lines.map((l) => ({ itemId: l.item_id, qty: l.qty, lineNo: l.line_no, name: l.item_name })),
    ).map((m) => m.itemId),
  ];
}

/** "Only 2 kg of Chicken in stock" for goods (and ingredients) the bill needs beyond what is in stock. */
function billStockWarnings(ctx: Ctx, p: PreparedBill, billId: number | null, recipe?: MoveInput[]): string[] {
  const out = billStockMoves(ctx, p, recipe).map((m) => ({ itemId: m.itemId, qty: -m.qty }));
  return shortStockWarnings(ctx, out, billId ? { sourceType: 'bill', sourceId: billId } : null);
}

/* ------------------------------------------------------------------ */
/* Snapshots & change descriptions (audit trail)                       */
/* ------------------------------------------------------------------ */

export interface BillSnapshot {
  billNo: string;
  date: string;
  status: 'active' | 'cancelled';
  customerId: number | null;
  customerName: string | null;
  customerPhone: string | null;
  items: Array<{
    itemId: number | null;
    itemName: string;
    unit: string | null;
    qty: number;
    rate: number;
    discount: number;
    discountPct: number | null;
    amount: number;
    /** GST rate (bills with GST; missing in revisions saved before GST). */
    gstRate?: number | null;
  }>;
  subtotal: number;
  itemDiscount: number;
  billDiscount: number;
  billDiscountPct: number | null;
  roundOff: number;
  total: number;
  paid: number;
  credit: number;
  paymentMode: BillPaymentMode;
  payments: Array<{ mode: SettlementMode; accountId: number; accountName: string; amount: number; reference: string | null }>;
  remarks: string | null;
  cancelReason: string | null;
  /** Tax totals of bills with GST. */
  gst?: { taxable: number | null; cgst: number; sgst: number; igst: number; placeOfSupply: string | null } | null;
}

export function billSnapshot(b: BillDetail): BillSnapshot {
  return {
    billNo: b.billNo,
    date: b.date,
    status: b.status,
    customerId: b.customerId,
    customerName: b.customerName,
    customerPhone: b.customerPhone,
    items: b.items.map((i) => ({
      itemId: i.itemId,
      itemName: i.itemName,
      unit: i.unit,
      qty: i.qty,
      rate: i.rate,
      discount: i.discount,
      discountPct: i.discountPct,
      amount: i.amount,
      ...(b.gst.mode === 'regular' ? { gstRate: i.gstRate } : {}),
    })),
    subtotal: b.subtotal,
    itemDiscount: b.itemDiscount,
    billDiscount: b.billDiscount,
    billDiscountPct: b.billDiscountPct,
    roundOff: b.roundOff,
    total: b.total,
    paid: b.paid,
    credit: b.credit,
    paymentMode: b.paymentMode,
    payments: b.payments.map((p) => ({ mode: p.mode, accountId: p.accountId, accountName: p.accountName, amount: p.amount, reference: p.reference })),
    remarks: b.remarks,
    cancelReason: b.cancelReason,
    gst: b.gst.mode === 'regular' ? { taxable: b.gst.taxable, cgst: b.gst.cgst, sgst: b.gst.sgst, igst: b.gst.igst, placeOfSupply: b.gst.placeOfSupply } : null,
  };
}

export interface BillChange {
  /** What changed, e.g. "Total", "Item added", "Sugar". */
  label: string;
  before: string | null;
  after: string | null;
}

const qtyText = (qty: number, unit: string | null) => `${formatQty(qty)}${unit ? ' ' + unit : ''}`;
const discText = (d: number, pct: number | null) => (d ? (pct ? `${formatQty(pct)}% (${formatINR(d)})` : formatINR(d)) : 'none');
const lineText = (i: BillSnapshot['items'][number]) =>
  `${qtyText(i.qty, i.unit)} × ${formatINR(i.rate)}${i.discount ? ` less ${discText(i.discount, i.discountPct)}` : ''} = ${formatINR(i.amount)}${
    i.gstRate !== undefined && i.gstRate !== null ? ` (GST ${formatRate(i.gstRate)})` : ''
  }`;
const paymentsText = (s: BillSnapshot) => {
  const parts = s.payments.map((p) => `${PAYMENT_MODE_LABELS[p.mode]} ${formatINR(p.amount)}`);
  if (s.credit > 0) parts.push(`Credit ${formatINR(s.credit)}`);
  return parts.join(' + ') || 'none';
};

/** Readable differences between two versions of a bill. */
export function diffBills(a: BillSnapshot, b: BillSnapshot): BillChange[] {
  const out: BillChange[] = [];
  if (a.date !== b.date) out.push({ label: 'Date', before: formatDate(a.date), after: formatDate(b.date) });
  const custA = a.customerName ? `${a.customerName}${a.customerId ? '' : ' (walk-in)'}` : 'Walk-in';
  const custB = b.customerName ? `${b.customerName}${b.customerId ? '' : ' (walk-in)'}` : 'Walk-in';
  if (a.customerId !== b.customerId || (a.customerName ?? '') !== (b.customerName ?? '')) out.push({ label: 'Customer', before: custA, after: custB });
  if ((a.customerPhone ?? '') !== (b.customerPhone ?? '') && a.customerId === b.customerId) {
    out.push({ label: 'Phone', before: a.customerPhone || '—', after: b.customerPhone || '—' });
  }

  // Items: match by item id (or name for free-text lines), in order.
  const key = (i: BillSnapshot['items'][number]) => (i.itemId ? `id:${i.itemId}` : `name:${i.itemName.toLowerCase()}`);
  const remaining = [...b.items];
  for (const ia of a.items) {
    const idx = remaining.findIndex((ib) => key(ib) === key(ia));
    if (idx < 0) {
      out.push({ label: 'Item removed', before: `${ia.itemName}: ${lineText(ia)}`, after: null });
      continue;
    }
    const ib = remaining.splice(idx, 1)[0];
    if (
      ia.qty !== ib.qty ||
      ia.rate !== ib.rate ||
      ia.discount !== ib.discount ||
      (ia.unit ?? '') !== (ib.unit ?? '') ||
      ia.itemName !== ib.itemName ||
      (ia.gstRate ?? null) !== (ib.gstRate ?? null)
    ) {
      out.push({ label: ib.itemName, before: lineText(ia), after: lineText(ib) });
    }
  }
  for (const ib of remaining) out.push({ label: 'Item added', before: null, after: `${ib.itemName}: ${lineText(ib)}` });

  if (a.billDiscount !== b.billDiscount) out.push({ label: 'Bill discount', before: discText(a.billDiscount, a.billDiscountPct), after: discText(b.billDiscount, b.billDiscountPct) });
  const taxA = a.gst ? a.gst.cgst + a.gst.sgst + a.gst.igst : 0;
  const taxB = b.gst ? b.gst.cgst + b.gst.sgst + b.gst.igst : 0;
  if (taxA !== taxB) out.push({ label: 'GST', before: formatINR(taxA), after: formatINR(taxB) });
  if ((a.gst?.placeOfSupply ?? null) !== (b.gst?.placeOfSupply ?? null) && a.gst && b.gst) {
    out.push({ label: 'Place of supply', before: stateLabel(a.gst.placeOfSupply) || '—', after: stateLabel(b.gst.placeOfSupply) || '—' });
  }
  if (a.roundOff !== b.roundOff) out.push({ label: 'Round off', before: formatINR(a.roundOff), after: formatINR(b.roundOff) });
  if (a.total !== b.total) out.push({ label: 'Total', before: formatINR(a.total), after: formatINR(b.total) });
  if (paymentsText(a) !== paymentsText(b)) out.push({ label: 'Payment', before: paymentsText(a), after: paymentsText(b) });
  if ((a.remarks ?? '') !== (b.remarks ?? '')) out.push({ label: 'Remarks', before: a.remarks || '—', after: b.remarks || '—' });
  if (a.status !== b.status) out.push({ label: 'Status', before: a.status === 'active' ? 'Active' : 'Cancelled', after: b.status === 'active' ? 'Active' : 'Cancelled' });
  return out;
}

const GENERIC_LABELS = ['Date', 'Customer', 'Phone', 'Bill discount', 'GST', 'Place of supply', 'Round off', 'Total', 'Payment', 'Status'];

/** One line for the activity log, e.g. "total ₹450.00 → ₹500.00; added Sugar: 2 kg × ₹45.00 = ₹90.00". */
export function changeSummary(changes: BillChange[]): string {
  if (!changes.length) return 'no changes';
  return changes
    .map((c) => {
      if (c.label === 'Item added') return `added ${c.after}`;
      if (c.label === 'Item removed') return `removed ${c.before}`;
      if (c.label === 'Remarks') return 'remarks changed';
      const label = GENERIC_LABELS.includes(c.label) ? c.label.toLowerCase() : c.label;
      return `${label} ${c.before} → ${c.after}`;
    })
    .join('; ');
}

export interface BillRevision {
  revision: number;
  action: string;
  reason: string | null;
  username: string | null;
  at: string;
  snapshot: BillSnapshot;
  /** Differences from the previous revision (empty for the first one). */
  changes: BillChange[];
}

export function billRevisions(ctx: Ctx, id: number): BillRevision[] {
  const revs = listRevisions(ctx, 'bill', id);
  return revs.map((r, i) => ({
    revision: r.revision,
    action: r.action,
    reason: r.reason,
    username: r.username,
    at: r.at,
    snapshot: r.snapshot as BillSnapshot,
    changes: i === 0 ? [] : diffBills(revs[i - 1].snapshot as BillSnapshot, r.snapshot as BillSnapshot),
  }));
}

/* ------------------------------------------------------------------ */
/* Create / update / cancel                                            */
/* ------------------------------------------------------------------ */

export type BillResult = BillDetail & { warnings: string[] };

export function createBill(ctx: Ctx, input: BillInput): BillResult {
  const p = prepareBill(ctx, input, null);
  const tracked = stockEnabled(ctx);
  if (tracked) p.warnings.push(...billStockWarnings(ctx, p, null));
  const num = nextDocNumber(ctx, 'bill', p.date);
  const id = ctx.db.insert('bills', {
    bill_no: num.number,
    seq: num.seq,
    fy_start: num.fyStart,
    ...billColumns(p),
    status: 'active',
    revision: 1,
    stock_tracked: tracked ? 1 : 0,
    created_by: currentUserId(ctx),
    created_at: now(ctx),
  });
  writeLinesAndPayments(ctx, id, p);
  if (tracked) writeBillStock(ctx, id, p);
  if (p.gst) useGstAccounts(ctx);
  const entryId = postEntry(ctx, buildEntry(p, id, num.number));
  ctx.db.update('bills', id, { journal_entry_id: entryId });
  for (const itemId of new Set(p.lines.map((l) => l.itemId).filter((x): x is number => !!x))) touchItemUsage(ctx, itemId);

  recordRevision(ctx, 'bill', id, 'created', billSnapshot(getBill(ctx, id)));
  const mode = billPaymentLabel(p.paymentMode, p.credit);
  const rates = rateChangesText(p.rateChanges);
  logActivity(ctx, 'bill.create', `Created bill ${num.number} for ${formatINR(p.total)} (${mode})${p.customerName ? ` - ${p.customerName}` : ''}${rates}`, {
    entityType: 'bill',
    entityId: id,
    details: {
      total: p.total,
      paymentMode: p.paymentMode,
      customerId: p.customer?.id ?? null,
      items: p.lines.length,
      ...(p.rateChanges.length ? { rateChanges: p.rateChanges } : {}),
      ...(p.oneTimeLines.length ? { oneTimeLines: p.oneTimeLines } : {}),
    },
  });
  return { ...getBill(ctx, id), warnings: p.warnings };
}

function activeCreditNotes(ctx: Ctx, billId: number): Array<{ cn_no: string }> {
  return ctx.db.all<{ cn_no: string }>("SELECT cn_no FROM credit_notes WHERE bill_id = ? AND status = 'active' ORDER BY id", [billId]);
}

function assertNoActiveReturns(ctx: Ctx, bill: BillRow, action: 'edit' | 'cancel'): void {
  const notes = activeCreditNotes(ctx, bill.id);
  if (notes.length) {
    const list = notes.map((n) => n.cn_no).join(', ');
    throw fail.validation(
      `Bill ${bill.bill_no} has ${notes.length === 1 ? 'a sales return' : 'sales returns'} (${list}). Cancel ${notes.length === 1 ? 'it' : 'them'} first, then ${action} the bill.`,
    );
  }
}

export function updateBill(ctx: Ctx, id: number, input: BillInput, reason: string | null): BillResult {
  const bill = getBillRow(ctx, id);
  if (bill.status !== 'active') throw fail.validation(`Bill ${bill.bill_no} is cancelled and cannot be edited.`);
  assertNoActiveReturns(ctx, bill, 'edit');
  const before = billSnapshot(getBill(ctx, id));
  const p = prepareBill(ctx, input, bill);
  const recipe = bill.stock_tracked ? editedRecipeMoves(ctx, id, p) : [];
  if (bill.stock_tracked) p.warnings.push(...billStockWarnings(ctx, p, id, recipe));

  const stockBefore = bill.stock_tracked ? billStockItems(ctx, id) : [];
  ctx.db.update('bills', id, { ...billColumns(p), revision: bill.revision + 1, updated_by: currentUserId(ctx), updated_at: now(ctx) });
  ctx.db.run('DELETE FROM bill_items WHERE bill_id = ?', [id]);
  ctx.db.run('DELETE FROM bill_payments WHERE bill_id = ?', [id]);
  writeLinesAndPayments(ctx, id, p);
  if (bill.stock_tracked) writeBillStock(ctx, id, p, { before: stockBefore, recipe });
  if (p.gst) useGstAccounts(ctx);
  const entry = buildEntry(p, id, bill.bill_no);
  if (bill.journal_entry_id) replaceEntry(ctx, bill.journal_entry_id, entry);
  else ctx.db.update('bills', id, { journal_entry_id: postEntry(ctx, entry) });

  const oldItems = new Set(before.items.map((i) => i.itemId).filter(Boolean));
  for (const itemId of new Set(p.lines.map((l) => l.itemId).filter((x): x is number => !!x))) {
    if (!oldItems.has(itemId)) touchItemUsage(ctx, itemId);
  }

  const after = billSnapshot(getBill(ctx, id));
  recordRevision(ctx, 'bill', id, 'edited', after, reason);
  const changes = diffBills(before, after);
  logActivity(ctx, 'bill.edit', `Edited bill ${bill.bill_no}: ${changeSummary(changes)}${rateChangesText(p.rateChanges)}${reason ? `. Reason: ${reason}` : ''}`, {
    entityType: 'bill',
    entityId: id,
    details: { reason, changes, ...(p.rateChanges.length ? { rateChanges: p.rateChanges } : {}), ...(p.oneTimeLines.length ? { oneTimeLines: p.oneTimeLines } : {}) },
  });
  return { ...getBill(ctx, id), warnings: p.warnings };
}

/** ". Rate changed: Sugar ₹45.00 (list ₹48.00)" for the activity log. */
function rateChangesText(list: PreparedBill['rateChanges']): string {
  if (!list.length) return '';
  return `. Rate changed: ${list.map((r) => `${r.itemName} ${formatINR(r.rate)} (list ${formatINR(r.listRate)})`).join(', ')}`;
}

export function cancelBill(ctx: Ctx, id: number, reason: string): BillDetail {
  const bill = getBillRow(ctx, id);
  if (bill.status === 'cancelled') throw fail.validation(`Bill ${bill.bill_no} is already cancelled.`);
  const why = reason.trim();
  if (!why) throw fail.validation('Enter the reason for cancelling the bill.', { reason: 'Reason is required' });
  assertNoActiveReturns(ctx, bill, 'cancel');
  assertCancelKeepsClosedAccounts(ctx, bill.journal_entry_id, 'this bill');
  const at = now(ctx);
  ctx.db.update('bills', id, { status: 'cancelled', cancelled_by: currentUserId(ctx), cancelled_at: at, cancel_reason: why });
  if (bill.journal_entry_id) voidEntry(ctx, bill.journal_entry_id, `Bill ${bill.bill_no} cancelled: ${why}`);
  // The goods of a cancelled bill are back in stock.
  removeDocumentMoves(ctx, 'bill', id);
  const detail = getBill(ctx, id);
  recordRevision(ctx, 'bill', id, 'cancelled', billSnapshot(detail), why);
  logActivity(ctx, 'bill.cancel', `Cancelled bill ${bill.bill_no} (${formatINR(bill.total)}${bill.customer_name ? ` - ${bill.customer_name}` : ''}). Reason: ${why}`, {
    entityType: 'bill',
    entityId: id,
    details: { reason: why, total: bill.total },
  });
  return getBill(ctx, id);
}

/* ------------------------------------------------------------------ */
/* Lists                                                               */
/* ------------------------------------------------------------------ */

export interface BillListQuery {
  from: string;
  to: string;
  q?: string | null;
  status?: 'active' | 'cancelled' | null;
  paymentMode?: BillPaymentMode | null;
  customerId?: number | null;
  limit: number;
  offset: number;
}

export interface BillListRow {
  id: number;
  billNo: string;
  date: string;
  createdAt: string;
  customerId: number | null;
  customerName: string | null;
  customerPhone: string | null;
  itemCount: number;
  itemsSummary: string;
  total: number;
  paid: number;
  credit: number;
  discount: number;
  paymentMode: BillPaymentMode;
  status: 'active' | 'cancelled';
  edited: boolean;
  printCount: number;
  createdByName: string | null;
}

export interface BillListResult {
  from: string;
  to: string;
  /** True when the range was limited to today (user may not view older bills). */
  todayOnly: boolean;
  rows: BillListRow[];
  totals: { count: number; total: number; paid: number; credit: number; discount: number; cancelledCount: number };
  hasMore: boolean;
}

export function listBills(ctx: Ctx, query: BillListQuery): BillListResult {
  requireSession(ctx);
  let { from, to } = query;
  const todayOnly = !can(ctx, 'billing.view');
  if (todayOnly) from = to = today(ctx);
  if (from > to) [from, to] = [to, from];
  const where = ['b.date >= :from', 'b.date <= :to'];
  const params: Record<string, unknown> = { from, to };
  if (query.status) {
    where.push('b.status = :status');
    params.status = query.status;
  }
  if (query.paymentMode) {
    where.push('b.payment_mode = :mode');
    params.mode = query.paymentMode;
  }
  if (query.customerId) {
    where.push('b.customer_id = :customerId');
    params.customerId = query.customerId;
  }
  const text = (query.q ?? '').trim();
  if (text) {
    where.push(`(b.bill_no LIKE :like OR b.customer_name LIKE :like OR REPLACE(COALESCE(b.customer_phone, ''), ' ', '') LIKE :phone
       OR b.remarks LIKE :like OR EXISTS (SELECT 1 FROM bill_items bi WHERE bi.bill_id = b.id AND bi.item_name LIKE :like))`);
    params.like = `%${text}%`;
    params.phone = `%${text.replace(/\s/g, '')}%`;
  }
  const whereSql = where.join(' AND ');
  const rows = ctx.db.all<BillRow & { item_count: number; created_by_name: string | null }>(
    `SELECT b.*, (SELECT COUNT(*) FROM bill_items bi WHERE bi.bill_id = b.id) AS item_count, u.full_name AS created_by_name
       FROM bills b LEFT JOIN users u ON u.id = b.created_by
      WHERE ${whereSql}
      ORDER BY b.date DESC, b.id DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit: query.limit + 1, offset: query.offset },
  );
  const hasMore = rows.length > query.limit;
  if (hasMore) rows.pop();
  const names = new Map<number, string[]>();
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    for (const r of ctx.db.all<{ bill_id: number; item_name: string }>(
      `SELECT bill_id, item_name FROM bill_items WHERE bill_id IN (${ids.map(() => '?').join(',')}) ORDER BY bill_id, line_no`,
      ids,
    )) {
      const list = names.get(r.bill_id) ?? [];
      list.push(r.item_name);
      names.set(r.bill_id, list);
    }
  }
  const totals = ctx.db.get<{ count: number; total: number; paid: number; credit: number; discount: number; cancelled: number }>(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN b.status = 'active' THEN b.total END), 0) AS total,
            COALESCE(SUM(CASE WHEN b.status = 'active' THEN b.paid END), 0) AS paid,
            COALESCE(SUM(CASE WHEN b.status = 'active' THEN b.credit END), 0) AS credit,
            COALESCE(SUM(CASE WHEN b.status = 'active' THEN b.item_discount + b.bill_discount END), 0) AS discount,
            COALESCE(SUM(CASE WHEN b.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
       FROM bills b WHERE ${whereSql}`,
    params,
  )!;
  return {
    from,
    to,
    todayOnly,
    hasMore,
    rows: rows.map((r) => {
      const list = names.get(r.id) ?? [];
      return {
        id: r.id,
        billNo: r.bill_no,
        date: r.date,
        createdAt: r.created_at,
        customerId: r.customer_id,
        customerName: r.customer_name,
        customerPhone: r.customer_phone,
        itemCount: r.item_count,
        itemsSummary: list.length > 3 ? `${list.slice(0, 3).join(', ')} +${list.length - 3} more` : list.join(', '),
        total: r.total,
        paid: r.paid,
        credit: r.credit,
        discount: r.item_discount + r.bill_discount,
        paymentMode: r.payment_mode,
        status: r.status,
        edited: r.revision > 1,
        printCount: r.print_count,
        createdByName: r.created_by_name,
      };
    }),
    totals: {
      count: totals.count,
      total: totals.total,
      paid: totals.paid,
      credit: totals.credit,
      discount: totals.discount,
      cancelledCount: totals.cancelled,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Quick repeat                                                        */
/* ------------------------------------------------------------------ */

export interface RepeatLine {
  itemId: number | null;
  itemName: string;
  unit: string | null;
  qty: number;
  rate: number;
  /** Current default rate of the item (null for free-text lines). */
  defaultRate: number | null;
  discount: number | null;
  discountPct: number | null;
  /** GST rate the new bill will use (item's own rate; null = the usual rate). */
  gstRate: number | null;
  hsn: string | null;
}

export interface RepeatData {
  sourceBillId: number;
  sourceBillNo: string;
  lines: RepeatLine[];
  customer: BillCustomer | null;
  customerName: string | null;
  customerPhone: string | null;
  billDiscount: number | null;
  billDiscountPct: number | null;
  /** Items whose default rate is now different from the old bill. */
  rateChanges: number;
}

export function repeatData(ctx: Ctx, billId: number): RepeatData {
  const b = getBill(ctx, billId);
  const allowDiscount = can(ctx, 'billing.discount');
  // Users who may not change rates get today's list rate for catalogue items.
  const allowRate = can(ctx, 'billing.rate');
  let rateChanges = 0;
  const lines = b.items.map((i): RepeatLine => {
    const item = i.itemId ? ctx.db.get<{ rate: number; unit: string; gst_rate: number | null; hsn: string | null }>('SELECT rate, unit, gst_rate, hsn FROM items WHERE id = ?', [i.itemId]) : undefined;
    if (item && item.rate !== i.rate) rateChanges++;
    return {
      itemId: item ? i.itemId : null,
      itemName: i.itemName,
      unit: i.unit,
      qty: i.qty,
      rate: item && item.rate > 0 && !allowRate ? item.rate : i.rate,
      defaultRate: item ? item.rate : null,
      discount: allowDiscount && !i.discountPct && i.discount ? i.discount : null,
      discountPct: allowDiscount && i.discountPct ? i.discountPct : null,
      gstRate: item ? item.gst_rate : i.gstRate,
      hsn: item ? item.hsn : i.hsn,
    };
  });
  const customer = b.customer && b.customer.isActive ? b.customer : null;
  return {
    sourceBillId: b.id,
    sourceBillNo: b.billNo,
    lines,
    customer,
    customerName: customer ? null : b.customerId ? null : b.customerName,
    customerPhone: customer ? null : b.customerId ? null : b.customerPhone,
    billDiscount: allowDiscount && !b.billDiscountPct && b.billDiscount ? b.billDiscount : null,
    billDiscountPct: allowDiscount && b.billDiscountPct ? b.billDiscountPct : null,
    rateChanges,
  };
}

export interface CustomerItem {
  itemId: number | null;
  itemName: string;
  unit: string | null;
  /** Rate charged to this customer last time. */
  lastRate: number;
  lastQty: number;
  lastDate: string;
  /** Current default rate (null for free-text lines or deleted items). */
  defaultRate: number | null;
  times: number;
  /** GST rate (item's own rate, or the one-time line's last rate; null = the usual rate). */
  gstRate: number | null;
}

/** Items a customer bought recently, newest first (for one-tap repeat on the billing screen). */
export function customerItems(ctx: Ctx, customerId: number, limit = 12): CustomerItem[] {
  const rows = ctx.db.all<{
    item_id: number | null;
    item_name: string;
    unit: string | null;
    rate: number;
    qty: number;
    date: string;
    cur_rate: number | null;
    cur_active: number | null;
    gst_rate: number | null;
    cur_gst: number | null;
  }>(
    `SELECT bi.item_id, bi.item_name, bi.unit, bi.rate, bi.qty, b.date, it.rate AS cur_rate, it.is_active AS cur_active,
            bi.gst_rate, it.gst_rate AS cur_gst
       FROM bill_items bi JOIN bills b ON b.id = bi.bill_id LEFT JOIN items it ON it.id = bi.item_id
      WHERE b.customer_id = ? AND b.status = 'active'
      ORDER BY b.date DESC, b.id DESC, bi.line_no LIMIT 400`,
    [customerId],
  );
  const map = new Map<string, CustomerItem>();
  for (const r of rows) {
    const key = r.item_id ? `id:${r.item_id}` : `name:${r.item_name.toLowerCase()}`;
    const existing = map.get(key);
    if (existing) {
      existing.times++;
      continue;
    }
    if (r.item_id && r.cur_active === 0) continue;
    map.set(key, {
      itemId: r.item_id,
      itemName: r.item_name,
      unit: r.unit,
      lastRate: r.rate,
      lastQty: r.qty,
      lastDate: r.date,
      defaultRate: r.cur_rate,
      times: 1,
      gstRate: r.item_id ? r.cur_gst : r.gst_rate,
    });
  }
  return [...map.values()].slice(0, limit);
}

export interface LastBillInfo {
  id: number;
  billNo: string;
  date: string;
  total: number;
  customerName: string | null;
  itemCount: number;
}

/** The current user's most recent active bill (for "Repeat last bill"). */
export function lastBill(ctx: Ctx): LastBillInfo | null {
  const uid = requireSession(ctx).userId;
  const r = ctx.db.get<{ id: number; bill_no: string; date: string; total: number; customer_name: string | null }>(
    "SELECT id, bill_no, date, total, customer_name FROM bills WHERE created_by = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
    [uid],
  );
  if (!r) return null;
  const itemCount = ctx.db.value<number>('SELECT COUNT(*) FROM bill_items WHERE bill_id = ?', [r.id], 0);
  return { id: r.id, billNo: r.bill_no, date: r.date, total: r.total, customerName: r.customer_name, itemCount };
}

export function nextBillNumber(ctx: Ctx, date?: string | null): string {
  return peekDocNumber(ctx, 'bill', date || today(ctx));
}

/** Settings the billing screen needs (readable by cashiers, unlike the settings module). */
export function posConfig(ctx: Ctx) {
  const billing = getSection(ctx, 'billing');
  const receipt = getSection(ctx, 'receipt');
  const t = today(ctx);
  return {
    today: t,
    nextBillNo: nextBillNumber(ctx, t),
    roundOff: billing.roundOff,
    defaultPaymentMode: billing.defaultPaymentMode,
    enforceCreditLimit: billing.enforceCreditLimit,
    autoPrint: receipt.autoPrint,
    paperWidth: receipt.paperWidth,
    printerName: receipt.printerName,
    booksStartDate: getSection(ctx, 'accounts').booksStartDate,
    gst: posGstConfig(ctx),
  };
}

/** GST settings the billing screen needs to preview tax exactly as the bill will be saved. */
export function posGstConfig(ctx: Ctx): { mode: GstMode; inclusive: boolean; stateCode: string | null; defaultRate: number } {
  const cfg = gstConfig(ctx);
  return { mode: cfg.mode, inclusive: cfg.inclusive, stateCode: cfg.stateCode, defaultRate: cfg.defaultRate };
}

/* ------------------------------------------------------------------ */
/* Receipts & printing                                                 */
/* ------------------------------------------------------------------ */

/** "Items: 3" plus the total quantity when every line has the same unit (adding kg to cups means nothing). */
export function itemCountLine(items: Array<{ qty: number; unit: string | null }>): string {
  const units = new Set(items.map((i) => (i.unit ?? '').toLowerCase()));
  if (units.size !== 1) return `Items: ${items.length}`;
  const unit = items[0]?.unit;
  return `Items: ${items.length}    Qty: ${formatQty(roundQty(items.reduce((s, i) => s + i.qty, 0)))}${unit ? ' ' + unit : ''}`;
}

/** The customer's balance on a receipt: due, advance or nothing (bills and credit notes print it the same way). */
export function customerBalanceLine(balance: number, asOn: string): string {
  const when = ` (as on ${formatDate(asOn)})`;
  if (balance > 0) return `Total due from you: ${formatINR(balance)}${when}`;
  if (balance < 0) return `Advance with us: ${formatINR(-balance)}${when}`;
  return `Nothing due${when}`;
}

export function billReceiptDoc(ctx: Ctx, b: BillDetail, opts: { duplicate?: boolean } = {}): ReceiptDoc {
  const receipt = getSection(ctx, 'receipt');
  const business = getSection(ctx, 'business');
  const sameDay = b.createdAt.slice(0, 10) === b.date;
  const meta: Array<[string, string]> = [
    ['Bill No', b.billNo],
    ['Date', `${formatDate(b.date)}${sameDay ? `  ${formatTime(b.createdAt)}` : ''}`],
  ];
  if (receipt.showCashier && b.createdByName) meta.push(['Cashier', b.createdByName]);
  const g = b.gst;
  const taxInvoice = g.mode === 'regular';
  if (taxInvoice && g.placeOfSupply && (g.interState || g.customerGstin)) meta.push(['Place of supply', stateLabel(g.placeOfSupply)]);

  const items = b.items.map((i) => {
    const notes: string[] = [];
    if (taxInvoice) notes.push(`${i.hsn ? `HSN ${i.hsn} · ` : ''}GST ${formatRate(i.gstRate ?? 0)}`);
    if (i.discount) notes.push(`Less discount${i.discountPct ? ` ${formatQty(i.discountPct)}%` : ''}: -${formatAmount(i.discount)}`);
    return { name: i.itemName, qty: qtyText(i.qty, i.unit), rate: formatAmount(i.rate), amount: formatAmount(i.gross), note: notes.join(' · ') || undefined };
  });

  const totals: ReceiptTotal[] = [];
  // Rates without GST: the tax is added after the discounts, before rounding.
  const taxOnTop = taxInvoice && !g.inclusive;
  const hasAdjust = b.itemDiscount > 0 || b.billDiscount > 0 || b.roundOff !== 0 || taxOnTop;
  if (hasAdjust) totals.push({ label: 'Subtotal', value: formatINR(b.subtotal) });
  if (b.itemDiscount > 0) totals.push({ label: 'Item discount', value: `-${formatINR(b.itemDiscount)}` });
  if (b.billDiscount > 0) totals.push({ label: `Discount${b.billDiscountPct ? ` (${formatQty(b.billDiscountPct)}%)` : ''}`, value: `-${formatINR(b.billDiscount)}` });
  if (taxOnTop) {
    totals.push({ label: 'Taxable value', value: formatINR(g.taxable ?? 0) });
    if (g.cgst) totals.push({ label: 'CGST', value: formatINR(g.cgst) });
    if (g.sgst) totals.push({ label: 'SGST', value: formatINR(g.sgst) });
    if (g.igst) totals.push({ label: 'IGST', value: formatINR(g.igst) });
  }
  if (b.roundOff !== 0) totals.push({ label: 'Round off', value: formatINR(b.roundOff, { plus: true }) });
  totals.push({ label: 'TOTAL', value: formatINR(b.total), big: true });
  for (const p of b.payments) totals.push({ label: `Paid by ${PAYMENT_MODE_LABELS[p.mode]}${p.reference ? ` (${p.reference})` : ''}`, value: formatINR(p.amount) });
  if (b.credit > 0) totals.push({ label: 'Balance on credit', value: formatINR(b.credit), bold: true });

  const lines: string[] = [];
  lines.push(itemCountLine(b.items));
  if (taxInvoice && g.inclusive && g.tax) lines.push(`Prices include GST of ${formatINR(g.tax)}`);
  if (g.mode === 'composition') lines.push('Composition taxable person, not eligible to collect tax on supplies');
  if (b.itemDiscount + b.billDiscount > 0) lines.push(`You saved ${formatINR(b.itemDiscount + b.billDiscount)} on this bill`);
  if (receipt.showAmountInWords) lines.push(amountInWords(b.total));
  // The receipt is for the customer: its balance line comes from the books, even when the user
  // printing it may not see balances on screen (b.customer.balance is then a hidden 0).
  if (b.credit > 0 && b.customerId && b.customer && b.status === 'active') {
    lines.push(customerBalanceLine(partyBalance(ctx, 'customer', b.customerId, { account: 'AR' }), today(ctx)));
  }
  const returns = b.creditNotes.filter((c) => c.status === 'active');
  for (const c of returns) lines.push(`${c.kind === 'return' ? 'Goods returned' : 'Credit note'} ${c.cnNo}: -${formatINR(c.total)}`);
  if (b.remarks) lines.push(`Remarks: ${b.remarks}`);
  if (b.status === 'cancelled') lines.push(`Cancelled${b.cancelledAt ? ` on ${formatDate(b.cancelledAt)}` : ''}: ${b.cancelReason ?? ''}`);

  let qr: ReceiptDoc['qr'];
  const upiId = business.upiId?.trim();
  if (upiId && b.status === 'active' && (receipt.upiQr === 'always' || (receipt.upiQr === 'unpaid' && b.credit > 0))) {
    const amount = b.credit > 0 ? b.credit : b.total;
    qr = { data: upiLink(upiId, business.upiName?.trim() || business.name || 'Shop', amount, `Bill ${b.billNo}`), caption: `Scan to pay ${formatINR(amount)} by UPI` };
  }

  // A customer's GSTIN must be on a tax invoice, so the customer is printed then even when the setting hides it.
  const showParty = b.customerName && (receipt.showCustomer || !!g.customerGstin);
  return {
    title: taxInvoice ? 'TAX INVOICE' : g.mode === 'composition' ? 'BILL OF SUPPLY' : 'BILL',
    headerLines: g.mode !== 'none' && g.sellerGstin ? [`GSTIN: ${g.sellerGstin}`] : undefined,
    duplicate: !!opts.duplicate,
    cancelled: b.status === 'cancelled',
    meta,
    party: showParty ? { label: 'Customer', name: b.customerName!, phone: b.customerPhone, extra: g.customerGstin ? `GSTIN: ${g.customerGstin}` : null } : undefined,
    items,
    totals,
    table: taxInvoice ? gstTable(b.items, g.interState) : undefined,
    lines,
    qr,
  };
}

export function billReceiptHtml(ctx: Ctx, id: number, opts: { duplicate?: boolean } = {}): { html: string; paperWidth: 80 | 58 } {
  const b = getBill(ctx, id);
  const receipt = getSection(ctx, 'receipt');
  return { html: renderReceiptHtml(billReceiptDoc(ctx, b, opts), getSection(ctx, 'business'), receipt), paperWidth: receipt.paperWidth };
}

export interface PrintOutcome {
  printed: boolean;
  duplicate: boolean;
  message: string;
}

/** Send receipt HTML to the configured receipt printer. */
export async function sendToReceiptPrinter(ctx: Ctx, html: string, duplicate: boolean): Promise<{ printed: boolean; message?: string }> {
  const receipt = getSection(ctx, 'receipt');
  const printerName = receipt.printerName?.trim() || undefined;
  return ctx.platform.printHtml(html, {
    printerName,
    silent: !!printerName,
    paperWidthMm: receipt.paperWidth,
    copies: duplicate ? 1 : Math.max(1, receipt.copies || 1),
  });
}

/**
 * Print a bill. The first print of each version is the original; printing
 * the same version again is a reprint: it needs "Reprint bills", is marked
 * DUPLICATE (setting) and is logged.
 */
export async function printBill(ctx: Ctx, id: number): Promise<PrintOutcome> {
  const row = getBillRow(ctx, id);
  assertBillVisible(ctx, row, { allowOwn: false });
  const reprint = row.printed_revision !== null && row.printed_revision === row.revision;
  if (reprint) assertCan(ctx, 'billing.reprint', 'You are not allowed to reprint bills. Ask the owner for permission.');
  const duplicate = reprint && getSection(ctx, 'receipt').markDuplicate;
  const { html } = billReceiptHtml(ctx, id, { duplicate });
  const res = await sendToReceiptPrinter(ctx, html, reprint);
  if (!res.printed) return { printed: false, duplicate, message: res.message || 'Printing was cancelled.' };
  ctx.db.tx(() => {
    ctx.db.run('UPDATE bills SET print_count = print_count + 1, printed_revision = revision WHERE id = ?', [id]);
    if (reprint) {
      logActivity(ctx, 'bill.reprint', `Reprinted bill ${row.bill_no} (${formatINR(row.total)})${duplicate ? ' marked DUPLICATE' : ''}`, {
        entityType: 'bill',
        entityId: id,
        details: { printCount: row.print_count + 1 },
      });
    }
  });
  return { printed: true, duplicate, message: res.message || (reprint ? `Duplicate of ${row.bill_no} sent to the printer` : `Bill ${row.bill_no} sent to the printer`) };
}
