import type { AppRoute } from '../../routing';
import { DashboardPage } from './Dashboard';

export const dashboardPages: AppRoute[] = [{ path: '/', element: <DashboardPage /> }];
