/**
 * GST helpers shared by the core and the UI: registration types, rates,
 * state codes, GSTIN / HSN checks and the tax arithmetic of one line.
 * All amounts are integer paise; rates are percentages (18 = 18%).
 */

export const GST_REGISTRATIONS = ['unregistered', 'regular', 'composition'] as const;
export type GstRegistration = (typeof GST_REGISTRATIONS)[number];

export const GST_REGISTRATION_LABELS: Record<GstRegistration, string> = {
  unregistered: 'Not registered for GST',
  regular: 'Registered (regular)',
  composition: 'Registered (composition scheme)',
};

/** GST treatment saved on each bill / purchase when it is made. */
export type GstMode = 'none' | 'regular' | 'composition';

/** GST rates in use (percent). */
export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40] as const;

export function isGstRate(r: unknown): r is number {
  return typeof r === 'number' && (GST_RATES as readonly number[]).includes(r);
}

/** Composition tax rates (percent of turnover): 1 traders / manufacturers, 5 restaurants, 6 services. */
export const COMPOSITION_RATES = [1, 5, 6] as const;

/** "18%", "0.25%" */
export function formatRate(r: number): string {
  return `${Number.isInteger(r) ? r : r.toString()}%`;
}

/** GST state / union territory codes (the first two digits of a GSTIN). */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

/** Codes still found in older GSTINs. */
const OLD_STATE_CODES: Record<string, string> = { '25': 'Daman & Diu', '28': 'Andhra Pradesh (old)' };

export function stateName(code: string | null | undefined): string {
  if (!code) return '';
  return GST_STATES[code] ?? OLD_STATE_CODES[code] ?? code;
}

/** "Maharashtra (27)" */
export function stateLabel(code: string | null | undefined): string {
  return code ? `${stateName(code)} (${code})` : '';
}

export function isStateCode(code: unknown): code is string {
  return typeof code === 'string' && (code in GST_STATES || code in OLD_STATE_CODES);
}

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The check character (15th) of a GSTIN, from its first 14 characters. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/** Upper-case a typed GSTIN and drop spaces. */
export function normalizeGstin(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, '').toUpperCase();
}

/** Null when the GSTIN is valid, else a message a shop owner understands. */
export function gstinProblem(raw: string): string | null {
  const g = normalizeGstin(raw);
  if (g.length !== 15) return `A GSTIN has 15 characters (this one has ${g.length})`;
  if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(g)) return 'A GSTIN has only capital letters and digits, and starts with the 2-digit state code';
  if (!isStateCode(g.slice(0, 2))) return `"${g.slice(0, 2)}" is not a state code`;
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return 'This GSTIN is not valid (its last character does not match). Please check it for typing mistakes';
  return null;
}

/** The state code of a GSTIN (first two digits), or null. */
export function gstinState(gstin: string | null | undefined): string | null {
  const g = normalizeGstin(gstin);
  return g.length >= 2 && isStateCode(g.slice(0, 2)) ? g.slice(0, 2) : null;
}

/** HSN (goods) / SAC (services) codes are 4, 6 or 8 digits. Null when fine or empty. */
export function hsnProblem(raw: string | null | undefined): string | null {
  const h = (raw ?? '').trim();
  if (!h) return null;
  if (!/^[0-9]{4}([0-9]{2}){0,2}$/.test(h)) return 'HSN / SAC code must be 4, 6 or 8 digits';
  return null;
}

/* ------------------------------------------------------------------ */
/* Tax arithmetic                                                      */
/* ------------------------------------------------------------------ */

/** round(num / den) for integers, halves away from zero (exact for amounts in paise). */
export function divRound(num: number, den: number): number {
  if (num < 0) return -divRound(-num, den);
  return Math.floor((2 * num + den) / (2 * den));
}

/** Rate in hundredths of a percent (18 -> 1800, 0.25 -> 25), so the arithmetic stays in whole numbers. */
const bp = (rate: number) => Math.round(rate * 100);

export interface LineTax {
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
}

/**
 * Tax of one line worth `value` paise at `rate`%.
 * inclusive: the value already contains the tax (taxable + tax = value).
 * exclusive: the value is the taxable value and tax is added on top.
 * Intra-state tax is split equally into CGST and SGST; inter-state tax is IGST.
 */
export function lineTax(value: number, rate: number, inclusive: boolean, interState: boolean): LineTax {
  const r = bp(rate);
  if (!r || !value) return { taxable: value, cgst: 0, sgst: 0, igst: 0 };
  if (inclusive) {
    if (interState) {
      const igst = divRound(value * r, 10000 + r);
      return { taxable: value - igst, cgst: 0, sgst: 0, igst };
    }
    const half = divRound(value * r, 2 * (10000 + r));
    return { taxable: value - 2 * half, cgst: half, sgst: half, igst: 0 };
  }
  if (interState) return { taxable: value, cgst: 0, sgst: 0, igst: divRound(value * r, 10000) };
  const half = divRound(value * r, 20000);
  return { taxable: value, cgst: half, sgst: half, igst: 0 };
}

/** The tax-free part of an amount that includes tax at `rate`% (used for discounts on inclusive rates). */
export function withoutTax(amount: number, rate: number): number {
  const r = bp(rate);
  return r ? divRound(amount * 10000, 10000 + r) : amount;
}

/**
 * Take back part of a line's tax: `part` of a line worth `whole` (both including tax).
 * `left` is the tax of the line not yet taken back; taking everything that is left returns it exactly.
 */
export function taxShare(t: LineTax, whole: number, part: number, left: LineTax, all: boolean): LineTax {
  if (all && left.cgst + left.sgst + left.igst > part) all = false;
  const pick = (k: 'cgst' | 'sgst' | 'igst') => (all ? left[k] : Math.min(left[k], whole > 0 ? divRound(t[k] * part, whole) : 0));
  const cgst = pick('cgst');
  const sgst = pick('sgst');
  const igst = pick('igst');
  return { taxable: part - cgst - sgst - igst, cgst, sgst, igst };
}

export const taxOf = (t: { cgst: number; sgst: number; igst: number }) => t.cgst + t.sgst + t.igst;
