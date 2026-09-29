import type { AppRoute } from '../../routing';
import { MenuPage } from './MenuPage';
import { IngredientsPage } from './IngredientsPage';
import { MenuCostingPage } from './MenuCosting';

const VIEW = ['billing.create', 'items.manage', 'billing.view', 'stock.manage', 'reports.financial'] as const;

export const menuPages: AppRoute[] = [
  { path: '/menu', element: <MenuPage />, perm: [...VIEW] },
  { path: '/menu/ingredients', element: <IngredientsPage />, perm: [...VIEW] },
  { path: '/reports/menu-costing', element: <MenuCostingPage />, perm: ['stock.manage', 'purchases.manage', 'suppliers.view', 'reports.financial'] },
];
