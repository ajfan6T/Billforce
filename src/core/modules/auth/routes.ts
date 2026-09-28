import { z } from 'zod';
import { route, zDate, zPaise } from '../../api/router';
import * as auth from './service';

const zUsername = z
  .string()
  .trim()
  .min(2, 'Username must be at least 2 characters')
  .max(40)
  .regex(/^[A-Za-z0-9._-]+$/, 'Username can have letters, numbers, dot, dash and underscore only');

export const authRoutes = {
  /** App status for the startup screen: is setup done, who is logged in. */
  'app.status': route({ access: 'public', handler: (ctx) => auth.appStatus(ctx) }),

  'setup.complete': route({
    access: 'public',
    mutation: true,
    input: z.object({
      business: z.object({
        name: z.string().trim().min(1, 'Enter your business name').max(120),
        address: z.string().trim().max(500).nullish(),
        phone: z.string().trim().max(40).nullish(),
        email: z.string().trim().max(120).nullish(),
      }),
      owner: z.object({
        fullName: z.string().trim().min(1, 'Enter your name').max(80),
        username: zUsername,
        password: z.string().min(4, 'Password must be at least 4 characters').max(128),
      }),
      booksStartDate: zDate,
      openingCash: zPaise.optional(),
      openingBank: zPaise.optional(),
      openingUpi: zPaise.optional(),
    }),
    handler: (ctx, input) => auth.completeSetup(ctx, input),
  }),

  'auth.loginUsers': route({ access: 'public', handler: (ctx) => auth.loginUsers(ctx) }),

  // Not a single transaction on purpose: failed attempts must be recorded even though login throws.
  'auth.login': route({
    access: 'public',
    input: z.object({ username: z.string().trim().min(1, 'Enter your username'), password: z.string().min(1, 'Enter your password') }),
    handler: (ctx, input) => auth.login(ctx, input.username, input.password),
  }),

  'auth.logout': route({ access: 'public', handler: (ctx) => auth.logout(ctx) }),

  'auth.me': route({ access: 'public', handler: (ctx) => auth.sessionInfo(ctx) }),

  'auth.changePassword': route({
    access: 'user',
    mutation: true,
    input: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(4, 'Password must be at least 4 characters').max(128) }),
    handler: (ctx, input) => auth.changePassword(ctx, input.currentPassword, input.newPassword),
  }),

  'auth.recover': route({
    access: 'public',
    input: z.object({ recoveryCode: z.string().trim().min(1, 'Enter the recovery code'), newPassword: z.string().min(4).max(128) }),
    handler: (ctx, input) => auth.recoverOwner(ctx, input.recoveryCode, input.newPassword),
  }),

  'auth.regenerateRecoveryCode': route({
    access: 'user',
    mutation: true,
    input: z.object({ password: z.string().min(1) }),
    handler: (ctx, input) => ({ recoveryCode: auth.regenerateRecoveryCode(ctx, input.password) }),
  }),
};
