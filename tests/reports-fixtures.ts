/**
 * Test fixtures for the reports and dashboard tests. Documents are written
 * straight into their tables and their journal entries are posted with
 * postEntry exactly as the posting contract in docs/ARCHITECTURE.md says, so
 * these tests do not depend on the other modules' routes.
 */
import type { TestApp } from './helpers';
import { postEntry, systemAccountId, voidEntry, type EntryLineInput } from '../src/core/accounting/ledger';
import { setPartyOpeningBalance } from '../src/core/accounting/opening';
import { ensureFinancialYear } from '../src/core/accounting/periods';
import { fyOf } from '../src/shared/dates';
import { lineAmount } from '../src/shared/money';
import type { VoucherType } from '../src/shared/constants';

type Mode = 'cash' | 'upi' | 'bank';
const MODE_KEY = { cash: 'CASH', upi: 'UPI', bank: 'BANK' } as const;

export interface BillLine {
  item: string;
  qty: number;
  /** Rate in paise. */
  rate: number;
  discount?: number;
  unit?: string;
  /** Leave the bill line without an item record (typed at the counter). */
  adHoc?: boolean;
}

export class Books {
  constructor(readonly t: TestApp) {}

  get ctx() {
    return this.t.app.ctx();
  }

  private next(key: 'inv' | 'cn', date: string): { seq: number; no: string; fyStart: string } {
    const fy = fyOf(date);
    const table = key === 'inv' ? 'bills' : 'credit_notes';
    const n = this.t.app.db.value<number>(`SELECT COALESCE(MAX(seq), 0) FROM ${table} WHERE fy_start = ?`, [fy.start], 0) + 1;
    return { seq: n, no: `${key.toUpperCase()}/${fy.short}/${String(n).padStart(4, '0')}`, fyStart: fy.start };
  }

  post(date: string, voucherType: VoucherType, lines: EntryLineInput[], narration?: string, source?: { type: string; id: number }): number {
    return postEntry(this.ctx, { date, voucherType, lines, narration: narration ?? null, sourceType: source?.type ?? null, sourceId: source?.id ?? null });
  }

  customer(name: string, opts: { phone?: string; creditLimit?: number; opening?: number } = {}): number {
    const id = this.t.app.db.insert('customers', { name, phone: opts.phone ?? null, credit_limit: opts.creditLimit ?? null, created_at: '2025-01-01 10:00:00' });
    if (opts.opening) {
      const entry = setPartyOpeningBalance(this.ctx, 'customer', id, name, opts.opening, null);
      this.t.app.db.update('customers', id, { opening_entry_id: entry });
    }
    return id;
  }

  supplier(name: string, opts: { opening?: number } = {}): number {
    const id = this.t.app.db.insert('suppliers', { name, created_at: '2025-01-01 10:00:00' });
    // opening: amount you owe the supplier (positive).
    if (opts.opening) {
      const entry = setPartyOpeningBalance(this.ctx, 'supplier', id, name, -opts.opening, null);
      this.t.app.db.update('suppliers', id, { opening_entry_id: entry });
    }
    return id;
  }

  employee(name: string): number {
    return this.t.app.db.insert('employees', { name, salary_amount: 1000000, created_at: '2025-01-01 10:00:00' });
  }

  account(name: string, group: string, code: string): number {
    return this.t.app.db.insert('accounts', { name, group_code: group, code, created_at: '2025-01-01 10:00:00' });
  }

  accountId(name: string): number {
    return this.t.app.db.value<number>('SELECT id FROM accounts WHERE name = ?', [name]);
  }

  itemId(name: string, rate: number, unit = 'pcs'): number {
    const existing = this.t.app.db.value<number | null>('SELECT id FROM items WHERE name = ?', [name], null);
    if (existing) return existing;
    return this.t.app.db.insert('items', { name, unit, rate, created_at: '2025-01-01 10:00:00' });
  }

  /**
   * A sales bill. Round off to the rupee is applied automatically when `roundOff`
   * is true. Payments cover part or all of the total; the rest goes on credit.
   */
  bill(opts: {
    date: string;
    customerId?: number | null;
    lines: BillLine[];
    billDiscount?: number;
    payments: Array<{ mode: Mode; amount: number }>;
    roundOff?: boolean;
    cancel?: boolean;
  }): { id: number; total: number; entryId: number } {
    const db = this.t.app.db;
    const lines = opts.lines.map((l) => {
      const gross = lineAmount(l.qty, l.rate);
      return { ...l, gross, discount: l.discount ?? 0, amount: gross - (l.discount ?? 0) };
    });
    const subtotal = lines.reduce((s, l) => s + l.gross, 0);
    const itemDiscount = lines.reduce((s, l) => s + l.discount, 0);
    const billDiscount = opts.billDiscount ?? 0;
    const before = subtotal - itemDiscount - billDiscount;
    const roundOff = opts.roundOff ? Math.round(before / 100) * 100 - before : 0;
    const total = before + roundOff;
    const paid = opts.payments.reduce((s, p) => s + p.amount, 0);
    const credit = total - paid;
    if (credit < 0) throw new Error('overpaid');
    if (credit > 0 && !opts.customerId) throw new Error('credit needs a customer');
    const n = this.next('inv', opts.date);
    const customerName = opts.customerId ? db.value<string>('SELECT name FROM customers WHERE id = ?', [opts.customerId]) : null;
    const modes = [...new Set(opts.payments.map((p) => p.mode))];
    const paymentMode = credit > 0 ? (paid > 0 ? 'split' : 'credit') : modes.length === 1 ? modes[0] : 'split';
    const id = db.insert('bills', {
      bill_no: n.no,
      seq: n.seq,
      fy_start: n.fyStart,
      date: opts.date,
      customer_id: opts.customerId ?? null,
      customer_name: customerName,
      subtotal,
      item_discount: itemDiscount,
      bill_discount: billDiscount,
      round_off: roundOff,
      total,
      paid,
      credit,
      payment_mode: paymentMode,
      status: 'active',
      created_at: `${opts.date} 11:00:00`,
    });
    lines.forEach((l, i) => {
      db.insert('bill_items', {
        bill_id: id,
        line_no: i + 1,
        item_id: l.adHoc ? null : this.itemId(l.item, l.rate, l.unit),
        item_name: l.item,
        unit: l.unit ?? 'pcs',
        qty: l.qty,
        rate: l.rate,
        discount: l.discount,
        amount: l.amount,
      });
    });
    for (const p of opts.payments) {
      db.insert('bill_payments', { bill_id: id, mode: p.mode, account_id: systemAccountId(this.ctx, MODE_KEY[p.mode]), amount: p.amount });
    }
    const entry: EntryLineInput[] = opts.payments.map((p) => ({ account: MODE_KEY[p.mode], debit: p.amount }));
    if (credit > 0) entry.push({ account: 'AR', debit: credit, partyType: 'customer', partyId: opts.customerId! });
    if (itemDiscount + billDiscount > 0) entry.push({ account: 'DISCOUNT_ALLOWED', debit: itemDiscount + billDiscount });
    if (roundOff < 0) entry.push({ account: 'ROUND_OFF', debit: -roundOff });
    entry.push({ account: 'SALES', credit: subtotal });
    if (roundOff > 0) entry.push({ account: 'ROUND_OFF', credit: roundOff });
    const entryId = this.post(opts.date, 'sale', entry, `Bill ${n.no}`, { type: 'bill', id });
    db.update('bills', id, { journal_entry_id: entryId });
    if (opts.cancel) {
      voidEntry(this.ctx, entryId, 'Cancelled in test');
      db.update('bills', id, { status: 'cancelled', cancel_reason: 'Wrong bill', cancelled_at: `${opts.date} 12:00:00` });
    }
    return { id, total, entryId };
  }

  /** A sales return against a bill (items) or a plain credit note (no items). */
  creditNote(opts: {
    date: string;
    billId?: number | null;
    customerId?: number | null;
    lines?: Array<{ item: string; qty: number; rate: number }>;
    amount?: number;
    refund: Mode | 'credit';
    cancel?: boolean;
  }): { id: number; total: number } {
    const db = this.t.app.db;
    const lines = (opts.lines ?? []).map((l) => ({ ...l, amount: lineAmount(l.qty, l.rate) }));
    const total = lines.length ? lines.reduce((s, l) => s + l.amount, 0) : opts.amount!;
    const n = this.next('cn', opts.date);
    const customerId = opts.customerId ?? (opts.billId ? db.value<number | null>('SELECT customer_id FROM bills WHERE id = ?', [opts.billId], null) : null);
    const id = db.insert('credit_notes', {
      cn_no: n.no,
      seq: n.seq,
      fy_start: n.fyStart,
      date: opts.date,
      kind: lines.length ? 'return' : 'adjustment',
      bill_id: opts.billId ?? null,
      customer_id: customerId,
      subtotal: total,
      total,
      refund_mode: opts.refund,
      refund_account_id: opts.refund === 'credit' ? null : systemAccountId(this.ctx, MODE_KEY[opts.refund]),
      status: 'active',
      created_at: `${opts.date} 12:00:00`,
    });
    lines.forEach((l, i) => {
      db.insert('credit_note_items', {
        credit_note_id: id,
        line_no: i + 1,
        item_id: db.value<number | null>('SELECT id FROM items WHERE name = ?', [l.item], null),
        item_name: l.item,
        qty: l.qty,
        rate: l.rate,
        amount: l.amount,
      });
    });
    const refundLine: EntryLineInput =
      opts.refund === 'credit' ? { account: 'AR', credit: total, partyType: 'customer', partyId: customerId! } : { account: MODE_KEY[opts.refund], credit: total };
    const entryId = this.post(opts.date, 'sale_return', [{ account: 'SALES_RETURNS', debit: total }, refundLine], `Credit note ${n.no}`, { type: 'credit_note', id });
    db.update('credit_notes', id, { journal_entry_id: entryId });
    if (opts.cancel) {
      voidEntry(this.ctx, entryId, 'Cancelled in test');
      db.update('credit_notes', id, { status: 'cancelled' });
    }
    return { id, total };
  }

  receipt(date: string, customerId: number, amount: number, mode: Mode, discount = 0): number {
    const lines: EntryLineInput[] = [{ account: MODE_KEY[mode], debit: amount }];
    if (discount) lines.push({ account: 'DISCOUNT_ALLOWED', debit: discount });
    lines.push({ account: 'AR', credit: amount + discount, partyType: 'customer', partyId: customerId });
    return this.post(date, 'receipt', lines, 'Payment received');
  }

  purchase(date: string, supplierId: number | null, total: number, paid: number, mode: Mode = 'cash', account: number | 'PURCHASES' = 'PURCHASES'): number {
    const lines: EntryLineInput[] = [{ account, debit: total }];
    if (paid) lines.push({ account: MODE_KEY[mode], credit: paid });
    if (total - paid) lines.push({ account: 'AP', credit: total - paid, partyType: 'supplier', partyId: supplierId! });
    return this.post(date, 'purchase', lines, 'Purchase bill');
  }

  payment(date: string, supplierId: number, amount: number, mode: Mode, discount = 0): number {
    const lines: EntryLineInput[] = [{ account: 'AP', debit: amount + discount, partyType: 'supplier', partyId: supplierId }, { account: MODE_KEY[mode], credit: amount }];
    if (discount) lines.push({ account: 'DISCOUNT_RECEIVED', credit: discount });
    return this.post(date, 'payment', lines, 'Payment to supplier');
  }

  expense(date: string, accountName: string, amount: number, mode: Mode | { supplierId: number }): number {
    const acct = this.accountId(accountName);
    const credit: EntryLineInput = typeof mode === 'string' ? { account: MODE_KEY[mode], credit: amount } : { account: 'AP', credit: amount, partyType: 'supplier', partyId: mode.supplierId };
    return this.post(date, 'expense', [{ account: acct, debit: amount }, credit], `Expense - ${accountName}`);
  }

  capital(date: string, amount: number, mode: Mode): number {
    return this.post(date, 'capital', [{ account: MODE_KEY[mode], debit: amount }, { account: 'CAPITAL', credit: amount }], 'Capital introduced');
  }

  drawings(date: string, amount: number, mode: Mode): number {
    return this.post(date, 'drawings', [{ account: 'DRAWINGS', debit: amount }, { account: MODE_KEY[mode], credit: amount }], 'Drawings');
  }

  transfer(date: string, from: Mode, to: Mode, amount: number): number {
    return this.post(date, 'contra', [{ account: MODE_KEY[to], debit: amount }, { account: MODE_KEY[from], credit: amount }], 'Transfer');
  }

  /** Close a financial year the way the year-end module does, then lock it. */
  closeYear(fyStart: string): number {
    const fy = fyOf(fyStart);
    const db = this.t.app.db;
    const balances = db.all<{ account_id: number; bal: number }>(
      `SELECT l.account_id, SUM(l.debit - l.credit) AS bal FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id JOIN account_groups g ON g.code = a.group_code
        WHERE e.is_void = 0 AND e.voucher_type <> 'closing' AND e.date >= ? AND e.date <= ? AND g.type IN ('income', 'expense')
        GROUP BY l.account_id HAVING bal <> 0`,
      [fy.start, fy.end],
    );
    const lines: EntryLineInput[] = balances.map((b) => (b.bal > 0 ? { account: b.account_id, credit: b.bal } : { account: b.account_id, debit: -b.bal }));
    const profit = -balances.reduce((s, b) => s + b.bal, 0);
    if (profit > 0) lines.push({ account: 'CAPITAL', credit: profit });
    else if (profit < 0) lines.push({ account: 'CAPITAL', debit: -profit });
    const entryId = postEntry(this.ctx, { date: fy.end, voucherType: 'closing', voucherNo: `YE/${fy.short}`, sourceType: 'closing', lines, narration: 'Year-end closing' });
    const row = ensureFinancialYear(this.ctx, fy.start);
    db.update('financial_years', row.id, { is_closed: 1, closed_at: `${fy.end} 18:00:00`, closing_entry_id: entryId });
    return entryId;
  }
}

/** Sum of the balances of all cash and bank accounts up to a date (from the ledger). */
export function cashAndBank(t: TestApp, to?: string): number {
  return t.app.db.value<number>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE e.is_void = 0 AND a.group_code IN ('cash', 'bank') ${to ? 'AND e.date <= ?' : ''}`,
    to ? [to] : [],
    0,
  );
}
