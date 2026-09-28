import type { AppRoute } from '../../routing';
import { SettingsPage } from './SettingsPage';
import { UsersPage } from './UsersPage';
import { ActivityPage } from './ActivityPage';
import { BackupPage } from './BackupPage';
import { ImportPage } from './ImportPage';

export const adminPages: AppRoute[] = [
  { path: '/settings', element: <SettingsPage />, perm: 'settings.manage' },
  { path: '/admin/users', element: <UsersPage />, perm: 'users.manage' },
  { path: '/admin/activity', element: <ActivityPage />, perm: 'activity.view' },
  { path: '/settings/backup', element: <BackupPage />, perm: ['data.backup', 'data.restore'] },
  { path: '/settings/import', element: <ImportPage />, perm: 'data.import' },
];
