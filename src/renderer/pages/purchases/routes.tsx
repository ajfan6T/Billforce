import type { AppRoute } from '../../routing';
import { Placeholder } from '../Placeholder';

export const purchasesPages: AppRoute[] = [
  { path: '/suppliers', element: <Placeholder title="Suppliers" />, perm: 'suppliers.view' },
  { path: '/suppliers/payables', element: <Placeholder title="Payables" />, perm: 'suppliers.view' },
  { path: '/purchases', element: <Placeholder title="Purchase bills" />, perm: ['suppliers.view', 'purchases.manage'] },
  { path: '/purchases/payments', element: <Placeholder title="Payments made" />, perm: ['suppliers.view', 'suppliers.pay'] },
];
