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
    const x = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'cash' });
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
    expect(html).toContain('Advance with us now: ₹50.00');

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
