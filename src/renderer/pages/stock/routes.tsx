import type { AppRoute } from '../../routing';
import { StockLevelsPage } from './StockLevels';
import { ItemStockPage } from './ItemStock';
import { AdjustmentsPage } from './Adjustments';
import { AdjustmentFormPage } from './AdjustmentForm';
import { AdjustmentDetailPage } from './AdjustmentDetail';
import { OpeningStockPage } from './OpeningStock';

const VIEW = ['stock.manage', 'items.manage', 'billing.create', 'billing.view', 'purchases.manage', 'reports.financial'] as const;

export const stockPages: AppRoute[] = [
  { path: '/stock', element: <StockLevelsPage />, perm: [...VIEW] },
  { path: '/stock/items/:id', element: <ItemStockPage />, perm: [...VIEW] },
  { path: '/stock/adjustments', element: <AdjustmentsPage />, perm: [...VIEW] },
  { path: '/stock/adjustments/new', element: <AdjustmentFormPage />, perm: 'stock.manage' },
  { path: '/stock/adjustments/:id', element: <AdjustmentDetailPage />, perm: [...VIEW] },
  { path: '/stock/opening', element: <OpeningStockPage />, perm: [...VIEW] },
];
