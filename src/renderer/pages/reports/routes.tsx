import type { AppRoute } from '../../routing';
import { ReportsHomePage } from './ReportsHome';
import { SalesInsightsPage } from './SalesInsights';
import { ProfitLossPage } from './ProfitLoss';
import { BalanceSheetPage } from './BalanceSheet';
import { TrialBalancePage } from './TrialBalance';
import { CashFlowPage } from './CashFlow';
import { PayablesAgeingPage, ReceivablesAgeingPage } from './Ageing';

export const reportsPages: AppRoute[] = [
  { path: '/reports', element: <ReportsHomePage />, perm: ['reports.sales', 'reports.financial', 'customers.view', 'suppliers.view', 'accounts.view'] },
  { path: '/reports/sales', element: <SalesInsightsPage />, perm: 'reports.sales' },
  { path: '/reports/profit-loss', element: <ProfitLossPage />, perm: 'reports.financial' },
  { path: '/reports/balance-sheet', element: <BalanceSheetPage />, perm: 'reports.financial' },
  { path: '/reports/trial-balance', element: <TrialBalancePage />, perm: 'reports.financial' },
  { path: '/reports/cash-flow', element: <CashFlowPage />, perm: 'reports.financial' },
  { path: '/reports/receivables-ageing', element: <ReceivablesAgeingPage />, perm: ['reports.financial', 'customers.view'] },
  { path: '/reports/payables-ageing', element: <PayablesAgeingPage />, perm: ['reports.financial', 'suppliers.view'] },
];
