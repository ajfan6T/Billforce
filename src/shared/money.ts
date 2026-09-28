/**
 * Money helpers. All amounts are stored and computed as integer paise
 * (1 rupee = 100 paise) so that totals never suffer from floating point drift.
 * Formatting follows the Indian numbering system (lakh / crore grouping).
 */

export type Paise = number;

/** Group the integer part of a number the Indian way: 12,34,56,789 */
export function groupIndian(intDigits: string): string {
  if (intDigits.length <= 3) return intDigits;
  const last3 = intDigits.slice(-3);
  let rest = intDigits.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length) parts.unshift(rest);
  return parts.join(',') + ',' + last3;
}

/** Format a plain number with Indian grouping, e.g. 1234567.5 -> "12,34,567.50". */
export function formatIndianNumber(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '-';
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const grouped = groupIndian(intPart);
  const out = decPart !== undefined ? `${grouped}.${decPart}` : grouped;
  return negative && Number(fixed) !== 0 ? `-${out}` : out;
}

export interface FormatMoneyOptions {
  /** Prefix the rupee symbol. Default true. */
  symbol?: boolean;
  /** Number of decimals, default 2. */
  decimals?: 0 | 2;
  /** Show a "+" sign for positive values. */
  plus?: boolean;
}

/** Format paise as rupees: 12345650 -> "₹1,23,456.50". */
export function formatINR(paise: Paise | null | undefined, opts: FormatMoneyOptions = {}): string {
  const { symbol = true, decimals = 2, plus = false } = opts;
  const value = (paise ?? 0) / 100;
  const negative = value < 0 && Math.abs(value) >= (decimals === 0 ? 0.5 : 0.005);
  const body = formatIndianNumber(Math.abs(value), decimals);
  const sign = negative ? '-' : plus && value > 0 ? '+' : '';
  return `${sign}${symbol ? '₹' : ''}${body}`;
}

/** Format paise without the symbol: "1,23,456.50". */
export function formatAmount(paise: Paise | null | undefined, decimals: 0 | 2 = 2): string {
  return formatINR(paise, { symbol: false, decimals });
}

/** Balance with Dr / Cr suffix, as used in Indian ledgers. Positive = debit. */
export function formatDrCr(paise: Paise, symbol = true): string {
  if (!paise) return formatINR(0, { symbol });
  return `${formatINR(Math.abs(paise), { symbol })} ${paise > 0 ? 'Dr' : 'Cr'}`;
}

/** Convert rupees (possibly fractional) to paise, rounding half away from zero. */
export function rupeesToPaise(rupees: number): Paise {
  const sign = rupees < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(rupees) * 100 + Number.EPSILON * 100);
}

export function paiseToRupees(paise: Paise): number {
  return paise / 100;
}

/**
 * Parse user input such as "₹1,23,456.50", "1234.5", "-50" or "1.5k" into paise.
 * Returns null for empty or invalid input.
 */
export function parseMoney(input: string | number | null | undefined): Paise | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? rupeesToPaise(input) : null;
  let s = input.trim().replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  if (!s) return null;
  let multiplier = 1;
  const suffix = s.slice(-1).toLowerCase();
  if (suffix === 'k') multiplier = 1_000;
  else if (suffix === 'l') multiplier = 1_00_000;
  if (multiplier !== 1) s = s.slice(0, -1);
  if (!/^-?\d*\.?\d*$/.test(s) || s === '-' || s === '.' || s === '-.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return rupeesToPaise(n * multiplier);
}

/** Amount for a line: quantity x rate (rate in paise), rounded to the nearest paisa. */
export function lineAmount(qty: number, ratePaise: Paise): Paise {
  return Math.round(Math.round(qty * 1000) * ratePaise / 1000);
}

/** pct of an amount in paise, rounded to nearest paisa (pct = 10 means 10%). */
export function percentOf(paise: Paise, pct: number): Paise {
  return Math.round((paise * pct) / 100);
}

/** Round a paise amount to the nearest whole rupee; returns the adjustment (may be negative). */
export function roundOffAdjustment(paise: Paise): Paise {
  const rounded = Math.round(paise / 100) * 100;
  return rounded - paise;
}

/** Format a quantity: up to 3 decimals, trailing zeros removed, Indian grouping. */
export function formatQty(qty: number): string {
  if (!Number.isFinite(qty)) return '-';
  const rounded = Math.round(qty * 1000) / 1000;
  const decimals = Number.isInteger(rounded) ? 0 : rounded.toFixed(3).replace(/0+$/, '').split('.')[1].length;
  return formatIndianNumber(rounded, decimals);
}

export function sumPaise(values: Array<Paise | null | undefined>): Paise {
  let total = 0;
  for (const v of values) total += v ?? 0;
  return total;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`;
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ');
}

/** Whole number to words in the Indian system (crore, lakh, thousand). */
export function numberToIndianWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 1_00_00_000);
  n %= 1_00_00_000;
  const lakh = Math.floor(n / 1_00_000);
  n %= 1_00_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${crore > 999 ? numberToIndianWords(crore) : threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (n) parts.push(threeDigits(n));
  return parts.join(' ');
}

/** "Rupees One Thousand Two Hundred and Fifty Paise Only" */
export function amountInWords(paise: Paise): string {
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  let out = `Rupees ${numberToIndianWords(rupees)}`;
  if (p) out += ` and ${twoDigits(p)} Paise`;
  return `${paise < 0 ? 'Minus ' : ''}${out} Only`;
}
