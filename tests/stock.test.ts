import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance, type TestApp } from './helpers';
import { MIGRATIONS } from '../src/core/db/migrate';

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

describe('stock review fixes', () => {
  const on = (t: TestApp, enabled = true) => t.call('settings.update', { section: 'stock', values: { enabled } });

  it('values stock at a moving average: goods sold out long ago do not set the cost of new stock', async () => {
    t = await createTestApp({ today: '2026-05-01' });
    await on(t);
    const onion = await item(t, 'Onion', 5000, { unit: 'kg' });
    await t.call('purchases.create', { supplierName: 'Mandi', items: [{ description: 'Onion', itemId: onion.id, qty: 1000, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000000 }] });
    await t.call('sales.create', { items: [{ itemId: onion.id, itemName: 'Onion', qty: 1000, rate: 1500 }], payments: [{ mode: 'cash', amount: 1500000 }] });
    t.setToday('2026-09-28');
    await t.call('purchases.create', { supplierName: 'Mandi', items: [{ description: 'Onion', itemId: onion.id, qty: 100, rate: 6000 }], payments: [{ mode: 'cash', amount: 600000 }] });
    const s = (await t.call('stock.summary', {})).items[0];
    expect([s.qty, s.avgCost, s.value]).toEqual([100, 6000, 600000]);
    const pl = await t.call('reports.profitLoss', { from: '2026-04-01', to: '2026-09-28' });
    expect(pl.figures.netProfit).toBe(500000);
    const bs = await t.call('reports.balanceSheet', { asOf: '2026-09-28' });
    expect(bs.figures.stock).toBe(600000);
    expect(bs.totals.balanced).toBe(true);
    // A back-dated purchase re-averages what came after it.
    t.setToday('2026-09-28');
    const early = await t.call('purchases.create', { date: '2026-05-02', supplierName: 'Mandi', items: [{ description: 'Onion', itemId: onion.id, qty: 100, rate: 2000 }], payments: [{ mode: 'cash', amount: 200000 }] });
    // 100 kg at 20 then 100 kg at 60: average 40.
    expect((await t.call('stock.summary', {})).items[0]).toMatchObject({ qty: 200, avgCost: 4000, value: 800000 });
    await t.call('purchases.cancel', { id: early.id, reason: 'Entered twice' });
    expect((await t.call('stock.summary', {})).items[0]).toMatchObject({ qty: 100, avgCost: 6000 });
  });

  it('editing an old bill keeps its stock effect when "Track stock" was ticked later', async () => {
    t = await createTestApp({ today: '2026-09-01' });
    await on(t);
    const tea = await item(t, 'Tea', 1000, { trackStock: false });
    const bill = await t.call('sales.create', { items: [{ itemId: tea.id, itemName: 'Tea', qty: 5, rate: 1000 }], payments: [{ mode: 'cash', amount: 5000 }] });
    t.setToday('2026-09-28');
    await t.call('items.update', { id: tea.id, name: 'Tea', unit: 'pcs', rate: 1000, trackStock: true });
    await t.call('stock.adjust', { kind: 'count', reason: 'Start', lines: [{ itemId: tea.id, counted: 20, unitCost: 500 }] });
    await t.call('sales.update', { id: bill.id, items: [{ itemId: tea.id, itemName: 'Tea', qty: 5, rate: 1000 }], payments: [{ mode: 'cash', amount: 5000 }], remarks: 'fixed' });
    expect(await qtyOf(t, 'Tea')).toBe(20);
    // A tracked item added to the old bill does move stock.
    const cup = await item(t, 'Cup', 2000);
    await t.call('stock.adjust', { kind: 'count', reason: 'Start', lines: [{ itemId: cup.id, counted: 10, unitCost: 1000 }] });
    await t.call('sales.update', {
      id: bill.id,
      items: [
        { itemId: tea.id, itemName: 'Tea', qty: 5, rate: 1000 },
        { itemId: cup.id, itemName: 'Cup', qty: 1, rate: 2000 },
      ],
      payments: [{ mode: 'cash', amount: 7000 }],
    });
    expect([await qtyOf(t, 'Tea'), await qtyOf(t, 'Cup')]).toEqual([20, 9]);
  });

  it('an item with stock cannot stop being tracked; with none, its old purchases keep their movements', async () => {
    t = await createTestApp();
    await on(t);
    const a = await item(t, 'A', 1000);
    const p = await t.call('purchases.create', { supplierName: 'Market', items: [{ description: 'A', itemId: a.id, qty: 10, rate: 500 }], payments: [{ mode: 'cash', amount: 5000 }] });
    const refused = await t.fails('items.update', { id: a.id, name: 'A', unit: 'pcs', rate: 1000, trackStock: false });
    expect(refused.message).toMatch(/A has 10 pcs in stock/);
    await t.call('sales.create', { items: [{ itemId: a.id, itemName: 'A', qty: 10, rate: 1000 }], payments: [{ mode: 'cash', amount: 10000 }] });
    await t.call('items.update', { id: a.id, name: 'A', unit: 'pcs', rate: 1000, trackStock: false });
    await t.call('purchases.update', { id: p.id, supplierName: 'Market', items: [{ description: 'A', itemId: a.id, qty: 10, rate: 500 }], payments: [{ mode: 'cash', amount: 5000 }], remarks: 'note' });
    await t.call('items.update', { id: a.id, name: 'A', unit: 'pcs', rate: 1000, trackStock: true });
    expect(await qtyOf(t, 'A')).toBe(0);
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM stock_moves WHERE source_type = 'purchase'", undefined, 0)).toBe(1);
  });

  it('opening stock of an item no longer tracked can be saved again unchanged', async () => {
    t = await createTestApp({ today: '2026-06-01' });
    await on(t);
    const a = await item(t, 'A', 1000);
    const b = await item(t, 'B', 1000);
    await t.call('stock.saveOpening', {
      lines: [
        { itemId: a.id, qty: 10, unitCost: 500 },
        { itemId: b.id, qty: 10, unitCost: 500 },
      ],
    });
    await t.call('sales.create', { items: [{ itemId: b.id, itemName: 'B', qty: 10, rate: 1000 }], payments: [{ mode: 'cash', amount: 10000 }] });
    await t.call('items.update', { id: b.id, name: 'B', unit: 'pcs', rate: 1000, trackStock: false });
    const view = await t.call('stock.opening');
    await t.call('stock.saveOpening', { lines: view.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitCost: l.unitCost })) });
    await t.call('stock.saveOpening', { lines: [{ itemId: a.id, qty: 12, unitCost: 500 }] });
    expect(systemBalance(t.app, 'STOCK')).toBe(11000);
    const bs = await t.call('reports.balanceSheet', { asOf: '2026-06-01' });
    expect(bs.totals.balanced).toBe(true);
    // Unticking B changed nothing in the value of its history.
    const pl = await t.call('reports.profitLoss', { from: '2026-04-01', to: '2026-06-01' });
    expect(pl.figures).toMatchObject({ openingStock: 11000, closingStock: 6000 });
  });

  it('the list of years shows the profit its Profit & loss and closing show', async () => {
    t = await createTestApp({ today: '2026-06-01' });
    await on(t);
    const rice = await item(t, 'Rice', 6000, { unit: 'kg' });
    await t.call('purchases.create', { supplierName: 'Market', items: [{ description: 'Rice', itemId: rice.id, qty: 10, rate: 5000 }], payments: [{ mode: 'cash', amount: 50000 }] });
    t.setToday('2027-05-01');
    let years = await t.call('yearEnd.list');
    expect(years.map((y) => [y.name, y.netProfit])).toEqual([
      ['2027-28', 0],
      ['2026-27', 0],
    ]);
    await t.call('yearEnd.close', { fyStart: '2026-04-01', transferDrawings: false });
    years = await t.call('yearEnd.list');
    expect(years.map((y) => [y.name, y.netProfit, y.closingStock])).toEqual([
      ['2027-28', 0, 50000],
      ['2026-27', 0, 50000],
    ]);
  });

  it('turning stock off takes the stock left out of the books, so later profit is right', async () => {
    t = await createTestApp({ today: '2026-06-01' });
    await on(t);
    const rice = await item(t, 'Rice', 6000, { unit: 'kg' });
    await t.call('purchases.create', { supplierName: 'Market', items: [{ description: 'Rice', itemId: rice.id, qty: 10, rate: 5000 }], payments: [{ mode: 'cash', amount: 50000 }] });
    t.setToday('2027-04-10');
    await t.call('yearEnd.close', { fyStart: '2026-04-01', transferDrawings: false });
    await on(t, false);
    const adj = await t.call('stock.adjustments', { from: '2027-04-10', to: '2027-04-10' });
    expect(adj.map((a) => a.reason)).toEqual(['Stock tracking turned off: the stock left is taken out of the books']);
    await t.call('sales.create', { items: [{ itemId: rice.id, itemName: 'Rice', qty: 10, rate: 6000 }], payments: [{ mode: 'cash', amount: 60000 }] });
    const pl = await t.call('reports.profitLoss', { from: '2027-04-01', to: '2027-04-10' });
    expect(pl.figures).toMatchObject({ openingStock: 50000, closingStock: 0, netProfit: 10000 });
    const bs = await t.call('reports.balanceSheet', { asOf: '2027-04-10' });
    expect(bs.figures.stock).toBe(0);
    expect(bs.totals.balanced).toBe(true);
    t.setToday('2028-04-02');
    await t.call('yearEnd.close', { fyStart: '2027-04-01', transferDrawings: false });
    expect(systemBalance(t.app, 'STOCK')).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('cashiers see stock levels but not cost prices', async () => {
    t = await createTestApp();
    await on(t);
    await t.call('settings.update', { section: 'menu', values: { enabled: true } });
    const soap = await item(t, 'Soap', 5000);
    await t.call('stock.saveOpening', { lines: [{ itemId: soap.id, qty: 10, unitCost: 612 }] });
    const rice = await t.call('menu.createIngredient', { name: 'Rice', unit: 'kg' });
    await t.call('purchases.create', { supplierName: 'Market', items: [{ description: 'Rice', itemId: rice.id, qty: 10, rate: 5000 }], payments: [{ mode: 'cash', amount: 50000 }] });
    await t.call('menu.save', { name: 'Jeera Rice', rate: 15000, recipe: [{ ingredientId: rice.id, qty: 150, unit: 'g' }] });
    await t.loginAs('cashier');
    const s = await t.call('stock.summary', {});
    expect(s.costHidden).toBe(true);
    expect(s.items.map((i) => [i.name, i.qty, i.avgCost, i.value])).toEqual([
      ['Rice', 10, 0, 0],
      ['Soap', 10, 0, 0],
    ]);
    expect(s.report.columns.map((c) => c.key)).not.toContain('value');
    expect((await t.call('stock.opening')).lines.map((l) => [l.name, l.qty, l.unitCost, l.value])).toEqual([
      ['Rice', 0, 0, 0],
      ['Soap', 10, 0, 0],
    ]);
    expect((await t.call('menu.list', {}))[0]).toMatchObject({ recipeCost: null, foodCostPct: null, costHidden: true });
    expect((await t.call('menu.ingredients'))[0].avgCost).toBeNull();
    expect((await t.fails('menu.costing')).code).toBe('FORBIDDEN');
  });

  it('stock items must be bought into Purchases, not a fixed asset or running expense', async () => {
    t = await createTestApp();
    await on(t);
    const fridge = await item(t, 'Fridge', 3000000);
    const fa = t.app.db.get<{ id: number }>("SELECT id FROM accounts WHERE group_code = 'fixed_assets' LIMIT 1")!;
    const e = await t.fails('purchases.create', { supplierName: 'Market', expenseAccountId: fa.id, items: [{ description: 'Fridge', itemId: fridge.id, qty: 1, rate: 2500000 }], payments: [{ mode: 'cash', amount: 2500000 }] });
    expect(e.message).toMatch(/Fridge is a stock item, so it must be bought into "Purchases"/);
    // Without the stock item link it is an ordinary asset purchase.
    await t.call('purchases.create', { supplierName: 'Market', expenseAccountId: fa.id, items: [{ description: 'Fridge', qty: 1, rate: 2500000 }], payments: [{ mode: 'cash', amount: 2500000 }] });
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM stock_moves', undefined, 0)).toBe(0);
  });

  it('journals cannot post to Stock in Hand', async () => {
    t = await createTestApp();
    await on(t);
    const stockId = t.app.db.value<number>("SELECT id FROM accounts WHERE system_key = 'STOCK'")!;
    const capId = t.app.db.value<number>("SELECT id FROM accounts WHERE system_key = 'CAPITAL'")!;
    const e = await t.fails('journals.create', { narration: 'Stock brought in', lines: [{ accountId: stockId, debit: 100000 }, { accountId: capId, credit: 100000 }] });
    expect(e.message).toMatch(/changes with your stock/);
  });

  it('a stock count can value stock found at a cost', async () => {
    t = await createTestApp();
    await on(t);
    const jar = await item(t, 'Jar', 3000);
    await t.call('stock.adjust', { kind: 'count', reason: 'First count', lines: [{ itemId: jar.id, counted: 5, unitCost: 1000 }] });
    expect((await t.call('stock.summary', {})).items[0]).toMatchObject({ qty: 5, value: 5000, costKnown: true });
  });
});

describe('migration 6 (running stock average)', () => {
  it('fills in the running quantity and average cost of movements saved before it', async () => {
    t = await createTestApp();
    await t.call('settings.update', { section: 'stock', values: { enabled: true } });
    const oil = await item(t, 'Oil', 16000, { unit: 'ltr' });
    await t.call('purchases.create', { supplierName: 'Market', items: [{ description: 'Oil', itemId: oil.id, qty: 10, rate: 12000 }], payments: [{ mode: 'cash', amount: 120000 }] });
    await t.call('sales.create', { items: [{ itemId: oil.id, itemName: 'Oil', qty: 4, rate: 16000 }], payments: [{ mode: 'cash', amount: 64000 }] });
    const db = t.app.db;
    const before = db.all('SELECT id, bal_qty, avg_cost FROM stock_moves ORDER BY id');
    db.run('UPDATE stock_moves SET bal_qty = NULL, avg_cost = NULL');
    MIGRATIONS.find((m) => m.version === 6)!.up(db);
    expect(db.all('SELECT id, bal_qty, avg_cost FROM stock_moves ORDER BY id')).toEqual(before);
    expect(before.map((r) => [r.bal_qty, r.avg_cost])).toEqual([
      [10, 12000],
      [6, 12000],
    ]);
  });
});

describe('second review fixes', () => {
  const on = (t: TestApp, enabled = true) => t.call('settings.update', { section: 'stock', values: { enabled } });
  const buy = (t: TestApp, id: number, name: string, qty: number, rate: number) =>
    t.call('purchases.create', { supplierName: 'M', items: [{ description: name, itemId: id, qty, rate }], payments: [{ mode: 'cash', amount: Math.round(qty * rate) }] });
  const sell = (t: TestApp, id: number, name: string, qty: number, rate: number) =>
    t.call('sales.create', { items: [{ itemId: id, itemName: name, qty, rate }], payments: [{ mode: 'cash', amount: Math.round(qty * rate) }] });
  const valueOf = async (t: TestApp, name: string) => (await t.call('stock.summary', {})).items.find((i) => i.name === name)?.value;

  it('editing a bill or purchase keeps its place in the day, so the stock value does not change', async () => {
    t = await createTestApp();
    await on(t);
    const a = await item(t, 'A', 30000);
    const p1 = await buy(t, a.id, 'A', 10, 10000);
    const bill = await sell(t, a.id, 'A', 5, 30000);
    await buy(t, a.id, 'A', 10, 20000);
    const v = await valueOf(t, 'A');
    await t.call('sales.update', { id: bill.id, items: [{ itemId: a.id, itemName: 'A', qty: 5, rate: 30000 }], payments: [{ mode: 'cash', amount: 150000 }], remarks: 'typo fix' });
    expect(await valueOf(t, 'A')).toBe(v);
    await t.call('purchases.update', { id: p1.id, supplierName: 'M', items: [{ description: 'A', itemId: a.id, qty: 10, rate: 10000 }], payments: [{ mode: 'cash', amount: 100000 }], remarks: 'note' });
    expect(await valueOf(t, 'A')).toBe(v);
  });

  it('a return against a bill brings back only what that bill took out of stock', async () => {
    t = await createTestApp();
    const cup = await item(t, 'Cup', 5000);
    const bill = await sell(t, cup.id, 'Cup', 2, 5000);
    await on(t);
    await t.call('items.update', { id: cup.id, name: 'Cup', unit: 'pcs', rate: 5000, trackStock: true });
    const line = (await t.call('sales.get', { id: bill.id })).items[0];
    await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: line.id, qty: 2 }], refundMode: 'cash' });
    expect(await qtyOf(t, 'Cup')).toBe(0);
  });

  it('while tracking is off, cancelling or editing an old bill does not put stock back in the books', async () => {
    t = await createTestApp();
    await on(t);
    const a = await item(t, 'A', 10000);
    await buy(t, a.id, 'A', 10, 5000);
    const bill = await sell(t, a.id, 'A', 4, 10000);
    await on(t, false);
    await t.call('sales.cancel', { id: bill.id, reason: 'Wrong bill' });
    expect(t.app.db.value<number>('SELECT COALESCE(SUM(qty), 0) FROM stock_moves WHERE item_id = ?', [a.id], 0)).toBe(0);
    const bs = await t.call('reports.balanceSheet', { asOf: '2026-09-28' });
    expect(bs.figures.stock).toBe(0);
    expect(bs.totals.balanced).toBe(true);
    // The write-off itself cannot be cancelled while tracking is off.
    const offAdj = (await t.call('stock.adjustments', { from: '2026-09-01', to: '2026-09-30' }))[0];
    expect((await t.fails('stock.cancelAdjustment', { id: offAdj.id, reason: 'x' })).message).toMatch(/Stock tracking is off/);
  });

  it("an item's unit cannot change once it has stock history", async () => {
    t = await createTestApp();
    await on(t);
    const rice = await item(t, 'Rice', 6000, { unit: 'kg' });
    await buy(t, rice.id, 'Rice', 10, 5000);
    expect((await t.fails('items.update', { id: rice.id, name: 'Rice', unit: 'g', rate: 6000 })).message).toMatch(/stock history in kg/);
  });
});
