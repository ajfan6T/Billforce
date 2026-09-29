/**
 * Migration 5: restaurant menu (optional; Settings > Stock & menu). Dishes are
 * items with a recipe of ingredients; ingredients are items kept in stock but
 * not sold. Defaults keep every existing item exactly as it was (sold, no recipe).
 */
export const MENU_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  // 0 = an ingredient: kept in stock, never offered on bills (while the menu is on).
  ['items', 'sellable', 'INTEGER NOT NULL DEFAULT 1'],
  // 1 = a dish on the menu (it may have a recipe).
  ['items', 'menu', 'INTEGER NOT NULL DEFAULT 0'],
];

export const MENU_SCHEMA = /* sql */ `
-- What goes into one unit (plate, portion ...) of a dish.
CREATE TABLE IF NOT EXISTS recipe_items (
  id INTEGER PRIMARY KEY,
  dish_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  ingredient_id INTEGER NOT NULL REFERENCES items (id),
  qty REAL NOT NULL CHECK (qty > 0),
  unit TEXT NOT NULL,             -- as written in the recipe (g, kg, ml, ltr, pcs ...), converted to the ingredient's unit
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_recipe_dish ON recipe_items (dish_id);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredient ON recipe_items (ingredient_id);
`;
