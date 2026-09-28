import type { Ctx } from '../../context';
import { now, today } from '../../context';
import { AppError, fail } from '../../errors';
import { logActivity } from '../../audit';
import { partyBalance, partyBalances } from '../../accounting/ledger';
import { setPartyOpeningBalance } from '../../accounting/opening';
import { diffDays, formatDate, fyOf } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import type { ReportData, ReportRow } from '../../../shared/report';
import { normalizeEmail, openingDebit } from '../customers/common';
import { partyStatement } from '../customers/statement';

/*
 * CONTRACT functions used by other modules (purchases, expenses, import):
 * searchSuppliers, quickCreateSupplier. Keep their signatures.
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
  return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, payable: 0 - (balances.get(r.id) ?? 0) }));
}

export function quickCreateSupplier(ctx: Ctx, input: { name: string; phone?: string | null }): SupplierSummary {
  assertNameFree(ctx, input.name);
  const id = ctx.db.insert('suppliers', { name: input.name, phone: input.phone ?? null, created_at: now(ctx) });
  logActivity(ctx, 'supplier.create', `Added supplier "${input.name}"`, { entityType: 'supplier', entityId: id });
  return { id, name: input.name, phone: input.phone ?? null, payable: 0 };
}

/* ------------------------------------------------------------------ */

export type SupplierOpeningDirection = 'payable' | 'advance';

export interface SupplierOpeningInput {
  amount: number;
  /** payable = you owed the supplier when you started; advance = you had paid the supplier in advance. */
  direction: SupplierOpeningDirection;
}

export interface SupplierInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  email?: string | null;
  contactPerson?: string | null;
  notes?: string | null;
  /** undefined = leave unchanged (on update); null or amount 0 = none. */
  openingBalance?: SupplierOpeningInput | null;
}

interface SupplierRow {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  email: string | null;
  contact_person: string | null;
  notes: string | null;
  opening_entry_id: number | null;
  is_active: number;
  created_at: string;
  updated_at: string | null;
}

export interface SupplierListRow {
  id: number;
  name: string;
  phone: string | null;
  contactPerson: string | null;
  isActive: boolean;
  /** + = you owe the supplier, - = advance paid. */
  payable: number;
  lastPurchaseDate: string | null;
  purchasedThisFy: number;
}

export interface SupplierDetail {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  email: string | null;
  contactPerson: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
  openingBalance: SupplierOpeningInput | null;
  /** + = you owe the supplier, - = advance paid. */
  payable: number;
  totals: {
    purchases: number;
    purchased: number;
    paidAtPurchase: number;
    payments: number;
    paid: number;
    discount: number;
  };
  lastPurchaseDate: string | null;
  lastPaymentDate: string | null;
  canRemove: boolean;
}

export function getSupplierRow(ctx: Ctx, id: number): SupplierRow {
  const r = ctx.db.get<SupplierRow>('SELECT * FROM suppliers WHERE id = ?', [id]);
  if (!r) throw fail.notFound('Supplier');
  return r;
}

/** Supplier names must be unique among active suppliers (they are picked by name). */
function assertNameFree(ctx: Ctx, name: string, exceptId?: number): void {
  const dup = ctx.db.get<{ id: number }>('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE AND is_active = 1 AND id <> ?', [name.trim(), exceptId ?? 0]);
  if (dup) throw fail.validation(`A supplier named "${name.trim()}" already exists`, { name: 'Name already used' });
}

function openingFromDebit(debit: number): SupplierOpeningInput | null {
  if (!debit) return null;
  return debit < 0 ? { amount: -debit, direction: 'payable' } : { amount: debit, direction: 'advance' };
}

function debitFromOpening(o: SupplierOpeningInput | null | undefined): number {
  if (!o || !o.amount) return 0;
  return o.direction === 'payable' ? -o.amount : o.amount;
}

function describeOpening(debit: number): string {
  if (!debit) return 'no opening balance';
  return debit < 0 ? `opening balance ${formatINR(-debit)} payable` : `opening advance ${formatINR(debit)}`;
}

function hasHistory(ctx: Ctx, id: number): boolean {
  const n =
    ctx.db.value<number>('SELECT COUNT(*) FROM purchases WHERE supplier_id = ?', [id], 0) +
    ctx.db.value<number>('SELECT COUNT(*) FROM supplier_payments WHERE supplier_id = ?', [id], 0) +
    ctx.db.value<number>('SELECT COUNT(*) FROM expenses WHERE supplier_id = ?', [id], 0) +
    ctx.db.value<number>("SELECT COUNT(*) FROM journal_lines WHERE party_type = 'supplier' AND party_id = ?", [id], 0);
  return n > 0;
}

export function listSuppliers(ctx: Ctx, opts: { q?: string | null; onlyWithBalance?: boolean; includeInactive?: boolean } = {}): SupplierListRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (!opts.includeInactive) where.push('s.is_active = 1');
  const text = opts.q?.trim();
  if (text) {
    where.push("(s.name LIKE :like OR REPLACE(s.phone, ' ', '') LIKE :phone OR s.contact_person LIKE :like OR s.address LIKE :like)");
    params.like = `%${text}%`;
    params.phone = `%${text.replace(/\s/g, '')}%`;
  }
  const fy = fyOf(today(ctx));
  params.fyStart = fy.start;
  params.fyEnd = fy.end;
  const rows = ctx.db.all<SupplierRow & { last_purchase: string | null; purchased_fy: number }>(
    `SELECT s.*,
            (SELECT MAX(p.date) FROM purchases p WHERE p.supplier_id = s.id AND p.status = 'active') AS last_purchase,
            (SELECT COALESCE(SUM(p.total), 0) FROM purchases p
              WHERE p.supplier_id = s.id AND p.status = 'active' AND p.date >= :fyStart AND p.date <= :fyEnd) AS purchased_fy
       FROM suppliers s
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.name COLLATE NOCASE, s.id`,
    params,
  );
  const balances = partyBalances(ctx, 'supplier', { account: 'AP' });
  const out = rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    contactPerson: r.contact_person,
    isActive: !!r.is_active,
    payable: 0 - (balances.get(r.id) ?? 0),
    lastPurchaseDate: r.last_purchase,
    purchasedThisFy: r.purchased_fy ?? 0,
  }));
  return opts.onlyWithBalance ? out.filter((r) => r.payable !== 0) : out;
}

export function getSupplier(ctx: Ctx, id: number): SupplierDetail {
  const r = getSupplierRow(ctx, id);
  const purchases = ctx.db.get<{ n: number; total: number; paid: number; last: string | null }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(paid), 0) AS paid, MAX(date) AS last FROM purchases WHERE supplier_id = ? AND status = 'active'",
    [id],
  )!;
  const payments = ctx.db.get<{ n: number; paid: number; discount: number; last: string | null }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS paid, COALESCE(SUM(discount), 0) AS discount, MAX(date) AS last FROM supplier_payments WHERE supplier_id = ? AND status = 'active'",
    [id],
  )!;
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    address: r.address,
    email: r.email,
    contactPerson: r.contact_person,
    notes: r.notes,
    isActive: !!r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    openingBalance: openingFromDebit(openingDebit(ctx, 'supplier', id, r.opening_entry_id)),
    payable: 0 - partyBalance(ctx, 'supplier', id, { account: 'AP' }),
    totals: {
      purchases: purchases.n,
      purchased: purchases.total,
      paidAtPurchase: purchases.paid,
      payments: payments.n,
      paid: payments.paid,
      discount: payments.discount,
    },
    lastPurchaseDate: purchases.last,
    lastPaymentDate: payments.last,
    canRemove: !hasHistory(ctx, id),
  };
}

export function createSupplier(ctx: Ctx, input: SupplierInput): SupplierDetail {
  const name = input.name.trim();
  if (!name) throw fail.validation('Enter the supplier name', { name: 'Enter the supplier name' });
  assertNameFree(ctx, name);
  const email = normalizeEmail(input.email);
  const id = ctx.db.insert('suppliers', {
    name,
    phone: input.phone || null,
    address: input.address || null,
    email,
    contact_person: input.contactPerson || null,
    notes: input.notes || null,
    created_at: now(ctx),
  });
  const debit = debitFromOpening(input.openingBalance);
  if (debit) {
    const entryId = setPartyOpeningBalance(ctx, 'supplier', id, name, debit, null);
    ctx.db.update('suppliers', id, { opening_entry_id: entryId });
  }
  logActivity(ctx, 'supplier.create', `Added supplier "${name}"${debit ? ` with ${describeOpening(debit)}` : ''}`, {
    entityType: 'supplier',
    entityId: id,
    details: { ...input, name },
  });
  return getSupplier(ctx, id);
}

export function updateSupplier(ctx: Ctx, id: number, input: SupplierInput): SupplierDetail {
  const before = getSupplier(ctx, id);
  const row = getSupplierRow(ctx, id);
  const name = input.name.trim();
  if (!name) throw fail.validation('Enter the supplier name', { name: 'Enter the supplier name' });
  if (row.is_active) assertNameFree(ctx, name, id);
  const email = normalizeEmail(input.email);
  ctx.db.update('suppliers', id, {
    name,
    phone: input.phone || null,
    address: input.address || null,
    email,
    contact_person: input.contactPerson || null,
    notes: input.notes || null,
    updated_at: now(ctx),
  });
  const changes: string[] = [];
  if (before.name !== name) changes.push(`renamed from "${before.name}"`);
  if ((before.phone ?? '') !== (input.phone ?? '')) changes.push(`phone ${before.phone || '-'} → ${input.phone || '-'}`);
  if (input.openingBalance !== undefined) {
    const oldDebit = debitFromOpening(before.openingBalance);
    const newDebit = debitFromOpening(input.openingBalance);
    if (oldDebit !== newDebit) {
      const entryId = setPartyOpeningBalance(ctx, 'supplier', id, name, newDebit, row.opening_entry_id);
      if (entryId !== row.opening_entry_id) ctx.db.update('suppliers', id, { opening_entry_id: entryId });
      changes.push(`${describeOpening(oldDebit)} → ${describeOpening(newDebit)}`);
    }
  }
  logActivity(ctx, 'supplier.update', `Updated supplier "${name}"${changes.length ? ': ' + changes.join(', ') : ''}`, {
    entityType: 'supplier',
    entityId: id,
    details: { before, after: { ...input, name } },
  });
  return getSupplier(ctx, id);
}

export function setSupplierActive(ctx: Ctx, id: number, active: boolean): SupplierDetail {
  const row = getSupplierRow(ctx, id);
  if (!!row.is_active === active) return getSupplier(ctx, id);
  if (active) assertNameFree(ctx, row.name, id);
  ctx.db.update('suppliers', id, { is_active: active ? 1 : 0, updated_at: now(ctx) });
  const payable = 0 - partyBalance(ctx, 'supplier', id, { account: 'AP' });
  logActivity(
    ctx,
    active ? 'supplier.activate' : 'supplier.deactivate',
    `${active ? 'Re-activated' : 'Deactivated'} supplier "${row.name}"${!active && payable ? ` (payable ${formatINR(payable)})` : ''}`,
    { entityType: 'supplier', entityId: id },
  );
  return getSupplier(ctx, id);
}

export function removeSupplier(ctx: Ctx, id: number): { deleted: true } {
  const row = getSupplierRow(ctx, id);
  if (hasHistory(ctx, id)) {
    throw new AppError(
      'CONFLICT',
      `"${row.name}" has purchases, payments or an opening balance, so the record must be kept for your accounts. Deactivate the supplier instead.`,
    );
  }
  ctx.db.run('DELETE FROM suppliers WHERE id = ?', [id]);
  logActivity(ctx, 'supplier.delete', `Deleted supplier "${row.name}"`, { entityType: 'supplier', entityId: id, details: row });
  return { deleted: true };
}

/* ------------------------------ Statements & reports ------------------------------ */

export function supplierStatement(ctx: Ctx, supplierId: number, from: string, to: string): ReportData {
  if (from > to) throw fail.validation('The "from" date must be on or before the "to" date');
  const s = getSupplierRow(ctx, supplierId);
  return partyStatement(ctx, { partyType: 'supplier', partyId: s.id, partyName: s.name, partyPhone: s.phone, from, to });
}

/** Suppliers with a non-zero balance on a date: what you owe them and when you last paid. */
export function supplierPayables(ctx: Ctx, asOf: string): ReportData {
  const balances = partyBalances(ctx, 'supplier', { account: 'AP', to: asOf });
  const ids = new Set([...balances.entries()].filter(([, b]) => b !== 0).map(([id]) => id));
  const suppliers = ctx.db.all<SupplierRow>('SELECT * FROM suppliers').filter((s) => ids.has(s.id));
  const lastPay = new Map(
    ctx.db
      .all<{ supplier_id: number; last: string }>(
        "SELECT supplier_id, MAX(date) AS last FROM supplier_payments WHERE status = 'active' AND date <= ? GROUP BY supplier_id",
        [asOf],
      )
      .map((r) => [r.supplier_id, r.last] as const),
  );
  const lastPurchase = new Map(
    ctx.db
      .all<{ supplier_id: number; last: string }>(
        "SELECT supplier_id, MAX(date) AS last FROM purchases WHERE status = 'active' AND supplier_id IS NOT NULL AND date <= ? GROUP BY supplier_id",
        [asOf],
      )
      .map((r) => [r.supplier_id, r.last] as const),
  );
  const list = suppliers
    .map((s) => ({ s, payable: 0 - (balances.get(s.id) ?? 0) }))
    .sort((a, b) => b.payable - a.payable || a.s.name.localeCompare(b.s.name));
  let payable = 0;
  let advance = 0;
  const rows: ReportRow[] = list.map(({ s, payable: p }) => {
    if (p > 0) payable += p;
    else advance += -p;
    const last = lastPay.get(s.id) ?? null;
    return {
      cells: {
        name: s.name + (s.is_active ? '' : ' (inactive)'),
        phone: s.phone ?? '',
        payable: p > 0 ? p : null,
        advance: p < 0 ? -p : null,
        lastPurchase: lastPurchase.get(s.id) ?? null,
        lastPayment: last,
        days: last ? diffDays(last, asOf) : null,
      },
      link: { kind: 'supplier', id: s.id },
    };
  });
  if (rows.length) {
    rows.push({ cells: { name: `Total (${rows.length} suppliers)`, phone: '', payable, advance, lastPurchase: null, lastPayment: null, days: null }, style: 'total' });
  }
  return {
    title: 'Supplier payables',
    subtitle: `As on ${formatDate(asOf)}`,
    columns: [
      { key: 'name', label: 'Supplier', width: 28 },
      { key: 'phone', label: 'Phone', width: 14 },
      { key: 'payable', label: 'Payable', type: 'money', width: 14 },
      { key: 'advance', label: 'Advance paid', type: 'money', width: 14 },
      { key: 'lastPurchase', label: 'Last purchase', type: 'date', width: 12 },
      { key: 'lastPayment', label: 'Last payment', type: 'date', width: 12 },
      { key: 'days', label: 'Days since payment', type: 'number', width: 10 },
    ],
    rows,
    summary: [
      { label: 'Suppliers you owe', value: list.filter((x) => x.payable > 0).length, type: 'number' },
      { label: 'Total payable', value: payable, type: 'money' },
      { label: 'Advances paid', value: advance, type: 'money' },
      { label: 'Net payable', value: payable - advance, type: 'money' },
    ],
    notes: ['"Days since payment" is blank when no separate payment has been made to the supplier.'],
  };
}
