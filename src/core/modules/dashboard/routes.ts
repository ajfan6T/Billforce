import { route } from '../../api/router';
import { dashboardSummary } from './service';

export const dashboardRoutes = {
  /** Home screen figures; only the parts the logged-in user may see are filled in. */
  'dashboard.summary': route({ access: 'user', handler: (ctx) => dashboardSummary(ctx) }),
};
