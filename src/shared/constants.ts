export const PAYMENT_MODES = ['cash', 'upi', 'bank', 'credit'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** Modes that move money immediately (everything except credit). */
export const SETTLEMENT_MODES = ['cash', 'upi', 'bank'] as const;
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  cash: 'Cash',
  upi: 'UPI',
  bank: 'Bank',
  credit: 'Credit',
};

export const ROLES = ['owner', 'manager', 'cashier'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
};

export const UNITS = ['pcs', 'kg', 'g', 'ltr', 'ml', 'mtr', 'box', 'pack', 'dozen', 'pair', 'set', 'bag', 'bottle', 'plate', 'hour', 'service'] as const;

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Capital & Equity',
  income: 'Income',
  expense: 'Expenses',
};

/** Account types whose normal balance is a debit. */
export const DEBIT_NATURE: Record<AccountType, boolean> = {
  asset: true,
  expense: true,
  liability: false,
  equity: false,
  income: false,
};

export const VOUCHER_TYPES = [
  'sale',
  'sale_return',
  'receipt',
  'purchase',
  'payment',
  'expense',
  'journal',
  'contra',
  'capital',
  'drawings',
  'loan',
  'advance',
  'salary',
  'salary_payment',
  'opening',
  'closing',
  'gst_payment',
] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

export const VOUCHER_TYPE_LABELS: Record<VoucherType, string> = {
  sale: 'Sales Bill',
  sale_return: 'Sales Return / Credit Note',
  receipt: 'Payment Received',
  purchase: 'Purchase Bill',
  payment: 'Payment Made',
  expense: 'Expense',
  journal: 'Journal',
  contra: 'Cash / Bank Transfer',
  capital: 'Capital Introduced',
  drawings: 'Drawings',
  loan: 'Loan',
  advance: 'Employee Advance',
  salary: 'Salary',
  salary_payment: 'Salary Payment',
  opening: 'Opening Balance',
  closing: 'Year-end Closing',
  gst_payment: 'GST Payment',
};

export const PARTY_TYPES = ['customer', 'supplier', 'employee'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

/** Document number series. Prefix is configurable in settings. */
export const SEQUENCE_KEYS = [
  'bill',
  'credit_note',
  'receipt',
  'purchase',
  'payment',
  'expense',
  'journal',
  'salary',
  'advance',
  'stock_adjustment',
] as const;
export type SequenceKey = (typeof SEQUENCE_KEYS)[number];

export const DEFAULT_PREFIXES: Record<SequenceKey, string> = {
  bill: 'INV',
  credit_note: 'CN',
  receipt: 'RCT',
  purchase: 'PUR',
  payment: 'PAY',
  expense: 'EXP',
  journal: 'JV',
  salary: 'SAL',
  advance: 'ADV',
  stock_adjustment: 'ADJ',
};

export const SEQUENCE_LABELS: Record<SequenceKey, string> = {
  bill: 'Sales bills',
  credit_note: 'Returns / credit notes',
  receipt: 'Payments received',
  purchase: 'Purchase bills',
  payment: 'Payments made',
  expense: 'Expenses',
  journal: 'Journal vouchers',
  salary: 'Salary slips',
  advance: 'Employee advances',
  stock_adjustment: 'Stock counts & adjustments',
};

export const ATTENDANCE_STATUSES = ['P', 'A', 'H', 'L', 'W'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = {
  P: 'Present',
  A: 'Absent',
  H: 'Half day',
  L: 'Paid leave',
  W: 'Weekly off',
};

/** What a failed login says (wrong password, or an unknown / inactive user). The lock screen words it for a password only. */
export const WRONG_LOGIN_MESSAGE = 'Wrong username or password';
