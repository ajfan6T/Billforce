import { z } from 'zod';
import { route, zDate, zId, zOptText, zPaise, zPhone, zPositivePaise, zQty, zSettlementMode } from '../../api/router';
import * as sales from './service';

const zPct = z.number().min(0, 'Discount % cannot be negative').max(100, 'Discount cannot be more than 100%');

const zLine = z.object({
  itemId: zId.nullish(),
  itemName: z.string().trim().min(1, 'Enter the item name').max(120, 'Item name is too long'),
  unit: zOptText(20),
  qty: zQty,
  rate: zPaise,
  discount: zPaise.nullish(),
  discountPct: zPct.nullish(),
  /** GST rate / HSN of a one-time line (bills with GST). */
  gstRate: z.number().min(0).max(40).nullish(),
  hsn: zOptText(8),
});

const zPayment = z.object({
  mode: zSettlementMode,
  amount: zPositivePaise,
  accountId: zId.nullish(),
  reference: zOptText(60),
});

/** CONTRACT input of sales.create (docs/ARCHITECTURE.md). */
const zBillInput = z.object({
  date: zDate.nullish(),
  customerId: zId.nullish(),
  customerName: zOptText(120),
  customerPhone: zPhone,
  items: z.array(zLine).min(1, 'Add at least one item to the bill').max(500, 'A bill can have at most 500 lines'),
  billDiscount: zPaise.nullish(),
  billDiscountPct: zPct.nullish(),
  payments: z.array(zPayment).max(10, 'Too many payment rows').default([]),
  remarks: zOptText(500),
});

const VIEW = ['billing.create', 'billing.view'] as const;

export const salesRoutes = {
  /** CONTRACT: save a new bill; posts to the ledger. Returns the full bill (same shape as sales.get) + warnings. */
  'sales.create': route({
    access: 'billing.create',
    mutation: true,
    input: zBillInput,
    handler: (ctx, input) => sales.createBill(ctx, input),
  }),

  'sales.update': route({
    access: 'billing.edit',
    mutation: true,
    input: zBillInput.extend({ id: zId, reason: zOptText(300) }),
    handler: (ctx, { id, reason, ...input }) => sales.updateBill(ctx, id, input, reason),
  }),

  'sales.cancel': route({
    access: 'billing.cancel',
    mutation: true,
    input: z.object({ id: zId, reason: z.string().trim().min(1, 'Enter the reason for cancelling').max(300) }),
    handler: (ctx, input) => sales.cancelBill(ctx, input.id, input.reason),
  }),

  'sales.get': route({
    access: [...VIEW],
    input: z.object({ id: zId }),
    handler: (ctx, input) => {
      const bill = sales.getBill(ctx, input.id);
      sales.assertBillVisible(ctx, { date: bill.date });
      return bill;
    },
  }),

  'sales.list': route({
    access: [...VIEW],
    input: z.object({
      from: zDate,
      to: zDate,
      q: z.string().max(100).nullish(),
      status: z.enum(['active', 'cancelled']).nullish(),
      paymentMode: z.enum(['cash', 'upi', 'bank', 'credit', 'split']).nullish(),
      customerId: zId.nullish(),
      limit: z.number().int().min(1).max(5000).default(200),
      offset: z.number().int().min(0).default(0),
    }),
    handler: (ctx, input) => sales.listBills(ctx, input),
  }),

  /** Every version of a bill with readable differences, for the History tab. */
  'sales.revisions': route({
    access: [...VIEW],
    input: z.object({ id: zId }),
    handler: (ctx, input) => {
      sales.assertBillVisible(ctx, sales.getBillRow(ctx, input.id));
      return sales.billRevisions(ctx, input.id);
    },
  }),

  /** Receipt HTML for on-screen preview. */
  'sales.receiptHtml': route({
    access: [...VIEW],
    input: z.object({ id: zId, duplicate: z.boolean().optional() }),
    handler: (ctx, input) => {
      sales.assertBillVisible(ctx, sales.getBillRow(ctx, input.id));
      return sales.billReceiptHtml(ctx, input.id, { duplicate: input.duplicate });
    },
  }),

  /** Print on the receipt printer. Later prints are reprints (permission, DUPLICATE mark, activity log). */
  'sales.print': route({
    access: [...VIEW],
    input: z.object({ id: zId }),
    handler: (ctx, input) => sales.printBill(ctx, input.id),
  }),

  /** Lines (and customer) to prefill a new bill from an old one. */
  'sales.repeatData': route({
    access: 'billing.create',
    input: z.object({ billId: zId }),
    handler: (ctx, input) => {
      sales.assertBillVisible(ctx, sales.getBillRow(ctx, input.billId), { allowOwn: true });
      return sales.repeatData(ctx, input.billId);
    },
  }),

  /** Items a customer bought recently (quick-add chips on the billing screen). */
  'sales.customerItems': route({
    access: 'billing.create',
    input: z.object({ customerId: zId, limit: z.number().int().min(1).max(50).optional() }),
    handler: (ctx, input) => sales.customerItems(ctx, input.customerId, input.limit),
  }),

  /** The current user's last bill, for "Repeat last bill". */
  'sales.lastBill': route({ access: 'billing.create', handler: (ctx) => sales.lastBill(ctx) }),

  'sales.nextNumber': route({
    access: 'billing.create',
    input: z.object({ date: zDate.nullish() }),
    handler: (ctx, input) => ({ billNo: sales.nextBillNumber(ctx, input.date) }),
  }),

  /** Settings and next number for the billing screen. */
  'sales.posConfig': route({ access: [...VIEW, 'returns.create', 'returns.adjust'], handler: (ctx) => sales.posConfig(ctx) }),

  /** One customer with the current balance (e.g. /billing/new?customer=12). */
  'sales.customer': route({
    access: ['billing.create', 'billing.view', 'returns.create', 'returns.adjust'],
    input: z.object({ id: zId }),
    handler: (ctx, input) => sales.customerSummary(ctx, input.id),
  }),
};
