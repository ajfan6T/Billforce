import type { AppRoute } from '../../routing';
import { Placeholder } from '../Placeholder';

export const adminPages: AppRoute[] = [
  { path: '/settings', element: <Placeholder title="Business settings" />, perm: 'settings.manage' },
  { path: '/admin/users', element: <Placeholder title="Users & permissions" />, perm: 'users.manage' },
  { path: '/admin/activity', element: <Placeholder title="Activity log" />, perm: 'activity.view' },
  { path: '/settings/backup', element: <Placeholder title="Backup & restore" />, perm: ['data.backup', 'data.restore'] },
  { path: '/settings/import', element: <Placeholder title="Import from Excel / CSV" />, perm: 'data.import' },
];
