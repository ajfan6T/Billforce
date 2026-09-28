/** Sales: bills, sales returns / credit notes, payments received from customers. */
export const SALES_SCHEMA = /* sql */ `
CREATE TABLE bills (
  id INTEGER PRIMARY KEY,
  bill_no TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  fy_start TEXT NOT NULL,
  date TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers (id),
  -- Walk-in name/phone typed at the counter, or a snapshot of the customer record.
  customer_name TEXT,
  customer_phone TEXT,
  subtotal INTEGER NOT NULL,              -- sum of qty x rate (before discounts)
  item_discount INTEGER NOT NULL DEFAULT 0, -- sum of line discounts
  bill_discount INTEGER NOT NULL DEFAULT 0, -- discount on the whole bill
  round_off INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,                 -- subtotal - item_discount - bill_discount + round_off
  paid INTEGER NOT NULL DEFAULT 0,        -- received now via cash / UPI / bank
  credit INTEGER NOT NULL DEFAULT 0,      -- total - paid, added to the customer's balance
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('cash', 'upi', 'bank', 'credit', 'split')),
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  print_count INTEGER NOT NULL DEFAULT 0,
  journal_entry_id INTEGER REFERENCES journal_entries (id),
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE UNIQUE INDEX idx_bills_seq ON bills (fy_start, seq);
CREATE INDEX idx_bills_date ON bills (date);
CREATE INDEX idx_bills_customer ON bills (customer_id);

CREATE TABLE bill_items (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  item_id INTEGER REFERENCES items (id),
  item_name TEXT NOT NULL,
  unit TEXT,
  qty REAL NOT NULL CHECK (qty > 0),
  rate INTEGER NOT NULL CHECK (rate >= 0),
  discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0), -- line discount in paise
  discount_pct REAL,                        -- set when the discount was entered as a percentage
  amount INTEGER NOT NULL                   -- qty x rate - discount
);
CREATE INDEX idx_bill_items_bill ON bill_items (bill_id);
CREATE INDEX idx_bill_items_item ON bill_items (item_id);

CREATE TABLE bill_payments (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'bank')),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reference TEXT
);
CREATE INDEX idx_bill_payments_bill ON bill_payments (bill_id);

-- Sales returns (goods returned against a bill) and credit notes (amount adjustments).
CREATE TABLE credit_notes (
  id INTEGER PRIMARY KEY,
  cn_no TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  fy_start TEXT NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('return', 'adjustment')),
  bill_id INTEGER REFERENCES bills (id),
  customer_id INTEGER REFERENCES customers (id),
  customer_name TEXT,
  subtotal INTEGER NOT NULL,
  round_off INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL CHECK (total > 0),
  -- cash / upi / bank = money refunded now; credit = reduce the customer's balance.
  refund_mode TEXT NOT NULL CHECK (refund_mode IN ('cash', 'upi', 'bank', 'credit')),
  refund_account_id INTEGER REFERENCES accounts (id),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  print_count INTEGER NOT NULL DEFAULT 0,
  journal_entry_id INTEGER REFERENCES journal_entries (id),
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE UNIQUE INDEX idx_cn_seq ON credit_notes (fy_start, seq);
CREATE INDEX idx_cn_date ON credit_notes (date);
CREATE INDEX idx_cn_bill ON credit_notes (bill_id);
CREATE INDEX idx_cn_customer ON credit_notes (customer_id);

CREATE TABLE credit_note_items (
  id INTEGER PRIMARY KEY,
  credit_note_id INTEGER NOT NULL REFERENCES credit_notes (id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  bill_item_id INTEGER REFERENCES bill_items (id) ON DELETE SET NULL,
  item_id INTEGER REFERENCES items (id),
  item_name TEXT NOT NULL,
  unit TEXT,
  qty REAL NOT NULL CHECK (qty > 0),
  rate INTEGER NOT NULL CHECK (rate >= 0),
  amount INTEGER NOT NULL
);
CREATE INDEX idx_cn_items_cn ON credit_note_items (credit_note_id);

CREATE TABLE customer_receipts (
  id INTEGER PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  fy_start TEXT NOT NULL,
  date TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0), -- settlement discount allowed
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
CREATE UNIQUE INDEX idx_receipts_seq ON customer_receipts (fy_start, seq);
CREATE INDEX idx_receipts_date ON customer_receipts (date);
CREATE INDEX idx_receipts_customer ON customer_receipts (customer_id);
`;
