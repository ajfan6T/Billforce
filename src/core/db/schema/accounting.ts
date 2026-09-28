/** Double-entry ledger: account groups, chart of accounts, journal entries and lines, loans. */
export const ACCOUNTING_SCHEMA = /* sql */ `
CREATE TABLE account_groups (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  sort_order INTEGER NOT NULL,
  allow_user_accounts INTEGER NOT NULL DEFAULT 1,
  description TEXT
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  group_code TEXT NOT NULL REFERENCES account_groups (code),
  -- Stable identifier for accounts the software posts to automatically (CASH, SALES, AR ...).
  system_key TEXT UNIQUE,
  -- Control accounts: every line on this account must name a party of this type.
  party_type TEXT CHECK (party_type IN ('customer', 'supplier', 'employee')),
  is_active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE journal_entries (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  voucher_type TEXT NOT NULL,
  voucher_no TEXT,
  -- The document that produced this entry: bill, credit_note, receipt, purchase,
  -- supplier_payment, expense, salary, salary_payment, advance, loan, manual, opening, closing.
  source_type TEXT,
  source_id INTEGER,
  narration TEXT,
  -- Void entries are ignored by every balance and report (used when a document is cancelled).
  is_void INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT
);
CREATE INDEX idx_je_date ON journal_entries (date);
CREATE INDEX idx_je_source ON journal_entries (source_type, source_id);
CREATE INDEX idx_je_voucher_type ON journal_entries (voucher_type);

CREATE TABLE journal_lines (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries (id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  debit INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  party_type TEXT CHECK (party_type IN ('customer', 'supplier', 'employee')),
  party_id INTEGER,
  memo TEXT,
  CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX idx_jl_entry ON journal_lines (entry_id);
CREATE INDEX idx_jl_account ON journal_lines (account_id);
CREATE INDEX idx_jl_party ON journal_lines (party_type, party_id);

-- Loans taken (liability) or given (asset). Each loan has its own ledger account.
CREATE TABLE loans (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('taken', 'given')),
  account_id INTEGER NOT NULL UNIQUE REFERENCES accounts (id),
  principal INTEGER NOT NULL DEFAULT 0,
  interest_rate REAL,
  start_date TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
`;
