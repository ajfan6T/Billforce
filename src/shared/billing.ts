/**
 * Bill arithmetic shared by the core (which saves bills) and the billing
 * screen (which previews totals while typing), so both always agree.
 * All amounts are integer paise.
 */
import { lineAmount, percentOf, roundOffAdjustment } from './money';
import { lineTax, withoutTax } from './gst';

export interface CalcLineInput {
  qty: number;
  rate: number;
  /** Line discount in paise (ignored when discountPct is given). */
  discount?: number | null;
  /** Line discount as a percentage of qty x rate (0-100). */
  discountPct?: number | null;
  /** GST rate (percent) of the line; used only when the bill has GST. */
  gstRate?: number | null;
}

export interface CalcLine {
  /** qty x rate */
  gross: number;
  discount: number;
  /** Set when the discount was entered as a percentage. */
  discountPct: number | null;
  /** gross - discount */
  amount: number;
}

/** GST of one bill line (after its share of the bill discount). */
export interface CalcLineTax {
  gstRate: number;
  /** Share of the bill discount. */
  billDiscountShare: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** taxable + tax: what the customer pays for the line (before round off). */
  value: number;
  /** qty x rate without tax, and the discounts without tax (grossEx - discountEx = taxable). */
  grossEx: number;
  discountEx: number;
}

export interface BillGstInput {
  /** Rates include GST (tax is taken out of the price) instead of being added on top. */
  inclusive: boolean;
  /** Supply to another state: IGST instead of CGST + SGST. */
  interState: boolean;
}

export interface BillCalcInput {
  lines: CalcLineInput[];
  billDiscount?: number | null;
  billDiscountPct?: number | null;
  /** Round the total to the nearest rupee (settings.billing.roundOff). */
  roundOff: boolean;
  /** Charge GST (regular registration). Omit for no GST. */
  gst?: BillGstInput | null;
}

export interface BillGstTotals {
  inclusive: boolean;
  interState: boolean;
  lines: CalcLineTax[];
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  tax: number;
  /** Credited to Sales: qty x rate without tax. */
  grossEx: number;
  /** Debited to Discount Allowed: item + bill discounts without tax. */
  discountEx: number;
}

export interface CalcProblem {
  /** Line index, or null for the whole bill. */
  line: number | null;
  field: 'discount' | 'billDiscount';
  message: string;
}

export interface BillCalc {
  lines: CalcLine[];
  /** Sum of qty x rate. */
  subtotal: number;
  /** Sum of line discounts. */
  itemDiscount: number;
  /** subtotal - itemDiscount */
  afterItemDiscount: number;
  billDiscount: number;
  billDiscountPct: number | null;
  /** Total before rounding (including GST added on top of the rates). */
  beforeRound: number;
  roundOff: number;
  total: number;
  /** Tax of every line and the bill's tax totals; null when the bill has no GST. */
  gst: BillGstTotals | null;
  problems: CalcProblem[];
}

const hasPct = (p: number | null | undefined): p is number => p !== null && p !== undefined && Number.isFinite(p) && p > 0;

/** Discount for one line: an amount, or a percentage of qty x rate. */
export function calcLine(l: CalcLineInput): CalcLine & { problem?: string } {
  const gross = lineAmount(l.qty, l.rate);
  let discount: number;
  let discountPct: number | null = null;
  let problem: string | undefined;
  if (hasPct(l.discountPct)) {
    discountPct = l.discountPct;
    if (discountPct > 100) problem = 'Discount cannot be more than 100%';
    discount = percentOf(gross, Math.min(discountPct, 100));
  } else {
    discount = Math.max(0, Math.round(l.discount ?? 0));
    if (discount > gross) problem = 'Discount is more than the amount';
  }
  return { gross, discount, discountPct, amount: gross - discount, problem };
}

export function calcBill(input: BillCalcInput): BillCalc {
  const problems: CalcProblem[] = [];
  const lines = input.lines.map((l, i) => {
    const c = calcLine(l);
    if (c.problem) problems.push({ line: i, field: 'discount', message: c.problem });
    const { problem: _p, ...rest } = c;
    void _p;
    return rest;
  });
  const subtotal = lines.reduce((s, l) => s + l.gross, 0);
  const itemDiscount = lines.reduce((s, l) => s + l.discount, 0);
  const afterItemDiscount = subtotal - itemDiscount;
  let billDiscount: number;
  let billDiscountPct: number | null = null;
  if (hasPct(input.billDiscountPct)) {
    billDiscountPct = input.billDiscountPct;
    if (billDiscountPct > 100) problems.push({ line: null, field: 'billDiscount', message: 'Discount cannot be more than 100%' });
    billDiscount = percentOf(Math.max(afterItemDiscount, 0), Math.min(billDiscountPct, 100));
  } else {
    billDiscount = Math.max(0, Math.round(input.billDiscount ?? 0));
    if (billDiscount > 0 && billDiscount > afterItemDiscount) {
      problems.push({ line: null, field: 'billDiscount', message: 'Bill discount is more than the bill amount' });
    }
  }
  const gst = input.gst ? billTax(input.lines, lines, billDiscount, input.gst) : null;
  const beforeRound = gst ? gst.taxable + gst.tax : afterItemDiscount - billDiscount;
  const roundOff = input.roundOff && beforeRound > 0 ? roundOffAdjustment(beforeRound) : 0;
  return {
    lines,
    subtotal,
    itemDiscount,
    afterItemDiscount,
    billDiscount,
    billDiscountPct,
    beforeRound,
    roundOff,
    total: beforeRound + roundOff,
    gst,
    problems,
  };
}

/**
 * GST of a bill, line by line: the bill discount is shared over the lines first (so each line's tax is
 * on what the customer really pays for it), then tax is taken out of the value (rates include GST) or
 * added on top. With rates that include GST the bill total is the same as without GST.
 */
function billTax(inputs: CalcLineInput[], lines: CalcLine[], billDiscount: number, g: BillGstInput): BillGstTotals {
  const shares = shareDiscount(
    lines.map((l) => l.amount),
    billDiscount,
  );
  const out: CalcLineTax[] = lines.map((l, i) => {
    const gstRate = Math.max(0, inputs[i].gstRate ?? 0);
    const net = l.amount - shares[i];
    const t = lineTax(net, gstRate, g.inclusive, g.interState);
    const discount = l.discount + shares[i];
    const discountEx = g.inclusive ? withoutTax(discount, gstRate) : discount;
    return {
      gstRate,
      billDiscountShare: shares[i],
      ...t,
      value: t.taxable + t.cgst + t.sgst + t.igst,
      grossEx: t.taxable + discountEx,
      discountEx,
    };
  });
  const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'igst' | 'grossEx' | 'discountEx') => out.reduce((s, l) => s + l[k], 0);
  const cgst = sum('cgst');
  const sgst = sum('sgst');
  const igst = sum('igst');
  return {
    inclusive: g.inclusive,
    interState: g.interState,
    lines: out,
    taxable: sum('taxable'),
    cgst,
    sgst,
    igst,
    tax: cgst + sgst + igst,
    grossEx: sum('grossEx'),
    discountEx: sum('discountEx'),
  };
}

/** GST rate-wise totals of a bill (for the tax table on invoices and the HSN / rate summaries). */
export function taxByRate(lines: Array<{ gstRate: number | null; taxable: number | null; cgst: number; sgst: number; igst: number }>): Array<{
  rate: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
}> {
  const map = new Map<number, { rate: number; taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const l of lines) {
    const rate = l.gstRate ?? 0;
    const r = map.get(rate) ?? { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += l.taxable ?? 0;
    r.cgst += l.cgst;
    r.sgst += l.sgst;
    r.igst += l.igst;
    map.set(rate, r);
  }
  return [...map.values()].sort((a, b) => a.rate - b.rate);
}

export type BillPaymentMode = 'cash' | 'upi' | 'bank' | 'credit' | 'split';

/**
 * The payment mode shown for a bill: one payment covering everything -> its
 * mode; nothing paid -> credit; anything else -> split.
 */
export function billPaymentMode(total: number, payments: Array<{ mode: 'cash' | 'upi' | 'bank'; amount: number }>): BillPaymentMode {
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  if (payments.length === 0 || paid === 0) return 'credit';
  if (payments.length === 1 && paid === total) return payments[0].mode;
  const modes = new Set(payments.map((p) => p.mode));
  if (modes.size === 1 && paid === total) return payments[0].mode;
  return 'split';
}

/**
 * Share a bill discount across lines in proportion to their amounts, so that
 * the shares add up exactly to the discount (largest remainder method).
 */
export function shareDiscount(amounts: number[], discount: number): number[] {
  const base = amounts.reduce((s, a) => s + Math.max(a, 0), 0);
  if (!discount || base <= 0) return amounts.map(() => 0);
  const exact = amounts.map((a) => (Math.max(a, 0) * discount) / base);
  const shares = exact.map((x) => Math.floor(x));
  let left = discount - shares.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    shares[o.i] += 1;
    left -= 1;
  }
  return shares;
}

export const BILL_PAYMENT_MODE_LABELS: Record<BillPaymentMode, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank: 'Bank',
  credit: 'Credit',
  split: 'Split',
};

/**
 * Label shown for a bill's payment: "Part paid" when part of the bill is on
 * credit (a shopkeeper reads "Split" as "paid in two modes").
 */
export function billPaymentLabel(mode: BillPaymentMode, credit = 0): string {
  if (mode === 'split' && credit > 0) return 'Part paid';
  return BILL_PAYMENT_MODE_LABELS[mode];
}

/* ------------------------------------------------------------------ */
/* Sales returns                                                        */
/* ------------------------------------------------------------------ */

/**
 * What the customer actually paid for each line of a bill: the line amount
 * (after its line discount) less its share of the bill discount and of a
 * rounding down. A rounding up is not spread over the lines (a line is never
 * refunded above its billed amount); it comes back through the return's own
 * round off, or when everything is returned (see returnNoteTotal).
 */
export function netLineAmounts(amounts: number[], total: number): number[] {
  const base = amounts.map((a) => Math.max(a, 0));
  const diff = base.reduce((s, a) => s + a, 0) - total; // bill discount - round off
  if (diff <= 0) return base;
  const shares = shareDiscount(base, diff);
  return base.map((a, i) => a - shares[i]);
}

/**
 * The rate paid per unit, in whole paise, rounded down so that qty x rate is
 * never more than what was paid for the line. Refund lines use it, so their
 * rate always multiplies to their amount.
 */
export function paidRate(netAmount: number, qty: number): number {
  if (!(qty > 0) || netAmount <= 0) return 0;
  let rate = Math.floor(netAmount / qty + 1e-9);
  while (rate > 0 && lineAmount(qty, rate) > netAmount) rate--;
  return rate;
}

/** A bill line as far as returns are concerned (see returns.billReturnable). */
export interface ReturnLineState {
  qtyBilled: number;
  /** Quantity that can still be returned. */
  returnable: number;
  /** Per unit paid by the customer (paidRate); the highest refund rate allowed. */
  netRate: number;
  /** What the customer paid for the whole line. */
  netAmount: number;
  /** Already refunded for this line on active returns. */
  returnedAmount: number;
}

/**
 * Refund value of returning `qty` of a bill line at `rate` per unit: qty x rate,
 * never more than what is left of the line. Paise that per-unit rates leave out
 * are refunded when the whole bill comes back (see returnNoteTotal `settles`).
 */
export function returnLineAmount(line: ReturnLineState, qty: number, rate: number): number {
  const left = Math.max(0, line.netAmount - line.returnedAmount);
  return Math.min(lineAmount(qty, rate), left);
}

/**
 * True when this return takes back everything still returnable on the bill, at
 * the rate paid, and every earlier return on the bill was at the rate paid too:
 * the return then settles the bill exactly (see returnNoteTotal).
 */
export function returnSettlesBill(
  r: { allAtPaidRate: boolean; lines: Array<{ billItemId: number; returnable: number; refundable: number; netRate: number }> },
  items: Array<{ billItemId: number; qty: number | null; rate: number | null }>,
): boolean {
  if (!r.allAtPaidRate) return false;
  let any = false;
  for (const l of r.lines) {
    // Nothing left to refund on the line (free items, or already returned): not needed.
    if (l.returnable <= 0 || l.refundable <= 0) continue;
    const it = items.find((i) => i.billItemId === l.billItemId);
    if (!it || it.qty === null || roundQty(it.qty) < roundQty(l.returnable) || it.rate !== l.netRate) return false;
    any = true;
  }
  return any;
}

export interface ReturnTotalInput {
  billTotal: number;
  /** Totals of the active returns already made against the bill. */
  returnedTotal: number;
  /** Item value (before rounding) of those returns. */
  returnedValue: number;
  /** Item value of this return. */
  value: number;
  /** Round to the nearest rupee (settings.billing.roundOff). */
  roundOff: boolean;
  /** The return takes back everything left at the rate paid (returnSettlesBill). */
  settles?: boolean;
}

/**
 * Total of a return against a bill. Rounding is applied to the running total
 * of all returns on the bill (never note by note), refunds never add up to
 * more than the bill total, and the return that takes back everything left
 * refunds exactly what is left of the bill.
 */
export function returnNoteTotal(r: ReturnTotalInput): number {
  if (r.settles) return r.billTotal - r.returnedTotal;
  const cumulative = r.returnedValue + r.value;
  let target = cumulative;
  if (r.roundOff && cumulative < r.billTotal) target = cumulative + roundOffAdjustment(cumulative);
  return Math.min(target, r.billTotal) - r.returnedTotal;
}

/** Round a quantity to 3 decimals (avoids 0.1 + 0.2 style drift when adding quantities). */
export function roundQty(q: number): number {
  return Math.round(q * 1000) / 1000;
}
