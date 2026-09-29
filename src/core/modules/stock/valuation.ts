/**
 * Stock quantities and value, from the stock movements (stock_moves).
 *
 * Value = quantity on hand x moving average cost. Each movement keeps the running
 * quantity (bal_qty) and average cost (avg_cost) of its item after it: goods coming
 * in at a cost (opening stock, purchases, stock added at a cost) re-average the
 * cost of what is on hand; everything else (sales, returns, other adjustments)
 * moves quantity at the current average. Stock sold out long ago does not affect
 * the cost of what is on the shelf now. A quantity below zero is valued at nothing,
 * and new stock after that starts again at its own cost.
 *
 * Order: the opening stock (kind 'opening', the stock on the books start date)
 * comes first; it is there at the start of any period, so it is the opening stock
 * of the first year, not part of its result. Then movements by date and id.
 * Writers of stock_moves call revalueStock for the items and dates they touched.
 */
import type { Ctx } from '../../context';
import { getSection } from '../../settings';
import { roundStockQty, stateAt, stateBefore } from './running';

export { revalueAllStock, revalueStock, roundStockQty } from './running';

export interface ItemStock {
  itemId: number;
  name: string;
  unit: string;
  category: string | null;
  isActive: boolean;
  /** "Track stock" is on for the item now (older items may have stock history without it). */
  tracked: boolean;
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

/** Stock tracking is switched on (Settings > Stock & menu). */
export function stockEnabled(ctx: Ctx): boolean {
  return getSection(ctx, 'stock').enabled === true;
}

export function stockStatus(qty: number, reorderLevel: number | null): ItemStock['status'] {
  if (qty < 0) return 'negative';
  if (qty === 0) return 'out';
  if (reorderLevel !== null && reorderLevel > 0 && qty <= reorderLevel) return 'low';
  return 'ok';
}

/* ------------------------------------------------------------------ */
/* Stock on a date                                                     */
/* ------------------------------------------------------------------ */

/**
 * Stock of items as on `date`: at the end of the day ('end'), or at its start ('start': before
 * that day's movements; the opening stock of a period starting that day).
 * Items: tracked ones and any with stock history (so stock of an item that is no longer tracked
 * still counts on the dates it was there); `includeUntracked` = every item; `itemIds` = just those.
 */
export function itemStocks(ctx: Ctx, date: string, opts: { edge?: 'start' | 'end'; itemIds?: number[]; includeUntracked?: boolean } = {}): ItemStock[] {
  const edge = opts.edge ?? 'end';
  const where = opts.itemIds
    ? opts.itemIds.length
      ? `id IN (${opts.itemIds.map((n) => Number(n)).join(',')})`
      : '0'
    : opts.includeUntracked
      ? '1'
      : 'track_stock = 1 OR EXISTS (SELECT 1 FROM stock_moves m WHERE m.item_id = items.id)';
  const rows = ctx.db.all<{ id: number; name: string; unit: string; category: string | null; is_active: number; track_stock: number; reorder_level: number | null }>(
    `SELECT id, name, unit, category, is_active, track_stock, reorder_level FROM items WHERE ${where} ORDER BY name COLLATE NOCASE`,
  );
  return rows.map((r) => {
    const s = edge === 'end' ? stateAt(ctx.db, r.id, date) : stateBefore(ctx.db, r.id, date);
    const qty = roundStockQty(s.qty);
    const avgCost = s.avg ?? 0;
    return {
      itemId: r.id,
      name: r.name,
      unit: r.unit,
      category: r.category,
      isActive: !!r.is_active,
      tracked: !!r.track_stock,
      qty,
      avgCost,
      value: qty > 0 ? Math.round(qty * avgCost) : 0,
      costKnown: s.avg !== null,
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
  // The running quantity after an item's last movement is its stock now.
  if (!exclude) return new Map(ids.map((id) => [id, roundStockQty(stateAt(ctx.db, id, '9999-12-31').qty)]));
  const skip = exclude ? ' AND NOT (m.source_type = :st AND m.source_id = :sid)' : '';
  const rows = ctx.db.all<{ item_id: number; qty: number }>(
    `SELECT m.item_id, SUM(m.qty) AS qty FROM stock_moves m WHERE m.item_id IN (${ids.join(',')})${skip} GROUP BY m.item_id`,
    exclude ? { st: exclude.sourceType, sid: exclude.sourceId } : {},
  );
  const out = new Map(ids.map((id) => [id, 0]));
  for (const r of rows) out.set(r.item_id, roundStockQty(r.qty));
  return out;
}
