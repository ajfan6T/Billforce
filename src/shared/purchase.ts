import { lineAmount, roundOffAdjustment, type Paise } from './money';
import { lineTax } from './gst';
import { shareDiscount } from './billing';

export interface PurchaseTotalsInput {
  items: Array<{ qty: number; rate: Paise; gstRate?: number | null }>;
  discount?: Paise;
  otherCharges?: Paise;
  /** Round the total to the nearest rupee. */
  roundOff: boolean;
  /** GST on the supplier's bill (regular registration). Omit for no GST. */
  gst?: { inclusive: boolean; interState: boolean } | null;
}

export interface PurchaseLineTax {
  gstRate: number;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
}

export interface PurchaseTotals {
  /** qty x rate for each line. */
  amounts: Paise[];
  subtotal: Paise;
  discount: Paise;
  otherCharges: Paise;
  roundOff: Paise;
  /** subtotal - discount + otherCharges + roundOff (+ GST added on top of the rates) */
  total: Paise;
  /** Tax per line and in total (after sharing the discount over the lines); null without GST. */
  gst: { lines: PurchaseLineTax[]; taxable: Paise; cgst: Paise; sgst: Paise; igst: Paise; tax: Paise } | null;
}

/** Totals of a purchase bill. Used by both the purchase form and the core so they always agree. */
export function purchaseTotals(input: PurchaseTotalsInput): PurchaseTotals {
  const amounts = input.items.map((i) => lineAmount(i.qty, i.rate));
  const subtotal = amounts.reduce((s, a) => s + a, 0);
  const discount = input.discount ?? 0;
  const otherCharges = input.otherCharges ?? 0;
  let gst: PurchaseTotals['gst'] = null;
  let goods = subtotal - discount;
  if (input.gst) {
    const shares = shareDiscount(amounts, Math.min(discount, subtotal));
    const lines = amounts.map((a, i) => {
      const gstRate = Math.max(0, input.items[i].gstRate ?? 0);
      return { gstRate, ...lineTax(a - shares[i], gstRate, input.gst!.inclusive, input.gst!.interState) };
    });
    const sum = (k: 'taxable' | 'cgst' | 'sgst' | 'igst') => lines.reduce((s, l) => s + l[k], 0);
    const cgst = sum('cgst');
    const sgst = sum('sgst');
    const igst = sum('igst');
    gst = { lines, taxable: sum('taxable'), cgst, sgst, igst, tax: cgst + sgst + igst };
    goods = gst.taxable + gst.tax;
  }
  const before = goods + otherCharges;
  const roundOff = input.roundOff ? roundOffAdjustment(before) : 0;
  return { amounts, subtotal, discount, otherCharges, roundOff, total: before + roundOff, gst };
}
