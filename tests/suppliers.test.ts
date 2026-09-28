import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance, type TestApp } from './helpers';
import { partyBalance } from '../src/core/accounting/ledger';

/** Amount you owe the supplier (+ = payable). */
const payable = (t: TestApp, id: number) => 0 - partyBalance(t.app.ctx(), 'supplier', id, { account: 'AP' });

async function creditPurchase(t: TestApp, supplierId: number, amount: number, date?: string) {
  return t.call('purchases.create', {
    supplierId,
    date,
    items: [{ description: 'Stock', qty: 1, rate: amount }],
    roundOff: false,
  });
}

describe('supplier records', () => {
  it('creates suppliers with opening balances in both directions and edits them', async () => {
    const t = await createTestApp();
    const s = await t.call('suppliers.create', {
      name: 'Gupta Traders',
      phone: '98220 33333',
      contactPerson: 'Mr. Gupta',
      address: 'Market Yard, Pune',
      openingBalance: { amount: 250000, direction: 'payable' },
    });
    expect(s.payable).toBe(250000);
    expect(s.openingBalance).toEqual({ amount: 250000, direction: 'payable' });
    expect(s.contactPerson).toBe('Mr. Gupta');
    expect(systemBalance(t.app, 'AP')).toBe(-250000);
    expect(systemBalance(t.app, 'OPENING_EQUITY')).toBe(250000);

    const adv = await t.call('suppliers.create', { name: 'Advance Co', openingBalance: { amount: 10000, direction: 'advance' } });
    expect(adv.payable).toBe(-10000);
    expect(adv.openingBalance).toEqual({ amount: 10000, direction: 'advance' });

    const entryId = t.app.db.value<number>('SELECT opening_entry_id FROM suppliers WHERE id = ?', [s.id]);
    let u = await t.call('suppliers.update', { id: s.id, name: 'Gupta Traders', openingBalance: { amount: 5000, direction: 'advance' } });
    expect(u.payable).toBe(-5000);
    expect(t.app.db.value('SELECT opening_entry_id FROM suppliers WHERE id = ?', [s.id])).toBe(entryId);
    u = await t.call('suppliers.update', { id: s.id, name: 'Gupta Traders Pvt Ltd', openingBalance: null });
    expect(u.payable).toBe(0);
    expect(u.openingBalance).toBeNull();
    expect(t.app.db.value('SELECT is_void FROM journal_entries WHERE id = ?', [entryId])).toBe(1);
    expect(t.app.db.value<string>("SELECT summary FROM activity_log WHERE action = 'supplier.update' ORDER BY id DESC LIMIT 1")).toContain(
      'renamed from "Gupta Traders"',
    );
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('keeps supplier names unique and validates details', async () => {
    const t = await createTestApp();
    const a = await t.call('suppliers.create', { name: 'Gupta Traders' });
    let err = await t.fails('suppliers.create', { name: 'gupta traders' });
    expect(err.message).toBe('A supplier named "gupta traders" already exists');
    err = await t.fails('suppliers.quickCreate', { name: 'Gupta Traders' });
    expect(err.code).toBe('VALIDATION');
    const b = await t.call('suppliers.create', { name: 'Other' });
    expect((await t.fails('suppliers.update', { id: b.id, name: 'GUPTA TRADERS' })).fields?.name).toBeTruthy();
    expect((await t.fails('suppliers.create', { name: 'X', email: 'bad@' })).fields?.email).toBeTruthy();
    await t.call('suppliers.setActive', { id: a.id, active: false });
    const again = await t.call('suppliers.create', { name: 'Gupta Traders' });
    expect(again.id).not.toBe(a.id);
    expect((await t.fails('suppliers.setActive', { id: a.id, active: true })).message).toMatch(/already exists/);
  });

  it('lists suppliers with payable and this year purchases; removes or deactivates', async () => {
    const t = await createTestApp();
    const a = await t.call('suppliers.create', { name: 'Anand Dairy', phone: '98220 11111' });
    const b = await t.call('suppliers.create', { name: 'Bharat Wholesale' });
    const fresh = await t.call('suppliers.create', { name: 'Fresh' });
    await creditPurchase(t, a.id, 120000, '2026-09-01');
    await t.call('purchases.create', {
      supplierId: a.id,
      items: [{ description: 'Milk', qty: 10, rate: 5000 }],
      payments: [{ mode: 'cash', amount: 50000 }],
    });
    let rows = await t.call('suppliers.list', {});
    expect(rows.map((r) => r.name)).toEqual(['Anand Dairy', 'Bharat Wholesale', 'Fresh']);
    expect(rows[0]).toMatchObject({ payable: 120000, lastPurchaseDate: '2026-09-28', purchasedThisFy: 170000 });
    rows = await t.call('suppliers.list', { onlyWithBalance: true });
    expect(rows.map((r) => r.id)).toEqual([a.id]);
    rows = await t.call('suppliers.list', { q: '11111' });
    expect(rows.map((r) => r.id)).toEqual([a.id]);

    const detail = await t.call('suppliers.get', { id: a.id });
    expect(detail.totals).toMatchObject({ purchases: 2, purchased: 170000, paidAtPurchase: 50000 });
    expect(detail.canRemove).toBe(false);

    const list = await t.call('suppliers.purchases', { supplierId: a.id });
    expect(list.rows).toHaveLength(2);
    expect(list.totals).toMatchObject({ count: 2, total: 170000, paid: 50000, credit: 120000 });

    expect(await t.call('suppliers.remove', { id: fresh.id })).toEqual({ deleted: true });
    const err = await t.fails('suppliers.remove', { id: a.id });
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/Deactivate the supplier instead/);
    await t.call('suppliers.setActive', { id: a.id, active: false });
    expect((await t.call('suppliers.search', { q: 'Anand' })).length).toBe(0);
    expect((await t.call('suppliers.list', { includeInactive: true })).find((r) => r.id === a.id)?.isActive).toBe(false);
    void b;
  });
});

describe('payments to suppliers', () => {
  it('pays a supplier with discount received and posts it per the contract', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const s = await t.call('suppliers.create', { name: 'Gupta Traders', openingBalance: { amount: 100000, direction: 'payable' } });
    await creditPurchase(t, s.id, 50000, '2026-09-10');
    expect(payable(t, s.id)).toBe(150000);

    const p = await t.call('supplierPayments.create', { supplierId: s.id, amount: 145000, discount: 5000, mode: 'cash', remarks: 'Full and final' });
    expect(p.paymentNo).toBe('PAY/26-27/0001');
    expect(p.warnings).toEqual([]);
    expect(payable(t, s.id)).toBe(0);
    expect(systemBalance(t.app, 'CASH')).toBe(1000000 - 145000);
    expect(systemBalance(t.app, 'DISCOUNT_RECEIVED')).toBe(-5000);
    expect(systemBalance(t.app, 'AP')).toBe(0);

    const d = await t.call('supplierPayments.get', { id: p.id });
    expect(d).toMatchObject({ payableBefore: 150000, payableAfter: 0, currentPayable: 0 });
    expect(d.posting.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['Sundry Creditors', 150000, 0],
      ['Cash in Hand', 0, 145000],
      ['Discount Received', 0, 5000],
    ]);
    const entry = t.app.db.get<any>('SELECT * FROM journal_entries WHERE id = ?', [p.journalEntryId]);
    expect(entry).toMatchObject({ voucher_type: 'payment', source_type: 'supplier_payment', source_id: p.id, voucher_no: 'PAY/26-27/0001' });
    expect(t.app.db.value<string>("SELECT summary FROM activity_log WHERE action = 'supplier_payment.create'")).toBe(
      'Paid ₹1,450.00 to Gupta Traders by Cash - PAY/26-27/0001 (discount received ₹50.00)',
    );
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('warns about advances, validates discount and edits / cancels with history', async () => {
    const t = await createTestApp();
    const s = await t.call('suppliers.create', { name: 'Gupta Traders', openingBalance: { amount: 30000, direction: 'payable' } });
    let err = await t.fails('supplierPayments.create', { supplierId: s.id, amount: 20000, discount: 15000, mode: 'cash' });
    expect(err.message).toMatch(/still payable after this payment \(₹100.00\)/);
    err = await t.fails('supplierPayments.create', { supplierId: s.id, amount: 0, mode: 'cash' });
    expect(err.message).toBe('Enter the amount paid');
    err = await t.fails('supplierPayments.create', { amount: 100, mode: 'cash' });
    expect(err.message).toMatch(/Choose a supplier/);

    const p = await t.call('supplierPayments.create', { supplierId: s.id, amount: 40000, mode: 'bank', reference: 'NEFT-1' });
    expect(p.warnings[0]).toMatch(/₹100.00 more than the amount payable/);
    expect(payable(t, s.id)).toBe(-10000);

    const e = await t.call('supplierPayments.update', { id: p.id, supplierId: s.id, amount: 25000, discount: 5000, mode: 'upi', reference: 'U-9', reason: 'Wrong amount' });
    expect(e).toMatchObject({ revision: 2, amount: 25000, discount: 5000, mode: 'upi', journalEntryId: p.journalEntryId });
    expect(payable(t, s.id)).toBe(0);
    expect(systemBalance(t.app, 'BANK')).toBe(0);
    expect(systemBalance(t.app, 'UPI')).toBe(-25000);

    const c = await t.call('supplierPayments.cancel', { id: p.id, reason: 'Paid by mistake' });
    expect(c.status).toBe('cancelled');
    expect(payable(t, s.id)).toBe(30000);
    expect(systemBalance(t.app, 'DISCOUNT_RECEIVED')).toBe(0);
    const revs = t.app.db.all<any>("SELECT revision, action, reason FROM document_revisions WHERE doc_type = 'supplier_payment' ORDER BY revision");
    expect(revs).toEqual([
      { revision: 1, action: 'created', reason: null },
      { revision: 2, action: 'edited', reason: 'Wrong amount' },
      { revision: 3, action: 'cancelled', reason: 'Paid by mistake' },
    ]);
    expect(t.app.db.all<any>("SELECT action FROM activity_log WHERE entity_type = 'supplier_payment' ORDER BY id").map((r) => r.action)).toEqual([
      'supplier_payment.create',
      'supplier_payment.update',
      'supplier_payment.cancel',
    ]);
    expect((await t.fails('supplierPayments.update', { id: p.id, supplierId: s.id, amount: 1, mode: 'cash' })).message).toMatch(/cancelled/);

    const list = await t.call('supplierPayments.list', { supplierId: s.id });
    expect(list.rows).toHaveLength(1);
    expect(list.totals).toMatchObject({ count: 0, amount: 0, cancelled: 1 });
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('lists payments with filters and prints a payment voucher', async () => {
    const t = await createTestApp();
    const a = await t.call('suppliers.create', { name: 'Anand Dairy', phone: '98220 11111', openingBalance: { amount: 90000, direction: 'payable' } });
    const b = await t.call('suppliers.create', { name: 'Bharat Wholesale', openingBalance: { amount: 90000, direction: 'payable' } });
    await t.call('supplierPayments.create', { supplierId: a.id, date: '2026-09-01', amount: 10000, mode: 'cash' });
    const p = await t.call('supplierPayments.create', { supplierId: b.id, date: '2026-09-20', amount: 20000, discount: 500, mode: 'bank', reference: 'CHQ 55' });
    let list = await t.call('supplierPayments.list', { from: '2026-09-01', to: '2026-09-30' });
    expect(list.totals).toEqual({ count: 2, amount: 30000, discount: 500, byMode: { cash: 10000, upi: 0, bank: 20000 }, cancelled: 0 });
    list = await t.call('supplierPayments.list', { q: 'CHQ' });
    expect(list.rows.map((r) => r.id)).toEqual([p.id]);
    list = await t.call('supplierPayments.list', { mode: 'cash' });
    expect(list.rows.map((r) => r.supplierName)).toEqual(['Anand Dairy']);

    const { html } = await t.call('supplierPayments.voucherHtml', { id: p.id });
    expect(html).toContain('PAYMENT VOUCHER');
    expect(html).toContain('Bharat Wholesale');
    expect(html).toContain('Rupees Two Hundred Only');
    expect(html).toContain('Payable before: ₹900.00');
    expect(html).toContain('Payable now: ₹695.00');
    await t.call('supplierPayments.print', { id: p.id });
    await t.call('supplierPayments.print', { id: p.id });
    expect(t.platform.printed).toHaveLength(2);
    expect(t.platform.printed[1].html).toContain('DUPLICATE');
  });

  it('only lets users with supplier permissions see or pay suppliers', async () => {
    const t = await createTestApp();
    const s = await t.call('suppliers.create', { name: 'Gupta Traders', openingBalance: { amount: 30000, direction: 'payable' } });
    await t.loginAs('cashier');
    expect((await t.fails('suppliers.list', {})).code).toBe('FORBIDDEN');
    expect((await t.fails('suppliers.get', { id: s.id })).code).toBe('FORBIDDEN');
    expect((await t.fails('suppliers.create', { name: 'X' })).code).toBe('FORBIDDEN');
    expect((await t.fails('supplierPayments.create', { supplierId: s.id, amount: 100, mode: 'cash' })).code).toBe('FORBIDDEN');
    expect((await t.fails('suppliers.payables', { asOf: '2026-09-28' })).code).toBe('FORBIDDEN');
    expect((await t.fails('suppliers.statement', { supplierId: s.id, from: '2026-04-01', to: '2026-09-28' })).code).toBe('FORBIDDEN');
    await t.loginAs('manager');
    const p = await t.call('supplierPayments.create', { supplierId: s.id, amount: 100, mode: 'cash' });
    expect(p.createdBy).toBe('Test manager');
    await t.call('suppliers.update', { id: s.id, name: 'Gupta Traders', phone: '98220 44444' });
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('supplier statement and payables', () => {
  it('shows bills as credits, payments as debits, with the closing equal to the ledger', async () => {
    const t = await createTestApp();
    const s = await t.call('suppliers.create', { name: 'Gupta Traders', phone: '98220 33333', openingBalance: { amount: 20000, direction: 'payable' } });
    const p1 = await t.call('purchases.create', {
      supplierId: s.id,
      date: '2026-05-05',
      supplierBillNo: 'GT/101',
      items: [{ description: 'Sugar', qty: 50, unit: 'kg', rate: 4000 }],
      roundOff: false,
    });
    const pay = await t.call('supplierPayments.create', { supplierId: s.id, date: '2026-06-01', amount: 100000, discount: 2000, mode: 'bank', reference: 'NEFT 1' });
    await t.call('purchases.create', {
      supplierId: s.id,
      date: '2026-07-01',
      items: [{ description: 'Oil', qty: 2, unit: 'ltr', rate: 15000 }],
      payments: [{ mode: 'cash', amount: 10000 }],
      roundOff: false,
    });
    const void1 = await creditPurchase(t, s.id, 99900, '2026-07-10');
    await t.call('purchases.cancel', { id: void1.id, reason: 'Wrong supplier' });

    const st = await t.call('suppliers.statement', { supplierId: s.id, from: '2026-04-01', to: '2026-09-28' });
    const body = st.rows.slice(1, -1);
    expect(body.map((r) => r.cells.type)).toEqual(['Opening balance', 'Purchase bill', 'Payment made', 'Purchase bill']);
    expect(body.map((r) => r.cells.balance)).toEqual([-20000, -220000, -118000, -138000]);
    expect(body[1].cells).toMatchObject({ number: p1.purchaseNo, particulars: 'Bill GT/101: Sugar 50 kg', credit: 200000, debit: null });
    expect(body[1].link).toEqual({ kind: 'purchase', id: p1.id });
    expect(body[2].cells).toMatchObject({ particulars: 'Bank · Ref NEFT 1 · incl. discount ₹20.00', debit: 102000 });
    expect(body[2].link).toEqual({ kind: 'supplier_payment', id: pay.id });
    expect(body[3].cells.particulars).toBe('Oil 2 ltr (bill ₹300.00, paid ₹100.00)');
    const closing = st.rows[st.rows.length - 1];
    expect(closing.cells.balance).toBe(-payable(t, s.id));
    expect(st.summary?.find((x) => x.label === 'Status')?.value).toBe('You owe ₹1,380.00');
    expect(st.columns.find((c) => c.key === 'credit')?.label).toBe('Credit (billed)');

    const later = await t.call('suppliers.statement', { supplierId: s.id, from: '2026-06-15', to: '2026-09-28' });
    expect(later.rows[0].cells.balance).toBe(-118000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('reports payables and advances as on a date', async () => {
    const t = await createTestApp();
    const a = await t.call('suppliers.create', { name: 'Anand Dairy', phone: '98220 11111' });
    const b = await t.call('suppliers.create', { name: 'Bharat Wholesale', openingBalance: { amount: 5000, direction: 'advance' } });
    await t.call('suppliers.create', { name: 'Zero' });
    await creditPurchase(t, a.id, 80000, '2026-08-01');
    await t.call('supplierPayments.create', { supplierId: a.id, date: '2026-09-18', amount: 30000, mode: 'cash' });
    const rep = await t.call('suppliers.payables', { asOf: '2026-09-28' });
    expect(rep.rows.map((r) => r.cells.name)).toEqual(['Anand Dairy', 'Bharat Wholesale', 'Total (2 suppliers)']);
    expect(rep.rows[0].cells).toMatchObject({ payable: 50000, advance: null, lastPurchase: '2026-08-01', lastPayment: '2026-09-18', days: 10 });
    expect(rep.rows[1].cells).toMatchObject({ payable: null, advance: 5000 });
    expect(rep.rows[2].cells).toMatchObject({ payable: 50000, advance: 5000 });
    expect(rep.summary?.map((s) => s.value)).toEqual([1, 50000, 5000, 45000]);
    expect(rep.rows[0].link).toEqual({ kind: 'supplier', id: a.id });
    const before = await t.call('suppliers.payables', { asOf: '2026-08-15' });
    expect(before.rows[0].cells.payable).toBe(80000);
    void b;
  });
});

describe('review fixes: supplier payments', () => {
  it('warns when a payment would take cash or bank below zero (and still saves it)', async () => {
    const t = await createTestApp({ openingCash: 100000 });
    const s = await t.call('suppliers.create', { name: 'Gupta Traders', openingBalance: { amount: 500000, direction: 'payable' } });
    const ok = await t.call('supplierPayments.create', { supplierId: s.id, amount: 80000, mode: 'cash' });
    expect(ok.warnings).toEqual([]);
    expect(systemBalance(t.app, 'CASH')).toBe(20000);

    const short = await t.call('supplierPayments.create', { supplierId: s.id, amount: 50000, mode: 'cash' });
    expect(short.warnings).toEqual(['Cash in Hand will be short by ₹300.00 after this payment. Check that all money received has been entered.']);
    expect(systemBalance(t.app, 'CASH')).toBe(-30000);
    const upi = await t.call('supplierPayments.create', { supplierId: s.id, amount: 1000, mode: 'upi' });
    expect(upi.warnings[0]).toContain('UPI Account will be short by ₹10.00');

    // Editing: the saved amount is already in the balance, so only the extra outflow counts.
    await t.call('supplierPayments.cancel', { id: short.id, reason: 'entered by mistake' });
    await t.call('supplierPayments.cancel', { id: upi.id, reason: 'entered by mistake' });
    let e = await t.call('supplierPayments.update', { id: ok.id, supplierId: s.id, amount: 90000, mode: 'cash' });
    expect(e.warnings).toEqual([]);
    e = await t.call('supplierPayments.update', { id: ok.id, supplierId: s.id, amount: 130000, mode: 'cash' });
    expect(e.warnings).toEqual(['Cash in Hand will be short by ₹300.00 after this payment. Check that all money received has been entered.']);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('reprinting a payment voucher needs "Reprint bills" and prints one DUPLICATE copy', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    await t.call('settings.update', { section: 'receipt', values: { copies: 2 } });
    const s = await t.call('suppliers.create', { name: 'Gupta Traders', openingBalance: { amount: 90000, direction: 'payable' } });
    await t.call('roles.update', { role: 'cashier', permissions: ['billing.create', 'suppliers.view', 'suppliers.pay'] });
    await t.loginAs('cashier');
    const p = await t.call('supplierPayments.create', { supplierId: s.id, amount: 10000, mode: 'cash' });
    expect(await t.call('supplierPayments.print', { id: p.id })).toMatchObject({ printed: true, duplicate: false });
    expect(t.platform.printed[0].opts.copies).toBe(2);
    expect((await t.fails('supplierPayments.print', { id: p.id })).code).toBe('FORBIDDEN');
    expect(t.platform.printed).toHaveLength(1);

    await t.loginOwner();
    expect(await t.call('supplierPayments.print', { id: p.id })).toMatchObject({ printed: true, duplicate: true });
    expect(t.platform.printed[1].html).toContain('DUPLICATE');
    expect(t.platform.printed[1].opts.copies).toBe(1);
    expect((await t.call('supplierPayments.get', { id: p.id })).printCount).toBe(2);
  });
});
