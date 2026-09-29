import { z } from 'zod';
import { route, zDate, zId, zOptText, zPaise, zRange } from '../../api/router';
import { today } from '../../context';
import * as stock from './service';
import { itemStockLedger, stockSummary } from './reports';
import { canSeeCosts, reportWithoutCosts, withoutCost } from './costs';

/** Stock levels are useful to everyone who sells, buys or looks after items. */
const VIEW = ['stock.manage', 'items.manage', 'billing.create', 'billing.view', 'purchases.manage', 'reports.financial'] as const;

const zQtyAny = z.number({ error: 'Enter the quantity' }).finite().min(-1_000_000_000).max(1_000_000_000);

export const stockRoutes = {
  'stock.summary': route({
    access: [...VIEW],
    input: z.object({ asOf: zDate.nullish(), filter: z.enum(['all', 'low', 'out']).optional(), q: z.string().max(100).nullish(), includeInactive: z.boolean().optional() }),
    handler: (ctx, input) => {
      const r = stockSummary(ctx, { ...input, asOf: input.asOf || today(ctx) });
      if (canSeeCosts(ctx)) return { ...r, costHidden: false };
      return { ...r, items: r.items.map(withoutCost), totals: { ...r.totals, value: 0 }, report: reportWithoutCosts(r.report, ['avgCost', 'value']), costHidden: true };
    },
  }),
  'stock.itemLedger': route({
    access: [...VIEW],
    input: zRange.extend({ itemId: zId }),
    handler: (ctx, input) => {
      const r = itemStockLedger(ctx, input);
      return canSeeCosts(ctx) ? { ...r, costHidden: false } : { ...r, stockNow: r.stockNow && withoutCost(r.stockNow), costHidden: true };
    },
  }),
  'stock.lowItems': route({
    access: [...VIEW],
    handler: (ctx) => (canSeeCosts(ctx) ? stock.lowStockItems(ctx) : stock.lowStockItems(ctx).map(withoutCost)),
  }),
  'stock.trackAll': route({ access: 'stock.manage', mutation: true, handler: (ctx) => stock.trackAllItems(ctx) }),

  'stock.opening': route({
    access: [...VIEW],
    handler: (ctx) => {
      const r = stock.openingStock(ctx);
      return canSeeCosts(ctx) ? { ...r, costHidden: false } : { ...r, lines: r.lines.map((l) => ({ ...l, unitCost: 0, value: 0 })), total: 0, costHidden: true };
    },
  }),
  'stock.saveOpening': route({
    access: 'stock.manage',
    mutation: true,
    input: z.object({ lines: z.array(z.object({ itemId: zId, qty: z.number().min(0).max(1_000_000_000), unitCost: zPaise })).max(5000) }),
    handler: (ctx, input) => stock.saveOpeningStock(ctx, input.lines),
  }),

  'stock.adjustments': route({ access: [...VIEW], input: zRange, handler: (ctx, input) => stock.listAdjustments(ctx, input) }),
  'stock.adjustment': route({
    access: [...VIEW],
    input: z.object({ id: zId }),
    handler: (ctx, input) => {
      const r = stock.getAdjustment(ctx, input.id);
      return canSeeCosts(ctx) ? r : { ...r, lines: r.lines.map((l) => ({ ...l, unitCost: null })) };
    },
  }),
  'stock.adjust': route({
    access: 'stock.manage',
    mutation: true,
    input: z.object({
      date: zDate.nullish(),
      kind: z.enum(['count', 'adjust']),
      reason: zOptText(300),
      lines: z
        .array(z.object({ itemId: zId, counted: z.number().min(0).max(1_000_000_000).nullish(), qty: zQtyAny.nullish(), unitCost: zPaise.nullish(), note: zOptText(200) }))
        .min(1, 'Add at least one item')
        .max(2000),
    }),
    handler: (ctx, input) => stock.createAdjustment(ctx, input),
  }),
  'stock.cancelAdjustment': route({
    access: 'stock.manage',
    mutation: true,
    input: z.object({ id: zId, reason: z.string().trim().min(1, 'Enter the reason for cancelling').max(300) }),
    handler: (ctx, input) => stock.cancelAdjustment(ctx, input.id, input.reason),
  }),
};
