/**
 * Unit conversion for recipes: a recipe may give an ingredient in grams while
 * the ingredient is stocked in kilograms (or ml / litres). Units of the same
 * kind convert; other units (pcs, plate, box ...) only match themselves.
 */

const FACTORS: Record<string, { base: string; factor: number }> = {
  kg: { base: 'g', factor: 1000 },
  g: { base: 'g', factor: 1 },
  ltr: { base: 'ml', factor: 1000 },
  l: { base: 'ml', factor: 1000 },
  litre: { base: 'ml', factor: 1000 },
  ml: { base: 'ml', factor: 1 },
  dozen: { base: 'pcs', factor: 12 },
  pcs: { base: 'pcs', factor: 1 },
};

const key = (u: string | null | undefined) => (u ?? '').trim().toLowerCase();

/** Units a quantity in `unit` can be written in (e.g. kg -> kg, g). */
export function compatibleUnits(unit: string): string[] {
  const f = FACTORS[key(unit)];
  if (!f) return [unit];
  return Object.entries(FACTORS)
    .filter(([u, x]) => x.base === f.base && (u === 'kg' || u === 'g' || u === 'ltr' || u === 'ml' || u === 'pcs' || u === 'dozen'))
    .map(([u]) => u);
}

/** Convert a quantity between units; null when the units are of different kinds. */
export function convertQty(qty: number, from: string, to: string): number | null {
  if (key(from) === key(to)) return qty;
  const a = FACTORS[key(from)];
  const b = FACTORS[key(to)];
  if (!a || !b || a.base !== b.base) return null;
  return Math.round(((qty * a.factor) / b.factor) * 1e6) / 1e6;
}
