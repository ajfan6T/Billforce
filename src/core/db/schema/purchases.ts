/** Purchases, payments to suppliers, and expenses. */
export const PURCHASES_SCHEMA = /* sql */ `
CREATE TABLE purchases (
  id INTEGER PRIMARY KEY,
  purchase_no TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  fy_start TEXT NOT NULL,
  date TEXT NOT NULL,
  supplier_id INTEGER REFERENCES suppliers (id),
  supplier_name TEXT,                       -- for cash purchases without a supplier record
  supplier_bill_no TEXT,
  supplier_bill_date TEXT,
  expense_account_id INTEGER NOT NULL REFERENCES accounts (id), -- usually "Purchases"
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  other_charges INTEGER NOT NULL DEFAULT 0,  -- freight, loading etc.
  round_off INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,          -- added to the amount payable to the supplier
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('cash', 'upi', 'bank', 'credit', 'split')),
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  journal_entry_id INTEGER REFERENCES journal_entries (id),
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE UNIQUE INDEX idx_purchases_seq ON purchases (fy_start, seq);
CREATE INDEX idx_purchases_date ON purchases (date);
CREATE INDEX idx_purchases_supplier ON purchases (supplier_id);

CREATE TABLE purchase_items (
  id INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases (id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  description TEXT NOT NULL,
  unit TEXT,
  qty REAL NOT NULL CHECK (qty > 0),
  rate INTEGER NOT NULL CHECK (rate >= 0),
  amount INTEGER NOT NULL
);
CREATE INDEX idx_purchase_items_purchase ON purchase_items (purchase_id);

CREATE TABLE purchase_payments (
  id INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'bank')),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reference TEXT
);
CREATE INDEX idx_purchase_payments_purchase ON purchase_payments (purchase_id);

CREATE TABLE supplier_payments (
  id INTEGER PRIMARY KEY,
  payment_no TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  fy_start TEXT NOT NULL,
  date TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers (id),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0), -- settlement discount received
  mode TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'bank')),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  reference TEXT,
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  journal_entry_id INTEGER REFERENCES journal_entries (id),
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE UNIQUE INDEX idx_supplier_payments_seq ON supplier_payments (fy_start, seq);
CREATE INDEX idx_supplier_payments_date ON supplier_payments (date);
CREATE INDEX idx_supplier_payments_supplier ON supplier_payments (supplier_id);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  expense_no TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  fy_start TEXT NOT NULL,
  date TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts (id),   -- expense head
  amount INTEGER NOT NULL CHECK (amount > 0),
  mode TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'bank', 'credit')),
  pay_account_id INTEGER REFERENCES accounts (id),        -- NULL when on credit
  supplier_id INTEGER REFERENCES suppliers (id),          -- required when on credit
  payee TEXT,
  reference TEXT,
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  journal_entry_id INTEGER REFERENCES journal_entries (id),
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE UNIQUE INDEX idx_expenses_seq ON expenses (fy_start, seq);
CREATE INDEX idx_expenses_date ON expenses (date);
`;
