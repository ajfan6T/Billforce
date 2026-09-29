/**
 * GST summaries for filing returns (made by hand or by an accountant on the
 * GST portal; nothing is uploaded from here). They read the documents: only
 * active bills / returns / purchases made with GST count (gst_mode), so bills
 * from before registering, and unregistered periods, are left out.
 *
 *   GST summary        output tax (bills - returns), input tax credit (purchases), net tax    ~ GSTR-3B
 *   Sales register     every tax invoice and credit note, B2B (customer GSTIN) or B2C         ~ GSTR-1
 *   HSN summary        sales by HSN code and rate, net of returns                             ~ GSTR-1 table 12
 *   Purchase register  every purchase with GST, and whether its credit was claimed          ~ GSTR-2B check
 *   Composition        turnover and tax on it for businesses in the composition scheme       ~ CMP-08
 */
import type { Ctx } from '../../context';
import { fail } from '../../errors';
import { formatDate } from '../../../shared/dates';
import { formatRate, stateLabel } from '../../../shared/gst';
import type { ReportColumn, ReportData, ReportRow } from '../../../shared/report';
import { assertRange, rangeSubtitle } from '../reports/common';
import { gstConfig } from './common';

export interface GstRange {
  from: string;
  to: string;
}

interface Heads {
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
}

const zero = (): Heads => ({ taxable: 0, cgst: 0, sgst: 0, igst: 0 });
const taxOf = (h: Heads) => h.cgst + h.sgst + h.igst;
const minus = (a: Heads, b: Heads): Heads => ({ taxable: a.taxable - b.taxable, cgst: a.cgst - b.cgst, sgst: a.sgst - b.sgst, igst: a.igst - b.igst });

const TAX_COLUMNS: ReportColumn[] = [
  { key: 'taxable', label: 'Taxable value', type: 'money', width: 14 },
  { key: 'cgst', label: 'CGST', type: 'money', width: 12 },
  { key: 'sgst', label: 'SGST', type: 'money', width: 12 },
  { key: 'igst', label: 'IGST', type: 'money', width: 12 },
  { key: 'tax', label: 'Total tax', type: 'money', width: 12 },
];

const taxCells = (h: Heads) => ({ taxable: h.taxable, cgst: h.cgst, sgst: h.sgst, igst: h.igst, tax: taxOf(h) });

function checkRange(r: GstRange): void {
  assertRange(r.from, r.to);
}

function registrationNote(ctx: Ctx): string[] {
  const cfg = gstConfig(ctx);
  return cfg.gstin ? [`GSTIN ${cfg.gstin}${cfg.stateCode ? `, ${stateLabel(cfg.stateCode)}` : ''}.`] : [];
}

/* ------------------------------ Sums ------------------------------ */

function billSums(ctx: Ctx, r: GstRange, b2b: boolean | null): Heads & { count: number } {
  const who = b2b === null ? '' : b2b ? " AND COALESCE(customer_gstin, '') <> ''" : " AND COALESCE(customer_gstin, '') = ''";
  return ctx.db.get<Heads & { count: number }>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(taxable_total), 0) AS taxable, COALESCE(SUM(cgst), 0) AS cgst,
            COALESCE(SUM(sgst), 0) AS sgst, COALESCE(SUM(igst), 0) AS igst
       FROM bills WHERE status = 'active' AND gst_mode = 'regular' AND date BETWEEN ? AND ?${who}`,
    [r.from, r.to],
  )!;
}

function returnSums(ctx: Ctx, r: GstRange): Heads & { count: number } {
  return ctx.db.get<Heads & { count: number }>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(n.taxable_total), 0) AS taxable, COALESCE(SUM(n.cgst), 0) AS cgst,
            COALESCE(SUM(n.sgst), 0) AS sgst, COALESCE(SUM(n.igst), 0) AS igst
       FROM credit_notes n JOIN bills b ON b.id = n.bill_id
      WHERE n.status = 'active' AND b.gst_mode = 'regular' AND n.taxable_total IS NOT NULL AND n.date BETWEEN ? AND ?`,
    [r.from, r.to],
  )!;
}

function purchaseSums(ctx: Ctx, r: GstRange, itc: boolean): Heads & { count: number } {
  return ctx.db.get<Heads & { count: number }>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(taxable_total), 0) AS taxable, COALESCE(SUM(cgst), 0) AS cgst,
            COALESCE(SUM(sgst), 0) AS sgst, COALESCE(SUM(igst), 0) AS igst
       FROM purchases WHERE status = 'active' AND gst_mode = 'regular' AND itc = ? AND date BETWEEN ? AND ?`,
    [itc ? 1 : 0, r.from, r.to],
  )!;
}

export interface GstPeriodTotals {
  output: Heads;
  input: Heads;
  /** Output less input, head by head (may be negative: credit left over). */
  net: Heads;
}

export function gstPeriodTotals(ctx: Ctx, r: GstRange): GstPeriodTotals {
  const output = minus(billSums(ctx, r, null), returnSums(ctx, r));
  const input = purchaseSums(ctx, r, true);
  return { output, input: { taxable: input.taxable, cgst: input.cgst, sgst: input.sgst, igst: input.igst }, net: minus(output, input) };
}

/* ------------------------------ GST summary ------------------------------ */

export function gstSummary(ctx: Ctx, r: GstRange): ReportData {
  checkRange(r);
  const b2b = billSums(ctx, r, true);
  const b2c = billSums(ctx, r, false);
  const returns = returnSums(ctx, r);
  const sales = { taxable: b2b.taxable + b2c.taxable, cgst: b2b.cgst + b2c.cgst, sgst: b2b.sgst + b2c.sgst, igst: b2b.igst + b2c.igst };
  const output = minus(sales, returns);
  const withItc = purchaseSums(ctx, r, true);
  const withoutItc = purchaseSums(ctx, r, false);
  const net = minus(output, withItc);
  const rows: ReportRow[] = [
    { cells: { particulars: 'Tax on sales (output tax)' }, style: 'section' },
    { cells: { particulars: `Sales to registered businesses (B2B, ${b2b.count} bills)`, ...taxCells(b2b) }, indent: 1 },
    { cells: { particulars: `Sales to others (B2C, ${b2c.count} bills)`, ...taxCells(b2c) }, indent: 1 },
    { cells: { particulars: `Less: sales returns (${returns.count} credit notes)`, ...taxCells({ taxable: -returns.taxable, cgst: -returns.cgst, sgst: -returns.sgst, igst: -returns.igst }) }, indent: 1 },
    { cells: { particulars: 'Output tax', ...taxCells(output) }, style: 'subtotal' },
    { cells: { particulars: 'Tax on purchases (input tax credit)' }, style: 'section' },
    { cells: { particulars: `Purchases with GST credit claimed (${withItc.count} bills)`, ...taxCells(withItc) }, indent: 1 },
    { cells: { particulars: 'Input tax credit', ...taxCells(withItc) }, style: 'subtotal' },
    { cells: { particulars: 'Output tax less input tax credit', ...taxCells(net), taxable: null }, style: 'total' },
  ];
  if (withoutItc.count) {
    rows.push({ cells: { particulars: `Not claimed: purchases without GST credit (${withoutItc.count} bills; the tax is part of their cost)`, ...taxCells(withoutItc) }, style: 'muted' });
  }
  const netTax = taxOf(net);
  return {
    title: 'GST summary',
    subtitle: rangeSubtitle(r.from, r.to),
    columns: [{ key: 'particulars', label: 'Particulars', width: 46 }, ...TAX_COLUMNS],
    rows,
    summary: [
      { label: 'Output tax', value: taxOf(output), type: 'money' },
      { label: 'Input tax credit', value: taxOf(withItc), type: 'money' },
      { label: netTax >= 0 ? 'Tax payable (before earlier credit)' : 'Credit left over', value: Math.abs(netTax), type: 'money' },
    ],
    notes: [
      ...registrationNote(ctx),
      'Returns are counted on the date of the return. CGST credit cannot be used for SGST (or the other way round); "Pay GST" in Accounts sets off the credit in the legal order and shows what is left to pay, including credit carried forward from earlier months.',
      'Bills made before the business registered for GST, and bills of supply under the composition scheme, are not included.',
    ],
  };
}

/* ------------------------------ Sales register ------------------------------ */

export function gstSalesRegister(ctx: Ctx, r: GstRange & { kind?: 'all' | 'b2b' | 'b2c' }): ReportData {
  checkRange(r);
  const kind = r.kind ?? 'all';
  const who = kind === 'b2b' ? " AND COALESCE(b.customer_gstin, '') <> ''" : kind === 'b2c' ? " AND COALESCE(b.customer_gstin, '') = ''" : '';
  const bills = ctx.db.all<Heads & { id: number; date: string; no: string; customer: string | null; gstin: string | null; pos: string | null; total: number }>(
    `SELECT b.id, b.date, b.bill_no AS no, b.customer_name AS customer, b.customer_gstin AS gstin, b.place_of_supply AS pos,
            COALESCE(b.taxable_total, 0) AS taxable, b.cgst, b.sgst, b.igst, b.total
       FROM bills b WHERE b.status = 'active' AND b.gst_mode = 'regular' AND b.date BETWEEN ? AND ?${who}`,
    [r.from, r.to],
  );
  const notes = ctx.db.all<Heads & { id: number; date: string; no: string; customer: string | null; gstin: string | null; pos: string | null; total: number; bill_no: string }>(
    `SELECT n.id, n.date, n.cn_no AS no, n.customer_name AS customer, b.customer_gstin AS gstin, b.place_of_supply AS pos, b.bill_no,
            COALESCE(n.taxable_total, 0) AS taxable, n.cgst, n.sgst, n.igst, n.total
       FROM credit_notes n JOIN bills b ON b.id = n.bill_id
      WHERE n.status = 'active' AND b.gst_mode = 'regular' AND n.taxable_total IS NOT NULL AND n.date BETWEEN ? AND ?${who}`,
    [r.from, r.to],
  );
  type Line = { sort: string; row: ReportRow; heads: Heads; total: number };
  const lines: Line[] = [
    ...bills.map((b) => ({
      sort: `${b.date}|0|${b.no}`,
      heads: b,
      total: b.total,
      row: {
        cells: {
          date: b.date,
          no: b.no,
          type: 'Invoice',
          customer: b.customer ?? 'Walk-in',
          gstin: b.gstin ?? '',
          b2b: b.gstin ? 'B2B' : 'B2C',
          pos: stateLabel(b.pos),
          ...taxCells(b),
          total: b.total,
        },
        link: { kind: 'bill', id: b.id },
      } as ReportRow,
    })),
    ...notes.map((n) => {
      const neg = { taxable: -n.taxable, cgst: -n.cgst, sgst: -n.sgst, igst: -n.igst };
      return {
        sort: `${n.date}|1|${n.no}`,
        heads: neg,
        total: -n.total,
        row: {
          cells: {
            date: n.date,
            no: n.no,
            type: `Credit note (${n.bill_no})`,
            customer: n.customer ?? 'Walk-in',
            gstin: n.gstin ?? '',
            b2b: n.gstin ? 'B2B' : 'B2C',
            pos: stateLabel(n.pos),
            ...taxCells(neg),
            total: -n.total,
          },
          link: { kind: 'credit_note', id: n.id },
        } as ReportRow,
      };
    }),
  ].sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  const sum = lines.reduce((s, l) => ({ taxable: s.taxable + l.heads.taxable, cgst: s.cgst + l.heads.cgst, sgst: s.sgst + l.heads.sgst, igst: s.igst + l.heads.igst }), zero());
  const total = lines.reduce((s, l) => s + l.total, 0);
  const rows = lines.map((l) => l.row);
  rows.push({ cells: { date: null, no: 'Total', ...taxCells(sum), total }, style: 'total' });
  return {
    title: kind === 'b2b' ? 'GST sales register (B2B)' : kind === 'b2c' ? 'GST sales register (B2C)' : 'GST sales register',
    subtitle: rangeSubtitle(r.from, r.to),
    landscape: true,
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 11 },
      { key: 'no', label: 'Number', width: 16, nowrap: true },
      { key: 'type', label: 'Type', width: 14 },
      { key: 'customer', label: 'Customer', width: 22 },
      { key: 'gstin', label: 'GSTIN', width: 17, nowrap: true },
      { key: 'b2b', label: 'B2B / B2C', width: 8 },
      { key: 'pos', label: 'Place of supply', width: 16 },
      ...TAX_COLUMNS,
      { key: 'total', label: 'Invoice value', type: 'money', width: 13 },
    ],
    rows,
    summary: [
      { label: 'Invoices', value: bills.length, type: 'number' },
      { label: 'Credit notes', value: notes.length, type: 'number' },
      { label: 'Taxable value', value: sum.taxable, type: 'money' },
      { label: 'Total tax', value: taxOf(sum), type: 'money' },
    ],
    notes: [...registrationNote(ctx), 'Credit notes (sales returns) are shown as minus figures on the date of the return.'],
  };
}

/* ------------------------------ HSN summary ------------------------------ */

export function hsnSummary(ctx: Ctx, r: GstRange): ReportData {
  checkRange(r);
  const rows = ctx.db.all<Heads & { hsn: string | null; rate: number; unit: string | null; qty: number; name: string; names: number }>(
    `SELECT hsn, rate, unit, SUM(qty) AS qty, MIN(name) AS name, COUNT(DISTINCT name) AS names,
            SUM(taxable) AS taxable, SUM(cgst) AS cgst, SUM(sgst) AS sgst, SUM(igst) AS igst
       FROM (
         SELECT i.hsn, COALESCE(i.gst_rate, 0) AS rate, i.unit, i.qty, i.item_name AS name, COALESCE(i.taxable, 0) AS taxable, i.cgst, i.sgst, i.igst
           FROM bill_items i JOIN bills b ON b.id = i.bill_id
          WHERE b.status = 'active' AND b.gst_mode = 'regular' AND b.date BETWEEN :from AND :to
         UNION ALL
         SELECT bi.hsn, COALESCE(ci.gst_rate, 0), ci.unit, -ci.qty, ci.item_name, -COALESCE(ci.taxable, 0), -ci.cgst, -ci.sgst, -ci.igst
           FROM credit_note_items ci JOIN credit_notes n ON n.id = ci.credit_note_id
           JOIN bill_items bi ON bi.id = ci.bill_item_id JOIN bills b ON b.id = n.bill_id
          WHERE n.status = 'active' AND b.gst_mode = 'regular' AND ci.taxable IS NOT NULL AND n.date BETWEEN :from AND :to
       )
      GROUP BY COALESCE(hsn, ''), rate, COALESCE(unit, '')
      ORDER BY COALESCE(hsn, 'ZZZZ'), rate, unit`,
    { from: r.from, to: r.to },
  );
  const sum = rows.reduce((s, l) => ({ taxable: s.taxable + l.taxable, cgst: s.cgst + l.cgst, sgst: s.sgst + l.sgst, igst: s.igst + l.igst }), zero());
  const missing = rows.filter((x) => !x.hsn).length;
  const out: ReportRow[] = rows.map((x) => ({
    cells: {
      hsn: x.hsn ?? 'No HSN',
      description: x.names > 1 ? `${x.name} and others` : x.name,
      unit: x.unit ?? '',
      qty: Math.round(x.qty * 1000) / 1000,
      rate: x.rate,
      ...taxCells(x),
      value: x.taxable + taxOf(x),
    },
    style: x.hsn ? 'normal' : 'muted',
  }));
  out.push({ cells: { hsn: 'Total', ...taxCells(sum), value: sum.taxable + taxOf(sum) }, style: 'total' });
  return {
    title: 'HSN summary of sales',
    subtitle: rangeSubtitle(r.from, r.to),
    landscape: true,
    columns: [
      { key: 'hsn', label: 'HSN / SAC', width: 10, nowrap: true },
      { key: 'description', label: 'Description', width: 26 },
      { key: 'unit', label: 'Unit', width: 7 },
      { key: 'qty', label: 'Quantity', type: 'qty', width: 10 },
      { key: 'rate', label: 'GST %', type: 'percent', width: 7 },
      ...TAX_COLUMNS,
      { key: 'value', label: 'Total value', type: 'money', width: 13 },
    ],
    rows: out,
    notes: [
      ...registrationNote(ctx),
      'Net of sales returns. HSN codes come from the item list at the time of billing.',
      ...(missing ? [`${missing} line${missing === 1 ? ' has' : 's have'} no HSN code. Add HSN codes to your items in Sales > Items.`] : []),
    ],
  };
}

/* ------------------------------ Purchase register ------------------------------ */

export function gstPurchaseRegister(ctx: Ctx, r: GstRange): ReportData {
  checkRange(r);
  const list = ctx.db.all<Heads & { id: number; date: string; no: string; supplier: string | null; gstin: string | null; bill_no: string | null; bill_date: string | null; itc: number; total: number }>(
    `SELECT id, date, purchase_no AS no, supplier_name AS supplier, supplier_gstin AS gstin, supplier_bill_no AS bill_no, supplier_bill_date AS bill_date,
            itc, COALESCE(taxable_total, 0) AS taxable, cgst, sgst, igst, total
       FROM purchases WHERE status = 'active' AND gst_mode = 'regular' AND date BETWEEN ? AND ? ORDER BY date, id`,
    [r.from, r.to],
  );
  const claimed = zero();
  const all = zero();
  let total = 0;
  const rows: ReportRow[] = list.map((p) => {
    for (const k of ['taxable', 'cgst', 'sgst', 'igst'] as const) {
      all[k] += p[k];
      if (p.itc) claimed[k] += p[k];
    }
    total += p.total;
    return {
      cells: {
        date: p.date,
        no: p.no,
        supplier: p.supplier ?? 'Cash purchase',
        gstin: p.gstin ?? '',
        billNo: p.bill_no ?? '',
        billDate: p.bill_date,
        ...taxCells(p),
        total: p.total,
        itc: p.itc ? 'Yes' : 'No',
      },
      link: { kind: 'purchase', id: p.id },
      style: p.itc ? 'normal' : 'muted',
    };
  });
  rows.push({ cells: { date: null, no: 'Total', ...taxCells(all), total }, style: 'total' });
  rows.push({ cells: { date: null, no: 'Credit claimed', ...taxCells(claimed) }, style: 'subtotal' });
  return {
    title: 'GST purchase register',
    subtitle: rangeSubtitle(r.from, r.to),
    landscape: true,
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 11 },
      { key: 'no', label: 'Number', width: 16, nowrap: true },
      { key: 'supplier', label: 'Supplier', width: 22 },
      { key: 'gstin', label: 'GSTIN', width: 17, nowrap: true },
      { key: 'billNo', label: 'Supplier bill', width: 12, nowrap: true },
      { key: 'billDate', label: 'Bill date', type: 'date', width: 11 },
      ...TAX_COLUMNS,
      { key: 'total', label: 'Bill value', type: 'money', width: 13 },
      { key: 'itc', label: 'Credit claimed', width: 8 },
    ],
    rows,
    summary: [
      { label: 'Purchase bills', value: list.length, type: 'number' },
      { label: 'GST paid', value: taxOf(all), type: 'money' },
      { label: 'Input tax credit claimed', value: taxOf(claimed), type: 'money' },
    ],
    notes: [
      ...registrationNote(ctx),
      'Check the credit claimed against GSTR-2B on the GST portal: credit counts only for bills your suppliers have filed.',
    ],
  };
}

/* ------------------------------ Composition ------------------------------ */

export interface CompositionTotals {
  bills: number;
  billed: number;
  returns: number;
  turnover: number;
  rate: number;
  cgst: number;
  sgst: number;
  tax: number;
}

export function compositionTotals(ctx: Ctx, r: GstRange): CompositionTotals {
  const billed = ctx.db.get<{ n: number; total: number }>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM bills WHERE status = 'active' AND gst_mode = 'composition' AND date BETWEEN ? AND ?",
    [r.from, r.to],
  )!;
  const returns = ctx.db.value<number>(
    `SELECT COALESCE(SUM(n.total), 0) FROM credit_notes n JOIN bills b ON b.id = n.bill_id
      WHERE n.status = 'active' AND b.gst_mode = 'composition' AND n.date BETWEEN ? AND ?`,
    [r.from, r.to],
    0,
  );
  const rate = gstConfig(ctx).compositionRate;
  const turnover = Math.max(0, billed.total - returns);
  // Half is central tax and half state tax, each rounded to the rupee as paid on the portal.
  const half = Math.round((turnover * rate) / 200 / 100) * 100;
  return { bills: billed.n, billed: billed.total, returns, turnover, rate, cgst: half, sgst: half, tax: 2 * half };
}

export function compositionSummary(ctx: Ctx, r: GstRange): ReportData {
  checkRange(r);
  const t = compositionTotals(ctx, r);
  return {
    title: 'Composition scheme: turnover and tax',
    subtitle: rangeSubtitle(r.from, r.to),
    columns: [
      { key: 'particulars', label: 'Particulars', width: 40 },
      { key: 'amount', label: 'Amount', type: 'money', width: 16 },
    ],
    rows: [
      { cells: { particulars: `Sales (${t.bills} bills of supply)`, amount: t.billed } },
      { cells: { particulars: 'Less: sales returns', amount: -t.returns } },
      { cells: { particulars: 'Turnover', amount: t.turnover }, style: 'subtotal' },
      { cells: { particulars: `Central tax (CGST) @ ${formatRate(t.rate / 2)}`, amount: t.cgst } },
      { cells: { particulars: `State tax (SGST) @ ${formatRate(t.rate / 2)}`, amount: t.sgst } },
      { cells: { particulars: `Tax payable @ ${formatRate(t.rate)} of turnover`, amount: t.tax }, style: 'total' },
    ],
    summary: [
      { label: 'Turnover', value: t.turnover, type: 'money' },
      { label: 'Tax payable', value: t.tax, type: 'money' },
    ],
    notes: [
      ...registrationNote(ctx),
      'Composition tax is paid from your own money (it cannot be collected from customers), each quarter with CMP-08. Record the payment with "Pay GST" in Accounts.',
    ],
  };
}

/** "GST for 01-07-2026 to 30-09-2026" */
export function periodText(r: GstRange): string {
  return `${formatDate(r.from)} to ${formatDate(r.to)}`;
}

export function assertGstBusiness(ctx: Ctx): void {
  if (gstConfig(ctx).mode === 'none') throw fail.validation('The business is not registered for GST. Turn GST on in Settings > GST first.');
}

