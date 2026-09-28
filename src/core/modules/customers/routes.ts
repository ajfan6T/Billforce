import { z } from 'zod';
import { route, zPhone } from '../../api/router';
import * as customers from './service';

export const customersRoutes = {
  /** CONTRACT: customer type-ahead (billing screen, receipts). */
  'customers.search': route({
    access: ['customers.view', 'billing.create', 'customers.receive', 'returns.create'],
    input: z.object({ q: z.string(), limit: z.number().int().min(1).max(50).optional() }),
    handler: (ctx, input) => customers.searchCustomers(ctx, input.q, input.limit),
  }),
  /** CONTRACT: add a customer with just name / phone. */
  'customers.quickCreate': route({
    access: 'customers.manage',
    mutation: true,
    input: z.object({
      name: z.string().trim().min(1, 'Enter the customer name').max(120),
      phone: zPhone,
      address: z.string().trim().max(500).nullish(),
    }),
    handler: (ctx, input) => customers.quickCreateCustomer(ctx, input),
  }),
};
