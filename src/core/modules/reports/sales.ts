/**
 * Sales insights: by day, month, item, customer and payment mode, plus headline
 * figures. These read the sales documents themselves (bills, bill items, bill
 * payments, credit notes) because they need items and payment modes; only
 * ACTIVE documents count, so cancelled bills and returns are left out.
 *
 *   Gross sales                = sum of qty x rate on the bills
 *   Discounts                  = item discounts + bill discounts
 *   Net sales after discounts  = bill totals (after discounts and round off) - returns / credit notes
 * Returns are counted on the date of the return, not the date of the original bill.
 *
 * The Profit & loss "Net sales" is a different figure: Sales - Sales returns from the ledger, with
 * discounts and round off shown under indirect expenses. So these reports call theirs
 * "Net sales after discounts" and say so in their notes.
 */
import type { Ctx } from '../../context';
import { PAYMENT_MODE_LABELS, PAYMENT_MODES, type PaymentMode } from '../../../shared/constants';
import { datesBetween, monthLabel, monthsBetween, weekdayShort } from '../../../shared/dates';
import type { ReportColumn, ReportData, ReportRow } from '../../../shared/report';
import { assertMaxDays, assertRange, pct, rangeSubtitle, type ChartData } from './common';

export interface SalesRange {
  from: string;
  to: string;
}

export interface SalesInsight {
  report: ReportData;
  chart: ChartData;
}

export interface SalesSummary {
  from: string;
  to: string;
  bills: number;
  grossSales: number;
  discounts: number;
  roundOff: number;
  /** Bill totals (after discounts and round off). */
  billed: number;
  returns: number;
  returnCount: number;
  netSales: number;
  averageBill: number;
  /** Received at billing, by mode; credit = put on the customer's account. */
  byMode: Record<PaymentMode, number>;
  cancelledBills: number;
  cancelledAmount: number;
  customers: number;
}

interface Agg {
  bills: number;
  gross: number;
  discounts: number;
  roundOff: number;
  billed: number;
  returns: number;
}

const emptyAgg = (): Agg => ({ bills: 0, gross: 0, discounts: 0, roundOff: 0, billed: 0, returns: 0 });
const netOf = (a: Agg) => a.billed - a.returns;
const avgOf = (a: Agg) => (a.bills ? Math.round(a.billed / a.bills) : 0);

interface BillRow {
  id: number;
  date: string;
  customer_id: number | null;
  subtotal: number;
  item_discount: number;
  bill_discount: number;
  round_off: number;
  total: number;
  credit: number;
}

interface ReturnRow {
  id: number;
  date: string;
  customer_id: number | null;
  total: number;
  refund_mode: PaymentMode;
}

function bills(ctx: Ctx, r: SalesRange): BillRow[] {
  return ctx.db.all<BillRow>(
    `SELECT id, date, customer_id, subtotal, item_discount, bill_discount, round_off, total, credit
       FROM bills WHERE status = 'active' AND date >= ? AND date <= ? ORDER BY date, id`,
    [r.from, r.to],
  );
}

function returns(ctx: Ctx, r: SalesRange): ReturnRow[] {
  // A return against a bill belongs to the bill's customer even if the note itself has none.
  return ctx.db.all<ReturnRow>(
    `SELECT n.id, n.date, COALESCE(n.customer_id, b.customer_id) AS customer_id, n.total, n.refund_mode
       FROM credit_notes n LEFT JOIN bills b ON b.id = n.bill_id
      WHERE n.status = 'active' AND n.date >= ? AND n.date <= ? ORDER BY n.date, n.id`,
    [r.from, r.to],
  );
}

function addBill(a: Agg, b: BillRow): void {
  a.bills++;
  a.gross += b.subtotal;
  a.discounts += b.item_discount + b.bill_discount;
  a.roundOff += b.round_off;
  a.billed += b.total;
}

/** Label of bill totals less returns (not the P&L's "Net sales", which is before discounts). */
export const NET_SALES_LABEL = 'Net sales after discounts';

const AGG_COLUMNS: ReportColumn[] = [
  { key: 'bills', label: 'Bills', type: 'number', width: 8 },
  { key: 'gross', label: 'Gross sales', type: 'money', width: 15 },
  { key: 'discounts', label: 'Discounts', type: 'money', width: 13 },
  { key: 'returns', label: 'Returns', type: 'money', width: 13 },
  { key: 'net', label: NET_SALES_LABEL, type: 'money', width: 18 },
  { key: 'avg', label: 'Average bill', type: 'money', width: 13 },
];

function aggCells(a: Agg): Record<string, number | null> {
  return { bills: a.bills, gross: a.gross, discounts: a.discounts || null, returns: a.returns || null, net: netOf(a), avg: a.bills ? avgOf(a) : null };
}

const NET_NOTE =
  'Net sales after discounts = gross sales - discounts ± round off - returns. Cancelled bills and cancelled returns are not counted. ' +
  'The Profit & loss "Net sales" is sales less returns only: it shows discounts and round off under indirect expenses.';

function totalAgg(list: Agg[]): Agg {
  const t = emptyAgg();
  for (const a of list) {
    t.bills += a.bills;
    t.gross += a.gross;
    t.discounts += a.discounts;
    t.roundOff += a.roundOff;
    t.billed += a.billed;
    t.returns += a.returns;
  }
  return t;
}

function summaryItems(t: Agg): ReportData['summary'] {
  return [
    { label: NET_SALES_LABEL, value: netOf(t), type: 'money' },
    { label: 'Bills', value: t.bills, type: 'number' },
    { label: 'Average bill', value: avgOf(t), type: 'money' },
    { label: 'Discounts', value: t.discounts, type: 'money' },
    { label: 'Returns', value: t.returns, type: 'money' },
  ];
}

/* ------------------------------ Summary ------------------------------ */

export function salesSummary(ctx: Ctx, r: SalesRange): SalesSummary {
  assertRange(r.from, r.to);
  const bs = bills(ctx, r);
  const rs = returns(ctx, r);
  const t = emptyAgg();
  const customers = new Set<number>();
  for (const b of bs) {
    addBill(t, b);
    if (b.customer_id) customers.add(b.customer_id);
  }
  for (const x of rs) t.returns += x.total;
  const modes = modeTotals(ctx, r);
  const cancelled = ctx.db.get<{ n: number; amt: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS amt FROM bills WHERE status = 'cancelled' AND date >= ? AND date <= ?",
    [r.from, r.to],
  )!;
  return {
    from: r.from,
    to: r.to,
    bills: t.bills,
    grossSales: t.gross,
    discounts: t.discounts,
    roundOff: t.roundOff,
    billed: t.billed,
    returns: t.returns,
    returnCount: rs.length,
    netSales: netOf(t),
    averageBill: avgOf(t),
    byMode: { cash: modes.cash.amount, upi: modes.upi.amount, bank: modes.bank.amount, credit: modes.credit.amount },
    cancelledBills: cancelled.n,
    cancelledAmount: cancelled.amt,
    customers: customers.size,
  };
}

/* ------------------------------ By day ------------------------------ */

/** Short label for chart axes: "28 Sep". */
function dayLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`;
}

export function dailyNetSales(ctx: Ctx, r: SalesRange): Map<string, Agg> {
  const map = new Map<string, Agg>();
  for (const d of datesBetween(r.from, r.to)) map.set(d, emptyAgg());
  for (const b of bills(ctx, r)) addBill(map.get(b.date)!, b);
  for (const x of returns(ctx, r)) map.get(x.date)!.returns += x.total;
  return map;
}

export function salesByDay(ctx: Ctx, r: SalesRange): SalesInsight {
  assertRange(r.from, r.to);
  assertMaxDays(r.from, r.to, 731, 'For longer periods use the month-wise report.');
  const map = dailyNetSales(ctx, r);
  const rows: ReportRow[] = [];
  for (const [date, a] of map) {
    const empty = !a.bills && !a.returns;
    rows.push({ cells: { date, day: weekdayShort(date), ...(empty ? { bills: 0, net: 0 } : aggCells(a)) }, style: empty ? 'muted' : undefined });
  }
  const t = totalAgg([...map.values()]);
  rows.push({ cells: { date: 'Total', day: null, ...aggCells(t) }, style: 'total' });
  // Nothing at all in the period: no rows, so the screen shows a plain "no sales" message.
  if (!t.bills && !t.returns) rows.length = 0;
  const days = [...map.keys()];
  const activeDays = [...map.values()].filter((a) => a.bills || a.returns).length;
  return {
    report: {
      title: 'Sales by Day',
      subtitle: rangeSubtitle(r.from, r.to),
      columns: [{ key: 'date', label: 'Date', type: 'date', width: 12 }, { key: 'day', label: 'Day', width: 6 }, ...AGG_COLUMNS],
      rows,
      summary: [...summaryItems(t)!, { label: 'Days with sales', value: activeDays, type: 'number' }],
      notes: [NET_NOTE],
      landscape: true,
    },
    chart: { labels: days.map(dayLabel), series: [{ name: NET_SALES_LABEL, values: [...map.values()].map(netOf) }] },
  };
}

/* ------------------------------ By month ------------------------------ */

export function salesByMonth(ctx: Ctx, r: SalesRange): SalesInsight {
  assertRange(r.from, r.to);
  const months = monthsBetween(r.from, r.to);
  const map = new Map<string, Agg>(months.map((m) => [m, emptyAgg()]));
  for (const b of bills(ctx, r)) addBill(map.get(b.date.slice(0, 7))!, b);
  for (const x of returns(ctx, r)) map.get(x.date.slice(0, 7))!.returns += x.total;
  const t = totalAgg([...map.values()]);
  const rows: ReportRow[] = [];
  let prevNet: number | null = null;
  for (const [m, a] of map) {
    const net = netOf(a);
    const change = prevNet !== null && prevNet !== 0 ? Math.round(((net - prevNet) / Math.abs(prevNet)) * 1000) / 10 : null;
    rows.push({ cells: { month: monthLabel(m, true), ...aggCells(a), share: pct(net, netOf(t)), change }, style: !a.bills && !a.returns ? 'muted' : undefined });
    prevNet = net;
  }
  rows.push({ cells: { month: 'Total', ...aggCells(t), share: netOf(t) ? 100 : null, change: null }, style: 'total' });
  if (!t.bills && !t.returns) rows.length = 0;
  return {
    report: {
      title: 'Sales by Month',
      subtitle: rangeSubtitle(r.from, r.to),
      columns: [
        { key: 'month', label: 'Month', width: 16 },
        ...AGG_COLUMNS,
        { key: 'share', label: 'Share %', type: 'percent', width: 9 },
        { key: 'change', label: 'vs previous month', type: 'percent', width: 11 },
      ],
      rows,
      summary: summaryItems(t),
      notes: [NET_NOTE, 'The first and last months count only the days inside the chosen period.'],
      landscape: true,
    },
    chart: { labels: months.map((m) => monthLabel(m)), series: [{ name: NET_SALES_LABEL, values: [...map.values()].map(netOf) }] },
  };
}

/* ------------------------------ By item ------------------------------ */

export interface ItemSales {
  key: string;
  itemId: number | null;
  name: string;
  unit: string | null;
  bills: number;
  qtySold: number;
  qtyReturned: number;
  soldAmount: number;
  returnedAmount: number;
  amount: number;
}

export function itemSales(ctx: Ctx, r: SalesRange): ItemSales[] {
  const sold = ctx.db.all<{ item_id: number | null; name: string; unit: string | null; bills: number; qty: number; amount: number }>(
    `SELECT i.item_id, COALESCE(it.name, i.item_name) AS name, MAX(i.unit) AS unit, COUNT(DISTINCT i.bill_id) AS bills,
            SUM(i.qty) AS qty, SUM(i.amount) AS amount
       FROM bill_items i JOIN bills b ON b.id = i.bill_id LEFT JOIN items it ON it.id = i.item_id
      WHERE b.status = 'active' AND b.date >= ? AND b.date <= ?
      GROUP BY CASE WHEN i.item_id IS NULL THEN 'n:' || LOWER(TRIM(i.item_name)) ELSE 'i:' || i.item_id END`,
    [r.from, r.to],
  );
  const back = ctx.db.all<{ item_id: number | null; name: string; unit: string | null; qty: number; amount: number }>(
    `SELECT i.item_id, COALESCE(it.name, i.item_name) AS name, MAX(i.unit) AS unit, SUM(i.qty) AS qty, SUM(i.amount) AS amount
       FROM credit_note_items i JOIN credit_notes n ON n.id = i.credit_note_id LEFT JOIN items it ON it.id = i.item_id
      WHERE n.status = 'active' AND n.date >= ? AND n.date <= ?
      GROUP BY CASE WHEN i.item_id IS NULL THEN 'n:' || LOWER(TRIM(i.item_name)) ELSE 'i:' || i.item_id END`,
    [r.from, r.to],
  );
  const keyOf = (id: number | null, name: string) => (id ? `i:${id}` : `n:${name.trim().toLowerCase()}`);
  const map = new Map<string, ItemSales>();
  const get = (id: number | null, name: string, unit: string | null) => {
    const k = keyOf(id, name);
    let v = map.get(k);
    if (!v) {
      v = { key: k, itemId: id, name: name.trim(), unit, bills: 0, qtySold: 0, qtyReturned: 0, soldAmount: 0, returnedAmount: 0, amount: 0 };
      map.set(k, v);
    }
    return v;
  };
  for (const s of sold) {
    const v = get(s.item_id, s.name, s.unit);
    v.bills += s.bills;
    v.qtySold += s.qty;
    v.soldAmount += s.amount;
  }
  for (const s of back) {
    const v = get(s.item_id, s.name, s.unit);
    v.qtyReturned += s.qty;
    v.returnedAmount += s.amount;
  }
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const list = [...map.values()].map((v) => ({ ...v, qtySold: round3(v.qtySold), qtyReturned: round3(v.qtyReturned), amount: v.soldAmount - v.returnedAmount }));
  list.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  return list;
}

export function salesByItem(ctx: Ctx, r: SalesRange): SalesInsight {
  assertRange(r.from, r.to);
  const list = itemSales(ctx, r);
  const totalAmount = list.reduce((s, v) => s + v.amount, 0);
  const rows: ReportRow[] = list.map((v) => ({
    cells: {
      item: v.name,
      unit: v.unit,
      bills: v.bills,
      qtySold: v.qtySold,
      qtyReturned: v.qtyReturned || null,
      netQty: Math.round((v.qtySold - v.qtyReturned) * 1000) / 1000,
      amount: v.amount,
      share: pct(v.amount, totalAmount),
    },
  }));
  if (rows.length) rows.push({ cells: { item: `Total (${list.length} items)`, amount: totalAmount, share: totalAmount ? 100 : null }, style: 'total' });
  const top = list.slice(0, 10);
  const s = salesSummary(ctx, r);
  return {
    report: {
      title: 'Sales by Item',
      subtitle: rangeSubtitle(r.from, r.to),
      columns: [
        { key: 'item', label: 'Item', width: 30 },
        { key: 'unit', label: 'Unit', width: 7 },
        { key: 'bills', label: 'Bills', type: 'number', width: 8 },
        { key: 'qtySold', label: 'Qty sold', type: 'qty', width: 10 },
        { key: 'qtyReturned', label: 'Qty returned', type: 'qty', width: 11 },
        { key: 'netQty', label: 'Net qty', type: 'qty', width: 10 },
        { key: 'amount', label: 'Amount', type: 'money', width: 15 },
        { key: 'share', label: 'Share %', type: 'percent', width: 9 },
      ],
      rows,
      summary: [
        { label: 'Items sold', value: list.filter((v) => v.qtySold > 0).length, type: 'number' },
        { label: 'Total of items', value: totalAmount, type: 'money' },
        { label: `${NET_SALES_LABEL} (all bills)`, value: s.netSales, type: 'money' },
      ],
      notes: [
        'Amount = quantity x rate less item discounts, less items returned. Discounts on the whole bill and round off are not split across items, so the total of items can differ a little from net sales after discounts.',
        'Credit notes without items (price adjustments) are not in this list but are included in net sales after discounts.',
      ],
      landscape: true,
    },
    chart: { labels: top.map((v) => v.name), series: [{ name: 'Amount', values: top.map((v) => v.amount) }] },
  };
}

/* ------------------------------ By customer ------------------------------ */

export function salesByCustomer(ctx: Ctx, r: SalesRange): SalesInsight {
  assertRange(r.from, r.to);
  const map = new Map<number, Agg & { credit: number }>();
  const get = (id: number | null) => {
    const k = id ?? 0;
    let v = map.get(k);
    if (!v) {
      v = { ...emptyAgg(), credit: 0 };
      map.set(k, v);
    }
    return v;
  };
  for (const b of bills(ctx, r)) {
    const v = get(b.customer_id);
    addBill(v, b);
    v.credit += b.credit;
  }
  for (const x of returns(ctx, r)) get(x.customer_id).returns += x.total;
  const ids = [...map.keys()].filter((k) => k > 0);
  const names = new Map(
    ids.length
      ? ctx.db.all<{ id: number; name: string; phone: string | null }>(`SELECT id, name, phone FROM customers WHERE id IN (${ids.map(() => '?').join(', ')})`, ids).map((c) => [c.id, c])
      : [],
  );
  const t = totalAgg([...map.values()]);
  const totalNet = netOf(t);
  const list = [...map.entries()].map(([id, a]) => ({ id, a, name: id ? (names.get(id)?.name ?? `Customer #${id}`) : 'Walk-in customers', phone: id ? (names.get(id)?.phone ?? null) : null }));
  list.sort((x, y) => netOf(y.a) - netOf(x.a) || x.name.localeCompare(y.name));
  const rows: ReportRow[] = list.map(({ id, a, name, phone }) => ({
    cells: { customer: name, phone, ...aggCells(a), credit: a.credit || null, share: pct(netOf(a), totalNet) },
    ...(id ? { link: { kind: 'customer', id } } : { style: 'muted' as const }),
  }));
  const credit = list.reduce((s, x) => s + x.a.credit, 0);
  if (rows.length) rows.push({ cells: { customer: `Total (${list.filter((x) => x.id).length} customers${map.has(0) ? ' + walk-ins' : ''})`, phone: null, ...aggCells(t), credit: credit || null, share: totalNet ? 100 : null }, style: 'total' });
  const top = list.slice(0, 10);
  return {
    report: {
      title: 'Sales by Customer',
      subtitle: rangeSubtitle(r.from, r.to),
      columns: [
        { key: 'customer', label: 'Customer', width: 26 },
        { key: 'phone', label: 'Phone', width: 13 },
        ...AGG_COLUMNS,
        { key: 'credit', label: 'On credit', type: 'money', width: 13 },
        { key: 'share', label: 'Share %', type: 'percent', width: 9 },
      ],
      rows,
      summary: [...summaryItems(t)!, { label: 'Sold on credit', value: credit, type: 'money' }],
      notes: [NET_NOTE, 'Bills without a customer are grouped as "Walk-in customers".'],
      landscape: true,
    },
    chart: { labels: top.map((x) => x.name), series: [{ name: NET_SALES_LABEL, values: top.map((x) => netOf(x.a)) }] },
  };
}

/* ------------------------------ By payment mode ------------------------------ */

function modeTotals(ctx: Ctx, r: SalesRange): Record<PaymentMode, { bills: number; amount: number }> {
  const out = Object.fromEntries(PAYMENT_MODES.map((m) => [m, { bills: 0, amount: 0 }])) as Record<PaymentMode, { bills: number; amount: number }>;
  for (const p of ctx.db.all<{ mode: 'cash' | 'upi' | 'bank'; bills: number; amount: number }>(
    `SELECT p.mode, COUNT(DISTINCT p.bill_id) AS bills, SUM(p.amount) AS amount
       FROM bill_payments p JOIN bills b ON b.id = p.bill_id
      WHERE b.status = 'active' AND b.date >= ? AND b.date <= ? GROUP BY p.mode`,
    [r.from, r.to],
  )) {
    out[p.mode] = { bills: p.bills, amount: p.amount };
  }
  const credit = ctx.db.get<{ bills: number; amount: number }>(
    "SELECT COUNT(*) AS bills, COALESCE(SUM(credit), 0) AS amount FROM bills WHERE status = 'active' AND credit > 0 AND date >= ? AND date <= ?",
    [r.from, r.to],
  )!;
  out.credit = { bills: credit.bills, amount: credit.amount };
  return out;
}

export function salesByPaymentMode(ctx: Ctx, r: SalesRange): SalesInsight {
  assertRange(r.from, r.to);
  const modes = modeTotals(ctx, r);
  const refunds = Object.fromEntries(PAYMENT_MODES.map((m) => [m, 0])) as Record<PaymentMode, number>;
  for (const x of returns(ctx, r)) refunds[x.refund_mode] += x.total;
  const billCount = ctx.db.value<number>("SELECT COUNT(*) FROM bills WHERE status = 'active' AND date >= ? AND date <= ?", [r.from, r.to], 0);
  const total = PAYMENT_MODES.reduce((s, m) => s + modes[m].amount, 0);
  const totalRefunds = PAYMENT_MODES.reduce((s, m) => s + refunds[m], 0);
  const label: Record<PaymentMode, string> = { cash: 'Cash', upi: 'UPI', bank: 'Bank', credit: 'Credit (on account)' };
  const rows: ReportRow[] = PAYMENT_MODES.map((m) => ({
    cells: { mode: label[m], bills: modes[m].bills, amount: modes[m].amount, share: pct(modes[m].amount, total), refunds: refunds[m] || null, net: modes[m].amount - refunds[m] },
    style: modes[m].amount || refunds[m] ? undefined : ('muted' as const),
  }));
  rows.push({ cells: { mode: 'Total', bills: billCount, amount: total, share: total ? 100 : null, refunds: totalRefunds || null, net: total - totalRefunds }, style: 'total' });
  const summary: ReportData['summary'] = PAYMENT_MODES.map((m) => ({ label: PAYMENT_MODE_LABELS[m], value: modes[m].amount, type: 'money' as const }));
  return {
    report: {
      title: 'Sales by Payment Mode',
      subtitle: rangeSubtitle(r.from, r.to),
      columns: [
        { key: 'mode', label: 'Payment mode', width: 22 },
        { key: 'bills', label: 'Bills', type: 'number', width: 8 },
        { key: 'amount', label: 'Received at billing', type: 'money', width: 17 },
        { key: 'share', label: 'Share %', type: 'percent', width: 9 },
        { key: 'refunds', label: 'Refunds / credit notes', type: 'money', width: 17 },
        { key: 'net', label: 'Net', type: 'money', width: 15 },
      ],
      rows,
      summary,
      notes: [
        'Money received when the bill was made. "Credit" is the part of bills put on the customer\'s account; payments received later are in Customers > Payments received.',
        'A bill paid partly in cash and partly by UPI is counted under both modes, so the bill counts may add up to more than the total. Refunds in "Credit" were adjusted in the customer\'s account.',
      ],
    },
    chart: { labels: PAYMENT_MODES.map((m) => PAYMENT_MODE_LABELS[m]), series: [{ name: 'Received at billing', values: PAYMENT_MODES.map((m) => modes[m].amount) }] },
  };
}
