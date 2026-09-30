/**
 * Restaurant menu (optional; Settings > Stock & menu): dishes with a recipe of
 * ingredients.
 *
 * A dish is an item (items.menu = 1) that is sold on bills; its recipe lists what
 * goes into one unit (plate, portion ...) of it. Ingredients are items kept in
 * stock but not sold (items.sellable = 0): the billing screen does not offer them
 * while the menu is on. With stock tracking on, a bill that sells a dish takes the
 * recipe's ingredients out of stock (qty sold x recipe quantity, converted to the
 * ingredient's unit: g -> kg, ml -> ltr). Sales returns of dishes do not put food
 * back into stock. The dish itself is not stocked.
 */
import type { Ctx } from '../../context';
import { assertCan, now, today } from '../../context';
import { fail } from '../../errors';
import { logActivity } from '../../audit';
import { getSection } from '../../settings';
import { convertQty } from '../../../shared/units';
import { formatQty } from '../../../shared/money';
import type { ReportData, ReportRow } from '../../../shared/report';
import { createItem, getItem, updateItem, type Item } from '../items/service';
import { itemStocks, roundStockQty, stockEnabled, stockOnHand } from '../stock/valuation';
import type { MoveInput } from '../stock/service';

export function menuEnabled(ctx: Ctx): boolean {
  return getSection(ctx, 'menu').enabled === true;
}

function assertMenuOn(ctx: Ctx): void {
  if (!menuEnabled(ctx)) throw fail.validation('The restaurant menu is off. Turn it on in Settings > Stock & menu first.');
}

export interface RecipeLine {
  lineNo: number;
  ingredientId: number;
  ingredientName: string;
  /** The ingredient's own (stock) unit. */
  ingredientUnit: string;
  qty: number;
  /** Unit written in the recipe. */
  unit: string;
  /** qty converted to the ingredient's unit. */
  qtyInStockUnit: number;
  /** Cost of this quantity at the ingredient's average cost (paise); null when no cost is known. */
  cost: number | null;
  note: string | null;
}

export interface Dish {
  item: Item;
  recipe: RecipeLine[];
  /** Cost of one unit of the dish from its recipe (paise), of the ingredients that have a cost; null when none has. */
  recipeCost: number | null;
  /** Ingredients without a cost yet (never bought): the recipe cost leaves them out. */
  costMissing: string[];
  /** Recipe cost as % of the selling rate. */
  foodCostPct: number | null;
}

interface RecipeRow {
  dish_id: number;
  line_no: number;
  ingredient_id: number;
  qty: number;
  unit: string;
  note: string | null;
  name: string;
  item_unit: string;
}

function recipeRows(ctx: Ctx, dishIds: number[]): RecipeRow[] {
  if (!dishIds.length) return [];
  return ctx.db.all<RecipeRow>(
    `SELECT r.dish_id, r.line_no, r.ingredient_id, r.qty, r.unit, r.note, i.name, i.unit AS item_unit
       FROM recipe_items r JOIN items i ON i.id = r.ingredient_id
      WHERE r.dish_id IN (${dishIds.map(Number).join(',')}) ORDER BY r.dish_id, r.line_no`,
  );
}

function toDishes(ctx: Ctx, items: Item[]): Dish[] {
  const rows = recipeRows(
    ctx,
    items.map((i) => i.id),
  );
  const ids = [...new Set(rows.map((r) => r.ingredient_id))];
  const costs = new Map(itemStocks(ctx, today(ctx), { itemIds: ids, includeUntracked: true }).map((s) => [s.itemId, s.costKnown ? s.avgCost : null]));
  return items.map((item) => {
    const recipe = rows
      .filter((r) => r.dish_id === item.id)
      .map((r) => {
        const converted = convertQty(r.qty, r.unit, r.item_unit);
        const inUnit = converted ?? r.qty;
        const avg = converted === null ? null : (costs.get(r.ingredient_id) ?? null);
        return {
          lineNo: r.line_no,
          ingredientId: r.ingredient_id,
          ingredientName: r.name,
          ingredientUnit: r.item_unit,
          qty: r.qty,
          unit: r.unit,
          qtyInStockUnit: inUnit,
          cost: avg === null ? null : Math.round(inUnit * avg),
          note: r.note,
        };
      });
    const known = recipe.filter((l) => l.cost !== null);
    const recipeCost = known.length ? known.reduce((s, l) => s + (l.cost ?? 0), 0) : null;
    return {
      item,
      recipe,
      recipeCost,
      costMissing: recipe.filter((l) => l.cost === null).map((l) => l.ingredientName),
      foodCostPct: recipeCost !== null && item.rate > 0 ? Math.round((recipeCost / item.rate) * 1000) / 10 : null,
    };
  });
}

export function listDishes(ctx: Ctx, opts: { includeInactive?: boolean } = {}): Dish[] {
  const ids = ctx.db.all<{ id: number }>(`SELECT id FROM items WHERE menu = 1 ${opts.includeInactive ? '' : 'AND is_active = 1'} ORDER BY category COLLATE NOCASE, name COLLATE NOCASE`).map((r) => r.id);
  return toDishes(
    ctx,
    ids.map((id) => getItem(ctx, id)),
  );
}

export function getDish(ctx: Ctx, id: number): Dish {
  return toDishes(ctx, [getItem(ctx, id)])[0];
}

export interface RecipeLineInput {
  ingredientId: number;
  qty: number;
  unit: string;
  note?: string | null;
}

export interface DishInput {
  name: string;
  category?: string | null;
  unit?: string | null;
  rate: number;
  code?: string | null;
  gstRate?: number | null;
  hsn?: string | null;
  recipe: RecipeLineInput[];
}

const recipeText = (lines: Array<{ ingredientName: string; qty: number; unit: string }>) =>
  lines.map((l) => `${l.ingredientName} ${formatQty(l.qty)} ${l.unit}`).join(', ') || 'no recipe';

/** Add or change a dish and its recipe. */
export function saveDish(ctx: Ctx, id: number | null, input: DishInput): Dish {
  assertCan(ctx, 'items.manage', 'You are not allowed to change the menu. Ask the owner for permission.');
  assertMenuOn(ctx);
  const seen = new Set<number>();
  const lines = input.recipe.map((l, i) => {
    const ing = ctx.db.get<{ id: number; name: string; unit: string; menu: number }>('SELECT id, name, unit, menu FROM items WHERE id = ?', [l.ingredientId]);
    if (!ing) throw fail.validation(`Recipe line ${i + 1}: the ingredient was not found.`, { [`recipe.${i}.ingredientId`]: 'Not found' });
    if (ing.id === id) throw fail.validation('A dish cannot be an ingredient of itself.', { [`recipe.${i}.ingredientId`]: 'Choose an ingredient' });
    if (ing.menu) throw fail.validation(`${ing.name} is a dish. Add its ingredients to the recipe instead.`, { [`recipe.${i}.ingredientId`]: 'Choose an ingredient' });
    if (seen.has(ing.id)) throw fail.validation(`${ing.name} is in the recipe twice. Enter the total quantity once.`, { [`recipe.${i}.ingredientId`]: 'Listed twice' });
    seen.add(ing.id);
    if (!(l.qty > 0) || Math.abs(Math.round(l.qty * 1000) - l.qty * 1000) > 1e-6) {
      throw fail.validation(`Enter the quantity of ${ing.name} (up to 3 decimals).`, { [`recipe.${i}.qty`]: 'Enter the quantity' });
    }
    const unit = l.unit.trim().toLowerCase();
    const inStockUnit = convertQty(l.qty, unit, ing.unit);
    if (inStockUnit !== null && Math.abs(roundStockQty(inStockUnit) - inStockUnit) > 1e-9) {
      // Stock is counted to 3 decimals of its unit (1 g of a kg item): smaller amounts would never come off.
      throw fail.validation(
        `${formatQty(l.qty)} ${unit} of ${ing.name} is less than Billforce can count for an ingredient kept in ${ing.unit} (up to 3 decimals). Keep ${ing.name} in a smaller unit (for example g or ml), or round the amount.`,
        { [`recipe.${i}.qty`]: 'Too small for the unit' },
      );
    }
    if (inStockUnit === null) {
      throw fail.validation(`${ing.name} is kept in ${ing.unit}; write its quantity in ${ing.unit}${ing.unit === 'kg' ? ' or g' : ing.unit === 'g' ? ' or kg' : ing.unit === 'ltr' ? ' or ml' : ing.unit === 'ml' ? ' or ltr' : ''}.`, {
        [`recipe.${i}.unit`]: `Use ${ing.unit}`,
      });
    }
    return { ingredientId: ing.id, ingredientName: ing.name, qty: roundStockQty(l.qty), unit, note: l.note?.trim() || null };
  });
  const itemInput = {
    name: input.name.trim(),
    code: input.code ?? null,
    unit: input.unit?.trim() || 'plate',
    rate: input.rate,
    category: input.category?.trim() || null,
    ...(input.gstRate !== undefined ? { gstRate: input.gstRate } : {}),
    ...(input.hsn !== undefined ? { hsn: input.hsn } : {}),
    // The dish is not stocked; its ingredients are.
    trackStock: false,
  };
  if (!itemInput.name) throw fail.validation('Enter the name of the dish', { name: 'Enter the name' });
  const before = id ? getDish(ctx, id) : null;
  if (before && !before.item.menu) throw fail.validation(`${before.item.name} is not on the menu. Add it to the menu first.`);
  const item = id ? updateItem(ctx, id, itemInput) : createItem(ctx, itemInput);
  ctx.db.run('UPDATE items SET menu = 1, sellable = 1 WHERE id = ?', [item.id]);
  ctx.db.run('DELETE FROM recipe_items WHERE dish_id = ?', [item.id]);
  lines.forEach((l, i) => {
    ctx.db.insert('recipe_items', { dish_id: item.id, line_no: i + 1, ingredient_id: l.ingredientId, qty: l.qty, unit: l.unit, note: l.note });
  });
  const oldText = before ? recipeText(before.recipe) : null;
  const newText = recipeText(lines);
  if (oldText !== newText) {
    logActivity(ctx, 'menu.recipe', `${before ? 'Changed' : 'Set'} the recipe of ${item.name}: ${newText}${before ? ` (was: ${oldText})` : ''}`, {
      entityType: 'item',
      entityId: item.id,
      details: { before: before?.recipe ?? null, after: lines },
    });
  }
  return getDish(ctx, item.id);
}

/**
 * Put items the business already sells on the menu (a restaurant that billed its dishes as items
 * before the update). Dishes are not stocked themselves, so stock tracking stops for them.
 */
export function addItemsToMenu(ctx: Ctx, itemIds: number[]): { added: number } {
  assertCan(ctx, 'items.manage', 'You are not allowed to change the menu. Ask the owner for permission.');
  assertMenuOn(ctx);
  const ids = [...new Set(itemIds.map(Number))];
  if (!ids.length) return { added: 0 };
  const rows = ctx.db.all<{ id: number; name: string; unit: string; menu: number; sellable: number; used: number }>(
    `SELECT i.id, i.name, i.unit, i.menu, i.sellable, EXISTS (SELECT 1 FROM recipe_items r WHERE r.ingredient_id = i.id) AS used
       FROM items i WHERE i.id IN (${ids.join(',')})`,
  );
  if (rows.length !== ids.length) throw fail.notFound('Item');
  const used = rows.find((r) => r.used || !r.sellable);
  if (used) throw fail.validation(`${used.name} is an ingredient, so it cannot be a dish.`);
  // A dish is not stocked itself: stock left on it would stay in the books for ever.
  const onHand = stockOnHand(
    ctx,
    rows.filter((r) => !r.menu).map((r) => r.id),
  );
  const stocked = rows.find((r) => (onHand.get(r.id) ?? 0) !== 0);
  if (stocked) {
    throw fail.validation(
      `${stocked.name} has ${formatQty(onHand.get(stocked.id)!)} ${stocked.unit} in stock. Bring it to 0 with a stock count first, then put it on the menu.`,
    );
  }
  const add = rows.filter((r) => !r.menu);
  if (!add.length) return { added: 0 };
  ctx.db.run(`UPDATE items SET menu = 1, sellable = 1, track_stock = 0, updated_at = ? WHERE id IN (${add.map((r) => r.id).join(',')})`, [now(ctx)]);
  logActivity(ctx, 'menu.add', `Put ${add.length === 1 ? add[0].name : `${add.length} items`} on the menu${add.length > 1 ? `: ${add.map((r) => r.name).join(', ')}` : ''}`, {
    entityType: 'item',
    entityId: add.length === 1 ? add[0].id : null,
    details: { items: add.map((r) => ({ id: r.id, name: r.name })) },
  });
  return { added: add.length };
}

/** Items that could go on the menu (sold, not dishes, not used as ingredients). */
export function menuCandidates(ctx: Ctx): Item[] {
  return ctx.db
    .all<{ id: number }>(
      `SELECT id FROM items WHERE is_active = 1 AND menu = 0 AND sellable = 1
          AND NOT EXISTS (SELECT 1 FROM recipe_items r WHERE r.ingredient_id = items.id)
        ORDER BY category COLLATE NOCASE, name COLLATE NOCASE`,
    )
    .map((r) => getItem(ctx, r.id));
}

/* ------------------------------ Ingredients ------------------------------ */

export interface IngredientInput {
  name: string;
  unit: string;
  reorderLevel?: number | null;
}

export type Ingredient = Item & {
  /** Active dishes whose recipe uses it. */
  usedIn: number;
  /** Average cost per unit (paise); null when nothing was bought yet (or stock tracking is off). */
  avgCost: number | null;
};

/** Ingredients: items kept in stock but not sold (and anything used in a recipe). */
export function listIngredients(ctx: Ctx): Ingredient[] {
  const rows = ctx.db.all<{ id: number; used: number }>(
    `SELECT i.id, (SELECT COUNT(DISTINCT r.dish_id) FROM recipe_items r JOIN items d ON d.id = r.dish_id WHERE r.ingredient_id = i.id AND d.is_active = 1) AS used
       FROM items i WHERE i.menu = 0 AND (i.sellable = 0 OR EXISTS (SELECT 1 FROM recipe_items r WHERE r.ingredient_id = i.id))
      ORDER BY i.name COLLATE NOCASE`,
  );
  const costs = new Map(
    itemStocks(ctx, today(ctx), { itemIds: rows.map((r) => r.id), includeUntracked: true }).map((s) => [s.itemId, s.costKnown ? s.avgCost : null]),
  );
  return rows.map((r) => ({ ...getItem(ctx, r.id), usedIn: r.used, avgCost: costs.get(r.id) ?? null }));
}

/** Add an ingredient: stocked, not sold. */
export function createIngredient(ctx: Ctx, input: IngredientInput): Ingredient {
  assertCan(ctx, 'items.manage', 'You are not allowed to add ingredients. Ask the owner for permission.');
  assertMenuOn(ctx);
  const item = createItem(ctx, { name: input.name.trim(), unit: input.unit.trim() || 'kg', rate: 0, trackStock: true, reorderLevel: input.reorderLevel ?? null });
  ctx.db.run('UPDATE items SET sellable = 0 WHERE id = ?', [item.id]);
  return { ...getItem(ctx, item.id), usedIn: 0, avgCost: null };
}

/* ------------------------------ Selling dishes ------------------------------ */

/**
 * Ingredients used by bill lines that sell dishes (menu on, or `force` for a bill that already took
 * ingredients out). Each dish line gives one movement per ingredient: - qty sold x recipe quantity, in the
 * ingredient's unit, with a note naming the dish (which marks it as an ingredient movement).
 */
export function recipeMoves(ctx: Ctx, lines: Array<{ itemId: number | null; qty: number; lineNo: number; name: string }>, opts: { force?: boolean } = {}): MoveInput[] {
  if (!opts.force && !menuEnabled(ctx)) return [];
  const dishIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is number => !!x))];
  const rows = recipeRows(ctx, dishIds);
  if (!rows.length) return [];
  const moves: MoveInput[] = [];
  for (const l of lines) {
    if (!l.itemId) continue;
    for (const r of rows.filter((x) => x.dish_id === l.itemId)) {
      const per = convertQty(r.qty, r.unit, r.item_unit);
      if (per === null) continue;
      moves.push({ itemId: r.ingredient_id, qty: -roundStockQty(l.qty * per), kind: 'sale', line: l.lineNo, note: `${l.name} x ${formatQty(l.qty)}` });
    }
  }
  return moves;
}

/** Dish lines still take ingredients out only while both the menu and stock tracking are on. */
export function recipesMoveStock(ctx: Ctx): boolean {
  return menuEnabled(ctx) && stockEnabled(ctx);
}

/* ------------------------------ Menu costing ------------------------------ */

export function menuCosting(ctx: Ctx): ReportData {
  const dishes = listDishes(ctx);
  const rows: ReportRow[] = dishes.map((d) => ({
    cells: {
      dish: d.item.name,
      category: d.item.category ?? '',
      rate: d.item.rate,
      cost: d.recipeCost,
      margin: d.recipeCost === null ? null : d.item.rate - d.recipeCost,
      pct: d.foodCostPct,
      recipe: d.recipe.map((l) => `${l.ingredientName} ${formatQty(l.qty)} ${l.unit}${l.cost === null ? ' (no cost yet)' : ''}`).join(', ') || 'No recipe',
    },
    style: d.recipe.length ? 'normal' : 'muted',
  }));
  const partial = dishes.filter((d) => d.costMissing.length).length;
  return {
    title: 'Menu costing',
    subtitle: `Recipe cost at today's average ingredient cost`,
    landscape: true,
    columns: [
      { key: 'dish', label: 'Dish', width: 24 },
      { key: 'category', label: 'Category', width: 14 },
      { key: 'rate', label: 'Price', type: 'money', width: 12 },
      { key: 'cost', label: 'Recipe cost', type: 'money', width: 12 },
      { key: 'margin', label: 'Margin', type: 'money', width: 12 },
      { key: 'pct', label: 'Food cost %', type: 'percent', width: 10 },
      { key: 'recipe', label: 'Recipe (for one)', width: 44 },
    ],
    rows,
    summary: [
      { label: 'Dishes', value: dishes.length, type: 'number' },
      { label: 'With a recipe', value: dishes.filter((d) => d.recipe.length).length, type: 'number' },
    ],
    notes: [
      'Food cost % = recipe cost / price. Ingredient costs are their average purchase cost; prices include GST if your rates include GST.',
      ...(partial
        ? [`${partial} dish${partial === 1 ? ' uses' : 'es use'} an ingredient without a cost yet (never bought, no opening stock): the recipe cost leaves it out, so the real cost is higher.`]
        : []),
    ],
  };
}
