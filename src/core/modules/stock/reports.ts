/**
 * Stock reports: stock summary (quantity and value of every item as on a date)
 * and the stock history of one item (every movement with the running balance).
 */
import type { Ctx } from '../../context';
import { fail } from '../../errors';
import { addDays, formatDate } from '../../../shared/dates';
import type { ReportData, ReportRow } from '../../../shared/report';
import { formatQty } from '../../../shared/money';
import { assertRange, rangeSubtitle } from '../reports/common';
import { itemStocks, roundStockQty, type ItemStock } from './valuation';

const STATUS_LABEL: Record<ItemStock['status'], string> = { ok: 'In stock', low: 'Low', out: 'Out of stock', negative: 'Below zero' };

export type StockFilter = 'all' | 'low' | 'out';

export interface StockSummaryResult {
  report: ReportData;
  items: ItemStock[];
  totals: { items: number; value: number; low: number; out: number; negative: number; noCost: number };
}

export function stockSummary(ctx: Ctx, input: { asOf: string; filter?: StockFilter; q?: string | null; includeInactive?: boolean }): StockSummaryResult {
  // Items no longer tracked show while they still have stock on the date.
  const all = itemStocks(ctx, input.asOf).filter((s) => (s.tracked || s.qty !== 0) && (input.includeInactive || s.isActive || s.qty !== 0));
  const text = input.q?.trim().toLowerCase();
  const filter = input.filter ?? 'all';
  const items = all.filter(
    (s) =>
      (!text || s.name.toLowerCase().includes(text) || (s.category ?? '').toLowerCase().includes(text)) &&
      (filter === 'all' || (filter === 'low' ? s.status === 'low' || s.status === 'out' || s.status === 'negative' : s.status === 'out' || s.status === 'negative')),
  );
  const totals = {
    items: all.length,
    value: all.reduce((s, i) => s + i.value, 0),
    low: all.filter((s) => s.status === 'low').length,
    out: all.filter((s) => s.status === 'out').length,
    negative: all.filter((s) => s.status === 'negative').length,
    noCost: all.filter((s) => s.qty > 0 && !s.costKnown).length,
  };
  const rows: ReportRow[] = items.map((s) => ({
    cells: {
      item: s.name,
      category: s.category ?? '',
      qty: s.qty,
      unit: s.unit,
      reorder: s.reorderLevel,
      avgCost: s.costKnown ? Math.round(s.avgCost) : null,
      value: s.value,
      status: STATUS_LABEL[s.status],
    },
    link: { kind: 'stock_item', id: s.itemId },
    style: s.status === 'negative' || s.status === 'out' ? 'muted' : 'normal',
  }));
  rows.push({ cells: { item: 'Total', value: items.reduce((s, i) => s + i.value, 0) }, style: 'total' });
  const notes = [
    'Value = quantity x average purchase cost (opening stock and purchases up to the date). Items below zero are valued at nothing.',
  ];
  if (totals.noCost) notes.push(`${totals.noCost} item${totals.noCost === 1 ? ' has' : 's have'} stock but no cost yet (no purchase or opening stock with a cost), so ${totals.noCost === 1 ? 'it is' : 'they are'} valued at nothing.`);
  if (totals.negative) notes.push('Stock below zero usually means a purchase was not entered, or a stock count is due.');
  return {
    items,
    totals,
    report: {
      title: filter === 'low' ? 'Low stock' : filter === 'out' ? 'Out of stock' : 'Stock summary',
      subtitle: `As on ${formatDate(input.asOf)}`,
      columns: [
        { key: 'item', label: 'Item', width: 30 },
        { key: 'category', label: 'Category', width: 14 },
        { key: 'qty', label: 'In stock', type: 'qty', width: 11 },
        { key: 'unit', label: 'Unit', width: 7 },
        { key: 'reorder', label: 'Low at', type: 'qty', width: 9 },
        { key: 'avgCost', label: 'Avg cost', type: 'money', width: 12 },
        { key: 'value', label: 'Value', type: 'money', width: 14 },
        { key: 'status', label: 'Status', width: 12 },
      ],
      rows,
      summary: [
        { label: 'Items tracked', value: totals.items, type: 'number' },
        { label: 'Stock value', value: totals.value, type: 'money' },
        { label: 'Low stock', value: totals.low, type: 'number' },
        { label: 'Out of stock', value: totals.out + totals.negative, type: 'number' },
      ],
      notes,
    },
  };
}

const KIND_LABEL: Record<string, string> = {
  opening: 'Opening stock',
  purchase: 'Purchase',
  sale: 'Sale',
  sale_return: 'Sales return',
  adjustment: 'Adjustment',
};

export interface ItemStockLedger {
  report: ReportData;
  item: { id: number; name: string; unit: string; trackStock: boolean; reorderLevel: number | null };
  opening: number;
  closing: number;
  stockNow: ItemStock | null;
}

/** Every movement of one item in a period, with the running quantity. */
export function itemStockLedger(ctx: Ctx, input: { itemId: number; from: string; to: string }): ItemStockLedger {
  assertRange(input.from, input.to);
  const it = ctx.db.get<{ id: number; name: string; unit: string; track_stock: number; reorder_level: number | null }>(
    'SELECT id, name, unit, track_stock, reorder_level FROM items WHERE id = ?',
    [input.itemId],
  );
  if (!it) throw fail.notFound('Item');
  const opening = roundStockQty(
    ctx.db.value<number>("SELECT COALESCE(SUM(qty), 0) FROM stock_moves WHERE item_id = ? AND (kind = 'opening' OR date < ?)", [it.id, input.from], 0),
  );
  const moves = ctx.db.all<{ id: number; date: string; qty: number; kind: string; value: number | null; source_type: string; source_id: number | null; note: string | null; doc_no: string | null }>(
    `SELECT m.id, m.date, m.qty, m.kind, m.value, m.source_type, m.source_id, m.note,
            CASE m.source_type
              WHEN 'bill' THEN (SELECT bill_no FROM bills WHERE id = m.source_id)
              WHEN 'credit_note' THEN (SELECT cn_no FROM credit_notes WHERE id = m.source_id)
              WHEN 'purchase' THEN (SELECT purchase_no FROM purchases WHERE id = m.source_id)
              WHEN 'adjustment' THEN (SELECT adj_no FROM stock_adjustments WHERE id = m.source_id)
            END AS doc_no
       FROM stock_moves m WHERE m.item_id = ? AND m.kind <> 'opening' AND m.date BETWEEN ? AND ? ORDER BY m.date, m.id`,
    [it.id, input.from, input.to],
  );
  let bal = opening;
  let totalIn = 0;
  let totalOut = 0;
  const rows: ReportRow[] = [{ cells: { date: input.from, particulars: 'Opening stock', in: null, out: null, balance: opening }, style: 'subtotal' }];
  for (const m of moves) {
    bal = roundStockQty(bal + m.qty);
    if (m.qty > 0) totalIn += m.qty;
    else totalOut += -m.qty;
    rows.push({
      cells: {
        date: m.date,
        particulars: `${KIND_LABEL[m.kind] ?? m.kind}${m.doc_no ? ` ${m.doc_no}` : ''}${m.note ? ` (${m.note})` : ''}`,
        in: m.qty > 0 ? m.qty : null,
        out: m.qty < 0 ? -m.qty : null,
        balance: bal,
      },
      ...(m.source_id && m.source_type !== 'opening' ? { link: { kind: m.source_type === 'adjustment' ? 'stock_adjustment' : m.source_type, id: m.source_id } } : {}),
    });
  }
  rows.push({ cells: { date: input.to, particulars: 'Closing stock', in: roundStockQty(totalIn), out: roundStockQty(totalOut), balance: bal }, style: 'total' });
  const now = itemStocks(ctx, addDays(input.to, 0), { itemIds: [it.id], includeUntracked: true })[0] ?? null;
  return {
    item: { id: it.id, name: it.name, unit: it.unit, trackStock: !!it.track_stock, reorderLevel: it.reorder_level },
    opening,
    closing: bal,
    stockNow: now,
    report: {
      title: `Stock of ${it.name}`,
      subtitle: `${rangeSubtitle(input.from, input.to)} · in ${it.unit}`,
      columns: [
        { key: 'date', label: 'Date', type: 'date', width: 11 },
        { key: 'particulars', label: 'Particulars', width: 40 },
        { key: 'in', label: 'In', type: 'qty', width: 10 },
        { key: 'out', label: 'Out', type: 'qty', width: 10 },
        { key: 'balance', label: 'Balance', type: 'qty', width: 11 },
      ],
      rows,
      summary: [
        { label: 'Opening', value: `${formatQty(opening)} ${it.unit}`, type: 'text' },
        { label: 'In', value: `${formatQty(roundStockQty(totalIn))} ${it.unit}`, type: 'text' },
        { label: 'Out', value: `${formatQty(roundStockQty(totalOut))} ${it.unit}`, type: 'text' },
        { label: 'Closing', value: `${formatQty(bal)} ${it.unit}`, type: 'text' },
      ],
    },
  };
}
