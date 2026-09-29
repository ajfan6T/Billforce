/**
 * Stock / inventory (optional; Settings > Stock).
 *
 * Quantities move with documents: bills take stock out, sales returns bring it
 * back, purchase lines that name an item bring it in at their cost, and stock
 * counts / adjustments correct it. The movements of a document are rewritten
 * when it is edited and removed when it is cancelled (the document itself keeps
 * its history). Only items with "Track stock" move stock, and only documents made
 * while stock tracking was on (stock_tracked), so turning tracking on later never
 * changes older bills.
 *
 * Value: see valuation.ts. The books use the periodic method: purchases stay an
 * expense; Profit & loss takes opening stock + purchases - closing stock as the
 * cost of goods sold, the balance sheet shows the stock in hand, and year-end
 * closing carries the closing stock into the "Stock in Hand" account. Opening
 * stock (on the books start date) is posted Dr Stock in Hand, Cr Opening Balance
 * Adjustment, like every other opening balance.
 */
import type { Ctx } from '../../context';
import { assertCan, can, currentUserId, now, today } from '../../context';
import { AppError, fail } from '../../errors';
import { listRevisions, logActivity, recordRevision } from '../../audit';
import { getSection } from '../../settings';
import { nextDocNumber } from '../../numbering';
import { assertDateOpen } from '../../accounting/periods';
import { ensureStockAccounts } from '../../seed';
import { getAccount, systemAccountId } from '../../accounting/ledger';
import { setAccountOpening } from '../accounting/chart';
import { openingLockedReason } from '../accounting/common';
import { resolveDocDate, userName } from '../customers/common';
import { formatINR, formatQty, lineAmount } from '../../../shared/money';
import { formatDate } from '../../../shared/dates';
import { itemStocks, roundStockQty, stockEnabled, stockOnHand, type ItemStock } from './valuation';

export type MoveKind = 'opening' | 'purchase' | 'sale' | 'sale_return' | 'adjustment';
export type MoveSource = 'opening' | 'bill' | 'credit_note' | 'purchase' | 'adjustment';

export interface MoveInput {
  itemId: number;
  /** + in, - out, in the item's unit. */
  qty: number;
  kind: MoveKind;
  /** Cost of goods coming in (paise); omit to value at the average cost. */
  value?: number | null;
  line?: number | null;
  note?: string | null;
}

/** Items (of these ids) whose stock is tracked. */
export function trackedItems(ctx: Ctx, ids: Array<number | null | undefined>): Set<number> {
  const list = [...new Set(ids.filter((x): x is number => !!x))];
  if (!list.length) return new Set();
  const rows = ctx.db.all<{ id: number }>(`SELECT id FROM items WHERE track_stock = 1 AND id IN (${list.map(Number).join(',')})`);
  return new Set(rows.map((r) => r.id));
}

/** Replace the stock movements of a document (only tracked items move stock). */
export function writeDocumentMoves(ctx: Ctx, sourceType: MoveSource, sourceId: number | null, date: string, moves: MoveInput[]): void {
  removeDocumentMoves(ctx, sourceType, sourceId);
  const tracked = trackedItems(
    ctx,
    moves.map((m) => m.itemId),
  );
  const at = now(ctx);
  for (const m of moves) {
    if (!tracked.has(m.itemId) || !m.qty) continue;
    ctx.db.insert('stock_moves', {
      item_id: m.itemId,
      date,
      qty: roundStockQty(m.qty),
      kind: m.kind,
      value: m.value ?? null,
      source_type: sourceType,
      source_id: sourceId,
      source_line: m.line ?? null,
      note: m.note ?? null,
      created_at: at,
    });
  }
}

export function removeDocumentMoves(ctx: Ctx, sourceType: MoveSource, sourceId: number | null): void {
  if (sourceId === null) ctx.db.run('DELETE FROM stock_moves WHERE source_type = ? AND source_id IS NULL', [sourceType]);
  else ctx.db.run('DELETE FROM stock_moves WHERE source_type = ? AND source_id = ?', [sourceType, sourceId]);
}

/**
 * "Only 3 pcs of Soap in stock" for items this document takes out beyond what is in stock
 * (selling is still allowed: the shop may have forgotten to enter a purchase).
 */
export function shortStockWarnings(
  ctx: Ctx,
  out: Array<{ itemId: number | null; qty: number }>,
  exclude?: { sourceType: MoveSource; sourceId: number } | null,
): string[] {
  const need = new Map<number, number>();
  for (const o of out) if (o.itemId && o.qty > 0) need.set(o.itemId, (need.get(o.itemId) ?? 0) + o.qty);
  const tracked = trackedItems(ctx, [...need.keys()]);
  if (!tracked.size) return [];
  const onHand = stockOnHand(ctx, [...tracked], exclude);
  const names = new Map(
    ctx.db.all<{ id: number; name: string; unit: string }>(`SELECT id, name, unit FROM items WHERE id IN (${[...tracked].join(',')})`).map((r) => [r.id, r]),
  );
  const warnings: string[] = [];
  for (const id of tracked) {
    const have = onHand.get(id) ?? 0;
    const want = roundStockQty(need.get(id)!);
    if (want <= have) continue;
    const it = names.get(id)!;
    warnings.push(
      have > 0
        ? `Only ${formatQty(have)} ${it.unit} of ${it.name} ${have === 1 ? 'is' : 'are'} in stock (this needs ${formatQty(want)}). Stock will go below zero; enter the purchase if goods came in.`
        : `${it.name} is out of stock (${formatQty(have)} ${it.unit}). Stock will go below zero; enter the purchase if goods came in.`,
    );
  }
  return warnings;
}

/** Make sure stock tracking is on (and the Stock in Hand account exists) before stock screens change anything. */
function assertStockOn(ctx: Ctx): void {
  if (!stockEnabled(ctx)) throw fail.validation('Stock tracking is off. Turn it on in Settings > Stock first.');
  ensureStockAccounts(ctx.db, now(ctx));
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

/** Units that are usually services, not goods on a shelf. */
const SERVICE_UNITS = new Set(['service', 'hour']);

/** New items are tracked when stock is on, except services. */
export function defaultTrackStock(ctx: Ctx, unit: string): boolean {
  return stockEnabled(ctx) && !SERVICE_UNITS.has(unit.toLowerCase());
}

/** Track stock for every active item that is not a service (Settings > Stock, when turning it on). */
export function trackAllItems(ctx: Ctx): { changed: number } {
  assertStockOn(ctx);
  const rows = ctx.db.all<{ id: number; unit: string }>('SELECT id, unit FROM items WHERE is_active = 1 AND track_stock = 0');
  const ids = rows.filter((r) => !SERVICE_UNITS.has(r.unit.toLowerCase())).map((r) => r.id);
  if (ids.length) ctx.db.run(`UPDATE items SET track_stock = 1, updated_at = ? WHERE id IN (${ids.join(',')})`, [now(ctx)]);
  logActivity(ctx, 'stock.track_all', `Started tracking stock for ${ids.length} item${ids.length === 1 ? '' : 's'}`, { entityType: 'stock', details: { items: ids.length } });
  return { changed: ids.length };
}

/* ------------------------------------------------------------------ */
/* Opening stock                                                       */
/* ------------------------------------------------------------------ */

export interface OpeningStockLine {
  itemId: number;
  name: string;
  unit: string;
  qty: number;
  /** Cost per unit in paise. */
  unitCost: number;
  value: number;
}

export interface OpeningStockView {
  date: string;
  lines: OpeningStockLine[];
  total: number;
  /** Opening stock can no longer change (the first year is closed). */
  lockedReason: string | null;
}

export function openingStock(ctx: Ctx): OpeningStockView {
  const date = getSection(ctx, 'accounts').booksStartDate;
  const moves = new Map(
    ctx.db
      .all<{ item_id: number; qty: number; value: number | null }>("SELECT item_id, qty, value FROM stock_moves WHERE kind = 'opening'")
      .map((m) => [m.item_id, m]),
  );
  const items = ctx.db.all<{ id: number; name: string; unit: string; track_stock: number }>(
    'SELECT id, name, unit, track_stock FROM items WHERE is_active = 1 OR id IN (SELECT item_id FROM stock_moves WHERE kind = \'opening\') ORDER BY name COLLATE NOCASE',
  );
  const lines = items
    .filter((i) => i.track_stock || moves.has(i.id))
    .map((i) => {
      const m = moves.get(i.id);
      const qty = m?.qty ?? 0;
      const value = m?.value ?? 0;
      return { itemId: i.id, name: i.name, unit: i.unit, qty, unitCost: qty > 0 ? Math.round(value / qty) : 0, value };
    });
  return { date, lines, total: lines.reduce((s, l) => s + l.value, 0), lockedReason: openingLockedReason(ctx) };
}

/** Save the opening stock (quantity and cost per unit of each item on the books start date). */
export function saveOpeningStock(ctx: Ctx, input: Array<{ itemId: number; qty: number; unitCost: number }>): OpeningStockView {
  assertCan(ctx, 'stock.manage', 'You are not allowed to change stock. Ask the owner for permission.');
  if (!can(ctx, 'accounts.manage')) {
    throw new AppError('FORBIDDEN', 'Opening stock is an opening balance of your books, so it needs "Journals, capital, drawings, loans, transfers". Ask the owner.');
  }
  assertStockOn(ctx);
  const locked = openingLockedReason(ctx);
  if (locked) throw fail.validation(locked);
  const date = getSection(ctx, 'accounts').booksStartDate;
  const before = openingStock(ctx);
  const seen = new Set<number>();
  const tracked = trackedItems(
    ctx,
    input.map((l) => l.itemId),
  );
  const moves: MoveInput[] = [];
  input.forEach((l, i) => {
    if (seen.has(l.itemId)) throw fail.validation(`Line ${i + 1}: the item is listed twice.`);
    seen.add(l.itemId);
    const name = ctx.db.value<string | null>('SELECT name FROM items WHERE id = ?', [l.itemId], null);
    if (!name) throw fail.validation(`Line ${i + 1}: the item was not found.`);
    if (!(l.qty >= 0) || Math.abs(Math.round(l.qty * 1000) - l.qty * 1000) > 1e-6) throw fail.validation(`Enter the quantity of ${name} (up to 3 decimals).`, { [`lines.${i}.qty`]: 'Invalid quantity' });
    if (!Number.isInteger(l.unitCost) || l.unitCost < 0) throw fail.validation(`Enter the cost price of ${name}.`, { [`lines.${i}.unitCost`]: 'Invalid cost' });
    if (!l.qty) return;
    if (!tracked.has(l.itemId)) throw fail.validation(`Stock is not tracked for ${name}. Turn on "Track stock" for it in Items first.`);
    if (!l.unitCost) throw fail.validation(`Enter the cost price of ${name}: opening stock is valued at cost.`, { [`lines.${i}.unitCost`]: 'Enter the cost' });
    moves.push({ itemId: l.itemId, qty: l.qty, kind: 'opening', value: lineAmount(l.qty, l.unitCost), line: i + 1 });
  });
  // Items left out of the input keep their opening stock.
  for (const old of before.lines) {
    if (!seen.has(old.itemId) && old.qty) moves.push({ itemId: old.itemId, qty: old.qty, kind: 'opening', value: old.value });
  }
  ctx.db.run("DELETE FROM stock_moves WHERE kind = 'opening'");
  const at = now(ctx);
  for (const m of moves) {
    ctx.db.insert('stock_moves', { item_id: m.itemId, date, qty: roundStockQty(m.qty), kind: 'opening', value: m.value, source_type: 'opening', source_id: null, source_line: m.line ?? null, created_at: at });
  }
  const total = moves.reduce((s, m) => s + (m.value ?? 0), 0);
  setAccountOpening(ctx, getAccount(ctx, systemAccountId(ctx, 'STOCK')), total, { stock: true });
  const after = openingStock(ctx);
  if (total !== before.total || after.lines.some((l, i) => l.qty !== before.lines[i]?.qty)) {
    logActivity(ctx, 'stock.opening', `Set opening stock on ${formatDate(date)}: ${moves.length} item${moves.length === 1 ? '' : 's'}, ${formatINR(total)} (was ${formatINR(before.total)})`, {
      entityType: 'stock',
      details: { before: before.lines.filter((l) => l.qty), after: after.lines.filter((l) => l.qty) },
    });
  }
  return after;
}

/* ------------------------------------------------------------------ */
/* Stock counts & adjustments                                          */
/* ------------------------------------------------------------------ */

export type AdjustmentKind = 'count' | 'adjust';

export interface AdjustmentLineInput {
  itemId: number;
  /** Stock count: the quantity found. */
  counted?: number | null;
  /** Adjustment: the change (+ added, - taken out). */
  qty?: number | null;
  /** Cost per unit (paise) of stock added; omit to use the average cost. */
  unitCost?: number | null;
  note?: string | null;
}

export interface AdjustmentInput {
  date?: string | null;
  kind: AdjustmentKind;
  reason?: string | null;
  lines: AdjustmentLineInput[];
}

export interface AdjustmentLine {
  lineNo: number;
  itemId: number;
  itemName: string;
  unit: string;
  counted: number | null;
  bookQty: number | null;
  qty: number;
  unitCost: number | null;
  note: string | null;
}

export interface AdjustmentDetail {
  id: number;
  adjNo: string;
  date: string;
  kind: AdjustmentKind;
  reason: string | null;
  status: 'active' | 'cancelled';
  lines: AdjustmentLine[];
  createdBy: string | null;
  createdAt: string;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  revisions: ReturnType<typeof listRevisions>;
}

interface AdjustmentRow {
  id: number;
  adj_no: string;
  date: string;
  kind: AdjustmentKind;
  reason: string | null;
  status: 'active' | 'cancelled';
  revision: number;
  created_by: number | null;
  created_at: string;
  cancelled_by: number | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

function adjustmentRow(ctx: Ctx, id: number): AdjustmentRow {
  const r = ctx.db.get<AdjustmentRow>('SELECT * FROM stock_adjustments WHERE id = ?', [id]);
  if (!r) throw fail.notFound('Stock adjustment');
  return r;
}

export function getAdjustment(ctx: Ctx, id: number): AdjustmentDetail {
  const r = adjustmentRow(ctx, id);
  const lines = ctx.db
    .all<{ line_no: number; item_id: number; name: string; unit: string; counted: number | null; book_qty: number | null; qty: number; unit_cost: number | null; note: string | null }>(
      `SELECT a.line_no, a.item_id, i.name, i.unit, a.counted, a.book_qty, a.qty, a.unit_cost, a.note
         FROM stock_adjustment_items a JOIN items i ON i.id = a.item_id WHERE a.adjustment_id = ? ORDER BY a.line_no`,
      [id],
    )
    .map((l) => ({ lineNo: l.line_no, itemId: l.item_id, itemName: l.name, unit: l.unit, counted: l.counted, bookQty: l.book_qty, qty: l.qty, unitCost: l.unit_cost, note: l.note }));
  return {
    id: r.id,
    adjNo: r.adj_no,
    date: r.date,
    kind: r.kind,
    reason: r.reason,
    status: r.status,
    lines,
    createdBy: userName(ctx, r.created_by),
    createdAt: r.created_at,
    cancelledBy: userName(ctx, r.cancelled_by),
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    revisions: listRevisions(ctx, 'stock_adjustment', id),
  };
}

const describeLine = (l: { itemName: string; qty: number; unit: string }) => `${l.itemName} ${l.qty > 0 ? '+' : ''}${formatQty(l.qty)} ${l.unit}`;

export function createAdjustment(ctx: Ctx, input: AdjustmentInput): AdjustmentDetail {
  assertCan(ctx, 'stock.manage', 'You are not allowed to change stock. Ask the owner for permission.');
  assertStockOn(ctx);
  const date = resolveDocDate(ctx, input.date, { what: 'A stock adjustment' });
  assertDateOpen(ctx, date, 'This stock adjustment');
  const reason = input.reason?.trim() || null;
  if (input.kind === 'adjust' && !reason) throw fail.validation('Write why the stock is changed (damaged, expired, own use, found ...).', { reason: 'Enter a reason' });
  if (!input.lines.length) throw fail.validation('Add at least one item.', { lines: 'Add an item' });
  const tracked = trackedItems(
    ctx,
    input.lines.map((l) => l.itemId),
  );
  const book = new Map(itemStocks(ctx, date, { itemIds: [...tracked] }).map((s) => [s.itemId, s.qty]));
  const seen = new Set<number>();
  const lines = input.lines.map((l, i) => {
    const it = ctx.db.get<{ id: number; name: string; unit: string }>('SELECT id, name, unit FROM items WHERE id = ?', [l.itemId]);
    if (!it) throw fail.validation(`Line ${i + 1}: the item was not found.`);
    if (!tracked.has(it.id)) throw fail.validation(`Stock is not tracked for ${it.name}. Turn on "Track stock" for it in Items first.`, { [`lines.${i}.itemId`]: 'Stock not tracked' });
    if (seen.has(it.id)) throw fail.validation(`${it.name} is listed twice.`, { [`lines.${i}.itemId`]: 'Listed twice' });
    seen.add(it.id);
    const q3 = (q: number) => Math.abs(Math.round(q * 1000) - q * 1000) < 1e-6;
    let counted: number | null = null;
    let bookQty: number | null = null;
    let qty: number;
    if (input.kind === 'count') {
      if (l.counted === null || l.counted === undefined || !(l.counted >= 0) || !q3(l.counted)) {
        throw fail.validation(`Enter the quantity of ${it.name} found (up to 3 decimals).`, { [`lines.${i}.counted`]: 'Enter the quantity' });
      }
      counted = roundStockQty(l.counted);
      bookQty = book.get(it.id) ?? 0;
      qty = roundStockQty(counted - bookQty);
    } else {
      if (!l.qty || !Number.isFinite(l.qty) || !q3(l.qty)) throw fail.validation(`Enter how much ${it.name} is added (+) or taken out (-).`, { [`lines.${i}.qty`]: 'Enter the change' });
      qty = roundStockQty(l.qty);
    }
    let unitCost: number | null = null;
    if (l.unitCost !== null && l.unitCost !== undefined && qty > 0) {
      if (!Number.isInteger(l.unitCost) || l.unitCost < 0) throw fail.validation(`Enter a valid cost price for ${it.name}.`, { [`lines.${i}.unitCost`]: 'Invalid cost' });
      unitCost = l.unitCost || null;
    }
    return { itemId: it.id, itemName: it.name, unit: it.unit, counted, bookQty, qty, unitCost, note: l.note?.trim() || null };
  });
  if (!lines.some((l) => l.qty !== 0)) {
    throw fail.validation(input.kind === 'count' ? 'The counted quantities are the same as in the books, so nothing needs to change.' : 'Nothing to change.');
  }
  const num = nextDocNumber(ctx, 'stock_adjustment', date);
  const id = ctx.db.insert('stock_adjustments', {
    adj_no: num.number,
    seq: num.seq,
    fy_start: num.fyStart,
    date,
    kind: input.kind,
    reason,
    status: 'active',
    revision: 1,
    created_by: currentUserId(ctx),
    created_at: now(ctx),
  });
  lines.forEach((l, i) => {
    ctx.db.insert('stock_adjustment_items', {
      adjustment_id: id,
      line_no: i + 1,
      item_id: l.itemId,
      counted: l.counted,
      book_qty: l.bookQty,
      qty: l.qty,
      unit_cost: l.unitCost,
      note: l.note,
    });
  });
  writeDocumentMoves(
    ctx,
    'adjustment',
    id,
    date,
    lines.map((l, i) => ({
      itemId: l.itemId,
      qty: l.qty,
      kind: 'adjustment' as const,
      value: l.unitCost && l.qty > 0 ? lineAmount(l.qty, l.unitCost) : null,
      line: i + 1,
      note: l.note ?? reason,
    })),
  );
  const detail = getAdjustment(ctx, id);
  recordRevision(ctx, 'stock_adjustment', id, 'created', detail);
  const changed = lines.filter((l) => l.qty !== 0);
  logActivity(
    ctx,
    input.kind === 'count' ? 'stock.count' : 'stock.adjust',
    `${input.kind === 'count' ? 'Stock count' : 'Stock adjustment'} ${num.number}: ${changed.slice(0, 3).map(describeLine).join(', ')}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}${reason ? `. Reason: ${reason}` : ''}`,
    { entityType: 'stock_adjustment', entityId: id, details: { kind: input.kind, lines: changed.length } },
  );
  return detail;
}

export function cancelAdjustment(ctx: Ctx, id: number, reason: string): AdjustmentDetail {
  assertCan(ctx, 'stock.manage', 'You are not allowed to change stock. Ask the owner for permission.');
  const r = adjustmentRow(ctx, id);
  if (r.status === 'cancelled') throw fail.validation(`${r.adj_no} is already cancelled.`);
  const why = reason.trim();
  if (!why) throw fail.validation('Enter the reason for cancelling.', { reason: 'Enter a reason' });
  assertDateOpen(ctx, r.date, 'This stock adjustment');
  ctx.db.update('stock_adjustments', id, { status: 'cancelled', revision: r.revision + 1, cancelled_by: currentUserId(ctx), cancelled_at: now(ctx), cancel_reason: why });
  removeDocumentMoves(ctx, 'adjustment', id);
  const detail = getAdjustment(ctx, id);
  recordRevision(ctx, 'stock_adjustment', id, 'cancelled', detail, why);
  logActivity(ctx, 'stock.adjust_cancel', `Cancelled ${r.kind === 'count' ? 'stock count' : 'stock adjustment'} ${r.adj_no}: ${why}`, {
    entityType: 'stock_adjustment',
    entityId: id,
    details: { reason: why },
  });
  return detail;
}

export interface AdjustmentListRow {
  id: number;
  adjNo: string;
  date: string;
  kind: AdjustmentKind;
  reason: string | null;
  items: string;
  status: 'active' | 'cancelled';
  createdBy: string | null;
}

export function listAdjustments(ctx: Ctx, q: { from: string; to: string }): AdjustmentListRow[] {
  const rows = ctx.db.all<AdjustmentRow>('SELECT * FROM stock_adjustments WHERE date BETWEEN ? AND ? ORDER BY date DESC, id DESC LIMIT 2000', [q.from, q.to]);
  return rows.map((r) => {
    const lines = ctx.db.all<{ name: string; qty: number; unit: string }>(
      'SELECT i.name, a.qty, i.unit FROM stock_adjustment_items a JOIN items i ON i.id = a.item_id WHERE a.adjustment_id = ? AND a.qty <> 0 ORDER BY a.line_no',
      [r.id],
    );
    return {
      id: r.id,
      adjNo: r.adj_no,
      date: r.date,
      kind: r.kind,
      reason: r.reason,
      items: `${lines.slice(0, 3).map((l) => describeLine({ itemName: l.name, qty: l.qty, unit: l.unit })).join(', ')}${lines.length > 3 ? ` +${lines.length - 3} more` : ''}`,
      status: r.status,
      createdBy: userName(ctx, r.created_by),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Stock levels for screens                                            */
/* ------------------------------------------------------------------ */

/** Active tracked items that are low, out of stock or below zero (for alerts). */
export function lowStockItems(ctx: Ctx): ItemStock[] {
  if (!stockEnabled(ctx)) return [];
  return itemStocks(ctx, today(ctx)).filter((s) => s.isActive && s.status !== 'ok');
}
