import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance, type TestApp } from './helpers';

let t: TestApp;
afterEach(() => t?.close());

async function stockOn(t: TestApp) {
  await t.call('settings.update', { section: 'stock', values: { enabled: true } });
}

async function item(t: TestApp, name: string, rate: number, extra: Record<string, unknown> = {}) {
  return t.call('items.create', { name, unit: 'pcs', rate, ...extra });
}

const qtyOf = async (t: TestApp, name: string) => (await t.call('stock.summary', {})).items.find((i) => i.name === name)?.qty;

describe('stock tracking off (the default)', () => {
  it('changes nothing: no stock moves, no stock account, purchases stay expenses', async () => {
    t = await createTestApp();
    const soap = await item(t, 'Soap', 5000);
    expect(soap.trackStock).toBe(false);
    expect(soap.stock).toBeNull();
    await t.call('sales.create', { items: [{ itemId: soap.id, itemName: 'Soap', qty: 2, rate: 5000 }], payments: [{ mode: 'cash', amount: 10000 }] });
    await t.call('purchases.create', { supplierName: 'Market', items: [{ description: 'Soap', itemId: soap.id, qty: 10, rate: 3000 }], payments: [{ mode: 'cash', amount: 30000 }] });
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM stock_moves', undefined, 0)).toBe(0);
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM accounts WHERE system_key = 'STOCK'", undefined, 0)).toBe(0);
    const pl = await t.call('reports.profitLoss', { from: '2026-04-01', to: '2026-09-28' });
    expect(pl.figures.closingStock).toBe(0);
    expect(pl.report.notes?.[0]).toMatch(/not tracked/);
    expect((await t.fails('stock.adjust', { kind: 'adjust', reason: 'x', lines: [{ itemId: soap.id, qty: 1 }] })).message).toMatch(/Stock tracking is off/);
  });
});

describe('stock movements', () => {
  it('purchases bring stock in at cost, bills take it out, returns bring it back, cancels undo', async () => {
    t = await createTestApp();
    await stockOn(t);
    const soap = await item(t, 'Soap', 5000);
    expect(soap.trackStock).toBe(true);
    const repair = await t.call('items.create', { name: 'Repair', unit: 'service', rate: 20000 });
    expect(repair.trackStock).toBe(false);
    const p = await t.call('purchases.create', { supplierName: 'Market', items: [{ description: 'Soap', itemId: soap.id, qty: 10, rate: 3000 }], payments: [{ mode: 'cash', amount: 30000 }] });
    expect(p.items[0].itemId).toBe(soap.id);
    expect(await qtyOf(t, 'Soap')).toBe(10);
    const bill = await t.call('sales.create', { items: [{ itemId: soap.id, itemName: 'Soap', qty: 3, rate: 5000 }], payments: [{ mode: 'cash', amount: 15000 }] });
    expect(bill.warnings).toEqual([]);
    expect(await qtyOf(t, 'Soap')).toBe(7);
    // Edit: the bill's movement follows it.
    await t.call('sales.update', { id: bill.id, items: [{ itemId: soap.id, itemName: 'Soap', qty: 4, rate: 5000 }], payments: [{ mode: 'cash', amount: 20000 }] });
    expect(await qtyOf(t, 'Soap')).toBe(6);
    const ret = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: (await t.call('sales.get', { id: bill.id })).items[0].id, qty: 1 }], refundMode: 'cash' });
    expect(await qtyOf(t, 'Soap')).toBe(7);
    await t.call('returns.cancel', { id: ret.id, reason: 'Mistake' });
    expect(await qtyOf(t, 'Soap')).toBe(6);
    await t.call('sales.cancel', { id: bill.id, reason: 'Mistake' });
    expect(await qtyOf(t, 'Soap')).toBe(10);
    await t.call('purchases.cancel', { id: p.id, reason: 'Wrong supplier' });
    expect(await qtyOf(t, 'Soap')).toBe(0);
    const ledger = await t.call('stock.itemLedger', { itemId: soap.id, from: '2026-09-01', to: '2026-09-30' });
    expect(ledger.closing).toBe(0);
    expect(ledger.report.rows.length).toBe(2);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('warns (but allows) selling more than is in stock, and shows stock on the till', async () => {
    t = await createTestApp();
    await stockOn(t);
    const oil = await item(t, 'Oil', 16000);
    const bill = await t.call('sales.create', { items: [{ itemId: oil.id, itemName: 'Oil', qty: 2, rate: 16000 }], payments: [{ mode: 'cash', amount: 32000 }] });
    expect(bill.warnings.join(' ')).toMatch(/Oil is out of stock/);
    expect(await qtyOf(t, 'Oil')).toBe(-2);
    const found = await t.call('items.search', { q: 'Oil' });
    expect(found[0].stock).toBe(-2);
    const low = await t.call('stock.lowItems');
    expect(low.map((l) => l.status)).toEqual(['negative']);
    const dash = await t.call('dashboard.summary');
    expect(dash.alerts.some((a) => a.kind === 'low_stock')).toBe(true);
  });

  it('only moves stock for documents made while tracking was on', async () => {
    t = await createTestApp();
    const tea = await item(t, 'Tea', 1000);
    const old = await t.call('sales.create', { items: [{ itemId: tea.id, itemName: 'Tea', qty: 5, rate: 1000 }], payments: [{ mode: 'cash', amount: 5000 }] });
    await stockOn(t);
    await t.call('stock.trackAll');
    await t.call('sales.update', { id: old.id, items: [{ itemId: tea.id, itemName: 'Tea', qty: 6, rate: 1000 }], payments: [{ mode: 'cash', amount: 6000 }] });
    expect(await qtyOf(t, 'Tea')).toBe(0);
  });
});

describe('opening stock, counts and adjustments', () => {
  it('opening stock is an opening balance of the books', async () => {
    t = await createTestApp();
    await stockOn(t);
    const rice = await item(t, 'Rice', 6000);
    const view = await t.call('stock.saveOpening', { lines: [{ itemId: rice.id, qty: 20, unitCost: 4500 }] });
    expect(view.total).toBe(90000);
    expect(systemBalance(t.app, 'STOCK')).toBe(90000);
    expect(systemBalance(t.app, 'OPENING_EQUITY')).toBe(-90000);
    expect((await t.fails('stock.saveOpening', { lines: [{ itemId: rice.id, qty: 5, unitCost: 0 }] })).message).toMatch(/cost price/);
    // Changing it replaces the opening entry.
    await t.call('stock.saveOpening', { lines: [{ itemId: rice.id, qty: 10, unitCost: 4500 }] });
    expect(systemBalance(t.app, 'STOCK')).toBe(45000);
    await t.loginAs('cashier');
    expect((await t.fails('stock.saveOpening', { lines: [] })).code).toBe('FORBIDDEN');
  });

  it('a stock count corrects the books to what was found', async () => {
    t = await createTestApp();
    await stockOn(t);
    const dal = await item(t, 'Dal', 14000);
    await t.call('purchases.create', { supplierName: 'Market', items: [{ description: 'Dal', itemId: dal.id, qty: 10, rate: 10000 }], payments: [{ mode: 'cash', amount: 100000 }] });
    const count = await t.call('stock.adjust', { kind: 'count', reason: 'Monthly count', lines: [{ itemId: dal.id, counted: 8 }] });
    expect(count.lines[0]).toMatchObject({ bookQty: 10, counted: 8, qty: -2 });
    expect(await qtyOf(t, 'Dal')).toBe(8);
    expect((await t.fails('stock.adjust', { kind: 'count', lines: [{ itemId: dal.id, counted: 8 }] })).message).toMatch(/same as in the books/);
    const adj = await t.call('stock.adjust', { kind: 'adjust', reason: 'Found in godown', lines: [{ itemId: dal.id, qty: 3, unitCost: 9000 }] });
    expect(await qtyOf(t, 'Dal')).toBe(11);
    expect((await t.fails('stock.adjust', { kind: 'adjust', lines: [{ itemId: dal.id, qty: -1 }] })).message).toMatch(/why/);
    await t.call('stock.cancelAdjustment', { id: adj.id, reason: 'Counted twice' });
    expect(await qtyOf(t, 'Dal')).toBe(8);
    const list = await t.call('stock.adjustments', { from: '2026-09-01', to: '2026-09-30' });
    expect(list.map((a) => a.status)).toEqual(['cancelled', 'active']);
  });
});

describe('stock in the accounts (average cost, periodic method)', () => {
  it('values stock at average cost and puts it in P&L and the balance sheet', async () => {
    t = await createTestApp();
    await stockOn(t);
    const soap = await item(t, 'Soap', 5000);
    // 10 at ₹30 and 10 at ₹40: average ₹35.
    await t.call('purchases.create', { supplierName: 'Market', items: [{ description: 'Soap', itemId: soap.id, qty: 10, rate: 3000 }], payments: [{ mode: 'cash', amount: 30000 }] });
    await t.call('purchases.create', { supplierName: 'Market', items: [{ description: 'Soap', itemId: soap.id, qty: 10, rate: 4000 }], payments: [{ mode: 'cash', amount: 40000 }] });
    await t.call('sales.create', { items: [{ itemId: soap.id, itemName: 'Soap', qty: 5, rate: 5000 }], payments: [{ mode: 'cash', amount: 25000 }] });
    const s = await t.call('stock.summary', {});
    const row = s.items.find((i) => i.name === 'Soap')!;
    expect(row.qty).toBe(15);
    expect(Math.round(row.avgCost)).toBe(3500);
    expect(row.value).toBe(52500);
    const pl = await t.call('reports.profitLoss', { from: '2026-04-01', to: '2026-09-28' });
    // COGS = 0 + 70000 - 52500 = 17500; gross profit = 25000 - 17500.
    expect(pl.figures).toMatchObject({ openingStock: 0, closingStock: 52500, costOfGoodsSold: 17500, grossProfit: 7500, netProfit: 7500 });
    const bs = await t.call('reports.balanceSheet', { asOf: '2026-09-28' });
    expect(bs.totals.balanced).toBe(true);
    expect(bs.figures.stock).toBe(52500);
    expect(bs.profit.currentYear).toBe(7500);
  });

  it('year-end closing carries the closing stock into the next year', async () => {
    t = await createTestApp({ today: '2027-04-10' });
    t.setToday('2026-06-01');
    await stockOn(t);
    const rice = await item(t, 'Rice', 6000);
    await t.call('stock.saveOpening', { lines: [{ itemId: rice.id, qty: 10, unitCost: 4000 }] });
    await t.call('purchases.create', { supplierName: 'Market', items: [{ description: 'Rice', itemId: rice.id, qty: 10, rate: 5000 }], payments: [{ mode: 'cash', amount: 50000 }] });
    await t.call('sales.create', { items: [{ itemId: rice.id, itemName: 'Rice', qty: 12, rate: 6000 }], payments: [{ mode: 'cash', amount: 72000 }] });
    t.setToday('2027-04-10');
    // 8 left at average ₹45 = ₹360; COGS = 400 + 500 - 360 = 540; profit = 720 - 540 = 180.
    const pl = await t.call('reports.profitLoss', { from: '2026-04-01', to: '2027-03-31' });
    expect(pl.figures).toMatchObject({ openingStock: 40000, closingStock: 36000, netProfit: 18000 });
    const preview = await t.call('yearEnd.preview', { fyStart: '2026-04-01', transferDrawings: false });
    expect(preview.netProfit).toBe(18000);
    expect(preview.stock).toEqual({ value: 36000, change: -4000 });
    await t.call('yearEnd.close', { fyStart: '2026-04-01', transferDrawings: false });
    expect(systemBalance(t.app, 'STOCK')).toBe(36000);
    const bs = await t.call('reports.balanceSheet', { asOf: '2027-04-10' });
    expect(bs.totals.balanced).toBe(true);
    expect(bs.figures.stock).toBe(36000);
    expect(bs.profit).toEqual({ currentYear: 0, previousYears: 0 });
    const next = await t.call('reports.profitLoss', { from: '2027-04-01', to: '2027-04-10' });
    expect(next.figures.openingStock).toBe(36000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});
