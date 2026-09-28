import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance, type TestApp } from './helpers';
import { getEntry, getEntryLines, partyBalance } from '../src/core/accounting/ledger';
import { updateSection } from '../src/core/settings';

async function customer(t: TestApp, name = 'Anita Desai', phone = '98111 22233') {
  return t.call('customers.quickCreate', { name, phone });
}

/** Bill: Sugar 4 kg @ 45 (10% off) + Soap 3 @ 30, bill discount ₹12, customer optional. */
async function discountedBill(t: TestApp, opts: { customerId?: number; payments?: Array<{ mode: 'cash' | 'upi' | 'bank'; amount: number }> } = {}) {
  return t.call('sales.create', {
    customerId: opts.customerId,
    items: [
      { itemName: 'Sugar', unit: 'kg', qty: 4, rate: 4500, discountPct: 10 },
      { itemName: 'Soap', qty: 3, rate: 3000 },
    ],
    billDiscount: 1200,
    payments: opts.payments ?? [{ mode: 'cash', amount: 24000 }],
  });
}

function removePermission(t: TestApp, role: 'cashier' | 'manager', perm: string) {
  t.app.db.run('DELETE FROM role_permissions WHERE role = ? AND permission = ?', [role, perm]);
}

describe('returns.billReturnable', () => {
  it('shows what can be returned and the effective net rate', async () => {
    const t = await createTestApp();
    const bill = await discountedBill(t);
    // Sugar 180.00 - 18.00 = 162.00, Soap 90.00; bill discount 12.00 shared 162:90
    expect(bill).toMatchObject({ subtotal: 27000, itemDiscount: 1800, billDiscount: 1200, total: 24000 });
    const r = await t.call('returns.billReturnable', { billId: bill.id });
    expect(r.bill).toMatchObject({ billNo: bill.billNo, status: 'active', total: 24000 });
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ itemName: 'Sugar', unit: 'kg', qtyBilled: 4, qtyReturned: 0, returnable: 4, rate: 4500, netAmount: 16200 - 771, netRate: Math.round((16200 - 771) / 4) });
    expect(r.lines[1]).toMatchObject({ itemName: 'Soap', netAmount: 9000 - 429, netRate: Math.round((9000 - 429) / 3) });
    expect(r.lines[0].netAmount + r.lines[1].netAmount).toBe(24000);
    expect(r.suggestedRefundMode).toBe('cash');
    expect(r.returnedTotal).toBe(0);
  });
});

describe('returns.create (goods returned)', () => {
  it('handles partial and repeated returns up to the billed quantity', async () => {
    const t = await createTestApp({ openingCash: 100000 });
    updateSection(t.app.ctx(), 'billing', { roundOff: false });
    const bill = await discountedBill(t);
    const sugar = bill.items[0];
    const soap = bill.items[1];
    const r0 = await t.call('returns.billReturnable', { billId: bill.id });
    const netSugar = r0.lines[0].netRate;

    const first = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: sugar.id, qty: 1.5 }], refundMode: 'cash', reason: 'Damaged pack' });
    expect(first).toMatchObject({ cnNo: 'CN/26-27/0001', kind: 'return', billId: bill.id, billNo: bill.billNo, refundMode: 'cash', status: 'active', reason: 'Damaged pack' });
    expect(first.items[0]).toMatchObject({ itemName: 'Sugar', unit: 'kg', qty: 1.5, rate: netSugar, amount: Math.round(1.5 * netSugar) });
    expect(first.total).toBe(first.subtotal);

    let r = await t.call('returns.billReturnable', { billId: bill.id });
    expect(r.lines[0]).toMatchObject({ qtyReturned: 1.5, returnable: 2.5 });

    const tooMany = await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: sugar.id, qty: 3 }], refundMode: 'cash' });
    expect(tooMany.message).toBe('Only 2.5 kg of "Sugar" can be returned (4 kg billed, 1.5 kg already returned).');

    // Return everything that is left: refunds exactly what the customer paid in total.
    const second = await t.call('returns.create', {
      kind: 'return',
      billId: bill.id,
      items: [
        { billItemId: sugar.id, qty: 2.5 },
        { billItemId: soap.id, qty: 3 },
      ],
      refundMode: 'cash',
    });
    expect(first.total + second.total).toBe(bill.total);
    r = await t.call('returns.billReturnable', { billId: bill.id });
    expect(r.lines.map((l) => l.returnable)).toEqual([0, 0]);
    expect(r.returnedTotal).toBe(bill.total);
    const none = await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: soap.id, qty: 1 }], refundMode: 'cash' });
    expect(none.message).toBe('All of "Soap" has already been returned.');

    expect(systemBalance(t.app, 'SALES_RETURNS')).toBe(bill.total);
    expect(systemBalance(t.app, 'CASH')).toBe(100000 + bill.total - bill.total);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('posts Dr Sales Returns / Cr refund account with round off', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', { items: [{ itemName: 'Oil', qty: 2, rate: 14550 }], payments: [{ mode: 'upi', amount: 29100 }] });
    const cn = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'upi' });
    expect(cn).toMatchObject({ subtotal: 14550, roundOff: 50, total: 14600, refundMode: 'upi', refundAccountName: 'UPI Account' });
    expect(systemBalance(t.app, 'SALES_RETURNS')).toBe(14550);
    expect(systemBalance(t.app, 'ROUND_OFF')).toBe(50);
    expect(systemBalance(t.app, 'UPI')).toBe(29100 - 14600);
    const entry = getEntry(t.app.ctx(), cn.journalEntryId!);
    expect(entry).toMatchObject({ voucher_type: 'sale_return', source_type: 'credit_note', source_id: cn.id, voucher_no: cn.cnNo });
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it("adjusts in the customer's account (credit) and refuses that for walk-in bills", async () => {
    const t = await createTestApp();
    const c = await customer(t);
    const credit = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Rice', qty: 5, rate: 6000 }], payments: [] });
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(30000);
    const r = await t.call('returns.billReturnable', { billId: credit.id });
    expect(r.suggestedRefundMode).toBe('credit');
    const cn = await t.call('returns.create', { kind: 'return', billId: credit.id, items: [{ billItemId: credit.items[0].id, qty: 2 }], refundMode: 'credit' });
    expect(cn).toMatchObject({ total: 12000, refundMode: 'credit', customerId: c.id, customerName: 'Anita Desai', refundAccountId: null });
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(18000);
    const arLine = getEntryLines(t.app.ctx(), cn.journalEntryId!).find((l) => l.party_type === 'customer');
    expect(arLine).toMatchObject({ credit: 12000, party_id: c.id });

    const walkIn = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 2, rate: 1000 }], payments: [{ mode: 'cash', amount: 2000 }] });
    const e = await t.fails('returns.create', { kind: 'return', billId: walkIn.id, items: [{ billItemId: walkIn.items[0].id, qty: 1 }], refundMode: 'credit' });
    expect(e.message).toMatch(/has no customer account/);
    const bank = await t.call('returns.create', { kind: 'return', billId: walkIn.id, items: [{ billItemId: walkIn.items[0].id, qty: 1 }], refundMode: 'bank' });
    expect(bank.refundAccountName).toBe('Bank Account');
    expect(systemBalance(t.app, 'BANK')).toBe(-1000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('allows a lower refund rate but never more than the billed rate', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', { items: [{ itemName: 'Shirt', qty: 2, rate: 50000 }], payments: [{ mode: 'cash', amount: 100000 }] });
    const e = await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1, rate: 60000 }], refundMode: 'cash' });
    expect(e.message).toBe('Refund rate for "Shirt" cannot be more than the billed rate ₹500.00.');
    const cn = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1, rate: 40000 }], refundMode: 'cash', reason: 'Used' });
    expect(cn.total).toBe(40000);
  });

  it('validates the bill, the lines and the date', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', { date: '2026-09-25', items: [{ itemName: 'Pen', qty: 2, rate: 1000 }], payments: [{ mode: 'cash', amount: 2000 }] });
    const other = await t.call('sales.create', { items: [{ itemName: 'Ink', qty: 1, rate: 5000 }], payments: [{ mode: 'cash', amount: 5000 }] });
    const line = bill.items[0].id;
    let e = await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: other.items[0].id, qty: 1 }], refundMode: 'cash' });
    expect(e.message).toMatch(/is not on bill/);
    e = await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [], refundMode: 'cash' });
    expect(e.code).toBe('VALIDATION');
    e = await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: line, qty: 1 }, { billItemId: line, qty: 1 }], refundMode: 'cash' });
    expect(e.message).toMatch(/listed twice/);
    e = await t.fails('returns.create', { kind: 'return', billId: bill.id, date: '2026-09-24', items: [{ billItemId: line, qty: 1 }], refundMode: 'cash' });
    expect(e.message).toMatch(/cannot be dated before its bill \(25-09-2026\)/);
    e = await t.fails('returns.create', { kind: 'return', billId: bill.id, date: '2026-09-29', items: [{ billItemId: line, qty: 1 }], refundMode: 'cash' });
    expect(e.message).toMatch(/cannot be in the future/);
    e = await t.fails('returns.create', { kind: 'return', billId: 999, items: [{ billItemId: line, qty: 1 }], refundMode: 'cash' });
    expect(e.code).toBe('NOT_FOUND');
    const backdated = await t.call('returns.create', { kind: 'return', billId: bill.id, date: '2026-09-26', items: [{ billItemId: line, qty: 1 }], refundMode: 'cash' });
    expect(backdated.date).toBe('2026-09-26');

    await t.call('sales.cancel', { id: other.id, reason: 'Wrong' });
    e = await t.fails('returns.create', { kind: 'return', billId: other.id, items: [{ billItemId: other.items[0].id, qty: 1 }], refundMode: 'cash' });
    expect(e.message).toMatch(/is cancelled, so nothing can be returned/);

    await t.loginAs('cashier');
    e = await t.fails('returns.create', { kind: 'return', billId: bill.id, date: '2026-09-27', items: [{ billItemId: line, qty: 1 }], refundMode: 'cash' });
    expect(e.code).toBe('FORBIDDEN');
    // cashiers can return goods of older bills with today's date
    const ok = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: line, qty: 1 }], refundMode: 'cash' });
    expect(ok.date).toBe('2026-09-28');
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('credit notes without goods', () => {
  it("reduces the customer's balance or refunds money", async () => {
    const t = await createTestApp({ openingCash: 50000 });
    const c = await customer(t);
    await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Cement bag', qty: 10, rate: 40000 }], payments: [] });
    const adj = await t.call('returns.create', { kind: 'adjustment', customerId: c.id, amount: 25050, reason: 'Price correction: charged ₹25.05 extra per bag', refundMode: 'credit' });
    expect(adj).toMatchObject({ kind: 'adjustment', billId: null, total: 25050, roundOff: 0, customerName: 'Anita Desai', items: [] });
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(400000 - 25050);

    const cash = await t.call('returns.create', { kind: 'adjustment', customerId: c.id, amount: 10000, reason: 'Goodwill', refundMode: 'cash' });
    expect(cash.refundAccountName).toBe('Cash in Hand');
    expect(systemBalance(t.app, 'CASH')).toBe(40000);
    expect(systemBalance(t.app, 'SALES_RETURNS')).toBe(35050);

    let e = await t.fails('returns.create', { kind: 'adjustment', customerId: c.id, amount: 1000, reason: '  ', refundMode: 'credit' });
    expect(e.code).toBe('VALIDATION');
    e = await t.fails('returns.create', { kind: 'adjustment', customerId: c.id, amount: 0, reason: 'x', refundMode: 'credit' });
    expect(e.code).toBe('VALIDATION');
    e = await t.fails('returns.create', { kind: 'adjustment', customerId: 999, amount: 1000, reason: 'x', refundMode: 'credit' });
    expect(e.message).toMatch(/customer was not found/);
    const logged = t.app.db.value<string>("SELECT summary FROM activity_log WHERE action = 'credit_note.create' ORDER BY id LIMIT 1");
    expect(logged).toBe("Credit note CN/26-27/0001 for ₹250.50 to Anita Desai (adjusted in customer's account). Reason: Price correction: charged ₹25.05 extra per bag");
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('returns.cancel', () => {
  it('voids the entry, restores balances and frees the quantity', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    const bill = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Rice', qty: 5, rate: 6000 }], payments: [] });
    const cn = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 5 }], refundMode: 'credit' });
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);
    expect((await t.fails('returns.cancel', { id: cn.id, reason: '' })).code).toBe('VALIDATION');

    await t.loginAs('cashier');
    expect((await t.fails('returns.cancel', { id: cn.id, reason: 'Oops' })).code).toBe('FORBIDDEN');
    await t.loginOwner();

    const cancelled = await t.call('returns.cancel', { id: cn.id, reason: 'Goods not actually returned' });
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Goods not actually returned', cancelledByName: 'Ravi Sharma' });
    expect(getEntry(t.app.ctx(), cn.journalEntryId!).is_void).toBe(1);
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(30000);
    expect(systemBalance(t.app, 'SALES_RETURNS')).toBe(0);
    expect((await t.call('returns.billReturnable', { billId: bill.id })).lines[0].returnable).toBe(5);
    expect((await t.fails('returns.cancel', { id: cn.id, reason: 'again' })).message).toMatch(/already cancelled/);

    const revs = await t.call('returns.revisions', { id: cn.id });
    expect(revs.map((r) => [r.action, r.reason])).toEqual([
      ['created', null],
      ['cancelled', 'Goods not actually returned'],
    ]);
    const actions = t.app.db.all<{ action: string }>("SELECT action FROM activity_log WHERE entity_type = 'credit_note' ORDER BY id").map((r) => r.action);
    expect(actions).toEqual(['return.create', 'return.cancel']);
    // the bill can be cancelled once its return is cancelled
    await t.call('sales.cancel', { id: bill.id, reason: 'Not delivered' });
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('returns.list, receipts and printing', () => {
  it('lists with filters and totals', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    const bill = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Rice', qty: 5, rate: 6000 }], payments: [] });
    const a = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'credit' });
    const b = await t.call('returns.create', { kind: 'adjustment', customerId: c.id, amount: 5000, reason: 'Late delivery', refundMode: 'cash' });
    const x = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'credit' });
    await t.call('returns.cancel', { id: x.id, reason: 'Mistake' });
    const all = await t.call('returns.list', { from: '2026-09-01', to: '2026-09-30' });
    expect(all.rows.map((r) => r.id)).toEqual([x.id, b.id, a.id]);
    expect(all.totals).toEqual({ count: 3, total: 11000, refunded: 5000, adjusted: 6000, cancelledCount: 1 });
    expect(all.rows[2]).toMatchObject({ billNo: bill.billNo, kind: 'return', itemCount: 1, customerName: 'Anita Desai' });
    expect((await t.call('returns.list', { from: '2026-09-01', to: '2026-09-30', kind: 'adjustment' })).rows.map((r) => r.id)).toEqual([b.id]);
    expect((await t.call('returns.list', { from: '2026-09-01', to: '2026-09-30', status: 'cancelled' })).rows.map((r) => r.id)).toEqual([x.id]);
    expect((await t.call('returns.list', { from: '2026-09-01', to: '2026-09-30', q: 'late' })).rows.map((r) => r.id)).toEqual([b.id]);
    expect((await t.call('returns.list', { from: '2026-09-01', to: '2026-09-30', q: bill.billNo })).rows).toHaveLength(2);
    expect((await t.call('returns.list', { from: '2026-09-29', to: '2026-09-30' })).rows).toHaveLength(0);
    const found = await t.call('returns.findBills', { q: 'anita' });
    expect(found.map((f) => f.id)).toEqual([bill.id]);
  });

  it('prints SALES RETURN / CREDIT NOTE receipts and marks reprints', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    const bill = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Rice', qty: 5, rate: 6000 }], payments: [{ mode: 'cash', amount: 30000 }] });
    const ret = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'cash', reason: 'Wet' });
    let { html } = await t.call('returns.receiptHtml', { id: ret.id });
    expect(html).toContain('SALES RETURN');
    expect(html).toContain(ret.cnNo);
    expect(html).toContain(`${bill.billNo} (28-09-2026)`);
    expect(html).toContain('Refunded by Cash');
    expect(html).toContain('TOTAL REFUND');
    expect(html).toContain('Reason: Wet');
    expect(html).toContain('Receiver&#39;s signature');

    const adj = await t.call('returns.create', { kind: 'adjustment', customerId: c.id, amount: 5000, reason: 'Goodwill', refundMode: 'credit' });
    ({ html } = await t.call('returns.receiptHtml', { id: adj.id }));
    expect(html).toContain('CREDIT NOTE');
    expect(html).toContain("Adjusted in customer&#39;s account");
    expect(html).toContain('Advance with us: ₹50.00 (as on 28-09-2026)');

    const p1 = await t.call('returns.print', { id: ret.id });
    expect(p1).toMatchObject({ printed: true, duplicate: false });
    const p2 = await t.call('returns.print', { id: ret.id });
    expect(p2.duplicate).toBe(true);
    expect(t.platform.printed[1].html).toContain('DUPLICATE');
    expect((await t.call('returns.get', { id: ret.id })).printCount).toBe(2);

    await t.call('returns.cancel', { id: ret.id, reason: 'Mistake' });
    expect((await t.call('returns.receiptHtml', { id: ret.id })).html).toContain('CANCELLED');

    removePermission(t, 'cashier', 'billing.reprint');
    await t.loginAs('cashier');
    expect((await t.call('returns.print', { id: adj.id })).printed).toBe(true);
    expect((await t.fails('returns.print', { id: adj.id })).code).toBe('FORBIDDEN');
  });
});

describe('refund limits (never more than the customer paid)', () => {
  it('caps the refund rate at what was paid after line and bill discounts', async () => {
    const t = await createTestApp({ openingCash: 500000 });
    // Bill discount: ₹2,000 cooker sold for ₹1,000.
    const cooker = await t.call('sales.create', { items: [{ itemName: 'Pressure cooker', qty: 1, rate: 200000 }], billDiscount: 100000, payments: [{ mode: 'cash', amount: 100000 }] });
    // Line discount: 50% off a ₹1,000 shirt.
    const shirt = await t.call('sales.create', { items: [{ itemName: 'Shirt', qty: 1, rate: 100000, discountPct: 50 }], payments: [{ mode: 'cash', amount: 50000 }] });
    // Free item (100% off) on a bill with a paid item.
    const free = await t.call('sales.create', { items: [{ itemName: 'Mug', qty: 1, rate: 30000 }, { itemName: 'Coaster', qty: 1, rate: 700, discountPct: 100 }], payments: [{ mode: 'cash', amount: 30000 }] });
    await t.loginAs('cashier');
    const r = await t.call('returns.billReturnable', { billId: cooker.id });
    expect(r.lines[0]).toMatchObject({ rate: 200000, netRate: 100000, netAmount: 100000, refundable: 100000 });
    expect(r).toMatchObject({ refundable: 100000, moneyRefundable: 100000, returnedTotal: 0 });

    let e = await t.fails('returns.create', { kind: 'return', billId: cooker.id, items: [{ billItemId: cooker.items[0].id, qty: 1, rate: 200000 }], refundMode: 'cash' });
    expect(e.message).toBe('Refund rate for "Pressure cooker" cannot be more than ₹1,000.00, what the customer paid for it.');
    e = await t.fails('returns.create', { kind: 'return', billId: shirt.id, items: [{ billItemId: shirt.items[0].id, qty: 1, rate: 100000 }], refundMode: 'cash' });
    expect(e.fields).toEqual({ 'items.0.rate': 'At most ₹500.00' });
    e = await t.fails('returns.create', { kind: 'return', billId: free.id, items: [{ billItemId: free.items[1].id, qty: 1, rate: 700 }], refundMode: 'cash' });
    expect(e.code).toBe('VALIDATION');
    e = await t.fails('returns.create', { kind: 'return', billId: free.id, items: [{ billItemId: free.items[1].id, qty: 1 }], refundMode: 'cash' });
    expect(e.message).toBe('Nothing was paid for the chosen items (or it has already been refunded), so there is nothing to refund.');

    const a = await t.call('returns.create', { kind: 'return', billId: cooker.id, items: [{ billItemId: cooker.items[0].id, qty: 1 }], refundMode: 'cash' });
    const b = await t.call('returns.create', { kind: 'return', billId: shirt.id, items: [{ billItemId: shirt.items[0].id, qty: 1 }], refundMode: 'cash' });
    expect([a.total, b.total]).toEqual([100000, 50000]);
    expect(systemBalance(t.app, 'CASH')).toBe(500000 + 100000 + 50000 + 30000 - 150000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('shares a bill discount across lines so returning everything refunds only what was paid', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', { items: [{ itemName: 'A', qty: 2, rate: 50000 }], billDiscount: 40000, payments: [{ mode: 'upi', amount: 60000 }] });
    const e = await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 2, rate: 50000 }], refundMode: 'upi' });
    expect(e.message).toMatch(/cannot be more than ₹300\.00/);
    const one = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'upi' });
    const two = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'upi' });
    expect(one.total + two.total).toBe(60000);
    expect(systemBalance(t.app, 'UPI')).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('rounds returns on the running total, so separate returns add up to the bill total exactly', async () => {
    const t = await createTestApp({ openingCash: 100000 });
    // 3 pens @ ₹1.50 = ₹4.50, rounded up to ₹5.00.
    const pens = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 3, rate: 150 }], payments: [{ mode: 'cash', amount: 500 }] });
    expect(pens).toMatchObject({ roundOff: 50, total: 500 });
    const totals: number[] = [];
    for (let i = 0; i < 3; i++) {
      const cn = await t.call('returns.create', { kind: 'return', billId: pens.id, items: [{ billItemId: pens.items[0].id, qty: 1 }], refundMode: 'cash' });
      expect(cn.total % 100).toBe(0);
      expect(cn.roundOff).toBe(cn.total - cn.subtotal);
      totals.push(cn.total);
    }
    expect(totals.reduce((s, x) => s + x, 0)).toBe(500);

    // Two lines of ₹5.60 = ₹11.20, rounded down to ₹11.00: two single returns refund ₹11.00, not ₹12.00.
    const two = await t.call('sales.create', { items: [{ itemName: 'A', qty: 1, rate: 560 }, { itemName: 'B', qty: 1, rate: 560 }], payments: [{ mode: 'cash', amount: 1100 }] });
    const c1 = await t.call('returns.create', { kind: 'return', billId: two.id, items: [{ billItemId: two.items[0].id, qty: 1 }], refundMode: 'cash' });
    const c2 = await t.call('returns.create', { kind: 'return', billId: two.id, items: [{ billItemId: two.items[1].id, qty: 1 }], refundMode: 'cash' });
    expect(c1.total + c2.total).toBe(1100);

    // Three lines of ₹33.50 = ₹100.50 -> ₹101.00.
    const three = await t.call('sales.create', { items: [1, 2, 3].map((n) => ({ itemName: `Box ${n}`, qty: 1, rate: 3350 })), payments: [{ mode: 'cash', amount: 10100 }] });
    let sum = 0;
    for (const it of three.items) sum += (await t.call('returns.create', { kind: 'return', billId: three.id, items: [{ billItemId: it.id, qty: 1 }], refundMode: 'cash' })).total;
    expect(sum).toBe(10100);
    expect((await t.call('returns.billReturnable', { billId: three.id })).refundable).toBe(0);
    expect(systemBalance(t.app, 'CASH')).toBe(100000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('refunds what was charged even when round off was turned off after the sale', async () => {
    const t = await createTestApp({ openingCash: 10000 });
    const bill = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 2, rate: 520 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(bill).toMatchObject({ subtotal: 1040, roundOff: -40, total: 1000 });
    updateSection(t.app.ctx(), 'billing', { roundOff: false });
    const r = await t.call('returns.billReturnable', { billId: bill.id });
    expect(r.lines[0]).toMatchObject({ netAmount: 1000, netRate: 500 });
    const cn = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 2 }], refundMode: 'cash' });
    expect(cn.total).toBe(1000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('never refunds more than is left of the bill, even with a lower rate first', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', { items: [{ itemName: 'Shirt', qty: 2, rate: 50000 }], payments: [{ mode: 'cash', amount: 100000 }] });
    const used = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1, rate: 40000 }], refundMode: 'cash' });
    const rest = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'cash' });
    expect([used.total, rest.total]).toEqual([40000, 50000]);
    expect((await t.call('returns.billReturnable', { billId: bill.id })).returnedTotal).toBeLessThanOrEqual(bill.total);
  });

  it('pays money back only up to what was received on the bill; the rest is adjusted', async () => {
    const t = await createTestApp({ openingCash: 500000 });
    const c = await customer(t, 'Anil');
    // (a) sold fully on credit
    const onCredit = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Mixer', qty: 1, rate: 300000 }], payments: [] });
    await t.loginAs('cashier');
    let r = await t.call('returns.billReturnable', { billId: onCredit.id });
    expect(r).toMatchObject({ moneyRefundable: 0, suggestedRefundMode: 'credit' });
    let e = await t.fails('returns.create', { kind: 'return', billId: onCredit.id, items: [{ billItemId: onCredit.items[0].id, qty: 1 }], refundMode: 'cash' });
    expect(e.message).toBe('Nothing was paid on bill INV/26-27/0001 (it was sold on credit), so the return cannot be paid back in money. Choose "Adjust" to take ₹3,000.00 off Anil\'s balance, or return fewer items now.');
    expect(systemBalance(t.app, 'CASH')).toBe(500000);
    await t.call('returns.create', { kind: 'return', billId: onCredit.id, items: [{ billItemId: onCredit.items[0].id, qty: 1 }], refundMode: 'credit' });
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);

    // (b) part paid: ₹600 cash, ₹400 on credit
    await t.loginOwner();
    const part = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Plate', qty: 10, rate: 10000 }], payments: [{ mode: 'cash', amount: 60000 }] });
    await t.loginAs('cashier');
    e = await t.fails('returns.create', { kind: 'return', billId: part.id, items: [{ billItemId: part.items[0].id, qty: 10 }], refundMode: 'cash' });
    expect(e.message).toMatch(/^Only ₹600\.00 was received on bill INV\/26-27\/0002, so at most ₹600\.00 can be refunded in money\. Choose "Adjust"/);
    await t.call('returns.create', { kind: 'return', billId: part.id, items: [{ billItemId: part.items[0].id, qty: 4 }], refundMode: 'upi' });
    r = await t.call('returns.billReturnable', { billId: part.id });
    expect(r).toMatchObject({ moneyRefunded: 40000, moneyRefundable: 20000, refundable: 60000 });
    e = await t.fails('returns.create', { kind: 'return', billId: part.id, items: [{ billItemId: part.items[0].id, qty: 3 }], refundMode: 'cash' });
    expect(e.message).toMatch(/and ₹400\.00 has already been paid back, so at most ₹200\.00 can be refunded in money/);
    await t.call('returns.create', { kind: 'return', billId: part.id, items: [{ billItemId: part.items[0].id, qty: 2 }], refundMode: 'cash' });
    await t.call('returns.create', { kind: 'return', billId: part.id, items: [{ billItemId: part.items[0].id, qty: 4 }], refundMode: 'credit' });
    expect(systemBalance(t.app, 'CASH')).toBe(500000 + 60000 - 20000);
    expect(systemBalance(t.app, 'UPI')).toBe(-40000);
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('pays money back for a credit bill the customer has paid since by receipts', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const c = await customer(t, 'Rahul');
    const bill = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Rice', unit: 'kg', qty: 5, rate: 10000 }], payments: [] });
    // Still owed: money refunds are refused (the original protection).
    let r = await t.call('returns.billReturnable', { billId: bill.id });
    expect(r).toMatchObject({ paidLater: 0, moneyRefundable: 0, suggestedRefundMode: 'credit' });
    // Part paid later: ₹200 of the ₹500 credit.
    await t.call('receipts.create', { customerId: c.id, amount: 20000, mode: 'cash' });
    r = await t.call('returns.billReturnable', { billId: bill.id });
    expect(r).toMatchObject({ paidLater: 20000, moneyRefundable: 20000, suggestedRefundMode: 'credit' });
    let e = await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 3 }], refundMode: 'cash' });
    expect(e.message).toMatch(/^Only ₹200\.00 was received on bill INV\/26-27\/0001, so at most ₹200\.00 can be refunded in money\. Choose "Adjust"/);
    // Fully paid: the customer owes nothing, so the return may be paid back in cash.
    await t.call('receipts.create', { customerId: c.id, amount: 30000, mode: 'cash' });
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);
    r = await t.call('returns.billReturnable', { billId: bill.id });
    expect(r).toMatchObject({ paidLater: 50000, moneyRefundable: 50000, suggestedRefundMode: 'cash' });
    await t.loginAs('cashier');
    const cash = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'cash', reason: 'damaged' });
    expect(cash).toMatchObject({ total: 10000, refundMode: 'cash' });
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);
    r = await t.call('returns.billReturnable', { billId: bill.id });
    expect(r).toMatchObject({ moneyRefunded: 10000, moneyRefundable: 40000 });
    expect(systemBalance(t.app, 'CASH')).toBe(1000000 + 50000 - 10000);

    // Returns adjusted in the account are not payments: they do not open up money refunds.
    await t.loginOwner();
    const b2 = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Dal', qty: 5, rate: 10000 }], payments: [] });
    await t.call('returns.create', { kind: 'return', billId: b2.id, items: [{ billItemId: b2.items[0].id, qty: 1 }], refundMode: 'credit' });
    r = await t.call('returns.billReturnable', { billId: b2.id });
    expect(r).toMatchObject({ paidLater: 0, moneyRefundable: 0 });
    e = await t.fails('returns.create', { kind: 'return', billId: b2.id, items: [{ billItemId: b2.items[0].id, qty: 1 }], refundMode: 'cash' });
    expect(e.message).toMatch(/^Nothing was paid on bill INV\/26-27\/0002 \(it was sold on credit\)/);
    // The customer's dues count against the bill first: paying ₹100 of the ₹400 left opens up ₹100.
    await t.call('receipts.create', { customerId: c.id, amount: 10000, mode: 'upi' });
    r = await t.call('returns.billReturnable', { billId: b2.id });
    expect(r).toMatchObject({ paidLater: 10000, moneyRefundable: 10000 });
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  describe('money refunded never exceeds money received', () => {
    /** ₹1,000 bill to Ramesh, all on credit. */
    async function creditBill(t: TestApp, name = 'Ramesh', rate = 100000, qty = 1) {
      const c = await t.call('customers.quickCreate', { name });
      const bill = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Mixer', qty, rate }], payments: [] });
      return { c, bill };
    }
    const accountId = async (t: TestApp, name: string) => (await t.call('accounts.list', { includeInactive: true })).find((a) => a.name === name)!.id;

    it('(A) a payment discount is not money: ₹900 + ₹100 discount lets at most ₹900 go back', async () => {
      const t = await createTestApp({ openingCash: 1000000 });
      const { c, bill } = await creditBill(t);
      await t.call('receipts.create', { customerId: c.id, amount: 90000, discount: 10000, mode: 'cash' });
      expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);
      const r = await t.call('returns.billReturnable', { billId: bill.id });
      expect(r).toMatchObject({ paidLater: 90000, moneyReceived: 90000, moneyRefundable: 90000 });
      await t.loginAs('cashier');
      const e = await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'cash' });
      expect(e.message).toMatch(/^Only ₹900\.00 was received on bill INV\/26-27\/0001, so at most ₹900\.00 can be refunded in money\./);
      expect(systemBalance(t.app, 'CASH')).toBe(1000000 + 90000);
      expect(ledgerProblems(t.app)).toEqual([]);
    });

    it('(B) a credit note without goods, adjusted in the account, is not money', async () => {
      const t = await createTestApp({ openingCash: 1000000 });
      const { c, bill } = await creditBill(t);
      await t.call('returns.create', { kind: 'adjustment', customerId: c.id, amount: 100000, reason: 'Rate difference', refundMode: 'credit' });
      expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);
      const r = await t.call('returns.billReturnable', { billId: bill.id });
      expect(r).toMatchObject({ paidLater: 0, moneyReceived: 0, moneyRefundable: 0, suggestedRefundMode: 'credit' });
      await t.loginAs('cashier');
      const e = await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'cash' });
      expect(e.message).toMatch(/^Nothing was paid on bill INV\/26-27\/0001 \(it was sold on credit\)/);
      expect(systemBalance(t.app, 'CASH')).toBe(1000000);
    });

    it('(C) a journal write-off to Sundry Debtors is not money', async () => {
      const t = await createTestApp({ openingCash: 1000000 });
      const { c, bill } = await creditBill(t);
      await t.call('journals.create', {
        narration: 'Bad debt written off - Ramesh',
        lines: [
          { accountId: await accountId(t, 'Miscellaneous Expenses'), debit: 100000 },
          { accountId: await accountId(t, 'Sundry Debtors'), credit: 100000, partyType: 'customer', partyId: c.id },
        ],
      });
      expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);
      const r = await t.call('returns.billReturnable', { billId: bill.id });
      expect(r).toMatchObject({ paidLater: 0, moneyRefundable: 0 });
      await t.loginAs('cashier');
      expect((await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'cash' })).message).toMatch(
        /^Nothing was paid on bill INV\/26-27\/0001/,
      );
      expect(systemBalance(t.app, 'CASH')).toBe(1000000);
      expect(ledgerProblems(t.app)).toEqual([]);
    });

    it('shares the money out oldest dues first: opening balance, then bills in date order', async () => {
      const t = await createTestApp({ openingCash: 1000000 });
      const c = await t.call('customers.create', { name: 'Suresh', openingBalance: { amount: 50000, direction: 'receivable' } });
      const b1 = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Fan', qty: 2, rate: 50000 }], payments: [] });
      const b2 = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Iron', qty: 1, rate: 100000 }], payments: [] });
      // ₹1,500 received: ₹500 clears the opening balance and ₹1,000 pays bill 1; bill 2 got no money.
      await t.call('receipts.create', { customerId: c.id, amount: 150000, mode: 'cash' });
      // Still owed ₹1,000 (bill 2): the customer's dues count against each bill first.
      let r1 = await t.call('returns.billReturnable', { billId: b1.id });
      expect(r1).toMatchObject({ paidLater: 0, moneyRefundable: 0 });
      // Bill 2 written off: the customer owes nothing now, but only bill 1 was paid for in money.
      await t.call('journals.create', {
        narration: 'Written off',
        lines: [
          { accountId: await accountId(t, 'Miscellaneous Expenses'), debit: 100000 },
          { accountId: await accountId(t, 'Sundry Debtors'), credit: 100000, partyType: 'customer', partyId: c.id },
        ],
      });
      expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);
      r1 = await t.call('returns.billReturnable', { billId: b1.id });
      expect(r1).toMatchObject({ paidLater: 100000, moneyReceived: 100000, moneyRefundable: 100000, suggestedRefundMode: 'cash' });
      const r2 = await t.call('returns.billReturnable', { billId: b2.id });
      expect(r2).toMatchObject({ paidLater: 0, moneyRefundable: 0, suggestedRefundMode: 'credit' });
      await t.loginAs('cashier');
      await t.call('returns.create', { kind: 'return', billId: b1.id, items: [{ billItemId: b1.items[0].id, qty: 2 }], refundMode: 'cash' });
      expect((await t.fails('returns.create', { kind: 'return', billId: b2.id, items: [{ billItemId: b2.items[0].id, qty: 1 }], refundMode: 'cash' })).message).toMatch(
        /^Nothing was paid on bill INV\/26-27\/0002/,
      );
      // ₹1,500 came in and ₹1,000 went back.
      expect(systemBalance(t.app, 'CASH')).toBe(1000000 + 150000 - 100000);
      expect(ledgerProblems(t.app)).toEqual([]);
    });

    it('money for a bill returned into the account counts for the next bill', async () => {
      const t = await createTestApp({ openingCash: 1000000 });
      const { c, bill: b1 } = await creditBill(t);
      const b2 = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Iron', qty: 1, rate: 100000 }], payments: [] });
      await t.call('receipts.create', { customerId: c.id, amount: 100000, mode: 'cash' });
      // Bill 1 comes back and is adjusted: the ₹1,000 received now pays for bill 2.
      await t.call('returns.create', { kind: 'return', billId: b1.id, items: [{ billItemId: b1.items[0].id, qty: 1 }], refundMode: 'credit' });
      expect(await t.call('returns.billReturnable', { billId: b2.id })).toMatchObject({ paidLater: 100000, moneyRefundable: 100000 });
      await t.call('returns.create', { kind: 'return', billId: b2.id, items: [{ billItemId: b2.items[0].id, qty: 1 }], refundMode: 'cash' });
      expect(systemBalance(t.app, 'CASH')).toBe(1000000);
      expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);
      expect(ledgerProblems(t.app)).toEqual([]);
    });

    it('warns when a payment that money was paid back against is cancelled or cut', async () => {
      const t = await createTestApp({ openingCash: 1000000 });
      const { c, bill } = await creditBill(t, 'Ramesh', 50000, 2);
      await t.loginAs('cashier');
      const rc = await t.call('receipts.create', { customerId: c.id, amount: 100000, mode: 'cash' });
      const cn = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'cash' });
      await t.loginAs('manager');
      const cancelled = await t.call('receipts.cancel', { id: rc.id, reason: 'Cheque bounced' });
      expect(cancelled.warnings).toEqual([
        `Cash was refunded on ${bill.billNo} against this payment (return ${cn.cnNo}). ₹500.00 was paid back on that bill, but only ₹0.00 has now been received for it.`,
      ]);
      expect(await t.call('returns.billReturnable', { billId: bill.id })).toMatchObject({ moneyReceived: 0, moneyRefunded: 50000, moneyRefundable: 0 });

      // Cut down after a full refund by UPI; a payment nothing was paid back against says nothing.
      const t2 = await createTestApp({ openingCash: 1000000 });
      const s = await creditBill(t2, 'Suresh');
      const other = await creditBill(t2, 'Mohan');
      const r2 = await t2.call('receipts.create', { customerId: s.c.id, amount: 100000, mode: 'cash' });
      const r3 = await t2.call('receipts.create', { customerId: other.c.id, amount: 40000, mode: 'cash' });
      const upi = await t2.call('returns.create', { kind: 'return', billId: s.bill.id, items: [{ billItemId: s.bill.items[0].id, qty: 1 }], refundMode: 'upi' });
      const cut = await t2.call('receipts.update', { id: r2.id, customerId: s.c.id, amount: 1000, mode: 'cash', reason: 'Typed wrong' });
      expect(cut.warnings).toEqual([
        `Money was refunded by UPI on ${s.bill.billNo} against this payment (return ${upi.cnNo}). ₹1,000.00 was paid back on that bill, but only ₹10.00 has now been received for it.`,
      ]);
      // Cutting it further warns again; changing only the remarks does not.
      expect((await t2.call('receipts.update', { id: r2.id, customerId: s.c.id, amount: 500, mode: 'cash' })).warnings).toHaveLength(1);
      expect((await t2.call('receipts.update', { id: r2.id, customerId: s.c.id, amount: 500, mode: 'cash', remarks: 'note' })).warnings).toEqual([]);
      expect((await t2.call('receipts.cancel', { id: r3.id, reason: 'Entered twice' })).warnings).toEqual([]);
      expect(ledgerProblems(t2.app)).toEqual([]);
    });

    it('warns when cancelling an adjusted return moves received money away from a bill refunded in cash', async () => {
      const t = await createTestApp({ openingCash: 1000000 });
      const c = await t.call('customers.quickCreate', { name: 'Kavita' });
      const b1 = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Mixer', qty: 1, rate: 100000 }], payments: [] });
      const b2 = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Fan', qty: 2, rate: 50000 }], payments: [] });
      // Bill 1 goes back into the account, so the ₹1,000 payment counts for bill 2, which may then refund cash.
      const adjust = await t.call('returns.create', { kind: 'return', billId: b1.id, items: [{ billItemId: b1.items[0].id, qty: 1 }], refundMode: 'credit' });
      await t.call('receipts.create', { customerId: c.id, amount: 100000, mode: 'cash' });
      const cash = await t.call('returns.create', { kind: 'return', billId: b2.id, items: [{ billItemId: b2.items[0].id, qty: 1 }], refundMode: 'cash' });
      expect(cash.total).toBe(50000);
      // Cancelling the adjustment puts bill 1's debt back first, so bill 2 no longer has the money it refunded.
      const res = await t.call('returns.cancel', { id: adjust.id, reason: 'Customer kept the mixer' });
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toMatch(new RegExp(`Cash was refunded on ${b2.billNo.replace(/\//g, '\\/')}`));
      expect(ledgerProblems(t.app)).toEqual([]);
    });
  });

  it('credit notes without goods need "returns.adjust" (cashiers do not have it)', async () => {
    const t = await createTestApp({ openingCash: 5000 });
    const c = await customer(t, 'Fatima Begum');
    await t.loginAs('cashier');
    const e = await t.fails('returns.create', { kind: 'adjustment', customerId: c.id, amount: 1000000, reason: 'goodwill', refundMode: 'cash' });
    expect(e).toMatchObject({ code: 'FORBIDDEN', message: 'You are not allowed to make credit notes without goods. Ask the owner for permission.' });
    expect(systemBalance(t.app, 'CASH')).toBe(5000);

    // A manager has it by default; the cash going out is warned about, not blocked.
    await t.loginAs('manager');
    const cn = await t.call('returns.create', { kind: 'adjustment', customerId: c.id, amount: 10000, reason: 'Goodwill', refundMode: 'cash' });
    expect(cn.warnings).toEqual(['Cash in Hand will be short by ₹50.00 after this payment. Check that all money received has been entered.']);
    const ok = await t.call('returns.create', { kind: 'adjustment', customerId: c.id, amount: 1000, reason: 'Goodwill', refundMode: 'credit' });
    expect(ok.warnings).toEqual([]);

    // returns.adjust alone allows credit notes but not goods returns.
    removePermission(t, 'manager', 'returns.create');
    await t.loginAs('manager');
    await t.call('returns.create', { kind: 'adjustment', customerId: c.id, amount: 500, reason: 'Rate difference', refundMode: 'credit' });
    const bill = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect((await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'cash' })).code).toBe('FORBIDDEN');
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('refund rates on the note multiply to the amount', () => {
  it('shows the rate paid in whole paise, and refunds the paise left over when the whole bill comes back', async () => {
    const t = await createTestApp({ openingCash: 100000 });
    updateSection(t.app.ctx(), 'billing', { roundOff: false });
    // Toor Dal 2 × ₹166.00 + Soap 1 × ₹40.00 with ₹2.05 off the bill: the dal was paid ₹330.17 (not a whole paisa per packet).
    const bill = await t.call('sales.create', {
      items: [
        { itemName: 'Toor Dal 1kg', qty: 2, rate: 16600 },
        { itemName: 'Soap', qty: 1, rate: 4000 },
      ],
      billDiscount: 205,
      payments: [{ mode: 'cash', amount: 36995 }],
    });
    const r = await t.call('returns.billReturnable', { billId: bill.id });
    expect(r.lines[0]).toMatchObject({ netAmount: 33017, netRate: 16508 });
    expect(r.allAtPaidRate).toBe(true);
    const dal = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 2 }], refundMode: 'cash' });
    // Rate × qty = amount on the note and its receipt; never more than was paid.
    expect(dal.items[0]).toMatchObject({ qty: 2, rate: 16508, amount: 33016 });
    expect(dal).toMatchObject({ subtotal: 33016, roundOff: 0, total: 33016 });
    const html = (await t.call('returns.receiptHtml', { id: dal.id })).html;
    expect(html).toContain('165.08');
    expect(html).toContain('330.16');
    // The rest of the bill settles it exactly: the paisa left over comes back as round off.
    const rest = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[1].id, qty: 1 }], refundMode: 'cash' });
    expect(rest.items[0].amount).toBe(rest.items[0].rate * rest.items[0].qty);
    expect(dal.total + rest.total).toBe(bill.total);
    expect(rest.roundOff).toBe(rest.total - rest.subtotal);
    expect(systemBalance(t.app, 'CASH')).toBe(100000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('never refunds a line above its billed price when the bill was rounded up', async () => {
    const t = await createTestApp({ openingCash: 100000 });
    // ₹649.50 + ₹10.00 = ₹659.50, rounded up to ₹660.00.
    const bill = await t.call('sales.create', {
      items: [
        { itemName: 'Basmati Rice 5kg', qty: 1, rate: 64950 },
        { itemName: 'Pen', qty: 1, rate: 1000 },
      ],
      payments: [{ mode: 'cash', amount: 66000 }],
    });
    expect(bill).toMatchObject({ roundOff: 50, total: 66000 });
    const r = await t.call('returns.billReturnable', { billId: bill.id });
    expect(r.lines.map((l) => [l.rate, l.netRate, l.netAmount])).toEqual([
      [64950, 64950, 64950],
      [1000, 1000, 1000],
    ]);
    expect((await t.fails('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1, rate: 65000 }], refundMode: 'cash' })).code).toBe('VALIDATION');
    const rice = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'cash' });
    // The line is at its billed price; the rupee rounding is the note's own round off.
    expect(rice.items[0]).toMatchObject({ rate: 64950, amount: 64950 });
    expect(rice).toMatchObject({ subtotal: 64950, roundOff: 50, total: 65000 });
    const pen = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[1].id, qty: 1 }], refundMode: 'cash' });
    expect(rice.total + pen.total).toBe(66000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('does not settle the bill when an earlier return was at a lower rate', async () => {
    const t = await createTestApp({ openingCash: 100000 });
    updateSection(t.app.ctx(), 'billing', { roundOff: false });
    // 3 × ₹1.00 with ₹0.01 off: ₹2.99, paid rate ₹0.99 each.
    const bill = await t.call('sales.create', { items: [{ itemName: 'Toffee', qty: 3, rate: 100 }], billDiscount: 1, payments: [{ mode: 'cash', amount: 299 }] });
    const r = await t.call('returns.billReturnable', { billId: bill.id });
    expect(r.lines[0]).toMatchObject({ netAmount: 299, netRate: 99 });
    const low = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1, rate: 50 }], refundMode: 'cash' });
    expect(low.total).toBe(50);
    expect((await t.call('returns.billReturnable', { billId: bill.id })).allAtPaidRate).toBe(false);
    const rest = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 2 }], refundMode: 'cash' });
    expect(rest).toMatchObject({ subtotal: 198, total: 198 });
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('return arithmetic shared with the returns screen', () => {
  it('matches what the server saves for random partial returns', async () => {
    const { netLineAmounts, returnNoteTotal } = await import('../src/shared/billing');
    expect(netLineAmounts([16200, 9000], 24000)).toEqual([16200 - 771, 9000 - 429]);
    expect(netLineAmounts([560, 560], 1100)).toEqual([550, 550]);
    // A rounding up is not spread over the lines: no line is refunded above its billed amount.
    expect(netLineAmounts([450], 500)).toEqual([450]);
    expect(netLineAmounts([100000, 0], 100000)).toEqual([100000, 0]);
    // The note that returns the rest settles exactly; partial ones never go past the bill total.
    expect(returnNoteTotal({ billTotal: 500, returnedTotal: 300, returnedValue: 334, value: 166, roundOff: true })).toBe(200);
    expect(returnNoteTotal({ billTotal: 500, returnedTotal: 0, returnedValue: 0, value: 480, roundOff: true })).toBe(500);
    expect(returnNoteTotal({ billTotal: 1040, returnedTotal: 0, returnedValue: 0, value: 1040, roundOff: true })).toBe(1040);
  });
});
