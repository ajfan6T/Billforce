import type { AppRoute } from '../../routing';
import { Placeholder } from '../Placeholder';

export const customersPages: AppRoute[] = [
  { path: '/customers', element: <Placeholder title="Customers" />, perm: 'customers.view' },
  { path: '/customers/receipts', element: <Placeholder title="Payments received" />, perm: ['customers.receive', 'customers.view'] },
  { path: '/customers/outstanding', element: <Placeholder title="Outstanding" />, perm: 'customers.view' },
];
