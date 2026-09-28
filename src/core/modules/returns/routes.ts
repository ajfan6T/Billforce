import { z } from 'zod';
import { route, zDate, zId, zOptText, zPaise, zPaymentMode, zPositivePaise, zQty } from '../../api/router';
import * as returns from './service';

const zReturnInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('return'),
    billId: zId,
    date: zDate.nullish(),
    items: z
      .array(z.object({ billItemId: zId, qty: zQty, rate: zPaise.nullish() }))
      .min(1, 'Choose at least one item to return')
      .max(500),
    refundMode: zPaymentMode,
    refundAccountId: zId.nullish(),
    reason: zOptText(300),
  }),
  z.object({
    kind: z.literal('adjustment'),
    customerId: zId,
    amount: zPositivePaise,
    reason: z.string().trim().min(1, 'Enter the reason for the credit note').max(300),
    refundMode: zPaymentMode,
    refundAccountId: zId.nullish(),
    date: zDate.nullish(),
  }),
]);

const VIEW = ['returns.create', 'returns.cancel', 'billing.view'] as const;

export const returnsRoutes = {
  /** Lines of a bill that can still be returned, with the effective net rate. */
  'returns.billReturnable': route({
    access: 'returns.create',
    input: z.object({ billId: zId }),
    handler: (ctx, input) => returns.billReturnable(ctx, input.billId),
  }),

  /** Find a bill to return goods against (any date). */
  'returns.findBills': route({
    access: 'returns.create',
    input: z.object({ q: z.string().max(100), limit: z.number().int().min(1).max(50).optional() }),
    handler: (ctx, input) => returns.findBillsForReturn(ctx, input.q, input.limit),
  }),

  'returns.create': route({
    access: 'returns.create',
    mutation: true,
    input: zReturnInput,
    handler: (ctx, input) => returns.createCreditNote(ctx, input),
  }),

  'returns.cancel': route({
    access: 'returns.cancel',
    mutation: true,
    input: z.object({ id: zId, reason: z.string().trim().min(1, 'Enter the reason for cancelling').max(300) }),
    handler: (ctx, input) => returns.cancelCreditNote(ctx, input.id, input.reason),
  }),

  'returns.get': route({
    access: [...VIEW],
    input: z.object({ id: zId }),
    handler: (ctx, input) => returns.getCreditNote(ctx, input.id),
  }),

  'returns.revisions': route({
    access: [...VIEW],
    input: z.object({ id: zId }),
    handler: (ctx, input) => returns.creditNoteRevisions(ctx, input.id),
  }),

  'returns.list': route({
    access: [...VIEW],
    input: z.object({
      from: zDate,
      to: zDate,
      q: z.string().max(100).nullish(),
      kind: z.enum(['return', 'adjustment']).nullish(),
      status: z.enum(['active', 'cancelled']).nullish(),
      customerId: zId.nullish(),
      billId: zId.nullish(),
      limit: z.number().int().min(1).max(5000).default(200),
      offset: z.number().int().min(0).default(0),
    }),
    handler: (ctx, input) => returns.listCreditNotes(ctx, input),
  }),

  'returns.receiptHtml': route({
    access: [...VIEW],
    input: z.object({ id: zId, duplicate: z.boolean().optional() }),
    handler: (ctx, input) => returns.creditNoteReceiptHtml(ctx, input.id, { duplicate: input.duplicate }),
  }),

  'returns.print': route({
    access: [...VIEW],
    input: z.object({ id: zId }),
    handler: (ctx, input) => returns.printCreditNote(ctx, input.id),
  }),
};
