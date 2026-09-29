import type { Ctx } from '../../context';
import { assertCan, can, now, today } from '../../context';
import { AppError, fail } from '../../errors';
import { logActivity } from '../../audit';
import { partyBalance, partyBalances } from '../../accounting/ledger';
import { setPartyOpeningBalance } from '../../accounting/opening';
import { getSection } from '../../settings';
import { isDateInClosedYear } from '../../accounting/periods';
import { diffDays, formatDate, fyOf } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import type { ReportData, ReportRow } from '../../../shared/report';
import { cleanPhone, itemsSummary, normalizeEmail, openingDebit, PHONE_KEY_SQL, phoneKey } from './common';
import { partyStatement } from './statement';
import { partyGstColumns } from '../gst/common';

/*
 * CONTRACT functions used by other modules (billing screen, receipts, import):
 * searchCustomers, quickCreateCustomer. Keep their signatures.
 */

export interface CustomerSummary {
  id: number;
  name: string;
  phone: string | null;
  /** Outstanding balance in paise: + = customer owes you, - = advance. 0 when balanceHidden. */
  balance: number;
  /** null when there is no limit, or when balanceHidden. */
  creditLimit: number | null;
  /** The user may not see customer balances ("View customers & balances"): balance and creditLimit are blanked. */
  balanceHidden?: boolean;
  /** GSTIN (registered businesses buying from you) and state (place of supply). */
  gstin?: string | null;
  stateCode?: string | null;
}

/**
 * Balances and credit limits are for users who look after customer accounts:
 * "View customers & balances", or "Record payments received" (taking a payment
 * needs the amount due; customers.get shows it to them too).
 */
export function canSeeCustomerBalances(ctx: Ctx): boolean {
  return can(ctx, 'customers.view') || can(ctx, 'customers.receive');
}

/** Type-ahead search by name or phone; includes each customer's current balance (for users allowed to see it). */
export function searchCustomers(ctx: Ctx, q: string, limit = 10): CustomerSummary[] {
  const text = q.trim();
  const rows = ctx.db.all<{ id: number; name: string; phone: string | null; credit_limit: number | null; gstin: string | null; state_code: string | null }>(
    text
      ? `SELECT id, name, phone, credit_limit, gstin, state_code FROM customers
          WHERE is_active = 1 AND (name LIKE :like OR REPLACE(phone, ' ', '') LIKE :phone OR gstin LIKE :gstin)
          ORDER BY CASE WHEN name LIKE :prefix THEN 0 ELSE 1 END, name COLLATE NOCASE LIMIT :limit`
      : `SELECT id, name, phone, credit_limit, gstin, state_code FROM customers WHERE is_active = 1 ORDER BY id DESC LIMIT :limit`,
    text ? { like: `%${text}%`, phone: `%${text.replace(/\s/g, '')}%`, gstin: `${text.toUpperCase()}%`, prefix: `${text}%`, limit } : { limit },
  );
  const gst = (r: (typeof rows)[number]) => ({ gstin: r.gstin, stateCode: r.state_code });
  if (!canSeeCustomerBalances(ctx)) {
    return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, balance: 0, creditLimit: null, balanceHidden: true, ...gst(r) }));
  }
  const balances = partyBalances(ctx, 'customer', { account: 'AR' });
  return rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, balance: balances.get(r.id) ?? 0, creditLimit: r.credit_limit, ...gst(r) }));
}

export interface QuickCustomerInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  gstin?: string | null;
  stateCode?: string | null;
}

/** Add a customer from the billing screen with just a name (and phone). Never sets a credit limit or opening balance. */
export function quickCreateCustomer(ctx: Ctx, input: QuickCustomerInput): CustomerSummary {
  const phone = cleanPhone(input.phone);
  assertPhoneFree(ctx, phone);
  const gst = partyGstColumns({ gstin: input.gstin, stateCode: input.stateCode });
  const id = ctx.db.insert('customers', { name: input.name, phone, address: input.address ?? null, ...gst, created_at: now(ctx) });
  logActivity(ctx, 'customer.create', `Added customer "${input.name}"${gst.gstin ? ` (GSTIN ${gst.gstin})` : ''}`, { entityType: 'customer', entityId: id });
  return {
    id,
    name: input.name,
    phone,
    balance: 0,
    creditLimit: null,
    gstin: (gst.gstin as string | null) ?? null,
    stateCode: (gst.state_code as string | null) ?? null,
    ...(canSeeCustomerBalances(ctx) ? {} : { balanceHidden: true }),
  };
}

/* ------------------------------------------------------------------ */

export type CustomerOpeningDirection = 'receivable' | 'advance';

export interface CustomerOpeningInput {
  /** Amount in paise (>= 0). */
  amount: number;
  /** receivable = the customer owed you when you started; advance = you were holding the customer's money. */
  direction: CustomerOpeningDirection;
}

export interface CustomerInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  email?: string | null;
  /**
   * Credit limit in paise; null = no limit. On update, undefined = leave unchanged.
   * Setting or changing it needs "Set credit limits & opening balances" (customers.credit).
   */
  creditLimit?: number | null;
  notes?: string | null;
  /**
   * undefined = leave unchanged (on update); null or amount 0 = no opening balance.
   * Setting or changing it needs "Set credit limits & opening balances" (customers.credit).
   */
  openingBalance?: CustomerOpeningInput | null;
  /** GSTIN; undefined = unchanged. */
  gstin?: string | null;
  /** State (place of supply) for customers without a GSTIN; undefined = unchanged. */
  stateCode?: string | null;
}

interface CustomerRow {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  email: string | null;
  gstin: string | null;
  state_code: string | null;
  credit_limit: number | null;
  notes: string | null;
  opening_entry_id: number | null;
  is_active: number;
  created_at: string;
  updated_at: string | null;
}

export interface CustomerListRow {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  email: string | null;
  gstin: string | null;
  stateCode: string | null;
  creditLimit: number | null;
  isActive: boolean;
  /** + = customer owes you, - = advance. */
  balance: number;
  lastBillDate: string | null;
  /** Total of active bills in the current financial year. */
  billedThisFy: number;
}

export interface CustomerDetail {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  email: string | null;
  gstin: string | null;
  stateCode: string | null;
  creditLimit: number | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
  openingBalance: CustomerOpeningInput | null;
  /** + = customer owes you, - = advance. */
  balance: number;
  /** Balance is above the credit limit. */
  overLimit: boolean;
  totals: {
    bills: number;
    /** Total of active bills. */
    billed: number;
    /** Paid at the counter when billing. */
    paidAtBilling: number;
    receipts: number;
    /** Payments received later (receipts). */
    received: number;
    /** Settlement discounts allowed on receipts. */
    discount: number;
    /** Sales returns and credit notes. */
    returned: number;
    /** Part of `returned` paid back in cash / UPI / bank (the rest was adjusted in the customer's account). */
    refunded: number;
    /** Opening balance (+ = owed to you, - = advance). */
    opening: number;
    /**
     * Anything else in the customer's account (e.g. journal entries), so that
     * opening + billed - paidAtBilling - received - discount - returned + refunded + adjustments = balance.
     */
    adjustments: number;
  };
  lastBillDate: string | null;
  lastPaymentDate: string | null;
  /** True when the customer has no history and can be deleted instead of deactivated. */
  canRemove: boolean;
  /** The user may not see customer balances: balance, credit limit, opening balance and money totals are blanked. */
  balanceHidden?: boolean;
}

/**
 * What the customers.* routes send back: users who may not see customer balances (e.g. a role
 * with "Add / edit customers" but not "View customers & balances") get the customer's details
 * without the balance, credit limit, opening balance or money totals. Internal callers (import,
 * the service itself) use getCustomer / listCustomers directly and always see the real figures.
 */
export function customerForViewer(ctx: Ctx, d: CustomerDetail): CustomerDetail {
  if (canSeeCustomerBalances(ctx)) return d;
  const t = d.totals;
  return {
    ...d,
    creditLimit: null,
    openingBalance: null,
    balance: 0,
    overLimit: false,
    totals: { ...t, billed: 0, paidAtBilling: 0, received: 0, discount: 0, returned: 0, refunded: 0, opening: 0, adjustments: 0 },
    balanceHidden: true,
  };
}

export function customerListForViewer(ctx: Ctx, rows: CustomerListRow[]): CustomerListRow[] {
  if (canSeeCustomerBalances(ctx)) return rows;
  return rows.map((r) => ({ ...r, creditLimit: null, balance: 0, billedThisFy: 0 }));
}

export function getCustomerRow(ctx: Ctx, id: number): CustomerRow {
  const r = ctx.db.get<CustomerRow>('SELECT * FROM customers WHERE id = ?', [id]);
  if (!r) throw fail.notFound('Customer');
  return r;
}

/** SQL for the duplicate-phone lookup (exported so a test can check it uses idx_customers_phone_key). */
export const PHONE_DUPLICATE_SQL = `SELECT id, name, phone FROM customers WHERE ${PHONE_KEY_SQL} = ? AND is_active = 1 AND id <> ? LIMIT 5`;

/**
 * Phone numbers must be unique among active customers (so the billing screen finds the right person).
 * An index lookup on the phone key, so importing thousands of customers stays fast.
 */
function assertPhoneFree(ctx: Ctx, phone: string | null, exceptId?: number): void {
  const key = phoneKey(phone);
  if (!key) return;
  const rows = ctx.db.all<{ id: number; name: string; phone: string }>(PHONE_DUPLICATE_SQL, [key, exceptId ?? 0]);
  const dup = rows.find((r) => phoneKey(r.phone) === key);
  if (dup) throw fail.validation(`This phone number already belongs to ${dup.name}`, { phone: `Already used by ${dup.name}` });
}

const CREDIT_DENIED = 'You are not allowed to set credit limits or opening balances. Ask the owner or manager.';

function openingFromDebit(debit: number): CustomerOpeningInput | null {
  if (!debit) return null;
  return debit > 0 ? { amount: debit, direction: 'receivable' } : { amount: -debit, direction: 'advance' };
}

function debitFromOpening(o: CustomerOpeningInput | null | undefined): number {
  if (!o || !o.amount) return 0;
  return o.direction === 'receivable' ? o.amount : -o.amount;
}

function hasHistory(ctx: Ctx, id: number): boolean {
  const n =
    ctx.db.value<number>('SELECT COUNT(*) FROM bills WHERE customer_id = ?', [id], 0) +
    ctx.db.value<number>('SELECT COUNT(*) FROM customer_receipts WHERE customer_id = ?', [id], 0) +
    ctx.db.value<number>('SELECT COUNT(*) FROM credit_notes WHERE customer_id = ?', [id], 0) +
    ctx.db.value<number>("SELECT COUNT(*) FROM journal_lines WHERE party_type = 'customer' AND party_id = ?", [id], 0);
  return n > 0;
}

export function listCustomers(ctx: Ctx, opts: { q?: string | null; onlyWithBalance?: boolean; includeInactive?: boolean } = {}): CustomerListRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (!opts.includeInactive) where.push('c.is_active = 1');
  const text = opts.q?.trim();
  if (text) {
    where.push("(c.name LIKE :like OR REPLACE(c.phone, ' ', '') LIKE :phone OR c.address LIKE :like OR c.email LIKE :like OR c.gstin LIKE :like)");
    params.like = `%${text}%`;
    params.phone = `%${text.replace(/\s/g, '')}%`;
  }
  const fy = fyOf(today(ctx));
  params.fyStart = fy.start;
  params.fyEnd = fy.end;
  const rows = ctx.db.all<CustomerRow & { last_bill_date: string | null; billed_fy: number }>(
    `SELECT c.*,
            (SELECT MAX(b.date) FROM bills b WHERE b.customer_id = c.id AND b.status = 'active') AS last_bill_date,
            (SELECT COALESCE(SUM(b.total), 0) FROM bills b
              WHERE b.customer_id = c.id AND b.status = 'active' AND b.date >= :fyStart AND b.date <= :fyEnd) AS billed_fy
       FROM customers c
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.name COLLATE NOCASE, c.id`,
    params,
  );
  const balances = partyBalances(ctx, 'customer', { account: 'AR' });
  const out = rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    address: r.address,
    email: r.email,
    gstin: r.gstin,
    stateCode: r.state_code,
    creditLimit: r.credit_limit,
    isActive: !!r.is_active,
    balance: balances.get(r.id) ?? 0,
    lastBillDate: r.last_bill_date,
    billedThisFy: r.billed_fy ?? 0,
  }));
  return opts.onlyWithBalance ? out.filter((r) => r.balance !== 0) : out;
}

export function getCustomer(ctx: Ctx, id: number): CustomerDetail {
  const r = getCustomerRow(ctx, id);
  const balance = partyBalance(ctx, 'customer', id, { account: 'AR' });
  const bills = ctx.db.get<{ n: number; billed: number; paid: number; last: string | null }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS billed, COALESCE(SUM(paid), 0) AS paid, MAX(date) AS last FROM bills WHERE customer_id = ? AND status = 'active'",
    [id],
  )!;
  const receipts = ctx.db.get<{ n: number; received: number; discount: number; last: string | null }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS received, COALESCE(SUM(discount), 0) AS discount, MAX(date) AS last FROM customer_receipts WHERE customer_id = ? AND status = 'active'",
    [id],
  )!;
  const returns = ctx.db.get<{ returned: number; refunded: number }>(
    `SELECT COALESCE(SUM(total), 0) AS returned, COALESCE(SUM(CASE WHEN refund_mode <> 'credit' THEN total ELSE 0 END), 0) AS refunded
       FROM credit_notes WHERE customer_id = ? AND status = 'active'`,
    [id],
  )!;
  const opening = openingDebit(ctx, 'customer', id, r.opening_entry_id);
  const explained = opening + bills.billed - bills.paid - receipts.received - receipts.discount - returns.returned + returns.refunded;
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    address: r.address,
    email: r.email,
    gstin: r.gstin,
    stateCode: r.state_code,
    creditLimit: r.credit_limit,
    notes: r.notes,
    isActive: !!r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    openingBalance: openingFromDebit(opening),
    balance,
    overLimit: r.credit_limit !== null && balance > r.credit_limit,
    totals: {
      bills: bills.n,
      billed: bills.billed,
      paidAtBilling: bills.paid,
      receipts: receipts.n,
      received: receipts.received,
      discount: receipts.discount,
      returned: returns.returned,
      refunded: returns.refunded,
      opening,
      adjustments: balance - explained,
    },
    lastBillDate: bills.last,
    lastPaymentDate: receipts.last,
    canRemove: !hasHistory(ctx, id),
  };
}

function describeOpening(debit: number): string {
  if (!debit) return 'no opening balance';
  return debit > 0 ? `opening balance ${formatINR(debit)} due` : `opening advance ${formatINR(-debit)}`;
}

export function createCustomer(ctx: Ctx, input: CustomerInput): CustomerDetail {
  const name = input.name.trim();
  if (!name) throw fail.validation('Enter the customer name', { name: 'Enter the customer name' });
  const phone = cleanPhone(input.phone);
  assertPhoneFree(ctx, phone);
  const email = normalizeEmail(input.email);
  const creditLimit = input.creditLimit ?? null;
  const debit = debitFromOpening(input.openingBalance);
  // A credit limit or opening balance changes what the customer may owe / what the books say they owe.
  if (creditLimit !== null || debit) assertCan(ctx, 'customers.credit', CREDIT_DENIED);
  const id = ctx.db.insert('customers', {
    name,
    phone,
    address: input.address || null,
    email,
    ...partyGstColumns(input),
    credit_limit: creditLimit,
    notes: input.notes || null,
    created_at: now(ctx),
  });
  if (debit) {
    const entryId = setPartyOpeningBalance(ctx, 'customer', id, name, debit, null);
    ctx.db.update('customers', id, { opening_entry_id: entryId });
  }
  logActivity(ctx, 'customer.create', `Added customer "${name}"${debit ? ` with ${describeOpening(debit)}` : ''}`, {
    entityType: 'customer',
    entityId: id,
    details: { ...input, name, phone },
  });
  return getCustomer(ctx, id);
}

export function updateCustomer(ctx: Ctx, id: number, input: CustomerInput): CustomerDetail {
  const before = getCustomer(ctx, id);
  const row = getCustomerRow(ctx, id);
  const name = input.name.trim();
  if (!name) throw fail.validation('Enter the customer name', { name: 'Enter the customer name' });
  const phone = cleanPhone(input.phone);
  if (row.is_active) assertPhoneFree(ctx, phone, id);
  const email = normalizeEmail(input.email);
  const creditLimit = input.creditLimit === undefined ? row.credit_limit : input.creditLimit;
  const oldDebit = debitFromOpening(before.openingBalance);
  const newDebit = input.openingBalance === undefined ? oldDebit : debitFromOpening(input.openingBalance);
  // Sending the saved values back unchanged is fine; changing them needs the permission.
  if (creditLimit !== row.credit_limit || newDebit !== oldDebit) assertCan(ctx, 'customers.credit', CREDIT_DENIED);
  const gst = partyGstColumns(input, row);
  ctx.db.update('customers', id, {
    name,
    phone,
    address: input.address || null,
    email,
    ...gst,
    credit_limit: creditLimit,
    notes: input.notes || null,
    updated_at: now(ctx),
  });
  const changes: string[] = [];
  if (before.name !== name) changes.push(`renamed from "${before.name}"`);
  if ((before.phone ?? '') !== (phone ?? '')) changes.push(`phone ${before.phone || '-'} → ${phone || '-'}`);
  if ('gstin' in gst && (before.gstin ?? null) !== gst.gstin) changes.push(`GSTIN ${before.gstin || '-'} → ${gst.gstin || '-'}`);
  if (before.creditLimit !== creditLimit) {
    changes.push(`credit limit ${before.creditLimit === null ? 'none' : formatINR(before.creditLimit)} → ${creditLimit === null ? 'none' : formatINR(creditLimit)}`);
  }
  if (oldDebit !== newDebit) {
    const entryId = setPartyOpeningBalance(ctx, 'customer', id, name, newDebit, row.opening_entry_id);
    if (entryId !== row.opening_entry_id) ctx.db.update('customers', id, { opening_entry_id: entryId });
    changes.push(`${describeOpening(oldDebit)} → ${describeOpening(newDebit)}`);
  }
  logActivity(ctx, 'customer.update', `Updated customer "${name}"${changes.length ? ': ' + changes.join(', ') : ''}`, {
    entityType: 'customer',
    entityId: id,
    details: { before, after: { ...input, name, phone, creditLimit } },
  });
  return getCustomer(ctx, id);
}

export function setCustomerActive(ctx: Ctx, id: number, active: boolean): CustomerDetail {
  const row = getCustomerRow(ctx, id);
  if (!!row.is_active === active) return getCustomer(ctx, id);
  if (active) assertPhoneFree(ctx, row.phone, id);
  ctx.db.update('customers', id, { is_active: active ? 1 : 0, updated_at: now(ctx) });
  const balance = partyBalance(ctx, 'customer', id, { account: 'AR' });
  logActivity(
    ctx,
    active ? 'customer.activate' : 'customer.deactivate',
    `${active ? 'Re-activated' : 'Deactivated'} customer "${row.name}"${!active && balance ? ` (balance ${formatINR(balance)})` : ''}`,
    { entityType: 'customer', entityId: id },
  );
  return getCustomer(ctx, id);
}

/** Delete a customer with no bills, payments or ledger history. Anyone with history can only be deactivated. */
export function removeCustomer(ctx: Ctx, id: number): { deleted: true } {
  const row = getCustomerRow(ctx, id);
  if (hasHistory(ctx, id)) {
    throw new AppError(
      'CONFLICT',
      `"${row.name}" has bills, payments or an opening balance, so the record must be kept for your accounts. Deactivate the customer instead - they will no longer appear when billing.`,
    );
  }
  ctx.db.run('DELETE FROM customers WHERE id = ?', [id]);
  logActivity(ctx, 'customer.delete', `Deleted customer "${row.name}"`, { entityType: 'customer', entityId: id, details: row });
  return { deleted: true };
}

/* ------------------------------ Statements & reports ------------------------------ */

export function customerStatement(ctx: Ctx, customerId: number, from: string, to: string): ReportData {
  if (from > to) throw fail.validation('The "from" date must be on or before the "to" date');
  const c = getCustomerRow(ctx, customerId);
  return partyStatement(ctx, { partyType: 'customer', partyId: c.id, partyName: c.name, partyPhone: c.phone, from, to });
}

/** Customers with a non-zero balance on a date: what they owe, advances, and when they last paid. */
export function customerOutstanding(ctx: Ctx, asOf: string): ReportData {
  const balances = partyBalances(ctx, 'customer', { account: 'AR', to: asOf });
  const ids = [...balances.entries()].filter(([, b]) => b !== 0).map(([id]) => id);
  const customers = new Map(
    ctx.db.all<CustomerRow>('SELECT * FROM customers').filter((c) => ids.includes(c.id)).map((c) => [c.id, c] as const),
  );
  const lastPay = new Map(
    ctx.db
      .all<{ customer_id: number; last: string }>(
        "SELECT customer_id, MAX(date) AS last FROM customer_receipts WHERE status = 'active' AND date <= ? GROUP BY customer_id",
        [asOf],
      )
      .map((r) => [r.customer_id, r.last] as const),
  );
  const lastBill = new Map(
    ctx.db
      .all<{ customer_id: number; last: string }>(
        "SELECT customer_id, MAX(date) AS last FROM bills WHERE status = 'active' AND customer_id IS NOT NULL AND date <= ? GROUP BY customer_id",
        [asOf],
      )
      .map((r) => [r.customer_id, r.last] as const),
  );
  const list = ids
    .map((id) => ({ c: customers.get(id)!, bal: balances.get(id)! }))
    .filter((x) => x.c)
    .sort((a, b) => b.bal - a.bal || a.c.name.localeCompare(b.c.name));
  let due = 0;
  let advance = 0;
  const rows: ReportRow[] = list.map(({ c, bal }) => {
    if (bal > 0) due += bal;
    else advance += -bal;
    const last = lastPay.get(c.id) ?? null;
    return {
      cells: {
        name: c.name + (c.is_active ? '' : ' (inactive)'),
        phone: c.phone ?? '',
        due: bal > 0 ? bal : null,
        advance: bal < 0 ? -bal : null,
        lastBill: lastBill.get(c.id) ?? null,
        lastPayment: last,
        days: last ? diffDays(last, asOf) : null,
      },
      link: { kind: 'customer', id: c.id },
    };
  });
  if (rows.length) {
    rows.push({ cells: { name: `Total (${rows.length} customer${rows.length === 1 ? '' : 's'})`, phone: '', due, advance, lastBill: null, lastPayment: null, days: null }, style: 'total' });
  }
  const dueCount = list.filter((x) => x.bal > 0).length;
  return {
    title: 'Customer outstanding',
    subtitle: `As on ${formatDate(asOf)}`,
    columns: [
      { key: 'name', label: 'Customer', width: 28 },
      { key: 'phone', label: 'Phone', width: 14, nowrap: true },
      { key: 'due', label: 'Due', type: 'money', width: 14 },
      { key: 'advance', label: 'Advance', type: 'money', width: 14 },
      { key: 'lastBill', label: 'Last bill', type: 'date', width: 11 },
      { key: 'lastPayment', label: 'Last payment', type: 'date', width: 12 },
      { key: 'days', label: 'Days since payment', type: 'number', width: 10 },
    ],
    rows,
    summary: [
      { label: 'Customers who owe you', value: dueCount, type: 'number' },
      { label: 'Total due', value: due, type: 'money' },
      { label: 'Advances held', value: advance, type: 'money' },
      { label: 'Net receivable', value: due - advance, type: 'money' },
    ],
    notes: ['"Days since payment" is blank when the customer has never made a separate payment.'],
  };
}

export interface CustomerBillRow {
  id: number;
  billNo: string;
  date: string;
  items: string;
  total: number;
  paid: number;
  credit: number;
  paymentMode: string;
  status: 'active' | 'cancelled';
}

/** A customer's sales bills (read directly from the bills table). */
export function customerBills(ctx: Ctx, customerId: number, from?: string | null, to?: string | null): { rows: CustomerBillRow[]; totals: { count: number; total: number; paid: number; credit: number } } {
  getCustomerRow(ctx, customerId);
  const where = ['customer_id = ?'];
  const params: unknown[] = [customerId];
  if (from) {
    where.push('date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('date <= ?');
    params.push(to);
  }
  const bills = ctx.db.all<{ id: number; bill_no: string; date: string; total: number; paid: number; credit: number; payment_mode: string; status: 'active' | 'cancelled' }>(
    `SELECT id, bill_no, date, total, paid, credit, payment_mode, status FROM bills WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC`,
    params,
  );
  const rows = bills.map((b) => ({
    id: b.id,
    billNo: b.bill_no,
    date: b.date,
    items: itemsSummary(ctx.db.all<{ name: string; qty: number; unit: string | null }>('SELECT item_name AS name, qty, unit FROM bill_items WHERE bill_id = ? ORDER BY line_no', [b.id])),
    total: b.total,
    paid: b.paid,
    credit: b.credit,
    paymentMode: b.payment_mode,
    status: b.status,
  }));
  const active = rows.filter((r) => r.status === 'active');
  return {
    rows,
    totals: {
      count: active.length,
      total: active.reduce((s, r) => s + r.total, 0),
      paid: active.reduce((s, r) => s + r.paid, 0),
      credit: active.reduce((s, r) => s + r.credit, 0),
    },
  };
}

/** Facts the customer / supplier forms need: opening balances are dated the books start date. */
export function partyFormInfo(ctx: Ctx): { booksStartDate: string; openingLocked: boolean } {
  const booksStartDate = getSection(ctx, 'accounts').booksStartDate;
  return { booksStartDate, openingLocked: isDateInClosedYear(ctx, booksStartDate) };
}
