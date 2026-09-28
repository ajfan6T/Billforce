import type { Ctx } from '../../context';
import { now } from '../../context';
import { AppError } from '../../errors';
import { logActivity } from '../../audit';
import { partyBalances } from '../../accounting/ledger';

/*
 * CONTRACT functions used by other modules (purchases, expenses, import).
 * The suppliers module owner extends this file but must keep these signatures.
 */

export interface SupplierSummary {
  id: number;
  name: string;
  phone: string | null;
  /** Amount you owe the supplier in paise (+ = payable, - = advance paid). */
  payable: number;
}

export function searchSuppliers(ctx: Ctx, q: string, limit = 10): SupplierSummary[] {
  const text = q.trim();
  const rows = ctx.db.all<{ id: number; name: string; phone: string | null }>(
    text
      ? `SELECT id, name, phone FROM suppliers
          WHERE is_active = 1 AND (name LIKE :like OR REPLACE(phone, ' ', '') LIKE :phone)
          ORDER BY CASE WHEN name LIKE :prefix THEN 0 ELSE 1 END, name COLLATE NOCASE LIMIT :limit`
      : `SELECT id, name, phone FROM suppliers WHERE is_active = 1 ORDER BY name COLLATE NOCASE LIMIT :limit`,
    text ? { like: `%${text}%`, phone: `%${text.replace(/\s/g, '')}%`, prefix: `${text}%`, limit } : { limit },
  );
  const balances = partyBalances(ctx, 'supplier', { account: 'AP' });
  return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, payable: -(balances.get(r.id) ?? 0) }));
}

export function quickCreateSupplier(ctx: Ctx, input: { name: string; phone?: string | null }): SupplierSummary {
  const dup = ctx.db.get<{ id: number }>('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE AND is_active = 1', [input.name]);
  if (dup) throw new AppError('VALIDATION', `A supplier named "${input.name}" already exists`, { name: 'Name already used' });
  const id = ctx.db.insert('suppliers', { name: input.name, phone: input.phone ?? null, created_at: now(ctx) });
  logActivity(ctx, 'supplier.create', `Added supplier "${input.name}"`, { entityType: 'supplier', entityId: id });
  return { id, name: input.name, phone: input.phone ?? null, payable: 0 };
}
