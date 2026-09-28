/** Master data: items (price list), customers, suppliers. */
export const MASTERS_SCHEMA = /* sql */ `
-- Items are a price list for quick billing. Stock is intentionally not tracked.
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  code TEXT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  rate INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX idx_items_code ON items (code);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  email TEXT,
  credit_limit INTEGER,
  notes TEXT,
  opening_entry_id INTEGER REFERENCES journal_entries (id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX idx_customers_name ON customers (name COLLATE NOCASE);
CREATE INDEX idx_customers_phone ON customers (phone);

CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  email TEXT,
  contact_person TEXT,
  notes TEXT,
  opening_entry_id INTEGER REFERENCES journal_entries (id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX idx_suppliers_name ON suppliers (name COLLATE NOCASE);
`;
