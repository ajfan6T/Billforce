/** Employees, attendance, salary and advances. */
export const EMPLOYEES_SCHEMA = /* sql */ `
CREATE TABLE employees (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  designation TEXT,
  join_date TEXT,
  leave_date TEXT,
  salary_type TEXT NOT NULL DEFAULT 'monthly' CHECK (salary_type IN ('monthly', 'daily')),
  salary_amount INTEGER NOT NULL DEFAULT 0,  -- per month (monthly) or per day (daily)
  weekly_off INTEGER CHECK (weekly_off BETWEEN 0 AND 6), -- 0 = Sunday; NULL = none
  id_proof TEXT,
  bank_details TEXT,
  notes TEXT,
  -- Advance already given before the books start (Dr Employee Advances / Cr Opening Balance Adjustment).
  opening_entry_id INTEGER REFERENCES journal_entries (id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX idx_employees_name ON employees (name COLLATE NOCASE);

-- P = present, A = absent, H = half day, L = paid leave, W = weekly off
CREATE TABLE attendance (
  employee_id INTEGER NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('P', 'A', 'H', 'L', 'W')),
  note TEXT,
  marked_by INTEGER,
  marked_at TEXT,
  PRIMARY KEY (employee_id, date)
);
CREATE INDEX idx_attendance_date ON attendance (date);

CREATE TABLE employee_advances (
  id INTEGER PRIMARY KEY,
  advance_no TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  fy_start TEXT NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees (id),
  date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  mode TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'bank')),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  journal_entry_id INTEGER REFERENCES journal_entries (id),
  created_by INTEGER,
  created_at TEXT NOT NULL,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE INDEX idx_advances_employee ON employee_advances (employee_id);

-- One salary slip per employee per month. Posting: Dr Salaries, Cr Employee Advances
-- (recovery), Cr Salary Payable (net). Payments then clear Salary Payable.
CREATE TABLE salaries (
  id INTEGER PRIMARY KEY,
  salary_no TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL,
  fy_start TEXT NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees (id),
  month TEXT NOT NULL,                  -- YYYY-MM
  date TEXT NOT NULL,                   -- posting date
  salary_type TEXT NOT NULL,
  rate INTEGER NOT NULL,                -- snapshot of monthly / daily rate
  days_in_month INTEGER NOT NULL,
  paid_days REAL NOT NULL,
  gross INTEGER NOT NULL,
  bonus INTEGER NOT NULL DEFAULT 0,
  deductions INTEGER NOT NULL DEFAULT 0,
  advance_recovery INTEGER NOT NULL DEFAULT 0,
  net INTEGER NOT NULL,                 -- gross + bonus - deductions - advance_recovery
  -- JSON snapshot of how paid days were worked out (employment window, attendance counts).
  details TEXT,
  paid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'partly_paid', 'paid', 'cancelled')),
  remarks TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries (id),
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE UNIQUE INDEX idx_salaries_employee_month ON salaries (employee_id, month) WHERE status <> 'cancelled';
CREATE INDEX idx_salaries_month ON salaries (month);

CREATE TABLE salary_payments (
  id INTEGER PRIMARY KEY,
  salary_id INTEGER NOT NULL REFERENCES salaries (id),
  date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  mode TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'bank')),
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  journal_entry_id INTEGER REFERENCES journal_entries (id),
  created_by INTEGER,
  created_at TEXT NOT NULL,
  cancelled_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE INDEX idx_salary_payments_salary ON salary_payments (salary_id);
`;
