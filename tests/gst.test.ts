import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance, type TestApp } from './helpers';
import { calcBill } from '../src/shared/billing';
import { purchaseTotals } from '../src/shared/purchase';
import { gstinCheckChar, gstinProblem, lineTax, taxShare } from '../src/shared/gst';
import { setOffCredit } from '../src/core/modules/gst/payment';

// Valid GSTINs (checksums verified): Maharashtra 27, Karnataka 29.
const OWN_GSTIN = '27AAPFU0939F1ZV';
const KA_GSTIN = '29AAGCB7383J1Z4';
const MH_CUSTOMER = `27ABCDE1234F1Z${gstinCheckChar('27ABCDE1234F1Z')}`;

let t: TestApp;
afterEach(() => t?.close());

async function register(t: TestApp, values: Record<string, unknown> = {}) {
  await t.call('settings.update', { section: 'gst', values: { registration: 'regular', gstin: OWN_GSTIN, ...values } });
}

async function item(t: TestApp, name: string, rate: number, gstRate: number | null, hsn: string | null = null) {
  return t.call('items.create', { name, unit: 'pcs', rate, gstRate, hsn });
}

const accountExists = (t: TestApp, key: string) => t.app.db.value<number>('SELECT COUNT(*) FROM accounts WHERE system_key = ?', [key], 0) > 0;

describe('GST arithmetic (shared by the till and the core)', () => {
  it('checks GSTINs, including the check character', () => {
    expect(gstinProblem(OWN_GSTIN)).toBeNull();
    expect(gstinProblem(KA_GSTIN)).toBeNull();
    expect(gstinProblem('27AAPFU0939F1ZX')).toMatch(/not valid/);
    expect(gstinProblem('27AAPFU0939F1Z')).toMatch(/15 characters/);
    expect(gstinProblem('99AAPFU0939F1ZV')).toMatch(/state code/);
  });

  it('takes tax out of inclusive rates and adds it on top of exclusive ones', () => {
    expect(lineTax(11800, 18, true, false)).toEqual({ taxable: 10000, cgst: 900, sgst: 900, igst: 0 });
    expect(lineTax(10000, 18, false, false)).toEqual({ taxable: 10000, cgst: 900, sgst: 900, igst: 0 });
    expect(lineTax(10500, 5, true, true)).toEqual({ taxable: 10000, cgst: 0, sgst: 0, igst: 500 });
    expect(lineTax(999, 0, true, false)).toEqual({ taxable: 999, cgst: 0, sgst: 0, igst: 0 });
  });

  it('keeps the bill total the same with inclusive rates, and posts sales and discounts without tax', () => {
    const lines = [
      { qty: 2, rate: 14500, gstRate: 5 },
      { qty: 3, rate: 16250, discountPct: 5, gstRate: 5 },
      { qty: 6, rate: 1000, gstRate: 18 },
    ];
    const plain = calcBill({ lines, billDiscount: 1000, roundOff: true });
    const withGst = calcBill({ lines, billDiscount: 1000, roundOff: true, gst: { inclusive: true, interState: false } });
    expect(withGst.total).toBe(plain.total);
    const g = withGst.gst!;
    expect(g.taxable + g.tax).toBe(plain.beforeRound);
    expect(g.grossEx - g.discountEx).toBe(g.taxable);
    expect(g.cgst).toBe(g.sgst);
    // Each line's tax is on what the customer pays for it: its share of the bill discount is taken off first.
    expect(g.lines.reduce((s, l) => s + l.billDiscountShare, 0)).toBe(1000);
  });

  it('adds tax on top with exclusive rates', () => {
    const c = calcBill({ lines: [{ qty: 1, rate: 10000, gstRate: 18 }], roundOff: false, gst: { inclusive: false, interState: false } });
    expect(c.total).toBe(11800);
    expect(c.gst).toMatchObject({ taxable: 10000, cgst: 900, sgst: 900, tax: 1800, grossEx: 10000, discountEx: 0 });
  });

  it('shares the purchase discount before tax', () => {
    const p = purchaseTotals({ items: [{ qty: 10, rate: 1000, gstRate: 18 }], discount: 1000, roundOff: false, gst: { inclusive: false, interState: true } });
    expect(p.gst).toMatchObject({ taxable: 9000, igst: 1620, tax: 1620 });
    expect(p.total).toBe(10620);
  });

  it('takes back tax in proportion, and all that is left on the last return', () => {
    const t0 = { taxable: 10000, cgst: 900, sgst: 900, igst: 0 };
    const part = taxShare(t0, 11800, 5900, t0, false);
    expect(part).toEqual({ taxable: 5000, cgst: 450, sgst: 450, igst: 0 });
    const rest = taxShare(t0, 11800, 5900, { taxable: 0, cgst: 450, sgst: 450, igst: 0 }, true);
    expect(rest.cgst + part.cgst).toBe(900);
  });

  it('sets off credit in the legal order: IGST credit first, CGST and SGST never for each other', () => {
    const s = setOffCredit({ cgst: 1000, sgst: 1000, igst: 500 }, { cgst: 200, sgst: 900, igst: 1000 });
    // IGST credit: 500 to IGST, then 500 to the CGST shortfall (CGST credit covers only 200 of 1000).
    expect(s.setOff).toEqual([
      { from: 'igst', to: 'igst', amount: 500 },
      { from: 'igst', to: 'cgst', amount: 500 },
      { from: 'cgst', to: 'cgst', amount: 200 },
      { from: 'sgst', to: 'sgst', amount: 900 },
    ]);
    expect(s.cash).toEqual({ cgst: 300, sgst: 100, igst: 0 });
    expect(s.creditLeft).toEqual({ cgst: 0, sgst: 0, igst: 0 });
    // SGST credit left over stays for next month; it is not used for CGST.
    expect(setOffCredit({ cgst: 100, sgst: 0, igst: 0 }, { cgst: 0, sgst: 500, igst: 0 }).cash.cgst).toBe(100);
  });
});

describe('unregistered businesses', () => {
  it('bill exactly as before: no GST accounts, no tax, sales at the full amount', async () => {
    t = await createTestApp();
    const sugar = await item(t, 'Sugar', 4800, 5);
    const bill = await t.call('sales.create', { items: [{ itemId: sugar.id, itemName: 'Sugar', qty: 2, rate: 4800 }], payments: [{ mode: 'cash', amount: 9600 }] });
    expect(bill.gst.mode).toBe('none');
    expect(bill.items[0].gstRate).toBeNull();
    expect(systemBalance(t.app, 'SALES')).toBe(-9600);
    expect(accountExists(t, 'GST_OUT_CGST')).toBe(false);
    const html = (await t.call('sales.receiptHtml', { id: bill.id })).html;
    expect(html).toContain('>BILL<');
    expect(html).not.toContain('GSTIN');
    expect((await t.call('sales.posConfig')).gst.mode).toBe('none');
  });
});

describe('registering for GST', () => {
  it('needs a valid GSTIN and creates the GST accounts', async () => {
    t = await createTestApp();
    expect((await t.fails('settings.update', { section: 'gst', values: { registration: 'regular' } })).message).toMatch(/GSTIN/);
    expect((await t.fails('settings.update', { section: 'gst', values: { registration: 'regular', gstin: '27AAPFU0939F1ZX' } })).message).toMatch(/not valid/);
    await register(t, { gstin: ' 27aapfu0939f1zv ' });
    const s = await t.call('settings.get');
    expect(s.gst).toMatchObject({ registration: 'regular', gstin: OWN_GSTIN, ratesIncludeGst: true });
    for (const key of ['GST_OUT_CGST', 'GST_OUT_SGST', 'GST_OUT_IGST', 'GST_IN_CGST', 'GST_IN_SGST', 'GST_IN_IGST', 'COMPOSITION_TAX']) expect(accountExists(t, key)).toBe(true);
    const log = t.app.db.value<string>("SELECT summary FROM activity_log WHERE action = 'settings.update' ORDER BY id DESC LIMIT 1", undefined, '');
    expect(log).toMatch(/GST registration Not registered for GST → Registered \(regular\)/);
  });

  it('only the owner (settings.manage) may change it', async () => {
    t = await createTestApp();
    await t.loginAs('manager');
    expect((await t.fails('settings.update', { section: 'gst', values: { registration: 'regular', gstin: OWN_GSTIN } })).code).toBe('FORBIDDEN');
  });
});

describe('bills with GST (regular)', () => {
  it('prices include GST: the tax is taken out, sales are posted without it', async () => {
    t = await createTestApp();
    await register(t);
    const soap = await item(t, 'Soap', 11800, 18, '3401');
    const bill = await t.call('sales.create', { items: [{ itemId: soap.id, itemName: 'Soap', qty: 1, rate: 11800 }], payments: [{ mode: 'cash', amount: 11800 }] });
    expect(bill.total).toBe(11800);
    expect(bill.gst).toMatchObject({ mode: 'regular', inclusive: true, sellerGstin: OWN_GSTIN, placeOfSupply: '27', interState: false, taxable: 10000, cgst: 900, sgst: 900, tax: 1800 });
    expect(bill.items[0]).toMatchObject({ gstRate: 18, hsn: '3401', taxable: 10000, cgst: 900, sgst: 900 });
    expect(systemBalance(t.app, 'SALES')).toBe(-10000);
    expect(systemBalance(t.app, 'GST_OUT_CGST')).toBe(-900);
    expect(systemBalance(t.app, 'GST_OUT_SGST')).toBe(-900);
    expect(systemBalance(t.app, 'CASH')).toBe(11800);
    expect(ledgerProblems(t.app)).toEqual([]);
    const html = (await t.call('sales.receiptHtml', { id: bill.id })).html;
    expect(html).toContain('TAX INVOICE');
    expect(html).toContain(`GSTIN: ${OWN_GSTIN}`);
    expect(html).toContain('HSN 3401');
    expect(html).toContain('Prices include GST of ₹18.00');
  });

  it('rates without GST: tax is added on top, and a bill discount lowers the tax', async () => {
    t = await createTestApp();
    await register(t, { ratesIncludeGst: false });
    const rice = await item(t, 'Rice', 10000, 5);
    const bill = await t.call('sales.create', {
      items: [{ itemId: rice.id, itemName: 'Rice', qty: 2, rate: 10000 }],
      billDiscount: 2000,
      payments: [{ mode: 'upi', amount: 18900 }],
    });
    // 20000 - 2000 = 18000 taxable, 5% = 900 tax.
    expect(bill.gst).toMatchObject({ taxable: 18000, cgst: 450, sgst: 450 });
    expect(bill.total).toBe(18900);
    expect(systemBalance(t.app, 'SALES')).toBe(-20000);
    expect(systemBalance(t.app, 'DISCOUNT_ALLOWED')).toBe(2000);
    expect(ledgerProblems(t.app)).toEqual([]);
    const html = (await t.call('sales.receiptHtml', { id: bill.id })).html;
    expect(html).toContain('Taxable value');
    expect(html).toContain('CGST');
  });

  it('charges IGST to a customer in another state and prints their GSTIN', async () => {
    t = await createTestApp();
    await register(t);
    const c = await t.call('customers.create', { name: 'Bengaluru Traders', gstin: KA_GSTIN });
    expect(c.stateCode).toBe('29');
    const pen = await item(t, 'Pen', 1180, 18);
    const bill = await t.call('sales.create', { customerId: c.id, items: [{ itemId: pen.id, itemName: 'Pen', qty: 10, rate: 1180 }], payments: [] });
    expect(bill.gst).toMatchObject({ interState: true, placeOfSupply: '29', customerGstin: KA_GSTIN, igst: 1800, cgst: 0, sgst: 0 });
    expect(systemBalance(t.app, 'GST_OUT_IGST')).toBe(-1800);
    expect(systemBalance(t.app, 'AR')).toBe(11800);
    const html = (await t.call('sales.receiptHtml', { id: bill.id })).html;
    expect(html).toContain(`GSTIN: ${KA_GSTIN}`);
    expect(html).toContain('Place of supply');
    expect(html).toContain('IGST');
  });

  it('uses the default rate for items without one and for one-time lines, which may pick their own', async () => {
    t = await createTestApp();
    await register(t, { defaultRate: 12 });
    const misc = await item(t, 'Misc', 11200, null);
    const bill = await t.call('sales.create', {
      items: [
        { itemId: misc.id, itemName: 'Misc', qty: 1, rate: 11200 },
        { itemName: 'Repair work', qty: 1, rate: 11800, gstRate: 18, hsn: '998729' },
      ],
      payments: [{ mode: 'cash', amount: 23000 }],
    });
    expect(bill.items.map((i) => i.gstRate)).toEqual([12, 18]);
    expect(bill.items[1].hsn).toBe('998729');
    expect((await t.fails('sales.create', { items: [{ itemName: 'X', qty: 1, rate: 100, gstRate: 7 }], payments: [] })).message).toMatch(/GST rate/);
  });

  it('keeps bills made before registering without GST, even when edited later', async () => {
    t = await createTestApp();
    const tea = await item(t, 'Tea', 5000, 5);
    const old = await t.call('sales.create', { items: [{ itemId: tea.id, itemName: 'Tea', qty: 1, rate: 5000 }], payments: [{ mode: 'cash', amount: 5000 }] });
    await register(t);
    const edited = await t.call('sales.update', { id: old.id, items: [{ itemId: tea.id, itemName: 'Tea', qty: 2, rate: 5000 }], payments: [{ mode: 'cash', amount: 10000 }] });
    expect(edited.gst.mode).toBe('none');
    expect(edited.gst.tax).toBe(0);
    expect(systemBalance(t.app, 'SALES')).toBe(-10000);
    // And a GST bill keeps its tax treatment (and the rate it was billed at) when edited.
    const bill = await t.call('sales.create', { items: [{ itemId: tea.id, itemName: 'Tea', qty: 1, rate: 5000 }], payments: [{ mode: 'cash', amount: 5000 }] });
    await t.call('items.update', { id: tea.id, name: 'Tea', unit: 'pcs', rate: 5000, gstRate: 18 });
    const again = await t.call('sales.update', { id: bill.id, items: [{ itemId: tea.id, itemName: 'Tea', qty: 2, rate: 5000 }], payments: [{ mode: 'cash', amount: 10000 }] });
    expect(again.items[0].gstRate).toBe(5);
    expect(again.gst.tax).toBe(476);
    const revs = await t.call('sales.revisions', { id: bill.id });
    expect(revs[1].changes.map((c) => c.label)).toContain('GST');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('gives the till what it needs to preview the same tax', async () => {
    t = await createTestApp();
    await register(t, { ratesIncludeGst: false, defaultRate: 5 });
    expect((await t.call('sales.posConfig')).gst).toEqual({ mode: 'regular', inclusive: false, stateCode: '27', defaultRate: 5 });
    const found = await t.call('customers.search', { q: '' });
    expect(found).toEqual([]);
  });
});

describe('returns against a GST bill', () => {
  it('refund includes the tax, and the tax is taken back line by line', async () => {
    t = await createTestApp();
    await register(t);
    const soap = await item(t, 'Soap', 11800, 18);
    const bill = await t.call('sales.create', { items: [{ itemId: soap.id, itemName: 'Soap', qty: 3, rate: 11800 }], payments: [{ mode: 'cash', amount: 35400 }] });
    const r = await t.call('returns.billReturnable', { billId: bill.id });
    expect(r.bill.gst).toBe(true);
    expect(r.lines[0]).toMatchObject({ netRate: 11800, gstRate: 18 });
    const one = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'cash' });
    expect(one.total).toBe(11800);
    expect(one.gst).toMatchObject({ mode: 'regular', cgst: 900, sgst: 900, taxable: 10000 });
    expect(systemBalance(t.app, 'SALES_RETURNS')).toBe(10000);
    expect(systemBalance(t.app, 'GST_OUT_CGST')).toBe(-1800);
    const html = (await t.call('returns.receiptHtml', { id: one.id })).html;
    expect(html).toContain('CREDIT NOTE');
    expect(html).toContain(`GSTIN: ${OWN_GSTIN}`);
    // The rest: all the tax left on the line comes back, to the paisa.
    await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 2 }], refundMode: 'cash' });
    expect(systemBalance(t.app, 'GST_OUT_CGST')).toBe(0);
    expect(systemBalance(t.app, 'GST_OUT_SGST')).toBe(0);
    expect(systemBalance(t.app, 'SALES') + systemBalance(t.app, 'SALES_RETURNS')).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('with tax added on top, refunds what the customer paid including tax', async () => {
    t = await createTestApp();
    await register(t, { ratesIncludeGst: false });
    const rice = await item(t, 'Rice', 3333, 5);
    const bill = await t.call('sales.create', { items: [{ itemId: rice.id, itemName: 'Rice', qty: 3, rate: 3333 }], payments: [{ mode: 'cash', amount: 10500 }] });
    // 9999 + 500 tax = 10499, rounded up to 10500.
    expect(bill.total).toBe(10500);
    const all = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 3 }], refundMode: 'cash' });
    expect(all.total).toBe(10500);
    expect(systemBalance(t.app, 'GST_OUT_CGST') + systemBalance(t.app, 'GST_OUT_SGST')).toBe(0);
    expect(systemBalance(t.app, 'CASH')).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('purchases with GST', () => {
  it('claims input tax credit when the supplier has a GSTIN', async () => {
    t = await createTestApp();
    await register(t);
    const s = await t.call('suppliers.create', { name: 'Pune Wholesale', gstin: MH_CUSTOMER });
    const p = await t.call('purchases.create', {
      supplierId: s.id,
      supplierBillNo: 'PW-1',
      items: [{ description: 'Soap cartons', qty: 10, rate: 10000, gstRate: 18, hsn: '3401' }],
      payments: [],
    });
    expect(p.gst).toMatchObject({ mode: 'regular', itc: true, taxable: 100000, cgst: 9000, sgst: 9000, supplierGstin: MH_CUSTOMER });
    expect(p.total).toBe(118000);
    expect(systemBalance(t.app, 'PURCHASES')).toBe(100000);
    expect(systemBalance(t.app, 'GST_IN_CGST')).toBe(9000);
    expect(systemBalance(t.app, 'AP')).toBe(-118000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('puts the tax in the cost without a supplier GSTIN, and refuses to claim it', async () => {
    t = await createTestApp();
    await register(t);
    const p = await t.call('purchases.create', { supplierName: 'Local shop', items: [{ description: 'Tape', qty: 1, rate: 10000, gstRate: 18 }], payments: [{ mode: 'cash', amount: 11800 }] });
    expect(p.gst).toMatchObject({ itc: false, tax: 1800 });
    expect(systemBalance(t.app, 'PURCHASES')).toBe(11800);
    expect((await t.fails('purchases.create', { supplierName: 'Local shop', itc: true, items: [{ description: 'Tape', qty: 1, rate: 10000 }], payments: [{ mode: 'cash', amount: 11800 }] })).message).toMatch(/GSTIN/);
  });

  it('charges IGST on a purchase from another state', async () => {
    t = await createTestApp();
    await register(t);
    const s = await t.call('suppliers.create', { name: 'Bengaluru Mills', gstin: KA_GSTIN });
    const p = await t.call('purchases.create', { supplierId: s.id, items: [{ description: 'Rice', qty: 1, rate: 10000, gstRate: 5 }], payments: [] });
    expect(p.gst).toMatchObject({ interState: true, igst: 500, cgst: 0 });
    expect(systemBalance(t.app, 'GST_IN_IGST')).toBe(500);
  });
});

describe('GST summaries and paying GST', () => {
  async function month(t: TestApp) {
    await register(t);
    const b2b = await t.call('customers.create', { name: 'Kumar Stores', gstin: MH_CUSTOMER });
    const soap = await item(t, 'Soap', 11800, 18, '3401');
    const rice = await item(t, 'Rice', 10500, 5, '1006');
    await t.call('sales.create', { customerId: b2b.id, items: [{ itemId: soap.id, itemName: 'Soap', qty: 10, rate: 11800 }], payments: [] });
    const walkIn = await t.call('sales.create', { items: [{ itemId: rice.id, itemName: 'Rice', qty: 2, rate: 10500 }], payments: [{ mode: 'cash', amount: 21000 }] });
    await t.call('returns.create', { kind: 'return', billId: walkIn.id, items: [{ billItemId: walkIn.items[0].id, qty: 1 }], refundMode: 'cash' });
    const sup = await t.call('suppliers.create', { name: 'Supplier', gstin: KA_GSTIN });
    await t.call('purchases.create', { supplierId: sup.id, items: [{ description: 'Soap', qty: 10, rate: 5000, gstRate: 18 }], payments: [] });
    return { b2b, soap, rice };
  }

  it('summarise output tax, input credit, B2B / B2C and HSN', async () => {
    t = await createTestApp();
    await month(t);
    const range = { from: '2026-09-01', to: '2026-09-30' };
    const summary = await t.call('gst.summary', range);
    const find = (label: RegExp) => summary.rows.find((r) => label.test(String(r.cells.particulars)))!;
    expect(find(/B2B/).cells).toMatchObject({ taxable: 100000, cgst: 9000, sgst: 9000, igst: 0 });
    expect(find(/B2C/).cells).toMatchObject({ taxable: 20000, cgst: 500, sgst: 500 });
    expect(find(/returns/).cells).toMatchObject({ taxable: -10000, cgst: -250, sgst: -250 });
    expect(find(/^Output tax$/).cells.tax).toBe(19000 - 500);
    expect(find(/^Input tax credit$/).cells).toMatchObject({ igst: 9000 });
    const register_ = await t.call('gst.salesRegister', { ...range, kind: 'b2b' });
    expect(register_.rows.filter((r) => r.link?.kind === 'bill')).toHaveLength(1);
    const all = await t.call('gst.salesRegister', range);
    expect(all.rows.some((r) => String(r.cells.type).startsWith('Credit note'))).toBe(true);
    const hsn = await t.call('gst.hsnSummary', range);
    const riceRow = hsn.rows.find((r) => r.cells.hsn === '1006')!;
    expect(riceRow.cells).toMatchObject({ qty: 1, rate: 5, taxable: 10000 });
    const purchases = await t.call('gst.purchaseRegister', range);
    expect(purchases.summary?.find((s) => s.label.startsWith('Input tax'))?.value).toBe(9000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('pays GST: sets off the credit, pays the rest, and finds nothing due the second time', async () => {
    t = await createTestApp();
    await month(t);
    t.setToday('2026-10-15');
    const due = await t.call('gst.due', { upTo: '2026-09-30' });
    if (due.mode !== 'regular') throw new Error('expected regular');
    expect(due.liability).toEqual({ cgst: 9250, sgst: 9250, igst: 0 });
    expect(due.credit).toEqual({ cgst: 0, sgst: 0, igst: 9000 });
    // IGST credit (9000) covers CGST and SGST where their own credit falls short.
    expect(due.cashTotal).toBe(18500 - 9000);
    const paid = await t.call('gst.pay', { upTo: '2026-09-30', mode: 'bank', reference: 'CPIN123' });
    expect(paid.voucherType).toBe('gst_payment');
    expect(systemBalance(t.app, 'GST_OUT_CGST')).toBe(0);
    expect(systemBalance(t.app, 'GST_OUT_SGST')).toBe(0);
    expect(systemBalance(t.app, 'GST_IN_IGST')).toBe(0);
    expect(systemBalance(t.app, 'BANK')).toBe(-9500);
    const again = await t.call('gst.due', { upTo: '2026-09-30' });
    expect(again.mode === 'regular' && again.cashTotal).toBe(0);
    expect((await t.fails('gst.pay', { upTo: '2026-09-30', mode: 'bank' })).message).toMatch(/No GST is due/);
    // Cancelling the payment (from Accounts) makes it due again.
    await t.call('journals.cancel', { entryId: paid.id, reason: 'Wrong challan' });
    const back = await t.call('gst.due', { upTo: '2026-09-30' });
    expect(back.mode === 'regular' && back.cashTotal).toBe(9500);
    expect((await t.call('gst.payments')).map((p) => p.cancelled)).toEqual([true]);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('refuses to pay before the period ends or when not registered', async () => {
    t = await createTestApp();
    expect((await t.fails('gst.due', { upTo: '2026-09-30' })).message).toMatch(/not registered/);
    await month(t);
    expect((await t.fails('gst.pay', { upTo: '2026-09-30', date: '2026-09-28', mode: 'bank' })).message).toMatch(/on or after/);
  });
});

describe('composition scheme', () => {
  it('prints a bill of supply without tax and pays tax on turnover from the business', async () => {
    t = await createTestApp();
    await t.call('settings.update', { section: 'gst', values: { registration: 'composition', gstin: OWN_GSTIN, compositionRate: 1 } });
    const tea = await item(t, 'Tea', 100000, 5);
    const bill = await t.call('sales.create', { items: [{ itemId: tea.id, itemName: 'Tea', qty: 3, rate: 100000 }], payments: [{ mode: 'cash', amount: 300000 }] });
    expect(bill.gst).toMatchObject({ mode: 'composition', tax: 0, sellerGstin: OWN_GSTIN });
    expect(systemBalance(t.app, 'SALES')).toBe(-300000);
    const html = (await t.call('sales.receiptHtml', { id: bill.id })).html;
    expect(html).toContain('BILL OF SUPPLY');
    expect(html).toContain('not eligible to collect tax');
    expect(html).not.toContain('CGST');
    const range = { from: '2026-07-01', to: '2026-09-30' };
    const report = await t.call('gst.compositionSummary', range);
    expect(report.summary?.find((s) => s.label === 'Tax payable')?.value).toBe(3000);
    t.setToday('2026-10-10');
    const due = await t.call('gst.due', { from: range.from, upTo: range.to });
    expect(due.mode === 'composition' && due.tax).toBe(3000);
    await t.call('gst.pay', { from: range.from, upTo: range.to, mode: 'bank' });
    expect(systemBalance(t.app, 'COMPOSITION_TAX')).toBe(3000);
    expect((await t.fails('gst.pay', { from: range.from, upTo: range.to, mode: 'bank' })).message).toMatch(/already paid/);
    // Purchases stay as before (no input tax credit under composition).
    const p = await t.call('purchases.create', { supplierName: 'Market', items: [{ description: 'Milk', qty: 1, rate: 5000, gstRate: 5 }], payments: [{ mode: 'cash', amount: 5000 }] });
    expect(p.gst.mode).toBe('none');
    expect(p.total).toBe(5000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('items, parties and import', () => {
  it('validates HSN codes, GST rates and party GSTINs', async () => {
    t = await createTestApp();
    await register(t);
    expect((await t.fails('items.create', { name: 'Bad', unit: 'pcs', rate: 100, hsn: '12' })).message).toMatch(/4, 6 or 8 digits/);
    expect((await t.fails('items.create', { name: 'Bad', unit: 'pcs', rate: 100, gstRate: 7 })).message).toMatch(/GST rate/);
    expect((await t.fails('customers.create', { name: 'X', gstin: '27AAPFU0939F1ZX' })).message).toMatch(/not valid/);
    const c = await t.call('customers.create', { name: 'Y', stateCode: '29' });
    expect(c).toMatchObject({ gstin: null, stateCode: '29' });
    // Editing without the GST fields leaves them as they are.
    const same = await t.call('customers.update', { id: c.id, name: 'Y2' });
    expect(same.stateCode).toBe('29');
    const it1 = await item(t, 'Oil', 20000, 5, '1512');
    const kept = await t.call('items.update', { id: it1.id, name: 'Oil', unit: 'pcs', rate: 21000 });
    expect(kept).toMatchObject({ gstRate: 5, hsn: '1512' });
  });

  it('shows HSN and GST % columns in the item import only when registered', async () => {
    t = await createTestApp();
    const before = (await t.call('import.types')).find((x) => x.type === 'items')!;
    expect(before.fields.map((f) => f.key)).not.toContain('gstRate');
    await register(t);
    const after = (await t.call('import.types')).find((x) => x.type === 'items')!;
    expect(after.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['hsn', 'gstRate']));
  });

  it('imports HSN, GST % and GSTIN columns from Excel / CSV', async () => {
    t = await createTestApp();
    await register(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-gst-import-'));
    const items = path.join(dir, 'items.csv');
    fs.writeFileSync(items, ['Item name,Rate,HSN code,GST %', 'Rice,52,1006,5', 'Soap,59,3401,18%', 'Odd,10,12,7'].join('\r\n'));
    const p = await t.call('import.preview', { type: 'items', path: items });
    expect(p.mapping).toMatchObject({ name: 0, rate: 1, hsn: 2, gstRate: 3 });
    const odd = p.rows.find((r) => r.values.name === 'Odd')!;
    expect(Object.keys(odd.fieldErrors).sort()).toEqual(['gstRate', 'hsn']);
    await t.call('import.commit', { type: 'items', path: items, duplicateMode: 'skip' });
    const list = await t.call('items.list', {});
    expect(list.find((i) => i.name === 'Soap')).toMatchObject({ hsn: '3401', gstRate: 18 });
    const customers = path.join(dir, 'customers.csv');
    fs.writeFileSync(customers, ['Name,Phone,GSTIN', `Kumar Stores,90000 00001,${MH_CUSTOMER.toLowerCase()}`, 'Bad GST,90000 00002,27AAPFU0939F1ZX'].join('\r\n'));
    const c = await t.call('import.preview', { type: 'customers', path: customers });
    expect(c.rows.find((r) => r.values.name === 'Bad GST')!.fieldErrors.gstin).toMatch(/not valid/);
    await t.call('import.commit', { type: 'customers', path: customers, duplicateMode: 'skip' });
    expect((await t.call('customers.search', { q: 'Kumar' }))[0]).toMatchObject({ gstin: MH_CUSTOMER, stateCode: '27' });
  });
});
