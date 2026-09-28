import type { Ctx } from '../../context';
import { now } from '../../context';
import { AppError } from '../../errors';
import { logActivity } from '../../audit';
import { formatINR } from '../../../shared/money';

export interface ItemRow {
  id: number;
  name: string;
  code: string | null;
  unit: string;
  rate: number;
  category: string | null;
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
  isActive: boolean;
  useCount: number;
  lastUsedAt: string | null;
}

export function toItem(r: ItemRow): Item {
  return {
    id: r.id,
    name: r.name,
    code: r.code,
    unit: r.unit,
    rate: r.rate,
    category: r.category,
    isActive: !!r.is_active,
    useCount: r.use_count,
    lastUsedAt: r.last_used_at,
  };
}

export function getItem(ctx: Ctx, id: number): Item {
  const r = ctx.db.get<ItemRow>('SELECT * FROM items WHERE id = ?', [id]);
  if (!r) throw new AppError('NOT_FOUND', 'Item not found');
  return toItem(r);
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
  return ctx.db.all<ItemRow>(sql, params).map(toItem);
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
      WHERE is_active = 1 AND (name LIKE :like OR code = :exact OR code LIKE :prefix)
      ORDER BY CASE WHEN code = :exact COLLATE NOCASE THEN 0
                    WHEN name LIKE :prefix THEN 1
                    ELSE 2 END,
               use_count DESC, name COLLATE NOCASE
      LIMIT :limit`,
    { like: `%${text}%`, exact: text, prefix: `${text}%`, limit },
  );
  return rows.map(toItem);
}

/** Most frequently / recently billed items, for one-tap "quick repeat" buttons. */
export function recentItems(ctx: Ctx, limit = 16): Item[] {
  return ctx.db
    .all<ItemRow>(
      `SELECT * FROM items WHERE is_active = 1
        ORDER BY (use_count > 0) DESC, last_used_at DESC, use_count DESC, name COLLATE NOCASE LIMIT ?`,
      [limit],
    )
    .map(toItem);
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
    updated_at: now(ctx),
  });
  const changes: string[] = [];
  if (before.rate !== input.rate) changes.push(`rate ${formatINR(before.rate)} → ${formatINR(input.rate)}`);
  if (before.name !== input.name) changes.push(`renamed from "${before.name}"`);
  logActivity(ctx, 'item.update', `Updated item "${input.name}"${changes.length ? ': ' + changes.join(', ') : ''}`, {
    entityType: 'item',
    entityId: id,
    details: { before, after: input },
  });
  return getItem(ctx, id);
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
    ctx.db.value<number>('SELECT COUNT(*) FROM credit_note_items WHERE item_id = ?', [id], 0);
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
  return r ? toItem(r) : null;
}
