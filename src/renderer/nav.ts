import {
  BarChart3,
  BookOpen,
  Briefcase,
  LayoutDashboard,
  Receipt,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '../shared/permissions';

export interface NavLinkItem {
  label: string;
  to: string;
  perm?: Permission | Permission[];
}

export interface NavGroup {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Single link groups have `to` and no items. */
  to?: string;
  perm?: Permission | Permission[];
  items?: NavLinkItem[];
}

/** Sidebar navigation. Items the user has no permission for are hidden. */
export const NAV: NavGroup[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, to: '/' },
  {
    key: 'sales',
    label: 'Sales',
    icon: Receipt,
    items: [
      { label: 'New bill', to: '/billing/new', perm: 'billing.create' },
      { label: 'Bills', to: '/sales/bills', perm: ['billing.create', 'billing.view'] },
      { label: 'Returns & credit notes', to: '/sales/returns', perm: ['returns.create', 'returns.adjust'] },
      { label: 'Items & rates', to: '/sales/items', perm: ['items.manage', 'billing.create'] },
    ],
  },
  {
    key: 'customers',
    label: 'Customers',
    icon: Users,
    items: [
      { label: 'Customers', to: '/customers', perm: 'customers.view' },
      { label: 'Payments received', to: '/customers/receipts', perm: ['customers.receive', 'customers.view'] },
      { label: 'Outstanding', to: '/customers/outstanding', perm: 'customers.view' },
    ],
  },
  {
    key: 'purchases',
    label: 'Purchases',
    icon: Truck,
    items: [
      { label: 'Suppliers', to: '/suppliers', perm: 'suppliers.view' },
      { label: 'Purchase bills', to: '/purchases', perm: ['suppliers.view', 'purchases.manage'] },
      { label: 'Payments made', to: '/purchases/payments', perm: ['suppliers.view', 'suppliers.pay'] },
      { label: 'Payables', to: '/suppliers/payables', perm: 'suppliers.view' },
    ],
  },
  {
    key: 'accounts',
    label: 'Accounts',
    icon: BookOpen,
    items: [
      { label: 'Expenses', to: '/accounts/expenses', perm: 'expenses.manage' },
      { label: 'Cash book', to: '/accounts/cash-book', perm: 'accounts.view' },
      { label: 'Bank & UPI book', to: '/accounts/bank-book', perm: 'accounts.view' },
      { label: 'Day book', to: '/accounts/day-book', perm: 'accounts.view' },
      { label: 'Ledgers', to: '/accounts/ledger', perm: 'accounts.view' },
      { label: 'Journal entries', to: '/accounts/journals', perm: ['accounts.view', 'accounts.manage'] },
      { label: 'Capital & drawings', to: '/accounts/capital', perm: 'accounts.manage' },
      { label: 'Loans', to: '/accounts/loans', perm: ['accounts.view', 'accounts.manage'] },
      { label: 'Cash & bank transfer', to: '/accounts/transfers', perm: 'accounts.manage' },
      { label: 'Chart of accounts', to: '/accounts/chart', perm: ['accounts.view', 'accounts.chart'] },
      { label: 'Year-end closing', to: '/accounts/year-end', perm: 'accounts.close_year' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    icon: BarChart3,
    items: [
      { label: 'All reports', to: '/reports', perm: ['reports.sales', 'reports.financial'] },
      { label: 'Sales insights', to: '/reports/sales', perm: 'reports.sales' },
      { label: 'Profit & loss', to: '/reports/profit-loss', perm: 'reports.financial' },
      { label: 'Balance sheet', to: '/reports/balance-sheet', perm: 'reports.financial' },
      { label: 'Trial balance', to: '/reports/trial-balance', perm: 'reports.financial' },
      { label: 'Cash flow', to: '/reports/cash-flow', perm: 'reports.financial' },
      { label: 'Receivables ageing', to: '/reports/receivables-ageing', perm: ['reports.financial', 'customers.view'] },
      { label: 'Payables ageing', to: '/reports/payables-ageing', perm: ['reports.financial', 'suppliers.view'] },
    ],
  },
  {
    key: 'employees',
    label: 'Employees',
    icon: Briefcase,
    items: [
      { label: 'Employees', to: '/employees', perm: 'employees.view' },
      { label: 'Attendance', to: '/employees/attendance', perm: 'employees.attendance' },
      { label: 'Salary', to: '/employees/salary', perm: 'employees.salary' },
      { label: 'Advances', to: '/employees/advances', perm: 'employees.salary' },
    ],
  },
  {
    key: 'admin',
    label: 'Settings & data',
    icon: Settings,
    items: [
      { label: 'Business settings', to: '/settings', perm: 'settings.manage' },
      { label: 'Users & permissions', to: '/admin/users', perm: 'users.manage' },
      { label: 'Activity log', to: '/admin/activity', perm: 'activity.view' },
      { label: 'Backup & restore', to: '/settings/backup', perm: ['data.backup', 'data.restore'] },
      { label: 'Import from Excel / CSV', to: '/settings/import', perm: 'data.import' },
    ],
  },
];

export const NEW_BILL_PATH = '/billing/new';

/** Icon for the prominent "New bill" button. */
export const NewBillIcon = ShoppingCart;
