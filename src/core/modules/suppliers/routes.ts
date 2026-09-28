import { z } from 'zod';
import { route, zDate, zOptText, zPaise, zPhone } from '../../api/router';
import * as suppliers from './service';
import { listPurchases } from '../purchases/service';

const zSupplierId = z.number({ error: 'Choose a supplier' }).int().positive('Choose a supplier');

const zSupplierInput = z.object({
  name: z.string().trim().min(1, 'Enter the supplier name').max(120, 'Name is too long (max 120 characters)'),
  phone: zPhone,
  address: zOptText(500),
  email: zOptText(120),
  contactPerson: zOptText(120),
  notes: zOptText(1000),
  openingBalance: z.object({ amount: zPaise, direction: z.enum(['payable', 'advance']) }).nullish(),
});

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

  'suppliers.list': route({
    access: 'suppliers.view',
    input: z.object({ q: z.string().nullish(), onlyWithBalance: z.boolean().optional(), includeInactive: z.boolean().optional() }),
    handler: (ctx, input) => suppliers.listSuppliers(ctx, input),
  }),
  'suppliers.get': route({
    access: ['suppliers.view', 'suppliers.pay', 'purchases.manage'],
    input: z.object({ id: zSupplierId }),
    handler: (ctx, input) => suppliers.getSupplier(ctx, input.id),
  }),
  'suppliers.create': route({
    access: 'suppliers.manage',
    mutation: true,
    input: zSupplierInput,
    handler: (ctx, input) => suppliers.createSupplier(ctx, input),
  }),
  'suppliers.update': route({
    access: 'suppliers.manage',
    mutation: true,
    input: zSupplierInput.extend({ id: zSupplierId }),
    handler: (ctx, { id, ...input }) => suppliers.updateSupplier(ctx, id, input),
  }),
  'suppliers.setActive': route({
    access: 'suppliers.manage',
    mutation: true,
    input: z.object({ id: zSupplierId, active: z.boolean() }),
    handler: (ctx, input) => suppliers.setSupplierActive(ctx, input.id, input.active),
  }),
  'suppliers.remove': route({
    access: 'suppliers.manage',
    mutation: true,
    input: z.object({ id: zSupplierId }),
    handler: (ctx, input) => suppliers.removeSupplier(ctx, input.id),
  }),
  'suppliers.statement': route({
    access: 'suppliers.view',
    input: z.object({ supplierId: zSupplierId, from: zDate, to: zDate }),
    handler: (ctx, input) => suppliers.supplierStatement(ctx, input.supplierId, input.from, input.to),
  }),
  'suppliers.payables': route({
    access: 'suppliers.view',
    input: z.object({ asOf: zDate }),
    handler: (ctx, input) => suppliers.supplierPayables(ctx, input.asOf),
  }),
  'suppliers.purchases': route({
    access: 'suppliers.view',
    input: z.object({ supplierId: zSupplierId, from: zDate.nullish(), to: zDate.nullish() }),
    handler: (ctx, input) => {
      suppliers.getSupplierRow(ctx, input.supplierId);
      return listPurchases(ctx, { supplierId: input.supplierId, from: input.from, to: input.to });
    },
  }),
};
