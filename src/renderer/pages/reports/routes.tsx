import type { AppRoute } from '../../routing';
import { Placeholder } from '../Placeholder';

export const reportsPages: AppRoute[] = [
  { path: '/reports', element: <Placeholder title="Reports" />, perm: ['reports.sales', 'reports.financial'] },
  { path: '/reports/sales', element: <Placeholder title="Sales insights" />, perm: 'reports.sales' },
  { path: '/reports/profit-loss', element: <Placeholder title="Profit & loss" />, perm: 'reports.financial' },
  { path: '/reports/balance-sheet', element: <Placeholder title="Balance sheet" />, perm: 'reports.financial' },
  { path: '/reports/trial-balance', element: <Placeholder title="Trial balance" />, perm: 'reports.financial' },
  { path: '/reports/cash-flow', element: <Placeholder title="Cash flow" />, perm: 'reports.financial' },
  { path: '/reports/receivables-ageing', element: <Placeholder title="Receivables ageing" />, perm: ['reports.financial', 'customers.view'] },
  { path: '/reports/payables-ageing', element: <Placeholder title="Payables ageing" />, perm: ['reports.financial', 'suppliers.view'] },
];
