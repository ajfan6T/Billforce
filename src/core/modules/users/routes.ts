import { z } from 'zod';
import { route, zDate, zId } from '../../api/router';
import { ROLES } from '../../../shared/constants';
import * as users from './service';
import * as activity from './activity';

const zUsername = z
  .string()
  .trim()
  .min(2, 'Username must be at least 2 characters')
  .max(40, 'Username is too long (max 40 characters)')
  .regex(/^[A-Za-z0-9._-]+$/, 'Username can have letters, numbers, dot, dash and underscore only');
const zFullName = z.string().trim().min(1, 'Enter the full name').max(80, 'Name is too long (max 80 characters)');
const zPassword = z.string().min(4, 'Password must be at least 4 characters').max(128, 'Password is too long');
const zRole = z.enum(ROLES, { message: 'Choose a role' });

const zActivityFilters = z.object({
  from: zDate,
  to: zDate,
  userId: zId.nullish(),
  action: z.union([z.string().max(60), z.array(z.string().max(60)).max(30)]).nullish(),
  entityType: z.string().max(40).nullish(),
  q: z.string().max(100).nullish(),
});

export const usersRoutes = {
  /* ------------------------------ Users ------------------------------ */
  'users.list': route({ access: 'users.manage', handler: (ctx) => users.listUsers(ctx) }),

  'users.create': route({
    access: 'users.manage',
    mutation: true,
    input: z.object({ username: zUsername, fullName: zFullName, role: zRole, password: zPassword, mustChangePassword: z.boolean().optional() }),
    handler: (ctx, input) => users.createUser(ctx, input),
  }),

  'users.update': route({
    access: 'users.manage',
    mutation: true,
    input: z.object({ id: zId, fullName: zFullName, role: zRole, isActive: z.boolean(), username: zUsername.nullish() }),
    handler: (ctx, { id, ...input }) => users.updateUser(ctx, id, input),
  }),

  'users.resetPassword': route({
    access: 'users.manage',
    mutation: true,
    input: z.object({ id: zId, newPassword: zPassword }),
    handler: (ctx, input) => users.resetUserPassword(ctx, input.id, input.newPassword),
  }),

  /* ------------------------------ Roles ------------------------------ */
  'roles.get': route({ access: 'users.manage', handler: (ctx) => users.getRoles(ctx) }),

  /** Owner only (checked in the service). */
  'roles.update': route({
    access: 'users.manage',
    mutation: true,
    input: z.object({ role: z.enum(['manager', 'cashier'], { message: 'Choose Manager or Cashier' }), permissions: z.array(z.string().max(60)).max(200) }),
    handler: (ctx, input) => users.updateRolePermissions(ctx, input.role, input.permissions),
  }),

  /* ------------------------------ Activity log ------------------------------ */
  'activity.list': route({
    access: 'activity.view',
    input: zActivityFilters.extend({
      limit: z.number().int().min(1).max(1000).default(100),
      offset: z.number().int().min(0).default(0),
    }),
    handler: (ctx, input) => activity.listActivity(ctx, input),
  }),

  'activity.get': route({ access: 'activity.view', input: z.object({ id: zId }), handler: (ctx, input) => activity.getActivity(ctx, input.id) }),

  /** The filtered log as ReportData for export / print. */
  'activity.report': route({
    access: 'activity.view',
    input: z.object({ filters: zActivityFilters }),
    handler: (ctx, input) => activity.activityReport(ctx, input.filters),
  }),

  'activity.users': route({ access: 'activity.view', handler: (ctx) => activity.activityUsers(ctx) }),

  /** Every saved version of a document (bill, purchase, receipt ...) with full snapshots. */
  'audit.revisions': route({
    access: 'user',
    input: z.object({ docType: z.string().min(1).max(40), docId: zId }),
    handler: (ctx, input) => activity.documentRevisions(ctx, input.docType, input.docId),
  }),
};
