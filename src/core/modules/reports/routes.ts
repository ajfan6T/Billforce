import { z } from 'zod';
import { route, zDate, zRange } from '../../api/router';
import { profitLoss } from './profitLoss';
import { balanceSheet } from './balanceSheet';
import { trialBalance } from './trialBalance';
import { cashFlow } from './cashFlow';
import { salesByCustomer, salesByDay, salesByItem, salesByMonth, salesByPaymentMode, salesSummary } from './sales';
import { payablesAgeing, receivablesAgeing } from './ageing';

const zAsOf = z.object({ asOf: zDate });

export const reportsRoutes = {
  /* ------------------------------ Financial statements ------------------------------ */
  'reports.profitLoss': route({
    access: 'reports.financial',
    input: zRange.extend({ compare: z.enum(['none', 'previous_period', 'previous_year']).default('none') }),
    handler: (ctx, input) => profitLoss(ctx, input),
  }),
  'reports.balanceSheet': route({
    access: 'reports.financial',
    input: zAsOf,
    handler: (ctx, input) => balanceSheet(ctx, input),
  }),
  /** CONTRACT (smoke test, accounting): trial balance as ReportData. */
  'reports.trialBalance': route({
    access: 'reports.financial',
    input: z.object({ from: zDate.nullish(), to: zDate, partyDetail: z.boolean().optional() }),
    handler: (ctx, input) => trialBalance(ctx, input),
  }),
  'reports.cashFlow': route({
    access: 'reports.financial',
    input: zRange,
    handler: (ctx, input) => cashFlow(ctx, input),
  }),

  /* ------------------------------ Sales insights ------------------------------ */
  'reports.salesSummary': route({ access: 'reports.sales', input: zRange, handler: (ctx, input) => salesSummary(ctx, input) }),
  'reports.salesByDay': route({ access: 'reports.sales', input: zRange, handler: (ctx, input) => salesByDay(ctx, input) }),
  'reports.salesByMonth': route({ access: 'reports.sales', input: zRange, handler: (ctx, input) => salesByMonth(ctx, input) }),
  'reports.salesByItem': route({ access: 'reports.sales', input: zRange, handler: (ctx, input) => salesByItem(ctx, input) }),
  'reports.salesByCustomer': route({ access: 'reports.sales', input: zRange, handler: (ctx, input) => salesByCustomer(ctx, input) }),
  'reports.salesByPaymentMode': route({ access: 'reports.sales', input: zRange, handler: (ctx, input) => salesByPaymentMode(ctx, input) }),

  /* ------------------------------ Receivables & payables ------------------------------ */
  'reports.receivablesAgeing': route({
    access: ['reports.financial', 'customers.view'],
    input: zAsOf,
    handler: (ctx, input) => receivablesAgeing(ctx, input),
  }),
  'reports.payablesAgeing': route({
    access: ['reports.financial', 'suppliers.view'],
    input: zAsOf,
    handler: (ctx, input) => payablesAgeing(ctx, input),
  }),
};
