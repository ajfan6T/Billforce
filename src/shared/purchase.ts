import { lineAmount, roundOffAdjustment, type Paise } from './money';

export interface PurchaseTotalsInput {
  items: Array<{ qty: number; rate: Paise }>;
  discount?: Paise;
  otherCharges?: Paise;
  /** Round the total to the nearest rupee. */
  roundOff: boolean;
}

export interface PurchaseTotals {
  /** qty x rate for each line. */
  amounts: Paise[];
  subtotal: Paise;
  discount: Paise;
  otherCharges: Paise;
  roundOff: Paise;
  /** subtotal - discount + otherCharges + roundOff */
  total: Paise;
}

/** Totals of a purchase bill. Used by both the purchase form and the core so they always agree. */
export function purchaseTotals(input: PurchaseTotalsInput): PurchaseTotals {
  const amounts = input.items.map((i) => lineAmount(i.qty, i.rate));
  const subtotal = amounts.reduce((s, a) => s + a, 0);
  const discount = input.discount ?? 0;
  const otherCharges = input.otherCharges ?? 0;
  const before = subtotal - discount + otherCharges;
  const roundOff = input.roundOff ? roundOffAdjustment(before) : 0;
  return { amounts, subtotal, discount, otherCharges, roundOff, total: before + roundOff };
}
