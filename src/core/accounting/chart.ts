import type { AccountType, PartyType } from '../../shared/constants';

export interface GroupSeed {
  code: string;
  name: string;
  type: AccountType;
  sort: number;
  allowUserAccounts: boolean;
  /** First account code for this group; new accounts get the next free number. */
  codeBase: number;
  description: string;
}

/** Fixed account groups (the top of the chart of accounts). */
export const ACCOUNT_GROUPS: GroupSeed[] = [
  { code: 'cash', name: 'Cash-in-Hand', type: 'asset', sort: 10, allowUserAccounts: true, codeBase: 1001, description: 'Cash kept at the shop or with the owner' },
  { code: 'bank', name: 'Bank & UPI Accounts', type: 'asset', sort: 20, allowUserAccounts: true, codeBase: 1101, description: 'Bank accounts and UPI-linked accounts' },
  { code: 'receivables', name: 'Sundry Debtors (Customers)', type: 'asset', sort: 30, allowUserAccounts: false, codeBase: 1201, description: 'Amounts customers owe you' },
  { code: 'current_assets', name: 'Other Current Assets', type: 'asset', sort: 40, allowUserAccounts: true, codeBase: 1301, description: 'Deposits, prepaid expenses and similar' },
  { code: 'loans_advances', name: 'Loans & Advances Given', type: 'asset', sort: 50, allowUserAccounts: true, codeBase: 1401, description: 'Loans given and advances to employees' },
  { code: 'fixed_assets', name: 'Fixed Assets', type: 'asset', sort: 60, allowUserAccounts: true, codeBase: 1501, description: 'Furniture, equipment, vehicles' },
  { code: 'payables', name: 'Sundry Creditors (Suppliers)', type: 'liability', sort: 110, allowUserAccounts: false, codeBase: 2001, description: 'Amounts you owe suppliers' },
  { code: 'current_liabilities', name: 'Current Liabilities', type: 'liability', sort: 120, allowUserAccounts: true, codeBase: 2101, description: 'Salary payable and other dues' },
  { code: 'loans', name: 'Loans Taken', type: 'liability', sort: 130, allowUserAccounts: true, codeBase: 2201, description: 'Bank loans and borrowings' },
  { code: 'capital', name: 'Capital Account', type: 'equity', sort: 210, allowUserAccounts: true, codeBase: 3001, description: "Owner's capital" },
  { code: 'drawings', name: 'Drawings', type: 'equity', sort: 220, allowUserAccounts: true, codeBase: 3101, description: 'Money or goods taken out by the owner' },
  { code: 'sales', name: 'Sales', type: 'income', sort: 310, allowUserAccounts: true, codeBase: 4001, description: 'Sales and sales returns' },
  { code: 'indirect_income', name: 'Other Income', type: 'income', sort: 320, allowUserAccounts: true, codeBase: 4101, description: 'Discounts received, interest and other income' },
  { code: 'purchases', name: 'Purchases', type: 'expense', sort: 410, allowUserAccounts: true, codeBase: 5001, description: 'Goods bought for resale or use' },
  { code: 'direct_expenses', name: 'Direct Expenses', type: 'expense', sort: 420, allowUserAccounts: true, codeBase: 5101, description: 'Freight inward, labour and other direct costs' },
  { code: 'indirect_expenses', name: 'Indirect Expenses', type: 'expense', sort: 430, allowUserAccounts: true, codeBase: 6001, description: 'Rent, salaries, electricity and other running costs' },
];

export const SYSTEM_KEYS = [
  'CASH',
  'BANK',
  'UPI',
  'AR',
  'EMP_ADV',
  'AP',
  'SALARY_PAYABLE',
  'CAPITAL',
  'OPENING_EQUITY',
  'DRAWINGS',
  'SALES',
  'SALES_RETURNS',
  'DISCOUNT_RECEIVED',
  'INTEREST_INCOME',
  'OTHER_INCOME',
  'PURCHASES',
  'SALARY',
  'DISCOUNT_ALLOWED',
  'ROUND_OFF',
  'INTEREST_EXPENSE',
  // GST accounts: created only when the business registers for GST (GST_ACCOUNTS).
  'GST_OUT_CGST',
  'GST_OUT_SGST',
  'GST_OUT_IGST',
  'GST_IN_CGST',
  'GST_IN_SGST',
  'GST_IN_IGST',
  'COMPOSITION_TAX',
  // Created only when stock tracking is turned on (STOCK_ACCOUNTS).
  'STOCK',
] as const;
export type SystemKey = (typeof SYSTEM_KEYS)[number];

export interface AccountSeed {
  code: string;
  name: string;
  group: string;
  systemKey?: SystemKey;
  partyType?: PartyType;
  description?: string;
}

/** Accounts the software posts to automatically. Always present; cannot be deleted. */
export const SYSTEM_ACCOUNTS: AccountSeed[] = [
  { code: '1001', name: 'Cash in Hand', group: 'cash', systemKey: 'CASH' },
  { code: '1101', name: 'Bank Account', group: 'bank', systemKey: 'BANK', description: 'Default account for "Bank" payments' },
  { code: '1102', name: 'UPI Account', group: 'bank', systemKey: 'UPI', description: 'Default account for "UPI" payments (the bank account linked to your UPI ID)' },
  { code: '1201', name: 'Sundry Debtors', group: 'receivables', systemKey: 'AR', partyType: 'customer', description: 'Total of all customer balances' },
  { code: '1401', name: 'Employee Advances', group: 'loans_advances', systemKey: 'EMP_ADV', partyType: 'employee' },
  { code: '2001', name: 'Sundry Creditors', group: 'payables', systemKey: 'AP', partyType: 'supplier', description: 'Total of all supplier balances' },
  { code: '2101', name: 'Salary Payable', group: 'current_liabilities', systemKey: 'SALARY_PAYABLE', partyType: 'employee' },
  { code: '3001', name: "Owner's Capital", group: 'capital', systemKey: 'CAPITAL' },
  { code: '3002', name: 'Opening Balance Adjustment', group: 'capital', systemKey: 'OPENING_EQUITY', description: 'Balancing figure for opening balances entered when you started using Billforce' },
  { code: '3101', name: 'Drawings', group: 'drawings', systemKey: 'DRAWINGS' },
  { code: '4001', name: 'Sales', group: 'sales', systemKey: 'SALES' },
  { code: '4002', name: 'Sales Returns', group: 'sales', systemKey: 'SALES_RETURNS' },
  { code: '4101', name: 'Discount Received', group: 'indirect_income', systemKey: 'DISCOUNT_RECEIVED' },
  { code: '4102', name: 'Interest Received', group: 'indirect_income', systemKey: 'INTEREST_INCOME' },
  { code: '4103', name: 'Other Income', group: 'indirect_income', systemKey: 'OTHER_INCOME' },
  { code: '5001', name: 'Purchases', group: 'purchases', systemKey: 'PURCHASES' },
  { code: '6001', name: 'Salaries & Wages', group: 'indirect_expenses', systemKey: 'SALARY' },
  { code: '6002', name: 'Discount Allowed', group: 'indirect_expenses', systemKey: 'DISCOUNT_ALLOWED' },
  { code: '6003', name: 'Round Off', group: 'indirect_expenses', systemKey: 'ROUND_OFF' },
  { code: '6004', name: 'Interest Paid', group: 'indirect_expenses', systemKey: 'INTEREST_EXPENSE' },
];

/**
 * GST accounts, created (and re-created if missing) only while the business is registered for GST,
 * so unregistered businesses never see them. Tax collected on sales is a current liability; tax paid on
 * purchases (input tax credit) is a current asset until it is set off against the tax collected.
 */
export const GST_ACCOUNTS: AccountSeed[] = [
  { code: '2111', name: 'Output CGST', group: 'current_liabilities', systemKey: 'GST_OUT_CGST', description: 'Central GST collected on sales' },
  { code: '2112', name: 'Output SGST', group: 'current_liabilities', systemKey: 'GST_OUT_SGST', description: 'State GST collected on sales' },
  { code: '2113', name: 'Output IGST', group: 'current_liabilities', systemKey: 'GST_OUT_IGST', description: 'Integrated GST collected on sales to other states' },
  { code: '1311', name: 'Input CGST', group: 'current_assets', systemKey: 'GST_IN_CGST', description: 'Central GST paid on purchases (input tax credit)' },
  { code: '1312', name: 'Input SGST', group: 'current_assets', systemKey: 'GST_IN_SGST', description: 'State GST paid on purchases (input tax credit)' },
  { code: '1313', name: 'Input IGST', group: 'current_assets', systemKey: 'GST_IN_IGST', description: 'Integrated GST paid on purchases (input tax credit)' },
  { code: '6030', name: 'Composition Tax', group: 'indirect_expenses', systemKey: 'COMPOSITION_TAX', description: 'GST paid on turnover under the composition scheme' },
];

/** Created (and re-created if missing) while stock tracking is on: the stock held, valued at average cost. */
export const STOCK_ACCOUNTS: AccountSeed[] = [
  { code: '1320', name: 'Stock in Hand', group: 'current_assets', systemKey: 'STOCK', description: 'Goods in the shop, at average purchase cost (opening stock, then the closing stock of each closed year)' },
];

/** Common accounts created once for a new business; the owner can rename or deactivate them. */
export const DEFAULT_ACCOUNTS: AccountSeed[] = [
  { code: '1301', name: 'Security Deposits', group: 'current_assets' },
  { code: '1501', name: 'Furniture & Fixtures', group: 'fixed_assets' },
  { code: '1502', name: 'Computers & Equipment', group: 'fixed_assets' },
  { code: '5101', name: 'Freight Inward', group: 'direct_expenses' },
  { code: '5102', name: 'Labour Charges', group: 'direct_expenses' },
  { code: '6010', name: 'Rent', group: 'indirect_expenses' },
  { code: '6011', name: 'Electricity', group: 'indirect_expenses' },
  { code: '6012', name: 'Telephone & Internet', group: 'indirect_expenses' },
  { code: '6013', name: 'Transport & Delivery', group: 'indirect_expenses' },
  { code: '6014', name: 'Repairs & Maintenance', group: 'indirect_expenses' },
  { code: '6015', name: 'Printing & Stationery', group: 'indirect_expenses' },
  { code: '6016', name: 'Tea & Refreshments', group: 'indirect_expenses' },
  { code: '6017', name: 'Bank Charges', group: 'indirect_expenses' },
  { code: '6018', name: 'Packing Materials', group: 'indirect_expenses' },
  { code: '6019', name: 'Advertisement', group: 'indirect_expenses' },
  { code: '6020', name: 'Shop Maintenance', group: 'indirect_expenses' },
  { code: '6099', name: 'Miscellaneous Expenses', group: 'indirect_expenses' },
];
