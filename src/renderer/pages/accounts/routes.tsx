import type { AppRoute } from '../../routing';
import { ExpensesPage } from './Expenses';
import { ExpenseDetailPage } from './ExpenseDetail';
import { BankBookPage, CashBookPage, DayBookPage } from './Books';
import { LedgerPage } from './Ledger';
import { JournalsListPage } from './JournalsList';
import { JournalFormPage } from './JournalForm';
import { JournalViewPage } from './JournalView';
import { CapitalPage } from './Capital';
import { LoansPage } from './Loans';
import { LoanDetailPage } from './LoanDetail';
import { TransfersPage } from './Transfers';
import { ChartOfAccountsPage } from './ChartOfAccounts';
import { YearEndPage } from './YearEnd';
import { GstPaymentPage } from './GstPayment';

export const accountsPages: AppRoute[] = [
  { path: '/accounts/expenses', element: <ExpensesPage />, perm: 'expenses.manage' },
  { path: '/accounts/expenses/:id', element: <ExpenseDetailPage />, perm: ['expenses.manage', 'accounts.view'] },
  { path: '/accounts/cash-book', element: <CashBookPage />, perm: 'accounts.view' },
  { path: '/accounts/bank-book', element: <BankBookPage />, perm: 'accounts.view' },
  { path: '/accounts/day-book', element: <DayBookPage />, perm: 'accounts.view' },
  { path: '/accounts/ledger', element: <LedgerPage />, perm: 'accounts.view' },
  { path: '/accounts/journals', element: <JournalsListPage />, perm: ['accounts.view', 'accounts.manage'] },
  { path: '/accounts/journals/new', element: <JournalFormPage />, perm: 'accounts.manage' },
  { path: '/accounts/journals/:id', element: <JournalViewPage />, perm: ['accounts.view', 'accounts.manage'] },
  { path: '/accounts/journals/:id/edit', element: <JournalFormPage />, perm: 'accounts.manage' },
  { path: '/accounts/capital', element: <CapitalPage />, perm: 'accounts.manage' },
  { path: '/accounts/loans', element: <LoansPage />, perm: ['accounts.view', 'accounts.manage'] },
  { path: '/accounts/loans/:id', element: <LoanDetailPage />, perm: ['accounts.view', 'accounts.manage'] },
  { path: '/accounts/transfers', element: <TransfersPage />, perm: 'accounts.manage' },
  { path: '/accounts/chart', element: <ChartOfAccountsPage />, perm: ['accounts.view', 'accounts.chart'] },
  { path: '/accounts/year-end', element: <YearEndPage />, perm: 'accounts.close_year' },
  { path: '/accounts/gst-payment', element: <GstPaymentPage />, perm: 'accounts.manage' },
];
