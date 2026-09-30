import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, type TestApp } from './helpers';

let t: TestApp;
afterEach(() => t?.close());

async function turnOn(t: TestApp, opts: { stock?: boolean } = { stock: true }) {
  if (opts.stock) await t.call('settings.update', { section: 'stock', values: { enabled: true } });
  await t.call('settings.update', { section: 'menu', values: { enabled: true } });
}

const qtyOf = async (t: TestApp, name: string) => (await t.call('stock.summary', {})).items.find((i) => i.name === name)?.qty;

/** Chicken (kg), Butter (kg) and Cream (ltr), bought in; Butter Chicken made from them. */
async function kitchen(t: TestApp) {
  const chicken = await t.call('menu.createIngredient', { name: 'Chicken', unit: 'kg', reorderLevel: 1 });
  const butter = await t.call('menu.createIngredient', { name: 'Butter', unit: 'kg' });
  const cream = await t.call('menu.createIngredient', { name: 'Cream', unit: 'ltr' });
  await t.call('purchases.create', {
    supplierName: 'Market',
    items: [
      { description: 'Chicken', itemId: chicken.id, qty: 5, rate: 24000 },
      { description: 'Butter', itemId: butter.id, qty: 1, rate: 50000 },
      { description: 'Cream', itemId: cream.id, qty: 2, rate: 20000 },
    ],
    payments: [{ mode: 'cash', amount: 210000 }],
  });
  const dish = await t.call('menu.save', {
    name: 'Butter Chicken',
    category: 'Main course',
    rate: 32000,
    recipe: [
      { ingredientId: chicken.id, qty: 250, unit: 'g' },
      { ingredientId: butter.id, qty: 20, unit: 'g' },
      { ingredientId: cream.id, qty: 50, unit: 'ml', note: 'fresh' },
    ],
  });
  return { chicken, butter, cream, dish };
}

describe('restaurant menu off (the default)', () => {
  it('shows nothing new and refuses menu changes', async () => {
    t = await createTestApp();
    expect((await t.call('app.status')).features.menu).toBe(false);
    const tea = await t.call('items.create', { name: 'Tea', unit: 'cup', rate: 1500 });
    expect(tea.sellable).toBe(true);
    expect(tea.menu).toBe(false);
    expect((await t.fails('menu.save', { name: 'Tea', rate: 1500, recipe: [] })).message).toMatch(/menu is off/);
    expect((await t.fails('menu.createIngredient', { name: 'Milk', unit: 'ltr' })).message).toMatch(/menu is off/);
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM items WHERE sellable = 1 AND menu = 0', undefined, 0)).toBe(1);
  });
});

describe('dishes and recipes', () => {
  it('selling a dish takes its ingredients out of stock (g -> kg, ml -> ltr); edits, cancels and returns follow', async () => {
    t = await createTestApp();
    await turnOn(t);
    expect((await t.call('app.status')).features.menu).toBe(true);
    const { dish } = await kitchen(t);
    expect(dish.item.menu).toBe(true);
    expect(dish.item.trackStock).toBe(false);
    expect(dish.recipe.map((l) => [l.ingredientName, l.qtyInStockUnit])).toEqual([
      ['Chicken', 0.25],
      ['Butter', 0.02],
      ['Cream', 0.05],
    ]);

    const bill = await t.call('sales.create', { items: [{ itemId: dish.item.id, itemName: 'Butter Chicken', qty: 2, rate: 32000 }], payments: [{ mode: 'cash', amount: 64000 }] });
    expect(bill.warnings).toEqual([]);
    expect(await qtyOf(t, 'Chicken')).toBe(4.5);
    expect(await qtyOf(t, 'Butter')).toBe(0.96);
    expect(await qtyOf(t, 'Cream')).toBe(1.9);
    // The dish itself is not stocked.
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM stock_moves WHERE item_id = ?', [dish.item.id], 0)).toBe(0);

    await t.call('sales.update', { id: bill.id, items: [{ itemId: dish.item.id, itemName: 'Butter Chicken', qty: 4, rate: 32000 }], payments: [{ mode: 'cash', amount: 128000 }] });
    expect(await qtyOf(t, 'Chicken')).toBe(4);

    // A returned plate of food does not go back into stock.
    const line = (await t.call('sales.get', { id: bill.id })).items[0];
    await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: line.id, qty: 1 }], refundMode: 'cash' });
    expect(await qtyOf(t, 'Chicken')).toBe(4);

    const ledger = await t.call('stock.itemLedger', { itemId: (await t.call('menu.ingredients')).find((i) => i.name === 'Chicken')!.id, from: '2026-09-01', to: '2026-09-30' });
    expect(ledger.report.rows.some((r) => String(r.cells.particulars ?? r.cells.note ?? JSON.stringify(r.cells)).includes('Butter Chicken'))).toBe(true);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('cancelling a bill puts the ingredients back; running short warns but still bills', async () => {
    t = await createTestApp();
    await turnOn(t);
    const { dish } = await kitchen(t);
    const big = await t.call('sales.create', { items: [{ itemId: dish.item.id, itemName: 'Butter Chicken', qty: 30, rate: 32000 }], payments: [{ mode: 'cash', amount: 960000 }] });
    expect(big.warnings.join(' ')).toMatch(/Only 5 kg of Chicken/);
    expect(big.warnings.length).toBe(1);
    expect(await qtyOf(t, 'Chicken')).toBe(-2.5);
    await t.call('sales.cancel', { id: big.id, reason: 'Wrong bill' });
    expect(await qtyOf(t, 'Chicken')).toBe(5);
    expect(await qtyOf(t, 'Butter')).toBe(1);
  });

  it('with stock tracking off, the menu and recipes work but nothing moves stock', async () => {
    t = await createTestApp();
    await turnOn(t, { stock: false });
    const rice = await t.call('menu.createIngredient', { name: 'Rice', unit: 'kg' });
    const dish = await t.call('menu.save', { name: 'Jeera Rice', rate: 15000, recipe: [{ ingredientId: rice.id, qty: 150, unit: 'g' }] });
    await t.call('sales.create', { items: [{ itemId: dish.item.id, itemName: 'Jeera Rice', qty: 1, rate: 15000 }], payments: [{ mode: 'cash', amount: 15000 }] });
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM stock_moves', undefined, 0)).toBe(0);
    expect(dish.recipeCost).toBeNull();
  });

  it('ingredients are not offered on bills but can be bought', async () => {
    t = await createTestApp();
    await turnOn(t);
    const { dish } = await kitchen(t);
    const found = await t.call('items.search', { q: 'Butter' });
    expect(found.map((i) => i.name)).toEqual(['Butter Chicken']);
    expect((await t.call('items.recent', {})).map((i) => i.name)).toEqual(['Butter Chicken']);
    const buy = await t.call('purchases.descriptions', { q: 'Butt' });
    expect(buy.some((d) => d.description === 'Butter' && d.itemId)).toBe(true);
    const ingredients = await t.call('menu.ingredients');
    expect(ingredients.map((i) => [i.name, i.usedIn, i.sellable])).toEqual([
      ['Butter', 1, false],
      ['Chicken', 1, false],
      ['Cream', 1, false],
    ]);
    expect(dish.item.sellable).toBe(true);
  });

  it('checks recipes: units must match the ingredient, no dishes inside dishes, no repeats', async () => {
    t = await createTestApp();
    await turnOn(t);
    const { chicken, dish } = await kitchen(t);
    const bad = await t.fails('menu.save', { name: 'Chicken Tikka', rate: 28000, recipe: [{ ingredientId: chicken.id, qty: 2, unit: 'pcs' }] });
    expect(bad.message).toMatch(/Chicken is kept in kg; write its quantity in kg or g/);
    expect((await t.fails('menu.save', { name: 'Thali', rate: 30000, recipe: [{ ingredientId: dish.item.id, qty: 1, unit: 'plate' }] })).message).toMatch(/is a dish/);
    expect(
      (
        await t.fails('menu.save', {
          name: 'Chicken Tikka',
          rate: 28000,
          recipe: [
            { ingredientId: chicken.id, qty: 200, unit: 'g' },
            { ingredientId: chicken.id, qty: 50, unit: 'g' },
          ],
        })
      ).message,
    ).toMatch(/twice/);
    // Changing a recipe is logged.
    await t.call('menu.save', { id: dish.item.id, name: 'Butter Chicken', category: 'Main course', rate: 34000, recipe: [{ ingredientId: chicken.id, qty: 300, unit: 'g' }] });
    const log = t.app.db.all<{ action: string; summary: string }>("SELECT action, summary FROM activity_log WHERE action = 'menu.recipe' ORDER BY id");
    expect(log.length).toBe(2);
    expect(log[1].summary).toMatch(/Changed the recipe of Butter Chicken: Chicken 300 g \(was: Chicken 250 g, Butter 20 g, Cream 50 ml\)/);
    // An ingredient used in a recipe is kept (deactivated), not deleted.
    expect((await t.call('items.remove', { id: chicken.id })).deleted).toBe(false);
  });

  it('costs dishes from ingredient average cost', async () => {
    t = await createTestApp();
    await turnOn(t);
    const { dish } = await kitchen(t);
    // 0.25 kg x 240 + 0.02 kg x 500 + 0.05 ltr x 200 = 60 + 10 + 10 = Rs 80.
    expect(dish.recipeCost).toBe(8000);
    expect(dish.foodCostPct).toBe(25);
    const report = await t.call('menu.costing');
    expect(report.rows[0].cells).toMatchObject({ dish: 'Butter Chicken', rate: 32000, cost: 8000, margin: 24000, pct: 25 });
  });

  it('puts existing items on the menu (they stop being stocked themselves)', async () => {
    t = await createTestApp();
    await turnOn(t);
    const dal = await t.call('items.create', { name: 'Dal Makhani', unit: 'plate', rate: 22000 });
    expect(dal.trackStock).toBe(true);
    expect((await t.call('menu.candidates')).map((i) => i.name)).toEqual(['Dal Makhani']);
    expect(await t.call('menu.addItems', { itemIds: [dal.id] })).toEqual({ added: 1 });
    const d = await t.call('menu.get', { id: dal.id });
    expect(d.item.menu).toBe(true);
    expect(d.item.trackStock).toBe(false);
    // Editing a dish on the items page cannot make it stocked again.
    const edited = await t.call('items.update', { id: dal.id, name: 'Dal Makhani', unit: 'plate', rate: 24000, trackStock: true, sellable: false });
    expect(edited.trackStock).toBe(false);
    expect(edited.sellable).toBe(true);
    expect((await t.call('menu.list')).map((x) => x.item.name)).toEqual(['Dal Makhani']);
  });
});

describe('menu: second review fixes', () => {
  it('an item with stock, or an ingredient, cannot be put on the menu', async () => {
    t = await createTestApp();
    await turnOn(t);
    const samosa = await t.call('items.create', { name: 'Samosa', unit: 'pcs', rate: 2000 });
    await t.call('stock.adjust', { kind: 'count', reason: 'Start', lines: [{ itemId: samosa.id, counted: 10, unitCost: 1000 }] });
    expect((await t.fails('menu.addItems', { itemIds: [samosa.id] })).message).toMatch(/Samosa has 10 pcs in stock/);
    const paneer = await t.call('menu.createIngredient', { name: 'Paneer', unit: 'kg' });
    expect((await t.fails('menu.addItems', { itemIds: [paneer.id] })).message).toMatch(/Paneer is an ingredient/);
  });

  it('editing an old bill keeps the ingredients it took out (menu turned off, or recipe changed since)', async () => {
    t = await createTestApp();
    await turnOn(t);
    const { chicken, dish } = await kitchen(t);
    const bill = await t.call('sales.create', { items: [{ itemId: dish.item.id, itemName: 'Butter Chicken', qty: 2, rate: 32000 }], payments: [{ mode: 'cash', amount: 64000 }] });
    expect(await qtyOf(t, 'Chicken')).toBe(4.5);
    // The recipe changes: the old bill, edited for its remarks only, keeps what it used.
    await t.call('menu.save', { id: dish.item.id, name: 'Butter Chicken', rate: 32000, recipe: [{ ingredientId: chicken.id, qty: 300, unit: 'g' }] });
    const edit = { id: bill.id, items: [{ itemId: dish.item.id, itemName: 'Butter Chicken', qty: 2, rate: 32000 }], payments: [{ mode: 'cash' as const, amount: 64000 }], remarks: 'Table 4' };
    await t.call('sales.update', edit);
    expect([await qtyOf(t, 'Chicken'), await qtyOf(t, 'Butter'), await qtyOf(t, 'Cream')]).toEqual([4.5, 0.96, 1.9]);
    // The menu is turned off: still the same.
    await t.call('settings.update', { section: 'menu', values: { enabled: false } });
    await t.call('sales.update', { ...edit, remarks: 'Table 5' });
    expect(await qtyOf(t, 'Chicken')).toBe(4.5);
    // Changing the dishes uses the recipe now (300 g x 3), even with the menu off.
    await t.call('sales.update', { ...edit, items: [{ itemId: dish.item.id, itemName: 'Butter Chicken', qty: 3, rate: 32000 }], payments: [{ mode: 'cash', amount: 96000 }] });
    expect([await qtyOf(t, 'Chicken'), await qtyOf(t, 'Butter')]).toEqual([4.1, 1]);
  });

  it('an ingredient cannot change to a unit its recipes cannot be written in', async () => {
    t = await createTestApp();
    await turnOn(t, { stock: false });
    const rice = await t.call('menu.createIngredient', { name: 'Rice', unit: 'kg' });
    await t.call('menu.save', { name: 'Jeera Rice', rate: 15000, recipe: [{ ingredientId: rice.id, qty: 150, unit: 'g' }] });
    expect((await t.fails('items.update', { id: rice.id, name: 'Rice', unit: 'pcs', rate: 0 })).message).toMatch(/in the recipe of Jeera Rice in g/);
    // g still works for a recipe in g.
    expect((await t.call('items.update', { id: rice.id, name: 'Rice', unit: 'g', rate: 0 })).unit).toBe('g');
  });

  it('refuses recipe amounts smaller than the stock can count', async () => {
    t = await createTestApp();
    await turnOn(t);
    const saffron = await t.call('menu.createIngredient', { name: 'Saffron', unit: 'kg' });
    const e = await t.fails('menu.save', { name: 'Kesar Pulao', rate: 30000, recipe: [{ ingredientId: saffron.id, qty: 0.4, unit: 'g' }] });
    expect(e.message).toMatch(/Keep Saffron in a smaller unit/);
    // 2 g of a kg item is fine (0.002 kg).
    expect((await t.call('menu.save', { name: 'Kesar Pulao', rate: 30000, recipe: [{ ingredientId: saffron.id, qty: 2, unit: 'g' }] })).recipe[0].qtyInStockUnit).toBe(0.002);
  });
});
