import type { AppRoute } from '../../routing';
import { Placeholder } from '../Placeholder';

export const salesPages: AppRoute[] = [
  { path: '/billing/new', element: <Placeholder title="New bill" />, perm: 'billing.create', fullBleed: true },
  { path: '/sales/bills', element: <Placeholder title="Bills" />, perm: ['billing.create', 'billing.view'] },
  { path: '/sales/returns', element: <Placeholder title="Returns & credit notes" />, perm: 'returns.create' },
  { path: '/sales/items', element: <Placeholder title="Items & rates" />, perm: ['items.manage', 'billing.create'] },
];
