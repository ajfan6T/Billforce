/**
 * Bill arithmetic shared by the core (which saves bills) and the billing
 * screen (which previews totals while typing), so both always agree.
 * All amounts are integer paise.
 */
import { lineAmount, percentOf, roundOffAdjustment } from './money';

export interface CalcLineInput {
  qty: number;
  rate: number;
  /** Line discount in paise (ignored when discountPct is given). */
  discount?: number | null;
  /** Line discount as a percentage of qty x rate (0-100). */
  discountPct?: number | null;
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

export interface BillCalcInput {
  lines: CalcLineInput[];
  billDiscount?: number | null;
  billDiscountPct?: number | null;
  /** Round the total to the nearest rupee (settings.billing.roundOff). */
  roundOff: boolean;
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
  /** Total before rounding. */
  beforeRound: number;
  roundOff: number;
  total: number;
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
  const beforeRound = afterItemDiscount - billDiscount;
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
    problems,
  };
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
 * (after its line discount) less its share of the bill discount and of the
 * bill's round off. The shares are exact, so the result adds up to the bill
 * total to the paisa.
 */
export function netLineAmounts(amounts: number[], total: number): number[] {
  const base = amounts.map((a) => Math.max(a, 0));
  const diff = base.reduce((s, a) => s + a, 0) - total; // bill discount - round off
  if (diff === 0) return base;
  const shares = shareDiscount(base, Math.abs(diff));
  return base.map((a, i) => (diff > 0 ? a - shares[i] : a + shares[i]));
}

/** A bill line as far as returns are concerned (see returns.billReturnable). */
export interface ReturnLineState {
  qtyBilled: number;
  /** Quantity that can still be returned. */
  returnable: number;
  /** Per unit paid by the customer (rounded to the paisa); the highest refund rate allowed. */
  netRate: number;
  /** What the customer paid for the whole line. */
  netAmount: number;
  /** Already refunded for this line on active returns. */
  returnedAmount: number;
}

/**
 * Refund value of returning `qty` of a bill line at `rate` per unit. Never more
 * than what is left of the line; returning all that is left at the paid rate
 * refunds exactly what is left, so per-unit rounding never leaves stray paise.
 */
export function returnLineAmount(line: ReturnLineState, qty: number, rate: number): number {
  const left = Math.max(0, line.netAmount - line.returnedAmount);
  let amount = lineAmount(qty, rate);
  if (roundQty(qty) >= line.returnable && rate === line.netRate && Math.abs(left - amount) <= Math.ceil(line.qtyBilled) + 1) amount = left;
  return Math.min(amount, left);
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
}

/**
 * Total of a return against a bill. Rounding is applied to the running total
 * of all returns on the bill (never note by note), refunds never add up to
 * more than the bill total, and the return that takes back everything left
 * refunds exactly what is left of the bill.
 */
export function returnNoteTotal(r: ReturnTotalInput): number {
  const cumulative = r.returnedValue + r.value;
  let target = cumulative;
  if (r.roundOff && cumulative < r.billTotal) target = cumulative + roundOffAdjustment(cumulative);
  return Math.min(target, r.billTotal) - r.returnedTotal;
}

/** Round a quantity to 3 decimals (avoids 0.1 + 0.2 style drift when adding quantities). */
export function roundQty(q: number): number {
  return Math.round(q * 1000) / 1000;
}
