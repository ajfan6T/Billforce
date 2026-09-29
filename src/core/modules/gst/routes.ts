import { z } from 'zod';
import { route, zDate, zOptText, zRange, zSettlementMode } from '../../api/router';
import { compositionSummary, gstPurchaseRegister, gstSalesRegister, gstSummary, hsnSummary } from './reports';
import { gstDue, gstPayments, payGst } from './payment';

export const gstRoutes = {
  /* ------------------------------ Summaries for filing ------------------------------ */
  'gst.summary': route({ access: 'reports.financial', input: zRange, handler: (ctx, input) => gstSummary(ctx, input) }),
  'gst.salesRegister': route({
    access: 'reports.financial',
    input: zRange.extend({ kind: z.enum(['all', 'b2b', 'b2c']).optional() }),
    handler: (ctx, input) => gstSalesRegister(ctx, input),
  }),
  'gst.hsnSummary': route({ access: 'reports.financial', input: zRange, handler: (ctx, input) => hsnSummary(ctx, input) }),
  'gst.purchaseRegister': route({ access: 'reports.financial', input: zRange, handler: (ctx, input) => gstPurchaseRegister(ctx, input) }),
  'gst.compositionSummary': route({ access: 'reports.financial', input: zRange, handler: (ctx, input) => compositionSummary(ctx, input) }),

  /* ------------------------------ Paying GST ------------------------------ */
  /** What is due for the tax period ending `upTo` (composition: the period from `from`). */
  'gst.due': route({
    access: ['accounts.manage', 'reports.financial'],
    input: z.object({ upTo: zDate, from: zDate.nullish() }),
    handler: (ctx, input) => gstDue(ctx, input),
  }),
  'gst.pay': route({
    access: 'accounts.manage',
    mutation: true,
    input: z.object({
      upTo: zDate,
      from: zDate.nullish(),
      date: zDate.nullish(),
      mode: zSettlementMode,
      accountId: z.number().int().positive().nullish(),
      reference: zOptText(60),
    }),
    handler: (ctx, input) => payGst(ctx, input),
  }),
  'gst.payments': route({ access: ['accounts.manage', 'accounts.view'], handler: (ctx) => gstPayments(ctx) }),
};
