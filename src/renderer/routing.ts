import type { ReactElement } from 'react';
import type { Permission } from '../shared/permissions';

export interface AppRoute {
  /** Path relative to the app root, e.g. "/sales/bills/:id". */
  path: string;
  element: ReactElement;
  /** Needed to open the page (any one of them). */
  perm?: Permission | Permission[];
  /** Hide the page chrome padding (full-bleed pages such as the billing screen). */
  fullBleed?: boolean;
}
