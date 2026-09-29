import { z } from 'zod';
import { route, zDate, zOptText, zPaise, zPositivePaise, zQty, zSettlementMode } from '../../api/router';
import * as purchases from './service';
import * as payments from './payments';

const zOptId = z.number().int().positive().nullish();

const zPurchaseInput = z.object({
  date: zDate.nullish(),
  supplierId: zOptId,
  supplierName: zOptText(120),
  supplierBillNo: zOptText(60),
  supplierBillDate: zDate.nullish(),
  expenseAccountId: zOptId,
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1, 'Enter what was bought').max(200),
        qty: zQty,
        unit: zOptText(20),
        rate: zPaise,
        gstRate: z.number().min(0).max(40).nullish(),
        // Left out = as saved (when editing); null / '' = none.
        hsn: z.string().trim().max(8).nullable().optional(),
        itemId: zOptId,
      }),
    )
    .min(1, 'Add at least one item')
    .max(500, 'A purchase can have at most 500 lines'),
  discount: zPaise.optional(),
  otherCharges: zPaise.optional(),
  roundOff: z.boolean().optional(),
  payments: z
    .array(z.object({ mode: zSettlementMode, amount: zPositivePaise, accountId: zOptId, reference: zOptText(80) }))
    .max(10)
    .optional(),
  remarks: zOptText(500),
  gstInclusive: z.boolean().nullish(),
  itc: z.boolean().nullish(),
});

const zPaymentInput = z.object({
  supplierId: z.number({ error: 'Choose a supplier' }).int().positive('Choose a supplier'),
  date: zDate.nullish(),
  amount: zPaise,
  discount: zPaise.optional(),
  mode: zSettlementMode,
  accountId: zOptId,
  reference: zOptText(80),
  remarks: zOptText(500),
});

const zDocId = z.object({ id: z.number().int().positive() });
const VIEW_PURCHASES = ['suppliers.view', 'purchases.manage'] as const;
const VIEW_PAYMENTS = ['suppliers.view', 'suppliers.pay'] as const;

export const purchasesRoutes = {
  /* ---------------- Purchase bills ---------------- */
  'purchases.formOptions': route({
    access: 'purchases.manage',
    handler: (ctx) => purchases.purchaseFormOptions(ctx),
  }),
  'purchases.descriptions': route({
    access: 'purchases.manage',
    input: z.object({ q: z.string(), supplierId: zOptId, limit: z.number().int().min(1).max(50).optional() }),
    handler: (ctx, input) => purchases.purchaseDescriptions(ctx, input.q, input.supplierId, input.limit),
  }),
  'purchases.checkBillNo': route({
    access: 'purchases.manage',
    input: z.object({ supplierId: z.number().int().positive(), supplierBillNo: z.string(), excludeId: zOptId }),
    handler: (ctx, input) => ({ duplicate: purchases.findDuplicateBill(ctx, input.supplierId, input.supplierBillNo, input.excludeId) }),
  }),
  'purchases.create': route({
    access: 'purchases.manage',
    mutation: true,
    input: zPurchaseInput,
    handler: (ctx, input) => purchases.createPurchase(ctx, input),
  }),
  'purchases.update': route({
    access: 'purchases.manage',
    mutation: true,
    input: zPurchaseInput.extend({ id: z.number().int().positive(), reason: zOptText(300) }),
    handler: (ctx, { id, reason, ...input }) => purchases.updatePurchase(ctx, id, input, reason),
  }),
  'purchases.cancel': route({
    access: 'purchases.manage',
    mutation: true,
    input: z.object({ id: z.number().int().positive(), reason: z.string().trim().min(1, 'Enter the reason for cancelling').max(300) }),
    handler: (ctx, input) => purchases.cancelPurchase(ctx, input.id, input.reason),
  }),
  'purchases.get': route({
    access: [...VIEW_PURCHASES],
    input: zDocId,
    handler: (ctx, input) => purchases.getPurchaseDetail(ctx, input.id),
  }),
  'purchases.list': route({
    access: [...VIEW_PURCHASES],
    input: z.object({
      from: zDate.nullish(),
      to: zDate.nullish(),
      q: z.string().nullish(),
      supplierId: zOptId,
      status: z.enum(['active', 'cancelled']).nullish(),
    }),
    handler: (ctx, input) => purchases.listPurchases(ctx, input),
  }),

  /* ---------------- Payments made to suppliers ---------------- */
  'supplierPayments.create': route({
    access: 'suppliers.pay',
    mutation: true,
    input: zPaymentInput,
    handler: (ctx, input) => payments.createSupplierPayment(ctx, input),
  }),
  'supplierPayments.update': route({
    access: 'suppliers.pay',
    mutation: true,
    input: zPaymentInput.extend({ id: z.number().int().positive(), reason: zOptText(300) }),
    handler: (ctx, { id, reason, ...input }) => payments.updateSupplierPayment(ctx, id, input, reason),
  }),
  'supplierPayments.cancel': route({
    access: 'suppliers.pay',
    mutation: true,
    input: z.object({ id: z.number().int().positive(), reason: z.string().trim().min(1, 'Enter the reason for cancelling').max(300) }),
    handler: (ctx, input) => payments.cancelSupplierPayment(ctx, input.id, input.reason),
  }),
  'supplierPayments.get': route({
    access: [...VIEW_PAYMENTS],
    input: zDocId,
    handler: (ctx, input) => payments.getSupplierPaymentDetail(ctx, input.id),
  }),
  'supplierPayments.list': route({
    access: [...VIEW_PAYMENTS],
    input: z.object({
      from: zDate.nullish(),
      to: zDate.nullish(),
      q: z.string().nullish(),
      supplierId: zOptId,
      mode: zSettlementMode.nullish(),
      status: z.enum(['active', 'cancelled']).nullish(),
    }),
    handler: (ctx, input) => payments.listSupplierPayments(ctx, input),
  }),
  'supplierPayments.voucherHtml': route({
    access: [...VIEW_PAYMENTS],
    input: zDocId,
    handler: (ctx, input) => ({ html: payments.paymentVoucherHtml(ctx, input.id) }),
  }),
  'supplierPayments.print': route({
    access: [...VIEW_PAYMENTS],
    input: zDocId,
    handler: (ctx, input) => payments.printPaymentVoucher(ctx, input.id),
  }),
};
