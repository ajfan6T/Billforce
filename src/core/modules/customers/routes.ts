import { z } from 'zod';
import { route, zDate, zOptText, zPaise, zPhone, zSettlementMode } from '../../api/router';
import * as customers from './service';
import * as receipts from './receipts';

const zCustomerId = z.number({ error: 'Choose a customer' }).int().positive('Choose a customer');

const zCustomerInput = z.object({
  name: z.string().trim().min(1, 'Enter the customer name').max(120, 'Name is too long (max 120 characters)'),
  phone: zPhone,
  address: zOptText(500),
  email: zOptText(120),
  // null = no limit; left out = unchanged when editing. Changing it needs customers.credit (checked in the service).
  creditLimit: zPaise.nullish(),
  notes: zOptText(1000),
  openingBalance: z
    .object({ amount: zPaise, direction: z.enum(['receivable', 'advance']) })
    .nullish(),
});

const zReceiptInput = z.object({
  customerId: zCustomerId,
  date: zDate.nullish(),
  amount: zPaise,
  discount: zPaise.optional(),
  mode: zSettlementMode,
  accountId: z.number().int().positive().nullish(),
  reference: zOptText(80),
  remarks: zOptText(500),
});

const VIEW_RECEIPTS = ['customers.receive', 'customers.view'] as const;

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

  // Balances and credit limits go only to users who may see them (customerForViewer); today the
  // read routes already need customers.view / customers.receive, but add / edit need only customers.manage.
  'customers.list': route({
    access: 'customers.view',
    input: z.object({ q: z.string().nullish(), onlyWithBalance: z.boolean().optional(), includeInactive: z.boolean().optional() }),
    handler: (ctx, input) => customers.customerListForViewer(ctx, customers.listCustomers(ctx, input)),
  }),
  'customers.get': route({
    access: ['customers.view', 'customers.receive'],
    input: z.object({ id: zCustomerId }),
    handler: (ctx, input) => customers.customerForViewer(ctx, customers.getCustomer(ctx, input.id)),
  }),
  'customers.formInfo': route({
    access: ['customers.view', 'customers.manage', 'suppliers.view', 'suppliers.manage'],
    handler: (ctx) => customers.partyFormInfo(ctx),
  }),
  'customers.create': route({
    access: 'customers.manage',
    mutation: true,
    input: zCustomerInput,
    handler: (ctx, input) => customers.customerForViewer(ctx, customers.createCustomer(ctx, input)),
  }),
  'customers.update': route({
    access: 'customers.manage',
    mutation: true,
    input: zCustomerInput.extend({ id: zCustomerId }),
    handler: (ctx, { id, ...input }) => customers.customerForViewer(ctx, customers.updateCustomer(ctx, id, input)),
  }),
  'customers.setActive': route({
    access: 'customers.manage',
    mutation: true,
    input: z.object({ id: zCustomerId, active: z.boolean() }),
    handler: (ctx, input) => customers.customerForViewer(ctx, customers.setCustomerActive(ctx, input.id, input.active)),
  }),
  'customers.remove': route({
    access: 'customers.manage',
    mutation: true,
    input: z.object({ id: zCustomerId }),
    handler: (ctx, input) => customers.removeCustomer(ctx, input.id),
  }),
  'customers.statement': route({
    access: 'customers.view',
    input: z.object({ customerId: zCustomerId, from: zDate, to: zDate }),
    handler: (ctx, input) => customers.customerStatement(ctx, input.customerId, input.from, input.to),
  }),
  'customers.outstanding': route({
    access: 'customers.view',
    input: z.object({ asOf: zDate }),
    handler: (ctx, input) => customers.customerOutstanding(ctx, input.asOf),
  }),
  'customers.bills': route({
    access: 'customers.view',
    input: z.object({ customerId: zCustomerId, from: zDate.nullish(), to: zDate.nullish() }),
    handler: (ctx, input) => customers.customerBills(ctx, input.customerId, input.from, input.to),
  }),

  /* ---------------- Payments received ---------------- */
  'receipts.create': route({
    access: 'customers.receive',
    mutation: true,
    input: zReceiptInput,
    handler: (ctx, input) => receipts.createReceipt(ctx, input),
  }),
  'receipts.update': route({
    access: 'customers.receive',
    mutation: true,
    input: zReceiptInput.extend({ id: z.number().int().positive(), reason: zOptText(300) }),
    handler: (ctx, { id, reason, ...input }) => receipts.updateReceipt(ctx, id, input, reason),
  }),
  'receipts.cancel': route({
    access: 'customers.receive',
    mutation: true,
    input: z.object({ id: z.number().int().positive(), reason: z.string().trim().min(1, 'Enter the reason for cancelling').max(300) }),
    handler: (ctx, input) => receipts.cancelReceipt(ctx, input.id, input.reason),
  }),
  'receipts.get': route({
    access: [...VIEW_RECEIPTS],
    input: z.object({ id: z.number().int().positive() }),
    handler: (ctx, input) => receipts.getReceiptDetail(ctx, input.id),
  }),
  'receipts.list': route({
    access: [...VIEW_RECEIPTS],
    input: z.object({
      from: zDate.nullish(),
      to: zDate.nullish(),
      q: z.string().nullish(),
      customerId: z.number().int().positive().nullish(),
      mode: zSettlementMode.nullish(),
      status: z.enum(['active', 'cancelled']).nullish(),
    }),
    handler: (ctx, input) => receipts.listReceipts(ctx, input),
  }),
  'receipts.receiptHtml': route({
    access: [...VIEW_RECEIPTS],
    input: z.object({ id: z.number().int().positive() }),
    handler: (ctx, input) => ({ html: receipts.receiptHtml(ctx, input.id) }),
  }),
  'receipts.print': route({
    access: [...VIEW_RECEIPTS],
    input: z.object({ id: z.number().int().positive() }),
    handler: (ctx, input) => receipts.printReceipt(ctx, input.id),
  }),
};
