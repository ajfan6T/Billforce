/**
 * Every API route in the app. The renderer imports only the *type* of this
 * object, which gives end-to-end type checking of every call.
 */
import { authRoutes } from '../modules/auth/routes';
import { filesRoutes } from '../modules/files/routes';
import { itemsRoutes } from '../modules/items/routes';
import { salesRoutes } from '../modules/sales/routes';
import { returnsRoutes } from '../modules/returns/routes';
import { customersRoutes } from '../modules/customers/routes';
import { suppliersRoutes } from '../modules/suppliers/routes';
import { purchasesRoutes } from '../modules/purchases/routes';
import { accountingRoutes } from '../modules/accounting/routes';
import { reportsRoutes } from '../modules/reports/routes';
import { dashboardRoutes } from '../modules/dashboard/routes';
import { employeesRoutes } from '../modules/employees/routes';
import { usersRoutes } from '../modules/users/routes';
import { settingsRoutes } from '../modules/settings/routes';
import { dataRoutes } from '../modules/data/routes';
import { gstRoutes } from '../modules/gst/routes';
import { stockRoutes } from '../modules/stock/routes';
import { menuRoutes } from '../modules/menu/routes';
import type { RouteInput, RouteOutput } from './router';

export const routes = {
  ...authRoutes,
  ...filesRoutes,
  ...itemsRoutes,
  ...salesRoutes,
  ...returnsRoutes,
  ...customersRoutes,
  ...suppliersRoutes,
  ...purchasesRoutes,
  ...accountingRoutes,
  ...reportsRoutes,
  ...dashboardRoutes,
  ...employeesRoutes,
  ...usersRoutes,
  ...settingsRoutes,
  ...dataRoutes,
  ...gstRoutes,
  ...stockRoutes,
  ...menuRoutes,
};

export type Routes = typeof routes;
export type RouteName = keyof Routes & string;
export type ApiInput<K extends RouteName> = RouteInput<Routes[K]>;
export type ApiOutput<K extends RouteName> = RouteOutput<Routes[K]>;
