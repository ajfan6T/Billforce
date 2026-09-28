import type { AppRoute } from '../../routing';
import { CustomersListPage } from './CustomersList';
import { CustomerDetailPage } from './CustomerDetail';
import { ReceiptsListPage } from './ReceiptsList';
import { ReceiptDetailPage } from './ReceiptDetail';
import { OutstandingPage } from './Outstanding';

export const customersPages: AppRoute[] = [
  { path: '/customers', element: <CustomersListPage />, perm: 'customers.view' },
  { path: '/customers/receipts', element: <ReceiptsListPage />, perm: ['customers.receive', 'customers.view'] },
  { path: '/customers/receipts/:id', element: <ReceiptDetailPage />, perm: ['customers.receive', 'customers.view'] },
  { path: '/customers/outstanding', element: <OutstandingPage />, perm: 'customers.view' },
  { path: '/customers/:id', element: <CustomerDetailPage />, perm: 'customers.view' },
];
