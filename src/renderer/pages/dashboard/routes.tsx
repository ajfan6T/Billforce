import type { AppRoute } from '../../routing';
import { Placeholder } from '../Placeholder';

export const dashboardPages: AppRoute[] = [{ path: '/', element: <Placeholder title="Dashboard" /> }];
