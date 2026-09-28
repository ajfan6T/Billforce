import { z } from 'zod';
import { route, zDate } from '../../api/router';
import * as accounts from './accounts';

export const accountingRoutes = {
  /** CONTRACT: accounts for pickers and the chart of accounts. */
  'accounts.list': route({
    access: 'user',
    input: z.object({
      groups: z.array(z.string()).optional(),
      types: z.array(z.enum(['asset', 'liability', 'equity', 'income', 'expense'])).optional(),
      includeInactive: z.boolean().optional(),
      withBalances: z.boolean().optional(),
      asOf: zDate.optional(),
    }),
    handler: (ctx, input) => {
      // Balances are financial information: only for users who may see the books.
      const withBalances = input.withBalances && (ctx.session?.role === 'owner' || ctx.session?.permissions.includes('accounts.view'));
      return accounts.listAccounts(ctx, { ...input, withBalances });
    },
  }),
  /** CONTRACT: cash / bank accounts for payment mode pickers. */
  'accounts.paymentAccounts': route({ access: 'user', handler: (ctx) => accounts.paymentAccounts(ctx) }),
};
