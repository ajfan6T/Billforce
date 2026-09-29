/**
 * Migration 4: stock / inventory (optional; Settings > Stock). Adds stock
 * settings to items, the item link on purchase lines, the stock movements of
 * every document and stock adjustments. Defaults mean "not tracked", so data
 * from before the update, and businesses that do not track stock, read as before.
 */
export const STOCK_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  // Items: whether stock is kept for the item, and the quantity at which it is "low".
  ['items', 'track_stock', 'INTEGER NOT NULL DEFAULT 0'],
  ['items', 'reorder_level', 'REAL'],
  // Purchase lines can name a catalogue item, so the goods come into its stock.
  ['purchase_items', 'item_id', 'INTEGER REFERENCES items (id)'],
  // Documents made while stock tracking was on move stock (also when edited or cancelled later).
  ['bills', 'stock_tracked', 'INTEGER NOT NULL DEFAULT 0'],
  ['credit_notes', 'stock_tracked', 'INTEGER NOT NULL DEFAULT 0'],
  ['purchases', 'stock_tracked', 'INTEGER NOT NULL DEFAULT 0'],
];

export const STOCK_SCHEMA = /* sql */ `
-- Every change in the quantity of an item: derived from documents (bills, returns, purchases,
-- adjustments) and rewritten when the document is edited; removed when it is cancelled.
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items (id),
  date TEXT NOT NULL,
  qty REAL NOT NULL,                  -- in the item's unit: + coming in, - going out
  kind TEXT NOT NULL CHECK (kind IN ('opening', 'purchase', 'sale', 'sale_return', 'adjustment')),
  -- Cost of the goods coming in (opening stock, purchases, stock added at a cost), in paise.
  -- NULL: valued at the average cost (sales, returns, most adjustments).
  value INTEGER,
  source_type TEXT NOT NULL,          -- opening | bill | credit_note | purchase | adjustment
  source_id INTEGER,
  source_line INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_moves_item ON stock_moves (item_id, date);
CREATE INDEX IF NOT EXISTS idx_stock_moves_source ON stock_moves (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_stock_moves_date ON stock_moves (date);

-- Stock counts (the quantity found on the shelf) and adjustments (damaged, expired, own use, found ...).
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id INTEGER PRIMARY KEY,
  adj_no TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  fy_start TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('count', 'adjust')),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_adj_seq ON stock_adjustments (fy_start, seq);
CREATE INDEX IF NOT EXISTS idx_stock_adj_date ON stock_adjustments (date);

CREATE TABLE IF NOT EXISTS stock_adjustment_items (
  id INTEGER PRIMARY KEY,
  adjustment_id INTEGER NOT NULL REFERENCES stock_adjustments (id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items (id),
  counted REAL,                       -- stock count: the quantity found
  book_qty REAL,                      -- stock count: the quantity the books showed then
  qty REAL NOT NULL,                  -- the change: + added, - taken out
  unit_cost INTEGER,                  -- paise per unit for stock added at a cost (NULL = average cost)
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_stock_adj_items ON stock_adjustment_items (adjustment_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_item ON purchase_items (item_id);
`;

/**
 * Migration 6: the running quantity and moving average cost after each movement, so the
 * value of stock on any date is one look-up per item (filled in for existing movements).
 */
export const STOCK_RUNNING_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  ['stock_moves', 'bal_qty', 'REAL'],
  ['stock_moves', 'avg_cost', 'REAL'],
];
