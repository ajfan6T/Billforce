import type { Role } from './constants';

export interface PermissionDef {
  key: string;
  label: string;
  group: string;
}

/**
 * Every permission in the system. The Owner role always has all of them;
 * Manager and Cashier get the defaults below, which the Owner can change.
 */
export const PERMISSIONS = [
  // Sales & billing
  { key: 'billing.create', label: 'Create bills', group: 'Sales & billing' },
  { key: 'billing.view', label: 'View bills (all days)', group: 'Sales & billing' },
  { key: 'billing.discount', label: 'Give discounts', group: 'Sales & billing' },
  { key: 'billing.edit', label: 'Edit saved bills', group: 'Sales & billing' },
  { key: 'billing.cancel', label: 'Cancel bills', group: 'Sales & billing' },
  { key: 'billing.backdate', label: 'Create bills with a past date', group: 'Sales & billing' },
  { key: 'billing.reprint', label: 'Reprint bills', group: 'Sales & billing' },
  { key: 'returns.create', label: 'Sales returns & credit notes', group: 'Sales & billing' },
  { key: 'returns.cancel', label: 'Cancel returns & credit notes', group: 'Sales & billing' },
  { key: 'items.manage', label: 'Add / edit items and rates', group: 'Sales & billing' },

  // Customers
  { key: 'customers.view', label: 'View customers & balances', group: 'Customers' },
  { key: 'customers.manage', label: 'Add / edit customers', group: 'Customers' },
  { key: 'customers.receive', label: 'Record payments received', group: 'Customers' },

  // Suppliers & purchases
  { key: 'suppliers.view', label: 'View suppliers & purchases', group: 'Suppliers & purchases' },
  { key: 'suppliers.manage', label: 'Add / edit suppliers', group: 'Suppliers & purchases' },
  { key: 'purchases.manage', label: 'Enter / edit purchase bills', group: 'Suppliers & purchases' },
  { key: 'suppliers.pay', label: 'Record payments to suppliers', group: 'Suppliers & purchases' },

  // Accounting
  { key: 'expenses.manage', label: 'Record expenses', group: 'Accounting' },
  { key: 'accounts.view', label: 'View books & ledgers', group: 'Accounting' },
  { key: 'accounts.manage', label: 'Journals, capital, drawings, loans, transfers', group: 'Accounting' },
  { key: 'accounts.chart', label: 'Edit chart of accounts', group: 'Accounting' },
  { key: 'accounts.close_year', label: 'Year-end closing', group: 'Accounting' },

  // Reports
  { key: 'reports.sales', label: 'Sales reports & insights', group: 'Reports' },
  { key: 'reports.financial', label: 'Financial reports (P&L, balance sheet...)', group: 'Reports' },
  { key: 'reports.export', label: 'Export reports (Excel, CSV, PDF)', group: 'Reports' },

  // Employees
  { key: 'employees.view', label: 'View employees', group: 'Employees' },
  { key: 'employees.manage', label: 'Add / edit employees', group: 'Employees' },
  { key: 'employees.attendance', label: 'Mark attendance', group: 'Employees' },
  { key: 'employees.salary', label: 'Salary & advances', group: 'Employees' },

  // Administration
  { key: 'users.manage', label: 'Manage users & permissions', group: 'Administration' },
  { key: 'activity.view', label: 'View activity log', group: 'Administration' },
  { key: 'settings.manage', label: 'Change settings', group: 'Administration' },
  { key: 'data.backup', label: 'Backup data', group: 'Administration' },
  { key: 'data.restore', label: 'Restore data from backup', group: 'Administration' },
  { key: 'data.import', label: 'Import from Excel / CSV', group: 'Administration' },
] as const satisfies readonly PermissionDef[];

export type Permission = (typeof PERMISSIONS)[number]['key'];

export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((p) => p.key);

export const DEFAULT_ROLE_PERMISSIONS: Record<Exclude<Role, 'owner'>, Permission[]> = {
  manager: [
    'billing.create',
    'billing.view',
    'billing.discount',
    'billing.edit',
    'billing.cancel',
    'billing.backdate',
    'billing.reprint',
    'returns.create',
    'returns.cancel',
    'items.manage',
    'customers.view',
    'customers.manage',
    'customers.receive',
    'suppliers.view',
    'suppliers.manage',
    'purchases.manage',
    'suppliers.pay',
    'expenses.manage',
    'accounts.view',
    'accounts.manage',
    'reports.sales',
    'reports.financial',
    'reports.export',
    'employees.view',
    'employees.manage',
    'employees.attendance',
    'employees.salary',
    'activity.view',
    'data.backup',
    'data.import',
  ],
  cashier: [
    'billing.create',
    'billing.discount',
    'billing.reprint',
    'returns.create',
    'customers.view',
    'customers.manage',
    'customers.receive',
  ],
};

export function isPermission(key: string): key is Permission {
  return (ALL_PERMISSIONS as string[]).includes(key);
}
