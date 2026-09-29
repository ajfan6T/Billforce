/**
 * Running quantity and moving average cost of each item, kept on its stock
 * movements (stock_moves.bal_qty / avg_cost: the state after the movement).
 * Order: opening stock first, then by date and id. See valuation.ts.
 */
import type { Db } from '../../db/database';

export const roundStockQty = (q: number) => Math.round(q * 1000) / 1000;

/* ------------------------------------------------------------------ */
/* Running quantity and average cost                                   */
/* ------------------------------------------------------------------ */

export interface State {
  qty: number;
  /** Paise per unit; null = no cost known yet. */
  avg: number | null;
}

interface MoveRow {
  id: number;
  qty: number;
  value: number | null;
  bal_qty: number | null;
  avg_cost: number | null;
}

/** The next state after one movement. */
function step(s: State, m: { qty: number; value: number | null }): State {
  let avg = s.avg;
  if (m.value !== null && m.qty > 0) {
    const base = Math.max(s.qty, 0);
    // Stock of unknown cost takes the cost of the first goods bought at a cost.
    avg = avg === null || base === 0 ? m.value / m.qty : (base * avg + m.value) / (base + m.qty);
  }
  return { qty: roundStockQty(s.qty + m.qty), avg };
}

const sameCost = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);

/** State of an item at the start of `date`: opening stock and everything dated before it. */
export function stateBefore(db: Db, itemId: number, date: string): State {
  const r =
    db.get<{ bal_qty: number | null; avg_cost: number | null }>(
      "SELECT bal_qty, avg_cost FROM stock_moves WHERE item_id = ? AND kind <> 'opening' AND date < ? ORDER BY date DESC, id DESC LIMIT 1",
      [itemId, date],
    ) ?? db.get<{ bal_qty: number | null; avg_cost: number | null }>("SELECT bal_qty, avg_cost FROM stock_moves WHERE item_id = ? AND kind = 'opening' ORDER BY id DESC LIMIT 1", [itemId]);
  return { qty: r?.bal_qty ?? 0, avg: r?.avg_cost ?? null };
}

/** State of an item at the end of `date`. */
export function stateAt(db: Db, itemId: number, date: string): State {
  const r =
    db.get<{ bal_qty: number | null; avg_cost: number | null }>(
      "SELECT bal_qty, avg_cost FROM stock_moves WHERE item_id = ? AND kind <> 'opening' AND date <= ? ORDER BY date DESC, id DESC LIMIT 1",
      [itemId, date],
    ) ?? db.get<{ bal_qty: number | null; avg_cost: number | null }>("SELECT bal_qty, avg_cost FROM stock_moves WHERE item_id = ? AND kind = 'opening' ORDER BY id DESC LIMIT 1", [itemId]);
  return { qty: r?.bal_qty ?? 0, avg: r?.avg_cost ?? null };
}

/**
 * Recompute the running quantity and average cost of items' movements from a date on
 * (null = from the opening stock). Call after adding, changing or removing movements.
 */
export function revalueStock(db: Db, itemIds: Iterable<number>, fromDate: string | null): void {
  for (const itemId of new Set(itemIds)) {
    let s: State;
    let rows: MoveRow[];
    if (fromDate === null) {
      s = { qty: 0, avg: null };
      rows = db.all<MoveRow>(
        "SELECT id, qty, value, bal_qty, avg_cost FROM stock_moves WHERE item_id = ? ORDER BY CASE WHEN kind = 'opening' THEN 0 ELSE 1 END, date, id",
        [itemId],
      );
    } else {
      s = stateBefore(db, itemId, fromDate);
      rows = db.all<MoveRow>("SELECT id, qty, value, bal_qty, avg_cost FROM stock_moves WHERE item_id = ? AND kind <> 'opening' AND date >= ? ORDER BY date, id", [itemId, fromDate]);
    }
    for (const m of rows) {
      s = step(s, m);
      if (m.bal_qty !== s.qty || !sameCost(m.avg_cost, s.avg)) db.run('UPDATE stock_moves SET bal_qty = ?, avg_cost = ? WHERE id = ?', [s.qty, s.avg, m.id]);
    }
  }
}

/** Recompute every item from the start (after an upgrade, import or repair). */
export function revalueAllStock(db: Db): void {
  revalueStock(
    db,
    db.all<{ item_id: number }>('SELECT DISTINCT item_id FROM stock_moves').map((r) => r.item_id),
    null,
  );
}

