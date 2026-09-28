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

/** Round a quantity to 3 decimals (avoids 0.1 + 0.2 style drift when adding quantities). */
export function roundQty(q: number): number {
  return Math.round(q * 1000) / 1000;
}
