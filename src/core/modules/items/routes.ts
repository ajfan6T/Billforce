import { z } from 'zod';
import { route, zId, zPaise } from '../../api/router';
import * as items from './service';

const zItemInput = z.object({
  name: z.string().trim().min(1, 'Enter the item name').max(120),
  code: z
    .string()
    .trim()
    .max(40)
    .nullish()
    .transform((v) => v || null),
  unit: z.string().trim().min(1).max(20).default('pcs'),
  rate: zPaise,
  category: z
    .string()
    .trim()
    .max(60)
    .nullish()
    .transform((v) => v || null),
  /** GST fields: left out = unchanged. */
  hsn: z.string().trim().max(8).nullable().optional(),
  gstRate: z.number().min(0).max(40).nullable().optional(),
  /** Stock fields: left out = unchanged. */
  trackStock: z.boolean().optional(),
  reorderLevel: z.number().min(0).max(1_000_000_000).nullable().optional(),
});

const VIEW = ['billing.create', 'items.manage', 'billing.view'] as const;

export const itemsRoutes = {
  'items.list': route({
    access: [...VIEW],
    input: z.object({ q: z.string().nullish(), category: z.string().nullish(), includeInactive: z.boolean().optional() }),
    handler: (ctx, input) => items.listItems(ctx, input),
  }),
  /** CONTRACT (billing screen): type-ahead suggestions. */
  'items.search': route({
    access: [...VIEW],
    input: z.object({ q: z.string(), limit: z.number().int().min(1).max(50).optional() }),
    handler: (ctx, input) => items.searchItems(ctx, input.q, input.limit),
  }),
  /** CONTRACT (billing screen): frequently used items for quick-add buttons. */
  'items.recent': route({
    access: [...VIEW],
    input: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    handler: (ctx, input) => items.recentItems(ctx, input.limit),
  }),
  'items.get': route({ access: [...VIEW], input: z.object({ id: zId }), handler: (ctx, input) => items.getItem(ctx, input.id) }),
  'items.categories': route({ access: [...VIEW], handler: (ctx) => items.itemCategories(ctx) }),
  'items.create': route({ access: 'items.manage', mutation: true, input: zItemInput, handler: (ctx, input) => items.createItem(ctx, input) }),
  'items.update': route({
    access: 'items.manage',
    mutation: true,
    input: zItemInput.extend({ id: zId }),
    handler: (ctx, { id, ...input }) => items.updateItem(ctx, id, input),
  }),
  'items.setRate': route({
    access: 'items.manage',
    mutation: true,
    input: z.object({ id: zId, rate: zPaise }),
    handler: (ctx, input) => items.setItemRate(ctx, input.id, input.rate),
  }),
  'items.setActive': route({
    access: 'items.manage',
    mutation: true,
    input: z.object({ id: zId, active: z.boolean() }),
    handler: (ctx, input) => items.setItemActive(ctx, input.id, input.active),
  }),
  'items.remove': route({ access: 'items.manage', mutation: true, input: z.object({ id: zId }), handler: (ctx, input) => items.removeItem(ctx, input.id) }),
};
