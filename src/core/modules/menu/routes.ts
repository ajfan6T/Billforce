import { z } from 'zod';
import { route, zId, zPaise } from '../../api/router';
import * as menu from './service';

const VIEW = ['billing.create', 'items.manage', 'billing.view', 'stock.manage', 'reports.financial'] as const;

const zOptName = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

const zDishInput = z.object({
  name: z.string().trim().min(1, 'Enter the name of the dish').max(120),
  code: zOptName(40),
  unit: z.string().trim().max(20).nullish(),
  rate: zPaise,
  category: zOptName(60),
  /** GST fields: left out = unchanged. */
  hsn: z.string().trim().max(8).nullable().optional(),
  gstRate: z.number().min(0).max(40).nullable().optional(),
  recipe: z
    .array(
      z.object({
        ingredientId: zId,
        qty: z.number({ error: 'Enter the quantity' }).positive('Enter the quantity').max(1_000_000),
        unit: z.string().trim().min(1, 'Choose the unit').max(20),
        note: zOptName(200),
      }),
    )
    .max(60, 'At most 60 ingredients in a recipe'),
});

export const menuRoutes = {
  'menu.list': route({
    access: [...VIEW],
    input: z.object({ includeInactive: z.boolean().optional() }).optional(),
    handler: (ctx, input) => menu.listDishes(ctx, input ?? {}),
  }),
  'menu.get': route({ access: [...VIEW], input: z.object({ id: zId }), handler: (ctx, input) => menu.getDish(ctx, input.id) }),
  'menu.save': route({
    access: 'items.manage',
    mutation: true,
    input: zDishInput.extend({ id: zId.nullish() }),
    handler: (ctx, { id, ...input }) => menu.saveDish(ctx, id ?? null, input),
  }),
  'menu.candidates': route({ access: 'items.manage', handler: (ctx) => menu.menuCandidates(ctx) }),
  'menu.addItems': route({
    access: 'items.manage',
    mutation: true,
    input: z.object({ itemIds: z.array(zId).min(1, 'Choose at least one item').max(2000) }),
    handler: (ctx, input) => menu.addItemsToMenu(ctx, input.itemIds),
  }),
  'menu.ingredients': route({ access: [...VIEW], handler: (ctx) => menu.listIngredients(ctx) }),
  'menu.createIngredient': route({
    access: 'items.manage',
    mutation: true,
    input: z.object({
      name: z.string().trim().min(1, 'Enter the name of the ingredient').max(120),
      unit: z.string().trim().min(1, 'Choose the unit').max(20),
      reorderLevel: z.number().min(0).max(1_000_000_000).nullish(),
    }),
    handler: (ctx, input) => menu.createIngredient(ctx, input),
  }),
  'menu.costing': route({ access: ['items.manage', 'reports.financial'], handler: (ctx) => menu.menuCosting(ctx) }),
};
