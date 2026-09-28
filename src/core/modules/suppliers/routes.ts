import { z } from 'zod';
import { route, zPhone } from '../../api/router';
import * as suppliers from './service';

export const suppliersRoutes = {
  /** CONTRACT: supplier type-ahead (purchases, payments, expenses). */
  'suppliers.search': route({
    access: ['suppliers.view', 'purchases.manage', 'suppliers.pay', 'expenses.manage'],
    input: z.object({ q: z.string(), limit: z.number().int().min(1).max(50).optional() }),
    handler: (ctx, input) => suppliers.searchSuppliers(ctx, input.q, input.limit),
  }),
  /** CONTRACT: add a supplier with just a name / phone. */
  'suppliers.quickCreate': route({
    access: 'suppliers.manage',
    mutation: true,
    input: z.object({ name: z.string().trim().min(1, 'Enter the supplier name').max(120), phone: zPhone }),
    handler: (ctx, input) => suppliers.quickCreateSupplier(ctx, input),
  }),
};
