import type { Ctx } from '../../context';
import { now } from '../../context';
import { AppError } from '../../errors';
import { logActivity } from '../../audit';
import { formatINR } from '../../../shared/money';
import { formatQty } from '../../../shared/money';
import { formatRate, hsnProblem, isGstRate } from '../../../shared/gst';
import { stockEnabled, stockOnHand } from '../stock/valuation';
import { defaultTrackStock } from '../stock/service';

export interface ItemRow {
  id: number;
  name: string;
  code: string | null;
  unit: string;
  rate: number;
  category: string | null;
  hsn: string | null;
  gst_rate: number | null;
  track_stock: number;
  reorder_level: number | null;
  sellable: number;
  menu: number;
  is_active: number;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface Item {
  id: number;
  name: string;
  code: string | null;
  unit: string;
  /** Default selling rate in paise. */
  rate: number;
  category: string | null;
  /** HSN / SAC code (GST). */
  hsn: string | null;
  /** GST rate in percent; null = the business's default rate. */
  gstRate: number | null;
  /** Stock is kept for this item (only matters while stock tracking is on). */
  trackStock: boolean;
  /** "Low stock" at or below this quantity. */
  reorderLevel: number | null;
  /** Quantity in stock now (stock tracking on and item tracked), else null. */
  stock: number | null;
  /** Offered on bills. False = an ingredient (restaurant menu): kept in stock, not sold. */
  sellable: boolean;
  /** A dish on the restaurant menu (it may have a recipe). */
  menu: boolean;
  isActive: boolean;
  useCount: number;
  lastUsedAt: string | null;
}

export function toItem(r: ItemRow, stock: number | null = null): Item {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    unit: r.unit,
    rate: r.rate,
    category: r.category,
    hsn: r.hsn,
    gstRate: r.gst_rate,
    trackStock: !!r.track_stock,
    reorderLevel: r.reorder_level,
    stock,
    sellable: r.sellable !== 0,
    menu: !!r.menu,
    isActive: !!r.is_active,
    useCount: r.use_count,
    lastUsedAt: r.last_used_at,
  };
}

/** Items with their quantity in stock (while stock tracking is on). */
function withStock(ctx: Ctx, rows: ItemRow[]): Item[] {
  if (!stockEnabled(ctx)) return rows.map((r) => toItem(r));
  const onHand = stockOnHand(
    ctx,
    rows.filter((r) => r.track_stock).map((r) => r.id),
  );
  return rows.map((r) => toItem(r, r.track_stock ? (onHand.get(r.id) ?? 0) : null));
}

export function getItem(ctx: Ctx, id: number): Item {
  const r = ctx.db.get<ItemRow>('SELECT * FROM items WHERE id = ?', [id]);
  if (!r) throw new AppError('NOT_FOUND', 'Item not found');
  return withStock(ctx, [r])[0];
}

export function listItems(ctx: Ctx, opts: { q?: string | null; category?: string | null; includeInactive?: boolean }): Item[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeInactive) where.push('is_active = 1');
  if (opts.q) {
    where.push('(name LIKE ? OR code LIKE ? OR category LIKE ?)');
    const like = `%${opts.q}%`;
    params.push(like, like, like);
  }
  if (opts.category) {
    where.push('category = ?');
    params.push(opts.category);
  }
  const sql = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name COLLATE NOCASE`;
  return withStock(ctx, ctx.db.all<ItemRow>(sql, params));
}

/**
 * Suggestions while typing on the billing screen: exact code first, then
 * names starting with the text, then names containing it; frequently used
 * items rank higher.
 */
export function searchItems(ctx: Ctx, q: string, limit = 12): Item[] {
  const text = q.trim();
  if (!text) return recentItems(ctx, limit);
  const rows = ctx.db.all<ItemRow>(
    `SELECT * FROM items
      WHERE is_active = 1 AND sellable = 1 AND (name LIKE :like OR code = :exact OR code LIKE :prefix)
      ORDER BY CASE WHEN code = :exact COLLATE NOCASE THEN 0
                    WHEN name LIKE :prefix THEN 1
                    ELSE 2 END,
               use_count DESC, name COLLATE NOCASE
      LIMIT :limit`,
    { like: `%${text}%`, exact: text, prefix: `${text}%`, limit },
  );
  return withStock(ctx, rows);
}

/** Most frequently / recently billed items, for one-tap "quick repeat" buttons. */
export function recentItems(ctx: Ctx, limit = 16): Item[] {
  return withStock(
    ctx,
    ctx.db.all<ItemRow>(
      `SELECT * FROM items WHERE is_active = 1 AND sellable = 1
        ORDER BY (use_count > 0) DESC, last_used_at DESC, use_count DESC, name COLLATE NOCASE LIMIT ?`,
      [limit],
    ),
  );
}

export function itemCategories(ctx: Ctx): string[] {
  return ctx.db
    .all<{ category: string }>("SELECT DISTINCT category FROM items WHERE category IS NOT NULL AND category <> '' ORDER BY category COLLATE NOCASE")
    .map((r) => r.category);
}

export interface ItemInput {
  name: string;
  code?: string | null;
  unit: string;
  rate: number;
  category?: string | null;
  /** Left out = unchanged (forms of unregistered businesses do not show GST fields). */
  hsn?: string | null;
  gstRate?: number | null;
  /** Stock fields: left out = unchanged (new items: tracked when stock tracking is on, except services). */
  trackStock?: boolean;
  reorderLevel?: number | null;
  /** Offered on bills (restaurant menu: false for ingredients). Left out = unchanged (new items: sold). */
  sellable?: boolean;
}

/** The stock columns of an item input (only those given). */
function stockColumns(input: Pick<ItemInput, 'trackStock' | 'reorderLevel'>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.trackStock !== undefined) out.track_stock = input.trackStock ? 1 : 0;
  if (input.reorderLevel !== undefined) {
    const r = input.reorderLevel;
    if (r !== null && (!(r >= 0) || Math.abs(Math.round(r * 1000) - r * 1000) > 1e-6)) {
      throw new AppError('VALIDATION', 'Enter the low-stock quantity (up to 3 decimals)', { reorderLevel: 'Invalid quantity' });
    }
    out.reorder_level = r || null;
  }
  return out;
}

/** The GST columns of an item input (only those given). */
function gstColumns(input: ItemInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.hsn !== undefined) {
    const hsn = input.hsn?.trim() || null;
    const problem = hsnProblem(hsn);
    if (problem) throw new AppError('VALIDATION', problem, { hsn: problem });
    out.hsn = hsn;
  }
  if (input.gstRate !== undefined) {
    if (input.gstRate !== null && !isGstRate(input.gstRate)) throw new AppError('VALIDATION', 'Choose a GST rate from the list', { gstRate: 'Choose a GST rate' });
    out.gst_rate = input.gstRate;
  }
  return out;
}

function assertUniqueName(ctx: Ctx, name: string, exceptId?: number) {
  const clash = ctx.db.get<{ id: number }>('SELECT id FROM items WHERE name = ? AND id <> ?', [name, exceptId ?? 0]);
  if (clash) throw new AppError('VALIDATION', `An item named "${name}" already exists`, { name: 'Name already used' });
}

export function createItem(ctx: Ctx, input: ItemInput): Item {
  assertUniqueName(ctx, input.name);
  const id = ctx.db.insert('items', {
    name: input.name,
    code: input.code || null,
    unit: input.unit || 'pcs',
    rate: input.rate,
    category: input.category || null,
    ...gstColumns(input),
    track_stock: (input.trackStock ?? defaultTrackStock(ctx, input.unit || 'pcs')) ? 1 : 0,
    ...stockColumns({ reorderLevel: input.reorderLevel }),
    sellable: input.sellable === false ? 0 : 1,
    created_at: now(ctx),
  });
  logActivity(ctx, 'item.create', `Added item "${input.name}" at ${formatINR(input.rate)}/${input.unit}`, { entityType: 'item', entityId: id });
  return getItem(ctx, id);
}

export function updateItem(ctx: Ctx, id: number, input: ItemInput): Item {
  const before = getItem(ctx, id);
  assertUniqueName(ctx, input.name, id);
  ctx.db.update('items', id, {
    name: input.name,
    code: input.code || null,
    unit: input.unit || 'pcs',
    rate: input.rate,
    category: input.category || null,
    ...gstColumns(input),
    // Dishes are not stocked themselves: selling one takes its ingredients out of stock.
    ...stockColumns(before.menu ? { ...input, trackStock: false } : input),
    // Dishes are always sold.
    ...(input.sellable !== undefined && !before.menu ? { sellable: input.sellable ? 1 : 0 } : {}),
    updated_at: now(ctx),
  });
  const after = getItem(ctx, id);
  const changes: string[] = [];
  if (before.rate !== input.rate) changes.push(`rate ${formatINR(before.rate)} → ${formatINR(input.rate)}`);
  if (before.gstRate !== after.gstRate) changes.push(`GST ${before.gstRate === null ? 'default' : formatRate(before.gstRate)} → ${after.gstRate === null ? 'default' : formatRate(after.gstRate)}`);
  if ((before.hsn ?? '') !== (after.hsn ?? '')) changes.push(`HSN ${before.hsn || 'none'} → ${after.hsn || 'none'}`);
  if (before.trackStock !== after.trackStock) changes.push(after.trackStock ? 'stock tracked' : 'stock no longer tracked');
  if (before.sellable !== after.sellable) changes.push(after.sellable ? 'sold on bills' : 'no longer sold on bills (ingredient)');
  if (before.reorderLevel !== after.reorderLevel) {
    changes.push(`low stock at ${before.reorderLevel === null ? 'none' : formatQty(before.reorderLevel)} → ${after.reorderLevel === null ? 'none' : formatQty(after.reorderLevel)}`);
  }
  if (before.name !== input.name) changes.push(`renamed from "${before.name}"`);
  logActivity(ctx, 'item.update', `Updated item "${input.name}"${changes.length ? ': ' + changes.join(', ') : ''}`, {
    entityType: 'item',
    entityId: id,
    details: { before, after },
  });
  return after;
}

/** Change only the default rate (quick edit from the item list). */
export function setItemRate(ctx: Ctx, id: number, rate: number): Item {
  const before = getItem(ctx, id);
  if (before.rate === rate) return before;
  ctx.db.update('items', id, { rate, updated_at: now(ctx) });
  logActivity(ctx, 'item.update', `Changed rate of "${before.name}": ${formatINR(before.rate)} → ${formatINR(rate)}/${before.unit}`, {
    entityType: 'item',
    entityId: id,
    details: { before: before.rate, after: rate },
  });
  return getItem(ctx, id);
}

export function setItemActive(ctx: Ctx, id: number, active: boolean): Item {
  const item = getItem(ctx, id);
  ctx.db.update('items', id, { is_active: active ? 1 : 0, updated_at: now(ctx) });
  logActivity(ctx, active ? 'item.activate' : 'item.deactivate', `${active ? 'Re-activated' : 'Deactivated'} item "${item.name}"`, {
    entityType: 'item',
    entityId: id,
  });
  return getItem(ctx, id);
}

/** Delete an item that was never billed; otherwise it is only deactivated. */
export function removeItem(ctx: Ctx, id: number): { deleted: boolean } {
  const item = getItem(ctx, id);
  const used =
    ctx.db.value<number>('SELECT COUNT(*) FROM bill_items WHERE item_id = ?', [id], 0) +
    ctx.db.value<number>('SELECT COUNT(*) FROM credit_note_items WHERE item_id = ?', [id], 0) +
    ctx.db.value<number>('SELECT COUNT(*) FROM purchase_items WHERE item_id = ?', [id], 0) +
    ctx.db.value<number>('SELECT COUNT(*) FROM stock_moves WHERE item_id = ?', [id], 0) +
    ctx.db.value<number>('SELECT COUNT(*) FROM stock_adjustment_items WHERE item_id = ?', [id], 0) +
    ctx.db.value<number>('SELECT COUNT(*) FROM recipe_items WHERE ingredient_id = ?', [id], 0);
  if (used) {
    setItemActive(ctx, id, false);
    return { deleted: false };
  }
  ctx.db.run('DELETE FROM items WHERE id = ?', [id]);
  logActivity(ctx, 'item.delete', `Deleted item "${item.name}"`, { entityType: 'item', entityId: id });
  return { deleted: true };
}

/** Record that an item was billed (drives "frequently used" suggestions). */
export function touchItemUsage(ctx: Ctx, itemId: number): void {
  ctx.db.run('UPDATE items SET use_count = use_count + 1, last_used_at = ? WHERE id = ?', [now(ctx), itemId]);
}

/** Find an active item by exact name (case-insensitive). */
export function findItemByName(ctx: Ctx, name: string): Item | null {
  const r = ctx.db.get<ItemRow>('SELECT * FROM items WHERE name = ?', [name.trim()]);
  return r ? withStock(ctx, [r])[0] : null;
}
