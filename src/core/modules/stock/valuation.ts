/**
 * Stock quantities and value, from the stock movements (stock_moves).
 *
 * Value = quantity on hand x weighted average cost, where the average is taken
 * over every costed receipt up to the date (opening stock, purchases, stock added
 * at a cost). Sales, returns and other adjustments move quantity at that average,
 * so they do not change it. A quantity below zero is valued at nothing.
 *
 * Opening stock (kind 'opening') is the stock on the books start date: it counts
 * as already there at the start of any period, so it is the opening stock of the
 * first year, not part of its result.
 */
import type { Ctx } from '../../context';
import { getSection } from '../../settings';

export interface ItemStock {
  itemId: number;
  name: string;
  unit: string;
  category: string | null;
  isActive: boolean;
  qty: number;
  /** Average cost per unit in paise (fractional); 0 when no costed receipt yet. */
  avgCost: number;
  /** Stock value in paise (qty x average cost; 0 below zero). */
  value: number;
  /** A cost is known (opening stock or a purchase). */
  costKnown: boolean;
  reorderLevel: number | null;
  status: 'ok' | 'low' | 'out' | 'negative';
}

/** Stock tracking is switched on (Settings > Stock). */
export function stockEnabled(ctx: Ctx): boolean {
  return getSection(ctx, 'stock').enabled === true;
}

export const roundStockQty = (q: number) => Math.round(q * 1000) / 1000;

export function stockStatus(qty: number, reorderLevel: number | null): ItemStock['status'] {
  if (qty < 0) return 'negative';
  if (qty === 0) return 'out';
  if (reorderLevel !== null && reorderLevel > 0 && qty <= reorderLevel) return 'low';
  return 'ok';
}

/**
 * Stock of every tracked item as on `date`: at the end of the day ('end'), or at its start
 * ('start': before that day's movements; the opening stock of a period starting that day).
 */
export function itemStocks(ctx: Ctx, date: string, opts: { edge?: 'start' | 'end'; itemIds?: number[]; includeUntracked?: boolean } = {}): ItemStock[] {
  const edge = opts.edge ?? 'end';
  const dateCond = edge === 'end' ? "(m.kind = 'opening' OR m.date <= :date)" : "(m.kind = 'opening' OR m.date < :date)";
  const where: string[] = [];
  if (!opts.includeUntracked) where.push('i.track_stock = 1');
  if (opts.itemIds) where.push(opts.itemIds.length ? `i.id IN (${opts.itemIds.map((n) => Number(n)).join(',')})` : '0');
  const rows = ctx.db.all<{
    id: number;
    name: string;
    unit: string;
    category: string | null;
    is_active: number;
    reorder_level: number | null;
    qty: number;
    cost_qty: number;
    cost_value: number;
  }>(
    `SELECT i.id, i.name, i.unit, i.category, i.is_active, i.reorder_level,
            COALESCE(SUM(m.qty), 0) AS qty,
            COALESCE(SUM(CASE WHEN m.value IS NOT NULL AND m.qty > 0 THEN m.qty END), 0) AS cost_qty,
            COALESCE(SUM(CASE WHEN m.value IS NOT NULL AND m.qty > 0 THEN m.value END), 0) AS cost_value
       FROM items i LEFT JOIN stock_moves m ON m.item_id = i.id AND ${dateCond}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY i.id ORDER BY i.name COLLATE NOCASE`,
    { date },
  );
  return rows.map((r) => {
    const qty = roundStockQty(r.qty);
    const avgCost = r.cost_qty > 0 ? r.cost_value / r.cost_qty : 0;
    return {
      itemId: r.id,
      name: r.name,
      unit: r.unit,
      category: r.category,
      isActive: !!r.is_active,
      qty,
      avgCost,
      value: qty > 0 ? Math.round(qty * avgCost) : 0,
      costKnown: r.cost_qty > 0,
      reorderLevel: r.reorder_level,
      status: stockStatus(qty, r.reorder_level),
    };
  });
}

/** Total stock value as on a date (see itemStocks for 'start' / 'end'). */
export function stockValue(ctx: Ctx, date: string, edge: 'start' | 'end' = 'end'): number {
  return itemStocks(ctx, date, { edge }).reduce((s, i) => s + i.value, 0);
}

/** Quantity on hand of some items now (every movement, whatever its date), leaving out one document's own. */
export function stockOnHand(ctx: Ctx, itemIds: number[], exclude?: { sourceType: string; sourceId: number } | null): Map<number, number> {
  const ids = [...new Set(itemIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return new Map();
  const skip = exclude ? ' AND NOT (m.source_type = :st AND m.source_id = :sid)' : '';
  const rows = ctx.db.all<{ item_id: number; qty: number }>(
    `SELECT m.item_id, SUM(m.qty) AS qty FROM stock_moves m WHERE m.item_id IN (${ids.join(',')})${skip} GROUP BY m.item_id`,
    exclude ? { st: exclude.sourceType, sid: exclude.sourceId } : {},
  );
  const out = new Map(ids.map((id) => [id, 0]));
  for (const r of rows) out.set(r.item_id, roundStockQty(r.qty));
  return out;
}
