import type { AppRoute } from './routing';
import { dashboardPages } from './pages/dashboard/routes';
import { salesPages } from './pages/sales/routes';
import { customersPages } from './pages/customers/routes';
import { purchasesPages } from './pages/purchases/routes';
import { accountsPages } from './pages/accounts/routes';
import { reportsPages } from './pages/reports/routes';
import { employeesPages } from './pages/employees/routes';
import { adminPages } from './pages/admin/routes';

/** All pages. Each module owns its own list in pages/<module>/routes.tsx. */
export const APP_ROUTES: AppRoute[] = [
  ...dashboardPages,
  ...salesPages,
  ...customersPages,
  ...purchasesPages,
  ...accountsPages,
  ...reportsPages,
  ...employeesPages,
  ...adminPages,
];
