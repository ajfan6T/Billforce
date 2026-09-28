import type { Ctx } from '../../context';
import { now } from '../../context';
import { AppError } from '../../errors';
import { logActivity } from '../../audit';
import { partyBalances } from '../../accounting/ledger';

/*
 * CONTRACT functions used by other modules (billing screen, receipts, import).
 * The customers module owner extends this file but must keep these signatures.
 */

export interface CustomerSummary {
  id: number;
  name: string;
  phone: string | null;
  /** Outstanding balance in paise: + = customer owes you, - = advance. */
  balance: number;
  creditLimit: number | null;
}

/** Type-ahead search by name or phone; includes each customer's current balance. */
export function searchCustomers(ctx: Ctx, q: string, limit = 10): CustomerSummary[] {
  const text = q.trim();
  const rows = ctx.db.all<{ id: number; name: string; phone: string | null; credit_limit: number | null }>(
    text
      ? `SELECT id, name, phone, credit_limit FROM customers
          WHERE is_active = 1 AND (name LIKE :like OR REPLACE(phone, ' ', '') LIKE :phone)
          ORDER BY CASE WHEN name LIKE :prefix THEN 0 ELSE 1 END, name COLLATE NOCASE LIMIT :limit`
      : `SELECT id, name, phone, credit_limit FROM customers WHERE is_active = 1 ORDER BY id DESC LIMIT :limit`,
    text ? { like: `%${text}%`, phone: `%${text.replace(/\s/g, '')}%`, prefix: `${text}%`, limit } : { limit },
  );
  const balances = partyBalances(ctx, 'customer', { account: 'AR' });
  return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, balance: balances.get(r.id) ?? 0, creditLimit: r.credit_limit }));
}

export interface QuickCustomerInput {
  name: string;
  phone?: string | null;
  address?: string | null;
}

/** Add a customer from the billing screen with just a name (and phone). */
export function quickCreateCustomer(ctx: Ctx, input: QuickCustomerInput): CustomerSummary {
  if (input.phone) {
    const dup = ctx.db.get<{ id: number; name: string }>("SELECT id, name FROM customers WHERE REPLACE(phone, ' ', '') = ? AND is_active = 1", [
      input.phone.replace(/\s/g, ''),
    ]);
    if (dup) throw new AppError('VALIDATION', `This phone number already belongs to ${dup.name}`, { phone: `Already used by ${dup.name}` });
  }
  const id = ctx.db.insert('customers', { name: input.name, phone: input.phone ?? null, address: input.address ?? null, created_at: now(ctx) });
  logActivity(ctx, 'customer.create', `Added customer "${input.name}"`, { entityType: 'customer', entityId: id });
  return { id, name: input.name, phone: input.phone ?? null, balance: 0, creditLimit: null };
}
