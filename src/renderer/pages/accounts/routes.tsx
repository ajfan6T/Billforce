import type { AppRoute } from '../../routing';
import { Placeholder } from '../Placeholder';

export const accountsPages: AppRoute[] = [
  { path: '/accounts/expenses', element: <Placeholder title="Expenses" />, perm: 'expenses.manage' },
  { path: '/accounts/cash-book', element: <Placeholder title="Cash book" />, perm: 'accounts.view' },
  { path: '/accounts/bank-book', element: <Placeholder title="Bank & UPI book" />, perm: 'accounts.view' },
  { path: '/accounts/day-book', element: <Placeholder title="Day book" />, perm: 'accounts.view' },
  { path: '/accounts/ledger', element: <Placeholder title="Ledgers" />, perm: 'accounts.view' },
  { path: '/accounts/journals', element: <Placeholder title="Journal entries" />, perm: ['accounts.view', 'accounts.manage'] },
  { path: '/accounts/capital', element: <Placeholder title="Capital & drawings" />, perm: 'accounts.manage' },
  { path: '/accounts/loans', element: <Placeholder title="Loans" />, perm: ['accounts.view', 'accounts.manage'] },
  { path: '/accounts/transfers', element: <Placeholder title="Cash & bank transfer" />, perm: 'accounts.manage' },
  { path: '/accounts/chart', element: <Placeholder title="Chart of accounts" />, perm: ['accounts.view', 'accounts.chart'] },
  { path: '/accounts/year-end', element: <Placeholder title="Year-end closing" />, perm: 'accounts.close_year' },
];
