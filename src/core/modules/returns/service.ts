/**
 * Sales returns (goods returned against a bill) and credit notes (amount
 * adjustments without goods, e.g. price correction or goodwill).
 *
 * Posting (voucher "sale_return", source "credit_note"):
 *   Dr SALES_RETURNS (amount before rounding)
 *   Dr ROUND_OFF if rounded up           Cr ROUND_OFF if rounded down
 *   Cr refund cash / bank account, or AR(customer) when adjusted in the customer's account
 *
 * Refund rules (goods returned against a bill):
 *   - a unit is refunded at most at the rate the customer paid for it (paidRate): the line amount
 *     after its discount, less its share of the bill discount and of a rounding down
 *     (netLineAmounts), in whole paise, so rate x qty is always the refund line's amount;
 *   - rounding works on the running total of the bill's returns, so refunds never add up to
 *     more than the bill total and the return that takes back the rest settles it exactly;
 *   - money (cash / UPI / bank) goes back only up to the money received for the bill (at the counter,
 *     or later: the money of the customer's payments, oldest dues first, once they no longer owe it);
 *     anything more is adjusted in the customer's account. Money refunded to a customer therefore
 *     never adds up to more than the money received from them.
 * Credit notes without goods need "returns.adjust".
 */
import type { Ctx } from '../../context';
import { assertCan, can, currentUserId, now, requireSession, today } from '../../context';
import { AppError, fail } from '../../errors';
import { listRevisions, logActivity, recordRevision } from '../../audit';
import { nextDocNumber } from '../../numbering';
import { getSection } from '../../settings';
import { negativeBalanceWarning, partyBalance, paymentAccountId, postEntry, voidEntry, type EntryLineInput } from '../../accounting/ledger';
import { assertDateOpen } from '../../accounting/periods';
import { renderReceiptHtml, type ReceiptDoc, type ReceiptTotal } from '../../print/receipt';
import { amountInWords, formatAmount, formatINR, formatQty } from '../../../shared/money';
import { formatDate, formatTime, isValidISODate } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS, type PaymentMode, type SettlementMode } from '../../../shared/constants';
import { assertCancelKeepsClosedAccounts } from '../accounting/common';
import { openingDebit } from '../customers/common';
import { netLineAmounts, paidRate, returnLineAmount, returnNoteTotal, returnSettlesBill, roundQty, type BillPaymentMode } from '../../../shared/billing';
import { customerBalanceLine, customerSummary, getBillRow, itemCountLine, sendToReceiptPrinter, type BillCustomer, type RevisionSummary } from '../sales/service';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type CreditNoteKind = 'return' | 'adjustment';

export interface CreditNoteRow {
  id: number;
  cn_no: string;
  seq: number;
  fy_start: string;
  date: string;
  kind: CreditNoteKind;
  bill_id: number | null;
  customer_id: number | null;
  customer_name: string | null;
  subtotal: number;
  round_off: number;
  total: number;
  refund_mode: PaymentMode;
  refund_account_id: number | null;
  reason: string | null;
  status: 'active' | 'cancelled';
  revision: number;
  print_count: number;
  journal_entry_id: number | null;
  created_by: number | null;
  created_at: string;
  updated_by: number | null;
  updated_at: string | null;
  cancelled_by: number | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

export interface ReturnableLine {
  billItemId: number;
  itemId: number | null;
  itemName: string;
  unit: string | null;
  qtyBilled: number;
  /** Already returned on active returns. */
  qtyReturned: number;
  returnable: number;
  /** Billed rate (before discounts). */
  rate: number;
  /**
   * What the customer paid per unit: after the line discount and the line's share of the bill discount
   * and round off. The highest refund rate allowed.
   */
  netRate: number;
  /** What the customer paid for the line: after line discount and its share of the bill discount and round off. */
  netAmount: number;
  /** Amount already refunded for this line on active returns (before note rounding). */
  returnedAmount: number;
  /** Most that can still be refunded for this line (netAmount - returnedAmount). */
  refundable: number;
}

export interface BillReturnable {
  bill: {
    id: number;
    billNo: string;
    date: string;
    status: 'active' | 'cancelled';
    customerId: number | null;
    customerName: string | null;
    customerPhone: string | null;
    subtotal: number;
    billDiscount: number;
    total: number;
    paid: number;
    credit: number;
    paymentMode: BillPaymentMode;
  };
  lines: ReturnableLine[];
  /** Total of active returns / credit notes already made against the bill. */
  returnedTotal: number;
  /** Item value (before rounding) of those returns; the running total that return rounding works on. */
  returnedValue: number;
  /** Most that can still be refunded on the bill: bill total less active returns. */
  refundable: number;
  /** Already paid back in cash / UPI / bank on active returns. */
  moneyRefunded: number;
  /**
   * Part of the bill's credit the customer has since paid in money: the money of their payments
   * (not the discounts) shared out oldest dues first, counted only while they do not still owe it.
   * Discounts, credit notes, returns adjusted in the account and write-offs are not money received.
   */
  paidLater: number;
  /** Money received for the bill: at the counter plus paidLater. */
  moneyReceived: number;
  /**
   * Most that can be paid back in cash / UPI / bank: moneyReceived less money already refunded.
   * Anything more must be adjusted in the customer's account.
   */
  moneyRefundable: number;
  /** Every return so far on the bill was at the rate paid (a return of all that is left then settles the bill exactly). */
  allAtPaidRate: boolean;
  /** Returns are rounded to the nearest rupee (settings.billing.roundOff). */
  roundOff: boolean;
  /** Suggested refund: adjust in the account while the customer still owes part of the bill, else money (the bill's payment mode). */
  suggestedRefundMode: PaymentMode;
}

export interface ReturnItemInput {
  billItemId: number;
  qty: number;
  /** Refund rate per unit in paise; defaults to the effective net rate. */
  rate?: number | null;
}

export type CreateCreditNoteInput =
  | {
      kind: 'return';
      billId: number;
      date?: string | null;
      items: ReturnItemInput[];
      refundMode: PaymentMode;
      refundAccountId?: number | null;
      reason?: string | null;
    }
  | {
      kind: 'adjustment';
      customerId: number;
      amount: number;
      reason: string;
      refundMode: PaymentMode;
      refundAccountId?: number | null;
      date?: string | null;
    };

export interface CreditNoteItem {
  id: number;
  lineNo: number;
  billItemId: number | null;
  itemId: number | null;
  itemName: string;
  unit: string | null;
  qty: number;
  rate: number;
  amount: number;
}

export interface CreditNoteDetail {
  id: number;
  cnNo: string;
  date: string;
  kind: CreditNoteKind;
  billId: number | null;
  billNo: string | null;
  billDate: string | null;
  customerId: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customer: BillCustomer | null;
  items: CreditNoteItem[];
  subtotal: number;
  roundOff: number;
  total: number;
  refundMode: PaymentMode;
  refundAccountId: number | null;
  refundAccountName: string | null;
  reason: string | null;
  status: 'active' | 'cancelled';
  printCount: number;
  journalEntryId: number | null;
  createdAt: string;
  createdByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  revisions: RevisionSummary[];
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

function userName(ctx: Ctx, id: number | null): string | null {
  if (!id) return null;
  return ctx.db.value<string | null>('SELECT full_name FROM users WHERE id = ?', [id], null);
}

export function getCreditNoteRow(ctx: Ctx, id: number): CreditNoteRow {
  const r = ctx.db.get<CreditNoteRow>('SELECT * FROM credit_notes WHERE id = ?', [id]);
  if (!r) throw fail.notFound('Return / credit note');
  return r;
}

export function getCreditNote(ctx: Ctx, id: number): CreditNoteDetail {
  const r = getCreditNoteRow(ctx, id);
  const bill = r.bill_id ? ctx.db.get<{ bill_no: string; date: string; customer_phone: string | null }>('SELECT bill_no, date, customer_phone FROM bills WHERE id = ?', [r.bill_id]) : undefined;
  let customer: BillCustomer | null = null;
  if (r.customer_id) {
    try {
      customer = customerSummary(ctx, r.customer_id);
    } catch {
      customer = null;
    }
  }
  const items = ctx.db
    .all<{ id: number; line_no: number; bill_item_id: number | null; item_id: number | null; item_name: string; unit: string | null; qty: number; rate: number; amount: number }>(
      'SELECT * FROM credit_note_items WHERE credit_note_id = ? ORDER BY line_no',
      [id],
    )
    .map((i) => ({ id: i.id, lineNo: i.line_no, billItemId: i.bill_item_id, itemId: i.item_id, itemName: i.item_name, unit: i.unit, qty: i.qty, rate: i.rate, amount: i.amount }));
  return {
    id: r.id,
    cnNo: r.cn_no,
    date: r.date,
    kind: r.kind,
    billId: r.bill_id,
    billNo: bill?.bill_no ?? null,
    billDate: bill?.date ?? null,
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerPhone: customer?.phone ?? bill?.customer_phone ?? null,
    customer,
    items,
    subtotal: r.subtotal,
    roundOff: r.round_off,
    total: r.total,
    refundMode: r.refund_mode,
    refundAccountId: r.refund_account_id,
    refundAccountName: r.refund_account_id ? ctx.db.value<string | null>('SELECT name FROM accounts WHERE id = ?', [r.refund_account_id], null) : null,
    reason: r.reason,
    status: r.status,
    printCount: r.print_count,
    journalEntryId: r.journal_entry_id,
    createdAt: r.created_at,
    createdByName: userName(ctx, r.created_by),
    cancelledAt: r.cancelled_at,
    cancelledByName: userName(ctx, r.cancelled_by),
    cancelReason: r.cancel_reason,
    revisions: listRevisions(ctx, 'credit_note', id).map((v) => ({ revision: v.revision, action: v.action, reason: v.reason, username: v.username, at: v.at })),
  };
}

/* ------------------------------------------------------------------ */
/* Money received later (how much may go back in money)               */
/* ------------------------------------------------------------------ */

/**
 * The money of a customer's active payments (their amounts, not their discounts) shared out
 * oldest dues first: the opening balance due, then each active bill's credit still to be paid
 * (its credit part less returns adjusted on it) in bill date order. Gives bill id -> money
 * received for that bill's credit. Discounts, credit notes, returns adjusted in the account and
 * journal write-offs lower what the customer owes but bring in no money, so they never count.
 */
function moneyReceivedLaterByBill(ctx: Ctx, customerId: number): Map<number, number> {
  const out = new Map<number, number>();
  let left = ctx.db.value<number>("SELECT COALESCE(SUM(amount), 0) FROM customer_receipts WHERE customer_id = ? AND status = 'active'", [customerId], 0);
  if (left <= 0) return out;
  const openingEntryId = ctx.db.value<number | null>('SELECT opening_entry_id FROM customers WHERE id = ?', [customerId], null);
  left -= Math.max(0, openingDebit(ctx, 'customer', customerId, openingEntryId));
  if (left <= 0) return out;
  const bills = ctx.db.all<{ id: number; due: number }>(
    `SELECT b.id, b.credit - COALESCE((SELECT SUM(n.total) FROM credit_notes n
                                        WHERE n.bill_id = b.id AND n.status = 'active' AND n.refund_mode = 'credit'), 0) AS due
       FROM bills b
      WHERE b.customer_id = ? AND b.status = 'active' AND b.credit > 0
      ORDER BY b.date, b.id`,
    [customerId],
  );
  for (const b of bills) {
    const share = Math.min(left, Math.max(0, b.due));
    if (share > 0) {
      out.set(b.id, share);
      left -= share;
    }
    if (left <= 0) break;
  }
  return out;
}

/**
 * Part of a bill's credit (creditLeft) paid later: money must have come in for it (moneyLater) AND
 * the customer must not still owe it (their dues, `owed`, count against this bill first).
 */
function paidLaterOf(moneyLater: number, creditLeft: number, owed: number): number {
  return Math.max(0, Math.min(moneyLater, creditLeft, creditLeft - Math.max(0, owed)));
}

function billPaidLater(ctx: Ctx, customerId: number, billId: number, creditLeft: number): number {
  const moneyLater = moneyReceivedLaterByBill(ctx, customerId).get(billId) ?? 0;
  if (moneyLater <= 0) return 0;
  return paidLaterOf(moneyLater, creditLeft, partyBalance(ctx, 'customer', customerId, { account: 'AR' }));
}

/** A bill on which more money was paid back than has been received for it. */
export interface MoneyOverRefund {
  billId: number;
  billNo: string;
  /** Money received for the bill now: at the counter plus paid later. */
  received: number;
  /** Money paid back on the bill's active returns. */
  refunded: number;
  /** The returns that paid money back. */
  returns: Array<{ cnNo: string; refundMode: PaymentMode; total: number }>;
}

/**
 * A customer's bills with more money paid back than received for them. Refunds never allow this
 * when they are made, but a payment they relied on can be cancelled or cut afterwards.
 */
export function moneyOverRefunds(ctx: Ctx, customerId: number): MoneyOverRefund[] {
  const rows = ctx.db.all<{ id: number; bill_no: string; paid: number; credit: number; money: number; adjusted: number }>(
    `SELECT b.id, b.bill_no, b.paid, b.credit,
            SUM(CASE WHEN n.refund_mode <> 'credit' THEN n.total ELSE 0 END) AS money,
            SUM(CASE WHEN n.refund_mode = 'credit' THEN n.total ELSE 0 END) AS adjusted
       FROM bills b JOIN credit_notes n ON n.bill_id = b.id AND n.status = 'active'
      WHERE b.customer_id = ? AND b.status = 'active'
      GROUP BY b.id
     HAVING money > b.paid
      ORDER BY b.date, b.id`,
    [customerId],
  );
  if (!rows.length) return [];
  const later = moneyReceivedLaterByBill(ctx, customerId);
  const owed = partyBalance(ctx, 'customer', customerId, { account: 'AR' });
  const out: MoneyOverRefund[] = [];
  for (const r of rows) {
    const creditLeft = Math.max(0, r.credit - r.adjusted);
    const received = r.paid + paidLaterOf(later.get(r.id) ?? 0, creditLeft, owed);
    if (r.money <= received) continue;
    const returns = ctx.db
      .all<{ cn_no: string; refund_mode: PaymentMode; total: number }>(
        "SELECT cn_no, refund_mode, total FROM credit_notes WHERE bill_id = ? AND status = 'active' AND refund_mode <> 'credit' ORDER BY date, id",
        [r.id],
      )
      .map((n) => ({ cnNo: n.cn_no, refundMode: n.refund_mode, total: n.total }));
    out.push({ billId: r.id, billNo: r.bill_no, received, refunded: r.money, returns });
  }
  return out;
}

function overRefundWarning(o: MoneyOverRefund): string {
  const modes = [...new Set(o.returns.map((n) => n.refundMode))];
  const what =
    modes.length === 1 && modes[0] === 'cash'
      ? 'Cash was refunded'
      : `Money was refunded by ${modes.map((m) => (m === 'upi' ? 'UPI' : m)).join(' and ')}`;
  const notes = `${o.returns.length === 1 ? 'return' : 'returns'} ${o.returns.map((n) => n.cnNo).join(', ')}`;
  return (
    `${what} on ${o.billNo} against this payment (${notes}). ${formatINR(o.refunded)} was paid back on that bill, ` +
    `but only ${formatINR(o.received)} has now been received for it.`
  );
}

/**
 * Call before cancelling or changing a customer's payment; the function it returns, called after
 * the change, gives a warning for each bill on which money was paid back against that payment
 * and more has now gone back than came in.
 */
export function watchMoneyRefunds(ctx: Ctx, customerId: number): () => string[] {
  const before = new Map(moneyOverRefunds(ctx, customerId).map((o) => [o.billId, o.refunded - o.received]));
  return () =>
    moneyOverRefunds(ctx, customerId)
      .filter((o) => o.refunded - o.received > (before.get(o.billId) ?? 0))
      .map(overRefundWarning);
}

/** What can still be returned from a bill, with the rate the customer actually paid. */
export function billReturnable(ctx: Ctx, billId: number): BillReturnable {
  const bill = getBillRow(ctx, billId);
  const items = ctx.db.all<{ id: number; item_id: number | null; item_name: string; unit: string | null; qty: number; rate: number; amount: number }>(
    'SELECT id, item_id, item_name, unit, qty, rate, amount FROM bill_items WHERE bill_id = ? ORDER BY line_no',
    [billId],
  );
  const returned = new Map(
    ctx.db
      .all<{ bill_item_id: number; qty: number; amount: number; min_rate: number }>(
        `SELECT i.bill_item_id, SUM(i.qty) AS qty, SUM(i.amount) AS amount, MIN(i.rate) AS min_rate
           FROM credit_note_items i JOIN credit_notes n ON n.id = i.credit_note_id
          WHERE n.bill_id = ? AND n.status = 'active' AND i.bill_item_id IS NOT NULL
          GROUP BY i.bill_item_id`,
        [billId],
      )
      .map((r) => [r.bill_item_id, r]),
  );
  // What was really paid for each line: bill discount and a rounding down shared out exactly.
  const net = netLineAmounts(
    items.map((i) => i.amount),
    bill.total,
  );
  const lines = items.map((it, idx): ReturnableLine => {
    const done = returned.get(it.id);
    const qtyReturned = roundQty(done?.qty ?? 0);
    const returnedAmount = done?.amount ?? 0;
    return {
      billItemId: it.id,
      itemId: it.item_id,
      itemName: it.item_name,
      unit: it.unit,
      qtyBilled: it.qty,
      qtyReturned,
      returnable: Math.max(0, roundQty(it.qty - qtyReturned)),
      rate: it.rate,
      netRate: paidRate(net[idx], it.qty),
      netAmount: net[idx],
      returnedAmount,
      refundable: Math.max(0, net[idx] - returnedAmount),
    };
  });
  const sums = ctx.db.get<{ total: number; value: number; money: number; adjusted: number }>(
    `SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(subtotal), 0) AS value,
            COALESCE(SUM(CASE WHEN refund_mode <> 'credit' THEN total END), 0) AS money,
            COALESCE(SUM(CASE WHEN refund_mode = 'credit' THEN total END), 0) AS adjusted
       FROM credit_notes WHERE bill_id = ? AND status = 'active'`,
    [billId],
  )!;
  // Credit bills settled later: the part of this bill's credit the customer has since paid in money may
  // go back in money too. Returns already adjusted in the account took their part of the credit off
  // without any payment.
  const creditLeft = Math.max(0, bill.credit - sums.adjusted);
  const paidLater = bill.customer_id && creditLeft > 0 ? billPaidLater(ctx, bill.customer_id, bill.id, creditLeft) : 0;
  const moneyReceived = bill.paid + paidLater;
  const moneyRefundable = Math.max(0, moneyReceived - sums.money);
  const stillOwed = creditLeft - paidLater;
  const suggestedRefundMode: PaymentMode =
    bill.customer_id && (stillOwed > 0 || moneyRefundable <= 0)
      ? 'credit'
      : bill.payment_mode === 'credit'
        ? 'cash'
        : bill.payment_mode === 'split'
          ? bill.customer_id
            ? 'credit'
            : 'cash'
          : bill.payment_mode;
  // Earlier returns at a lower refund rate mean the bill is not settled by returning the rest.
  const allAtPaidRate = lines.every((l) => {
    const done = returned.get(l.billItemId);
    return !done || done.min_rate >= l.netRate;
  });
  return {
    bill: {
      id: bill.id,
      billNo: bill.bill_no,
      date: bill.date,
      status: bill.status,
      customerId: bill.customer_id,
      customerName: bill.customer_name,
      customerPhone: bill.customer_phone,
      subtotal: bill.subtotal,
      billDiscount: bill.bill_discount,
      total: bill.total,
      paid: bill.paid,
      credit: bill.credit,
      paymentMode: bill.payment_mode,
    },
    lines,
    returnedTotal: sums.total,
    returnedValue: sums.value,
    refundable: Math.max(0, bill.total - sums.total),
    moneyRefunded: sums.money,
    paidLater,
    moneyReceived,
    moneyRefundable,
    allAtPaidRate,
    roundOff: getSection(ctx, 'billing').roundOff,
    suggestedRefundMode,
  };
}

/** Bills to return goods against: search by bill number, customer name or phone (any date). */
export function findBillsForReturn(ctx: Ctx, q: string, limit = 10) {
  const text = q.trim();
  const params: Record<string, unknown> = { limit };
  let where = "b.status = 'active'";
  if (text) {
    where += ` AND (b.bill_no LIKE :like OR b.customer_name LIKE :like OR REPLACE(COALESCE(b.customer_phone, ''), ' ', '') LIKE :phone)`;
    params.like = `%${text}%`;
    params.phone = `%${text.replace(/\s/g, '')}%`;
  }
  return ctx.db
    .all<{ id: number; bill_no: string; date: string; customer_name: string | null; customer_phone: string | null; total: number; item_count: number }>(
      `SELECT b.id, b.bill_no, b.date, b.customer_name, b.customer_phone, b.total,
              (SELECT COUNT(*) FROM bill_items bi WHERE bi.bill_id = b.id) AS item_count
         FROM bills b WHERE ${where}
        ORDER BY CASE WHEN b.bill_no LIKE :exactEnd THEN 0 ELSE 1 END, b.date DESC, b.id DESC LIMIT :limit`,
      { ...params, exactEnd: text ? `%${text}` : '' },
    )
    .map((r) => ({ id: r.id, billNo: r.bill_no, date: r.date, customerName: r.customer_name, customerPhone: r.customer_phone, total: r.total, itemCount: r.item_count }));
}

/* ------------------------------------------------------------------ */
/* Create / cancel                                                     */
/* ------------------------------------------------------------------ */

function checkDate(ctx: Ctx, input: string | null | undefined, what: string): string {
  const t = today(ctx);
  const date = input || t;
  if (!isValidISODate(date)) throw fail.validation('Enter a valid date', { date: 'Enter a valid date' });
  if (date > t) throw fail.validation(`The ${what} date cannot be in the future.`, { date: 'Date is in the future' });
  if (date !== t && !can(ctx, 'billing.backdate')) {
    throw new AppError('FORBIDDEN', `You are not allowed to enter a ${what} with a past date. Use today's date or ask the owner for permission.`, {
      date: 'Past dates need permission',
    });
  }
  assertDateOpen(ctx, date, `This ${what}`);
  return date;
}

function hasAtMost3Decimals(q: number): boolean {
  return Math.abs(Math.round(q * 1000) - q * 1000) < 1e-6;
}

interface PreparedItem {
  billItemId: number;
  itemId: number | null;
  itemName: string;
  unit: string | null;
  qty: number;
  rate: number;
  amount: number;
}

export type CreditNoteResult = CreditNoteDetail & { warnings: string[] };

export function createCreditNote(ctx: Ctx, input: CreateCreditNoteInput): CreditNoteResult {
  requireSession(ctx);
  let date: string;
  let billId: number | null = null;
  let billNo: string | null = null;
  let customerId: number | null;
  let customerName: string | null;
  let items: PreparedItem[] = [];
  let subtotal: number;
  let total: number;
  const reason = (input.reason ?? '').trim() || null;

  if (input.kind === 'return') {
    assertCan(ctx, 'returns.create', 'You are not allowed to take back goods. Ask the owner for permission.');
    const bill = getBillRow(ctx, input.billId);
    if (bill.status !== 'active') throw fail.validation(`Bill ${bill.bill_no} is cancelled, so nothing can be returned against it.`);
    date = checkDate(ctx, input.date, 'return');
    if (date < bill.date) throw fail.validation(`A return cannot be dated before its bill (${formatDate(bill.date)}).`, { date: 'Before the bill date' });
    const r = billReturnable(ctx, bill.id);
    if (!input.items.length) throw fail.validation('Choose at least one item to return.', { items: 'Choose an item' });
    const seen = new Set<number>();
    items = input.items.map((ri, idx) => {
      const line = r.lines.find((l) => l.billItemId === ri.billItemId);
      if (!line) throw fail.validation(`Line ${idx + 1} is not on bill ${bill.bill_no}.`, { [`items.${idx}.billItemId`]: 'Not on this bill' });
      if (seen.has(line.billItemId)) throw fail.validation(`"${line.itemName}" is listed twice. Enter the total quantity once.`);
      seen.add(line.billItemId);
      if (!(ri.qty > 0)) throw fail.validation(`Enter the quantity of "${line.itemName}" being returned.`, { [`items.${idx}.qty`]: 'Must be more than zero' });
      if (!hasAtMost3Decimals(ri.qty)) throw fail.validation(`Quantity of "${line.itemName}" can have at most 3 decimal places.`, { [`items.${idx}.qty`]: 'Up to 3 decimals' });
      const qty = roundQty(ri.qty);
      if (qty > line.returnable + 1e-9) {
        const unit = line.unit ? ` ${line.unit}` : '';
        throw fail.validation(
          line.returnable > 0
            ? `Only ${formatQty(line.returnable)}${unit} of "${line.itemName}" can be returned (${formatQty(line.qtyBilled)}${unit} billed, ${formatQty(line.qtyReturned)}${unit} already returned).`
            : `All of "${line.itemName}" has already been returned.`,
          { [`items.${idx}.qty`]: `At most ${formatQty(line.returnable)}` },
        );
      }
      const rate = ri.rate ?? line.netRate;
      if (!Number.isInteger(rate) || rate < 0) throw fail.validation(`Enter a valid refund rate for "${line.itemName}".`, { [`items.${idx}.rate`]: 'Invalid rate' });
      // The customer gets back at most what they actually paid: after discounts and round off.
      if (rate > line.netRate) {
        const paid = line.netRate === line.rate ? `the billed rate ${formatINR(line.rate)}` : `${formatINR(line.netRate)}, what the customer paid for it`;
        throw fail.validation(`Refund rate for "${line.itemName}" cannot be more than ${paid}.`, {
          [`items.${idx}.rate`]: `At most ${formatINR(line.netRate)}`,
        });
      }
      const amount = returnLineAmount(line, qty, rate);
      return { billItemId: line.billItemId, itemId: line.itemId, itemName: line.itemName, unit: line.unit, qty, rate, amount };
    });
    subtotal = items.reduce((s, i) => s + i.amount, 0);
    if (subtotal <= 0) {
      throw fail.validation(
        r.refundable <= 0
          ? `Everything paid on bill ${bill.bill_no} (${formatINR(bill.total)}) has already been refunded, so nothing is left to refund.`
          : 'Nothing was paid for the chosen items (or it has already been refunded), so there is nothing to refund.',
        { total: 'Nothing to refund' },
      );
    }
    // Rounded on the running total of the bill's returns, and never more than is left of the bill;
    // taking back everything left at the rate paid settles the bill exactly.
    total = returnNoteTotal({
      billTotal: bill.total,
      returnedTotal: r.returnedTotal,
      returnedValue: r.returnedValue,
      value: subtotal,
      roundOff: r.roundOff,
      settles: returnSettlesBill(r, items),
    });
    if (total <= 0) {
      throw fail.validation(
        r.refundable <= 0
          ? `Everything paid on bill ${bill.bill_no} (${formatINR(bill.total)}) has already been refunded, so nothing is left to refund.`
          : `This return comes to ${formatINR(Math.max(total, 0))} after rounding to the rupee. Return it together with other items of the bill.`,
        { total: 'Nothing to refund' },
      );
    }
    billId = bill.id;
    billNo = bill.bill_no;
    customerId = bill.customer_id;
    customerName = bill.customer_name;
    if (input.refundMode === 'credit' && !customerId) {
      throw fail.validation(`Bill ${bill.bill_no} has no customer account, so the return cannot be adjusted. Refund it in cash, UPI or bank instead.`, {
        refundMode: 'No customer on the bill',
      });
    }
    // Money goes back only up to what was paid for the bill; anything more is adjusted in the customer's account.
    if (input.refundMode !== 'credit' && total > r.moneyRefundable) {
      const received = r.moneyReceived;
      const why =
        received <= 0
          ? `Nothing was paid on bill ${bill.bill_no} (it was sold on credit), so the return cannot be paid back in money.`
          : r.moneyRefundable <= 0
            ? `The ${formatINR(received)} received on bill ${bill.bill_no} has already been paid back, so nothing more can be refunded in money.`
            : `Only ${formatINR(received)} was received on bill ${bill.bill_no}${r.moneyRefunded ? ` and ${formatINR(r.moneyRefunded)} has already been paid back` : ''}, so at most ${formatINR(r.moneyRefundable)} can be refunded in money.`;
      throw fail.validation(customerId ? `${why} Choose "Adjust" to take ${formatINR(total)} off ${customerName}'s balance, or return fewer items now.` : why, {
        refundMode: r.moneyRefundable > 0 ? `At most ${formatINR(r.moneyRefundable)} in money` : 'Adjust in the account',
      });
    }
  } else {
    assertCan(ctx, 'returns.adjust', 'You are not allowed to make credit notes without goods. Ask the owner for permission.');
    const c = ctx.db.get<{ id: number; name: string; is_active: number }>('SELECT id, name, is_active FROM customers WHERE id = ?', [input.customerId]);
    if (!c) throw fail.validation('The chosen customer was not found.', { customerId: 'Customer not found' });
    if (!reason) throw fail.validation('Enter the reason for the credit note.', { reason: 'Reason is required' });
    date = checkDate(ctx, input.date, 'credit note');
    if (!Number.isInteger(input.amount) || input.amount <= 0) throw fail.validation('Enter the credit note amount.', { amount: 'Must be more than zero' });
    customerId = c.id;
    customerName = c.name;
    subtotal = input.amount;
    total = input.amount;
  }
  const roundOff = total - subtotal;

  let refundAccountId: number | null = null;
  const warnings: string[] = [];
  if (input.refundMode !== 'credit') {
    refundAccountId = paymentAccountId(ctx, input.refundMode as SettlementMode, input.refundAccountId);
    const short = negativeBalanceWarning(ctx, refundAccountId, total, date);
    if (short) warnings.push(short);
  }

  const num = nextDocNumber(ctx, 'credit_note', date);
  const id = ctx.db.insert('credit_notes', {
    cn_no: num.number,
    seq: num.seq,
    fy_start: num.fyStart,
    date,
    kind: input.kind,
    bill_id: billId,
    customer_id: customerId,
    customer_name: customerName,
    subtotal,
    round_off: roundOff,
    total,
    refund_mode: input.refundMode,
    refund_account_id: refundAccountId,
    reason,
    status: 'active',
    revision: 1,
    created_by: currentUserId(ctx),
    created_at: now(ctx),
  });
  items.forEach((it, i) => {
    ctx.db.insert('credit_note_items', {
      credit_note_id: id,
      line_no: i + 1,
      bill_item_id: it.billItemId,
      item_id: it.itemId,
      item_name: it.itemName,
      unit: it.unit,
      qty: it.qty,
      rate: it.rate,
      amount: it.amount,
    });
  });

  const lines: EntryLineInput[] = [{ account: 'SALES_RETURNS', debit: subtotal }];
  if (roundOff > 0) lines.push({ account: 'ROUND_OFF', debit: roundOff });
  if (roundOff < 0) lines.push({ account: 'ROUND_OFF', credit: -roundOff });
  if (input.refundMode === 'credit') lines.push({ account: 'AR', credit: total, partyType: 'customer', partyId: customerId!, memo: 'Adjusted in account' });
  else lines.push({ account: refundAccountId!, credit: total, memo: `Refund by ${PAYMENT_MODE_LABELS[input.refundMode]}` });
  const what = input.kind === 'return' ? `Sales return against ${billNo}` : 'Credit note';
  const entryId = postEntry(ctx, {
    date,
    voucherType: 'sale_return',
    voucherNo: num.number,
    sourceType: 'credit_note',
    sourceId: id,
    narration: `${what}${customerName ? ` - ${customerName}` : ''}${reason ? ` (${reason})` : ''}`,
    lines,
  });
  ctx.db.update('credit_notes', id, { journal_entry_id: entryId });

  const detail = getCreditNote(ctx, id);
  recordRevision(ctx, 'credit_note', id, 'created', creditNoteSnapshot(detail));
  const refund = input.refundMode === 'credit' ? "adjusted in customer's account" : `refunded by ${PAYMENT_MODE_LABELS[input.refundMode]}`;
  logActivity(
    ctx,
    input.kind === 'return' ? 'return.create' : 'credit_note.create',
    input.kind === 'return'
      ? `Sales return ${num.number} for ${formatINR(total)} against bill ${billNo} (${items.length} item${items.length === 1 ? '' : 's'}, ${refund})`
      : `Credit note ${num.number} for ${formatINR(total)} to ${customerName} (${refund})${reason ? `. Reason: ${reason}` : ''}`,
    { entityType: 'credit_note', entityId: id, details: { kind: input.kind, billId, total, refundMode: input.refundMode } },
  );
  return { ...getCreditNote(ctx, id), warnings };
}

export function cancelCreditNote(ctx: Ctx, id: number, reason: string): CreditNoteResult {
  const r = getCreditNoteRow(ctx, id);
  if (r.status === 'cancelled') throw fail.validation(`${r.cn_no} is already cancelled.`);
  const why = reason.trim();
  if (!why) throw fail.validation('Enter the reason for cancelling.', { reason: 'Reason is required' });
  assertCancelKeepsClosedAccounts(ctx, r.journal_entry_id, r.kind === 'return' ? 'this return' : 'this credit note');
  // Cancelling an adjustment in the customer's account can take away money a cash refund relied on.
  const refundWarnings = r.customer_id ? watchMoneyRefunds(ctx, r.customer_id) : () => [];
  ctx.db.update('credit_notes', id, { status: 'cancelled', cancelled_by: currentUserId(ctx), cancelled_at: now(ctx), cancel_reason: why });
  if (r.journal_entry_id) voidEntry(ctx, r.journal_entry_id, `${r.cn_no} cancelled: ${why}`);
  const detail = getCreditNote(ctx, id);
  recordRevision(ctx, 'credit_note', id, 'cancelled', creditNoteSnapshot(detail), why);
  logActivity(ctx, r.kind === 'return' ? 'return.cancel' : 'credit_note.cancel', `Cancelled ${r.kind === 'return' ? 'sales return' : 'credit note'} ${r.cn_no} (${formatINR(r.total)}). Reason: ${why}`, {
    entityType: 'credit_note',
    entityId: id,
    details: { reason: why },
  });
  return { ...getCreditNote(ctx, id), warnings: refundWarnings() };
}

export function creditNoteSnapshot(d: CreditNoteDetail) {
  return {
    cnNo: d.cnNo,
    date: d.date,
    kind: d.kind,
    billId: d.billId,
    billNo: d.billNo,
    customerId: d.customerId,
    customerName: d.customerName,
    items: d.items.map((i) => ({ billItemId: i.billItemId, itemId: i.itemId, itemName: i.itemName, unit: i.unit, qty: i.qty, rate: i.rate, amount: i.amount })),
    subtotal: d.subtotal,
    roundOff: d.roundOff,
    total: d.total,
    refundMode: d.refundMode,
    refundAccountId: d.refundAccountId,
    refundAccountName: d.refundAccountName,
    reason: d.reason,
    status: d.status,
    cancelReason: d.cancelReason,
  };
}

export function creditNoteRevisions(ctx: Ctx, id: number) {
  return listRevisions(ctx, 'credit_note', id);
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

export interface CreditNoteListQuery {
  from: string;
  to: string;
  q?: string | null;
  kind?: CreditNoteKind | null;
  status?: 'active' | 'cancelled' | null;
  customerId?: number | null;
  billId?: number | null;
  limit: number;
  offset: number;
}

export function listCreditNotes(ctx: Ctx, query: CreditNoteListQuery) {
  let { from, to } = query;
  if (from > to) [from, to] = [to, from];
  const where = ['n.date >= :from', 'n.date <= :to'];
  const params: Record<string, unknown> = { from, to };
  if (query.kind) {
    where.push('n.kind = :kind');
    params.kind = query.kind;
  }
  if (query.status) {
    where.push('n.status = :status');
    params.status = query.status;
  }
  if (query.customerId) {
    where.push('n.customer_id = :customerId');
    params.customerId = query.customerId;
  }
  if (query.billId) {
    where.push('n.bill_id = :billId');
    params.billId = query.billId;
  }
  const text = (query.q ?? '').trim();
  if (text) {
    where.push('(n.cn_no LIKE :like OR n.customer_name LIKE :like OR n.reason LIKE :like OR b.bill_no LIKE :like)');
    params.like = `%${text}%`;
  }
  const whereSql = where.join(' AND ');
  const rows = ctx.db.all<CreditNoteRow & { bill_no: string | null; item_count: number; created_by_name: string | null }>(
    `SELECT n.*, b.bill_no, (SELECT COUNT(*) FROM credit_note_items i WHERE i.credit_note_id = n.id) AS item_count, u.full_name AS created_by_name
       FROM credit_notes n LEFT JOIN bills b ON b.id = n.bill_id LEFT JOIN users u ON u.id = n.created_by
      WHERE ${whereSql} ORDER BY n.date DESC, n.id DESC LIMIT :limit OFFSET :offset`,
    { ...params, limit: query.limit + 1, offset: query.offset },
  );
  const hasMore = rows.length > query.limit;
  if (hasMore) rows.pop();
  const totals = ctx.db.get<{ count: number; total: number; refunded: number; adjusted: number; cancelled: number }>(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN n.status = 'active' THEN n.total END), 0) AS total,
            COALESCE(SUM(CASE WHEN n.status = 'active' AND n.refund_mode <> 'credit' THEN n.total END), 0) AS refunded,
            COALESCE(SUM(CASE WHEN n.status = 'active' AND n.refund_mode = 'credit' THEN n.total END), 0) AS adjusted,
            COALESCE(SUM(CASE WHEN n.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
       FROM credit_notes n LEFT JOIN bills b ON b.id = n.bill_id WHERE ${whereSql}`,
    params,
  )!;
  return {
    from,
    to,
    hasMore,
    rows: rows.map((r) => ({
      id: r.id,
      cnNo: r.cn_no,
      date: r.date,
      createdAt: r.created_at,
      kind: r.kind,
      billId: r.bill_id,
      billNo: r.bill_no,
      customerId: r.customer_id,
      customerName: r.customer_name,
      itemCount: r.item_count,
      total: r.total,
      refundMode: r.refund_mode,
      reason: r.reason,
      status: r.status,
      createdByName: r.created_by_name,
    })),
    totals: { count: totals.count, total: totals.total, refunded: totals.refunded, adjusted: totals.adjusted, cancelledCount: totals.cancelled },
  };
}

/* ------------------------------------------------------------------ */
/* Receipts & printing                                                 */
/* ------------------------------------------------------------------ */

export function creditNoteReceiptDoc(ctx: Ctx, d: CreditNoteDetail, opts: { duplicate?: boolean } = {}): ReceiptDoc {
  const receipt = getSection(ctx, 'receipt');
  const sameDay = d.createdAt.slice(0, 10) === d.date;
  const meta: Array<[string, string]> = [
    [d.kind === 'return' ? 'Return No' : 'Credit Note No', d.cnNo],
    ['Date', `${formatDate(d.date)}${sameDay ? `  ${formatTime(d.createdAt)}` : ''}`],
  ];
  if (d.billNo) meta.push(['Against Bill', `${d.billNo}${d.billDate ? ` (${formatDate(d.billDate)})` : ''}`]);
  if (receipt.showCashier && d.createdByName) meta.push(['Cashier', d.createdByName]);
  const totals: ReceiptTotal[] = [];
  if (d.roundOff !== 0) {
    totals.push({ label: 'Subtotal', value: formatINR(d.subtotal) });
    totals.push({ label: 'Round off', value: formatINR(d.roundOff, { plus: true }) });
  }
  totals.push({ label: d.refundMode === 'credit' ? 'TOTAL CREDIT' : 'TOTAL REFUND', value: formatINR(d.total), big: true });
  totals.push({
    label: d.refundMode === 'credit' ? "Adjusted in customer's account" : `Refunded by ${PAYMENT_MODE_LABELS[d.refundMode]}`,
    value: formatINR(d.total),
  });
  const lines: string[] = [];
  if (d.items.length) lines.push(itemCountLine(d.items));
  if (receipt.showAmountInWords) lines.push(amountInWords(d.total));
  // For the customer: the real balance from the books, even when the user printing may not see balances.
  if (d.refundMode === 'credit' && d.customerId && d.customer && d.status === 'active') {
    lines.push(customerBalanceLine(partyBalance(ctx, 'customer', d.customerId, { account: 'AR' }), today(ctx)));
  }
  if (d.reason) lines.push(`Reason: ${d.reason}`);
  if (d.status === 'cancelled') lines.push(`Cancelled${d.cancelledAt ? ` on ${formatDate(d.cancelledAt)}` : ''}: ${d.cancelReason ?? ''}`);
  return {
    title: d.kind === 'return' ? 'SALES RETURN' : 'CREDIT NOTE',
    duplicate: !!opts.duplicate,
    cancelled: d.status === 'cancelled',
    meta,
    party: receipt.showCustomer && d.customerName ? { label: 'Customer', name: d.customerName, phone: d.customerPhone } : undefined,
    items: d.items.map((i) => ({ name: i.itemName, qty: `${formatQty(i.qty)}${i.unit ? ' ' + i.unit : ''}`, rate: formatAmount(i.rate), amount: formatAmount(i.amount) })),
    totals,
    lines,
    signature: d.refundMode !== 'credit' ? "Receiver's signature" : undefined,
  };
}

export function creditNoteReceiptHtml(ctx: Ctx, id: number, opts: { duplicate?: boolean } = {}): { html: string; paperWidth: 80 | 58 } {
  const d = getCreditNote(ctx, id);
  const receipt = getSection(ctx, 'receipt');
  return { html: renderReceiptHtml(creditNoteReceiptDoc(ctx, d, opts), getSection(ctx, 'business'), receipt), paperWidth: receipt.paperWidth };
}

export async function printCreditNote(ctx: Ctx, id: number): Promise<{ printed: boolean; duplicate: boolean; message: string }> {
  const r = getCreditNoteRow(ctx, id);
  const reprint = r.print_count > 0;
  if (reprint) assertCan(ctx, 'billing.reprint', 'You are not allowed to reprint. Ask the owner for permission.');
  const duplicate = reprint && getSection(ctx, 'receipt').markDuplicate;
  const { html } = creditNoteReceiptHtml(ctx, id, { duplicate });
  const res = await sendToReceiptPrinter(ctx, html, reprint);
  if (!res.printed) return { printed: false, duplicate, message: res.message || 'Printing was cancelled.' };
  ctx.db.tx(() => {
    ctx.db.run('UPDATE credit_notes SET print_count = print_count + 1 WHERE id = ?', [id]);
    if (reprint) {
      logActivity(ctx, 'credit_note.reprint', `Reprinted ${r.cn_no} (${formatINR(r.total)})`, { entityType: 'credit_note', entityId: id });
    }
  });
  return { printed: true, duplicate, message: res.message || `${r.cn_no} sent to the printer` };
}
