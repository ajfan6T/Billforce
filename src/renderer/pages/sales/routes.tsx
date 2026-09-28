import type { AppRoute } from '../../routing';
import { BillingScreen } from './BillingScreen';
import { BillsList } from './BillsList';
import { BillDetail } from './BillDetail';
import { ReturnsList } from './ReturnsList';
import { ReturnNew } from './ReturnNew';
import { ReturnDetail } from './ReturnDetail';
import { ItemsPage } from './ItemsPage';

export const salesPages: AppRoute[] = [
  { path: '/billing/new', element: <BillingScreen />, perm: 'billing.create', fullBleed: true },
  { path: '/sales/bills', element: <BillsList />, perm: ['billing.create', 'billing.view'] },
  { path: '/sales/bills/:id', element: <BillDetail />, perm: ['billing.create', 'billing.view'] },
  { path: '/sales/bills/:id/edit', element: <BillingScreen />, perm: 'billing.edit', fullBleed: true },
  { path: '/sales/returns', element: <ReturnsList />, perm: ['returns.create', 'returns.adjust', 'returns.cancel', 'billing.view'] },
  { path: '/sales/returns/new', element: <ReturnNew />, perm: ['returns.create', 'returns.adjust'] },
  { path: '/sales/returns/:id', element: <ReturnDetail />, perm: ['returns.create', 'returns.adjust', 'returns.cancel', 'billing.view'] },
  { path: '/sales/items', element: <ItemsPage />, perm: ['items.manage', 'billing.create', 'billing.view'] },
];
