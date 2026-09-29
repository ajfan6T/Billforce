import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance, type TestApp } from './helpers';
import { accountBalance, partyBalance, systemAccountId, getEntry, getEntryLines } from '../src/core/accounting/ledger';
import { updateSection } from '../src/core/settings';
import { calcBill, billPaymentMode, shareDiscount } from '../src/shared/billing';

async function customer(t: TestApp, name = 'Anita Desai', phone: string | null = '98111 22233') {
  return t.call('customers.quickCreate', { name, phone });
}

async function item(t: TestApp, name: string, rate: number, unit = 'pcs') {
  return t.call('items.create', { name, rate, unit });
}

function revisions(t: TestApp, billId: number) {
  return t.app.db.all<{ revision: number; action: string; reason: string | null; snapshot: string }>(
    "SELECT revision, action, reason, snapshot FROM document_revisions WHERE doc_type = 'bill' AND doc_id = ? ORDER BY revision",
    [billId],
  );
}

function activity(t: TestApp, action: string) {
  return t.app.db.all<{ summary: string; entity_id: number; username: string }>('SELECT summary, entity_id, username FROM activity_log WHERE action = ? ORDER BY id', [action]);
}

function accountBal(t: TestApp, accountId: number) {
  return accountBalance(t.app.ctx(), accountId);
}

function removePermission(t: TestApp, role: 'cashier' | 'manager', perm: string) {
  t.app.db.run('DELETE FROM role_permissions WHERE role = ? AND permission = ?', [role, perm]);
}

describe('shared bill arithmetic', () => {
  it('computes line and bill discounts and round off', () => {
    const c = calcBill({
      lines: [
        { qty: 2.5, rate: 4550, discountPct: 10 },
        { qty: 1, rate: 6000, discount: 500 },
      ],
      billDiscountPct: 5,
      roundOff: true,
    });
    expect(c.subtotal).toBe(17375);
    expect(c.lines[0]).toMatchObject({ gross: 11375, discount: 1138, discountPct: 10, amount: 10237 });
    expect(c.itemDiscount).toBe(1638);
    expect(c.billDiscount).toBe(787);
    expect(c.beforeRound).toBe(14950);
    expect(c.roundOff).toBe(50);
    expect(c.total).toBe(15000);
    expect(c.problems).toEqual([]);
  });
  it('flags discounts larger than the amount', () => {
    const c = calcBill({ lines: [{ qty: 1, rate: 1000, discount: 1500 }], billDiscount: 0, roundOff: false });
    expect(c.problems[0]).toMatchObject({ line: 0, field: 'discount' });
    const d = calcBill({ lines: [{ qty: 1, rate: 1000 }], billDiscount: 2000, roundOff: false });
    expect(d.problems[0]).toMatchObject({ line: null, field: 'billDiscount' });
  });
  it('names the payment mode and shares discounts exactly', () => {
    expect(billPaymentMode(1000, [{ mode: 'cash', amount: 1000 }])).toBe('cash');
    expect(billPaymentMode(1000, [])).toBe('credit');
    expect(billPaymentMode(1000, [{ mode: 'upi', amount: 400 }])).toBe('split');
    expect(billPaymentMode(1000, [{ mode: 'upi', amount: 400 }, { mode: 'cash', amount: 600 }])).toBe('split');
    const shares = shareDiscount([1000, 2000, 3001], 100);
    expect(shares.reduce((s, x) => s + x, 0)).toBe(100);
    expect(shares).toEqual([17, 33, 50]);
  });
});

describe('sales.create', () => {
  it('creates a cash bill, numbers it and posts Dr Cash / Cr Sales', async () => {
    const t = await createTestApp();
    const tea = await item(t, 'Tea', 1500, 'cup');
    const bill = await t.call('sales.create', {
      items: [
        { itemId: tea.id, itemName: 'Tea', qty: 2, rate: 1500 },
        { itemName: 'Samosa', qty: 3, rate: 2000 },
      ],
      payments: [{ mode: 'cash', amount: 9000 }],
      remarks: 'Table 4',
    });
    expect(bill.billNo).toBe('INV/26-27/0001');
    expect(bill.date).toBe('2026-09-28');
    expect(bill).toMatchObject({ subtotal: 9000, total: 9000, paid: 9000, credit: 0, paymentMode: 'cash', status: 'active', revision: 1, remarks: 'Table 4' });
    expect(bill.items).toHaveLength(2);
    expect(bill.items[0]).toMatchObject({ itemId: tea.id, unit: 'cup', qty: 2, rate: 1500, gross: 3000, amount: 3000 });
    expect(bill.items[1]).toMatchObject({ itemId: null, unit: null, itemName: 'Samosa' });
    expect(bill.payments[0]).toMatchObject({ mode: 'cash', amount: 9000, accountName: 'Cash in Hand' });
    expect(bill.createdByName).toBe('Ravi Sharma');
    expect(bill.warnings).toEqual([]);

    expect(systemBalance(t.app, 'CASH')).toBe(9000);
    expect(systemBalance(t.app, 'SALES')).toBe(-9000);
    const entry = getEntry(t.app.ctx(), bill.journalEntryId!);
    expect(entry).toMatchObject({ voucher_type: 'sale', voucher_no: 'INV/26-27/0001', source_type: 'bill', source_id: bill.id });

    // usage for quick-add suggestions
    expect((await t.call('items.get', { id: tea.id })).useCount).toBe(1);
    // audit trail
    expect(revisions(t, bill.id).map((r) => r.action)).toEqual(['created']);
    const log = activity(t, 'bill.create');
    expect(log).toHaveLength(1);
    expect(log[0].summary).toBe('Created bill INV/26-27/0001 for ₹90.00 (Cash)');
    expect(ledgerProblems(t.app)).toEqual([]);

    const second = await t.call('sales.create', { items: [{ itemName: 'Tea', qty: 1, rate: 1500 }], payments: [{ mode: 'cash', amount: 1500 }] });
    expect(second.billNo).toBe('INV/26-27/0002');
  });

  it('applies line and bill discounts with round off (UPI) and rounds down when needed', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', {
      items: [
        { itemName: 'Sugar', unit: 'kg', qty: 2.5, rate: 4550, discountPct: 10 },
        { itemName: 'Rice', unit: 'kg', qty: 1, rate: 6000, discount: 500 },
      ],
      billDiscountPct: 5,
      payments: [{ mode: 'upi', amount: 15000, reference: 'UTR123' }],
    });
    expect(bill).toMatchObject({ subtotal: 17375, itemDiscount: 1638, billDiscount: 787, billDiscountPct: 5, roundOff: 50, total: 15000, paymentMode: 'upi' });
    expect(bill.items[0]).toMatchObject({ discount: 1138, discountPct: 10, amount: 10237 });
    expect(systemBalance(t.app, 'SALES')).toBe(-17375);
    expect(systemBalance(t.app, 'DISCOUNT_ALLOWED')).toBe(2425);
    expect(systemBalance(t.app, 'ROUND_OFF')).toBe(-50);
    expect(systemBalance(t.app, 'UPI')).toBe(15000);
    expect(bill.payments[0].reference).toBe('UTR123');

    // 149.30 -> 149.00 : Dr Round off 0.30
    const down = await t.call('sales.create', { items: [{ itemName: 'Oil', qty: 1, rate: 14930 }], payments: [{ mode: 'cash', amount: 14900 }] });
    expect(down).toMatchObject({ roundOff: -30, total: 14900 });
    expect(systemBalance(t.app, 'ROUND_OFF')).toBe(-50 + 30);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('does not round when round off is switched off', async () => {
    const t = await createTestApp();
    updateSection(t.app.ctx(), 'billing', { roundOff: false });
    const bill = await t.call('sales.create', { items: [{ itemName: 'Oil', qty: 1, rate: 14930 }], payments: [{ mode: 'cash', amount: 14930 }] });
    expect(bill).toMatchObject({ roundOff: 0, total: 14930 });
    expect(systemBalance(t.app, 'ROUND_OFF')).toBe(0);
  });

  it('posts bank payments to the chosen bank account', async () => {
    const t = await createTestApp();
    const bankId = systemAccountId(t.app.ctx(), 'BANK');
    const bill = await t.call('sales.create', { items: [{ itemName: 'Chair', qty: 1, rate: 150000 }], payments: [{ mode: 'bank', amount: 150000, accountId: bankId }] });
    expect(bill.paymentMode).toBe('bank');
    expect(systemBalance(t.app, 'BANK')).toBe(150000);
    const cashId = systemAccountId(t.app.ctx(), 'CASH');
    const err = await t.fails('sales.create', { items: [{ itemName: 'Chair', qty: 1, rate: 1000 }], payments: [{ mode: 'bank', amount: 1000, accountId: cashId }] });
    expect(err.message).toMatch(/bank \/ UPI account/);
  });

  it('keeps credit bills on the customer account', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    const bill = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Atta 10 kg', qty: 1, rate: 45000 }], payments: [] });
    expect(bill).toMatchObject({ paymentMode: 'credit', paid: 0, credit: 45000, customerId: c.id, customerName: 'Anita Desai', customerPhone: '98111 22233' });
    expect(bill.customer).toMatchObject({ id: c.id, balance: 45000 });
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(45000);
    expect(systemBalance(t.app, 'AR')).toBe(45000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('splits payment across modes with the remainder on credit', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    const bill = await t.call('sales.create', {
      customerId: c.id,
      items: [{ itemName: 'Saree', qty: 1, rate: 1000000 }],
      payments: [
        { mode: 'cash', amount: 500000 },
        { mode: 'upi', amount: 300000 },
      ],
    });
    expect(bill).toMatchObject({ paymentMode: 'split', paid: 800000, credit: 200000 });
    expect(systemBalance(t.app, 'CASH')).toBe(500000);
    expect(systemBalance(t.app, 'UPI')).toBe(300000);
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(200000);
    expect(systemBalance(t.app, 'SALES')).toBe(-1000000);
    const lines = getEntryLines(t.app.ctx(), bill.journalEntryId!);
    expect(lines.find((l) => l.party_type === 'customer')).toMatchObject({ debit: 200000, party_id: c.id });
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('stores walk-in names and phones without a customer record', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', { customerName: 'Mr. Rao', customerPhone: '99000 11111', items: [{ itemName: 'Pen', qty: 5, rate: 1000 }], payments: [{ mode: 'cash', amount: 5000 }] });
    expect(bill).toMatchObject({ customerId: null, customerName: 'Mr. Rao', customerPhone: '99000 11111', customer: null });
  });

  it('rejects invalid bills with clear messages', async () => {
    const t = await createTestApp();
    const line = { itemName: 'Pen', qty: 1, rate: 1000 };
    let e = await t.fails('sales.create', { items: [line], payments: [] });
    expect(e.code).toBe('VALIDATION');
    expect(e.message).toMatch(/Choose a customer to keep ₹10.00 on credit/);
    expect(e.fields?.customerId).toBeTruthy();

    e = await t.fails('sales.create', { items: [line], payments: [{ mode: 'cash', amount: 1500 }] });
    expect(e.message).toMatch(/more than the bill total/);

    e = await t.fails('sales.create', { items: [{ ...line, discount: 1500 }], payments: [] });
    expect(e.message).toBe('Discount on "Pen" (₹15.00) is more than its amount (₹10.00).');

    e = await t.fails('sales.create', { items: [line], billDiscount: 1200, payments: [] });
    expect(e.message).toMatch(/bill discount/);

    e = await t.fails('sales.create', { items: [{ ...line, discountPct: 120 }], payments: [] });
    expect(e.code).toBe('VALIDATION');

    e = await t.fails('sales.create', { date: '2026-09-29', items: [line], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(e.message).toMatch(/cannot be in the future/);

    e = await t.fails('sales.create', { items: [{ itemName: 'Free sample', qty: 1, rate: 0 }], payments: [] });
    expect(e.message).toMatch(/total must be more than zero/);

    e = await t.fails('sales.create', { items: [line], billDiscountPct: 100, payments: [] });
    expect(e.message).toMatch(/total must be more than zero/);

    e = await t.fails('sales.create', { items: [], payments: [] });
    expect(e.code).toBe('VALIDATION');

    e = await t.fails('sales.create', { items: [{ ...line, qty: 0 }], payments: [] });
    expect(e.code).toBe('VALIDATION');

    e = await t.fails('sales.create', { items: [{ ...line, qty: 1.2345 }], payments: [{ mode: 'cash', amount: 1235 }] });
    expect(e.message).toMatch(/3 decimal places/);

    e = await t.fails('sales.create', { items: [{ ...line, itemId: 999 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(e.message).toMatch(/not found in the item list/);

    e = await t.fails('sales.create', { customerId: 999, items: [line], payments: [] });
    expect(e.message).toMatch(/customer was not found/);

    e = await t.fails('sales.create', { date: '2026-03-31', items: [line], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(e.message).toMatch(/before your books start/);

    e = await t.fails('sales.create', { items: [line], payments: [{ mode: 'cash', amount: 0 }] });
    expect(e.code).toBe('VALIDATION');

    // Nothing was saved and no number was used up.
    expect(t.app.db.value('SELECT COUNT(*) FROM bills')).toBe(0);
    expect(t.app.db.value('SELECT COUNT(*) FROM journal_entries')).toBe(0);
    expect((await t.call('sales.nextNumber', {})).billNo).toBe('INV/26-27/0001');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('refuses inactive customers', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    t.app.db.run('UPDATE customers SET is_active = 0 WHERE id = ?', [c.id]);
    const e = await t.fails('sales.create', { customerId: c.id, items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [] });
    expect(e.message).toMatch(/inactive/);
  });

  it('needs permission for discounts and past dates', async () => {
    const t = await createTestApp();
    removePermission(t, 'cashier', 'billing.discount');
    await t.loginAs('cashier');
    const e1 = await t.fails('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000, discount: 100 }], payments: [{ mode: 'cash', amount: 900 }] });
    expect(e1.code).toBe('FORBIDDEN');
    expect(e1.message).toMatch(/not allowed to give discounts/);
    const e2 = await t.fails('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], billDiscountPct: 10, payments: [] });
    expect(e2.code).toBe('FORBIDDEN');
    const e3 = await t.fails('sales.create', { date: '2026-09-20', items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(e3.code).toBe('FORBIDDEN');
    expect(e3.message).toMatch(/past date/);
    // today's date given explicitly is fine
    const ok = await t.call('sales.create', { date: '2026-09-28', items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(ok.createdByName).toBe('Test cashier');

    await t.loginOwner();
    const back = await t.call('sales.create', { date: '2026-09-20', items: [{ itemName: 'Pen', qty: 1, rate: 1000, discountPct: 10 }], payments: [{ mode: 'cash', amount: 900 }] });
    expect(back).toMatchObject({ date: '2026-09-20', total: 900 });
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('warns about or blocks credit beyond the credit limit', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    t.app.db.run('UPDATE customers SET credit_limit = 100000 WHERE id = ?', [c.id]);
    await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Rice', qty: 1, rate: 80000 }], payments: [] });
    const warned = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Dal', qty: 1, rate: 30000 }], payments: [] });
    expect(warned.warnings[0]).toMatch(/credit limit is ₹1,000.00; with this bill they would owe ₹1,100.00/);

    updateSection(t.app.ctx(), 'billing', { enforceCreditLimit: true });
    const e = await t.fails('sales.create', { customerId: c.id, items: [{ itemName: 'Dal', qty: 1, rate: 30000 }], payments: [] });
    expect(e.message).toMatch(/raise the limit/);
    // paying in full is always fine
    await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Dal', qty: 1, rate: 30000 }], payments: [{ mode: 'cash', amount: 30000 }] });
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(110000);
  });

  it('keeps the limit and dues out of the credit-limit message for users who may not see balances', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    t.app.db.run('UPDATE customers SET credit_limit = 100000 WHERE id = ?', [c.id]);
    await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Rice', qty: 1, rate: 80000 }], payments: [] });
    removePermission(t, 'cashier', 'customers.view');
    removePermission(t, 'cashier', 'customers.receive');
    await t.loginAs('cashier');
    const warned = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Dal', qty: 1, rate: 30000 }], payments: [] });
    expect(warned.warnings).toEqual(['Anita Desai would go over their credit limit with this bill.']);
    updateSection(t.app.ctx(), 'billing', { enforceCreditLimit: true });
    const e = await t.fails('sales.create', { customerId: c.id, items: [{ itemName: 'Dal', qty: 1, rate: 30000 }], payments: [] });
    expect(e.message).toBe('Anita Desai would go over their credit limit with this bill. Take a payment now or ask the owner to raise the limit.');
    expect(e.message).not.toMatch(/₹/);
  });

  it('with limits enforced, gives no credit to a customer without a limit unless the user may set limits', async () => {
    const t = await createTestApp();
    updateSection(t.app.ctx(), 'billing', { enforceCreditLimit: true });
    const anil = await customer(t, 'Anil', '90000 00001');
    t.app.db.run('UPDATE customers SET credit_limit = 100000 WHERE id = ?', [anil.id]);
    await t.loginAs('cashier');
    // Anil is at his limit ...
    await t.call('sales.create', { customerId: anil.id, items: [{ itemName: 'Rice', qty: 1, rate: 100000 }], payments: [] });
    expect((await t.fails('sales.create', { customerId: anil.id, items: [{ itemName: 'Dal', qty: 1, rate: 1000 }], payments: [] })).fields).toEqual({ customerId: 'Credit limit exceeded' });
    // ... and the same person added again (no phone, so no duplicate check) has no limit: no credit either.
    const dup = await t.call('customers.quickCreate', { name: 'Anil K' });
    const e = await t.fails('sales.create', { customerId: dup.id, items: [{ itemName: 'TV', qty: 1, rate: 15000000 }], payments: [] });
    expect(e).toMatchObject({
      code: 'VALIDATION',
      message: 'Anil K has no credit limit set. Ask the owner to set a credit limit for this customer first, or take the full payment now.',
      fields: { customerId: 'No credit limit set' },
    });
    // Paying in full is fine, and the owner (who sets limits) may still give credit.
    await t.call('sales.create', { customerId: dup.id, items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    await t.loginOwner();
    await t.call('sales.create', { customerId: dup.id, items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [] });
    // Without enforcement nothing changes.
    updateSection(t.app.ctx(), 'billing', { enforceCreditLimit: false });
    await t.loginAs('cashier');
    await t.call('sales.create', { customerId: dup.id, items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [] });
    expect(partyBalance(t.app.ctx(), 'customer', dup.id)).toBe(2000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('accepts the smoke-test call shape', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', {
      date: '2026-09-28',
      items: [
        { itemName: 'Tea', qty: 2, rate: 1500 },
        { itemName: 'Samosa', qty: 3, rate: 2000 },
      ],
      payments: [{ mode: 'cash', amount: 9000 }],
    });
    expect(bill.billNo).toBeTruthy();
    expect(bill.id).toBeGreaterThan(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('numbers bills per financial year', async () => {
    const t = await createTestApp({ booksStart: '2025-04-01', today: '2026-03-31' });
    const a = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    const b = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect([a.billNo, b.billNo]).toEqual(['INV/25-26/0001', 'INV/25-26/0002']);
    t.setToday('2026-04-01');
    expect((await t.call('sales.nextNumber', {})).billNo).toBe('INV/26-27/0001');
    expect((await t.call('sales.nextNumber', { date: '2026-03-15' })).billNo).toBe('INV/25-26/0003');
    const c = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(c.billNo).toBe('INV/26-27/0001');
    const d = await t.call('sales.create', { date: '2026-03-20', items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(d.billNo).toBe('INV/25-26/0003');
  });
});

describe('sales.update', () => {
  it('replaces the entry, keeps the number and records the revision', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    const bill = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Sugar', unit: 'kg', qty: 2, rate: 4500 }], payments: [] });
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(9000);
    const entryId = bill.journalEntryId;

    const updated = await t.call('sales.update', {
      id: bill.id,
      customerId: c.id,
      items: [
        { itemName: 'Sugar', unit: 'kg', qty: 3, rate: 4500 },
        { itemName: 'Tea powder', qty: 1, rate: 12000 },
      ],
      payments: [{ mode: 'cash', amount: 25500 }],
      reason: 'Customer added tea',
    });
    expect(updated).toMatchObject({ billNo: bill.billNo, revision: 2, total: 25500, paymentMode: 'cash', credit: 0, customerId: c.id });
    expect(updated.journalEntryId).toBe(entryId);
    expect(updated.updatedByName).toBe('Ravi Sharma');
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);
    expect(systemBalance(t.app, 'CASH')).toBe(25500);
    expect(systemBalance(t.app, 'SALES')).toBe(-25500);
    expect(t.app.db.value('SELECT COUNT(*) FROM journal_entries')).toBe(1);

    const revs = revisions(t, bill.id);
    expect(revs.map((r) => [r.revision, r.action, r.reason])).toEqual([
      [1, 'created', null],
      [2, 'edited', 'Customer added tea'],
    ]);
    expect(JSON.parse(revs[1].snapshot).total).toBe(25500);
    const log = activity(t, 'bill.edit');
    expect(log[0].summary).toContain('Edited bill INV/26-27/0001');
    expect(log[0].summary).toContain('Sugar 2 kg × ₹45.00 = ₹90.00 → 3 kg × ₹45.00 = ₹135.00');
    expect(log[0].summary).toContain('added Tea powder');
    expect(log[0].summary).toContain('total ₹90.00 → ₹255.00');
    expect(log[0].summary).toContain('payment Credit ₹90.00 → Cash ₹255.00');
    expect(log[0].summary).toContain('Reason: Customer added tea');

    const history = await t.call('sales.revisions', { id: bill.id });
    expect(history).toHaveLength(2);
    expect(history[1].changes.map((c) => c.label)).toEqual(['Sugar', 'Item added', 'Total', 'Payment']);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('can move a bill to another customer or to walk-in cash', async () => {
    const t = await createTestApp();
    const a = await customer(t, 'Anita', '9000000001');
    const b = await customer(t, 'Bharat', '9000000002');
    const bill = await t.call('sales.create', { customerId: a.id, items: [{ itemName: 'Rice', qty: 1, rate: 50000 }], payments: [] });
    await t.call('sales.update', { id: bill.id, customerId: b.id, items: [{ itemName: 'Rice', qty: 1, rate: 50000 }], payments: [] });
    expect(partyBalance(t.app.ctx(), 'customer', a.id)).toBe(0);
    expect(partyBalance(t.app.ctx(), 'customer', b.id)).toBe(50000);
    const cash = await t.call('sales.update', { id: bill.id, customerName: 'Walk-in', items: [{ itemName: 'Rice', qty: 1, rate: 50000 }], payments: [{ mode: 'cash', amount: 50000 }] });
    expect(cash).toMatchObject({ customerId: null, customerName: 'Walk-in', paymentMode: 'cash' });
    expect(partyBalance(t.app.ctx(), 'customer', b.id)).toBe(0);
    expect(activity(t, 'bill.edit')[0].summary).toContain('customer Anita → Bharat');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('keeps the date (and needs no backdate permission) when the date is unchanged', async () => {
    const t = await createTestApp();
    await t.call('sales.create', { date: '2026-09-20', items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    const bill = t.app.db.get<{ id: number }>('SELECT id FROM bills')!;
    removePermission(t, 'manager', 'billing.backdate');
    await t.loginAs('manager');
    const u = await t.call('sales.update', { id: bill.id, items: [{ itemName: 'Pen', qty: 2, rate: 1000 }], payments: [{ mode: 'cash', amount: 2000 }] });
    expect(u.date).toBe('2026-09-20');
    const e = await t.fails('sales.update', { id: bill.id, date: '2026-09-21', items: [{ itemName: 'Pen', qty: 2, rate: 1000 }], payments: [{ mode: 'cash', amount: 2000 }] });
    expect(e.code).toBe('FORBIDDEN');
  });

  it('rejects moving a bill into another financial year', async () => {
    const t = await createTestApp({ booksStart: '2025-04-01', today: '2026-04-02' });
    const bill = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(bill.billNo).toBe('INV/26-27/0001');
    const e = await t.fails('sales.update', { id: bill.id, date: '2026-03-31', items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(e.message).toMatch(/belongs to financial year 2026-27/);
    const ok = await t.call('sales.update', { id: bill.id, date: '2026-04-01', items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(ok.date).toBe('2026-04-01');
    expect(getEntry(t.app.ctx(), ok.journalEntryId!).date).toBe('2026-04-01');
  });

  it('is blocked while the bill has active returns and allowed after they are cancelled', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 2, rate: 1000 }], payments: [{ mode: 'cash', amount: 2000 }] });
    const cn = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'cash' });
    const edit = { id: bill.id, items: [{ itemName: 'Pen', qty: 3, rate: 1000 }], payments: [{ mode: 'cash' as const, amount: 3000 }] };
    let e = await t.fails('sales.update', edit);
    expect(e.message).toMatch(new RegExp(`has a sales return \\(${cn.cnNo.replace(/\//g, '\\/')}\\). Cancel it first, then edit the bill`));
    e = await t.fails('sales.cancel', { id: bill.id, reason: 'Wrong' });
    expect(e.message).toMatch(/Cancel it first, then cancel the bill/);
    await t.call('returns.cancel', { id: cn.id, reason: 'Entered by mistake' });
    const ok = await t.call('sales.update', edit);
    expect(ok.total).toBe(3000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('is not allowed for cashiers or on cancelled bills', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    await t.call('sales.cancel', { id: bill.id, reason: 'Duplicate bill' });
    const e = await t.fails('sales.update', { id: bill.id, items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(e.message).toMatch(/cancelled and cannot be edited/);
    await t.loginAs('cashier');
    const bill2 = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect((await t.fails('sales.update', { id: bill2.id, items: [{ itemName: 'Pen', qty: 2, rate: 1000 }], payments: [] })).code).toBe('FORBIDDEN');
    expect((await t.fails('sales.cancel', { id: bill2.id, reason: 'x' })).code).toBe('FORBIDDEN');
  });

  it('lets an editor keep an existing discount without the discount permission', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 2, rate: 1000, discount: 200 }], payments: [{ mode: 'cash', amount: 1800 }] });
    removePermission(t, 'manager', 'billing.discount');
    await t.loginAs('manager');
    const ok2 = await t.call('sales.update', { id: bill.id, items: [{ itemName: 'Pen', qty: 2, rate: 1000, discount: 200 }], payments: [{ mode: 'upi', amount: 1800 }] });
    expect(ok2.paymentMode).toBe('upi');
    const e = await t.fails('sales.update', { id: bill.id, items: [{ itemName: 'Pen', qty: 2, rate: 1000, discount: 500 }], payments: [{ mode: 'upi', amount: 1500 }] });
    expect(e.code).toBe('FORBIDDEN');
  });
});

describe('sales.cancel', () => {
  it('voids the entry, removes it from balances and keeps the audit trail', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    const bill = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Rice', qty: 1, rate: 50000 }], payments: [{ mode: 'cash', amount: 20000 }] });
    expect((await t.fails('sales.cancel', { id: bill.id, reason: '   ' })).code).toBe('VALIDATION');
    expect((await t.fails('sales.cancel', { id: bill.id })).code).toBe('VALIDATION');
    const cancelled = await t.call('sales.cancel', { id: bill.id, reason: 'Customer changed mind' });
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Customer changed mind', cancelledByName: 'Ravi Sharma' });
    expect(getEntry(t.app.ctx(), bill.journalEntryId!).is_void).toBe(1);
    expect(partyBalance(t.app.ctx(), 'customer', c.id)).toBe(0);
    expect(systemBalance(t.app, 'CASH')).toBe(0);
    expect(systemBalance(t.app, 'SALES')).toBe(0);
    expect(revisions(t, bill.id).map((r) => [r.action, r.reason])).toEqual([
      ['created', null],
      ['cancelled', 'Customer changed mind'],
    ]);
    expect(activity(t, 'bill.cancel')[0].summary).toBe('Cancelled bill INV/26-27/0001 (₹500.00 - Anita Desai). Reason: Customer changed mind');
    expect((await t.fails('sales.cancel', { id: bill.id, reason: 'again' })).message).toMatch(/already cancelled/);
    // the number is never reused
    const next = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(next.billNo).toBe('INV/26-27/0002');
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('sales.list and sales.get', () => {
  async function seed(t: TestApp) {
    const c = await customer(t, 'Kavita Rao', '98450 00001');
    const a = await t.call('sales.create', { date: '2026-09-27', items: [{ itemName: 'Sugar', qty: 1, rate: 4500 }], payments: [{ mode: 'cash', amount: 4500 }] });
    const b = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Rice', qty: 2, rate: 6000 }], payments: [], remarks: 'Deliver by 6 pm' });
    const d = await t.call('sales.create', { items: [{ itemName: 'Tea', qty: 1, rate: 1500 }], payments: [{ mode: 'upi', amount: 1500 }] });
    await t.call('sales.cancel', { id: d.id, reason: 'Test' });
    return { c, a, b, d };
  }

  it('filters by date, text, status, payment mode and customer with totals', async () => {
    const t = await createTestApp();
    const { c, b } = await seed(t);
    const all = await t.call('sales.list', { from: '2026-09-01', to: '2026-09-30' });
    expect(all.rows.map((r) => r.billNo)).toEqual(['INV/26-27/0003', 'INV/26-27/0002', 'INV/26-27/0001']);
    expect(all.totals).toEqual({ count: 3, total: 16500, paid: 4500, credit: 12000, discount: 0, cancelledCount: 1 });
    expect(all.todayOnly).toBe(false);
    expect(all.rows[1]).toMatchObject({ customerName: 'Kavita Rao', itemCount: 1, itemsSummary: 'Rice', paymentMode: 'credit', status: 'active' });

    expect((await t.call('sales.list', { from: '2026-09-28', to: '2026-09-28' })).rows).toHaveLength(2);
    expect((await t.call('sales.list', { from: '2026-09-01', to: '2026-09-30', q: 'kavita' })).rows.map((r) => r.id)).toEqual([b.id]);
    expect((await t.call('sales.list', { from: '2026-09-01', to: '2026-09-30', q: '98450 00001' })).rows.map((r) => r.id)).toEqual([b.id]);
    expect((await t.call('sales.list', { from: '2026-09-01', to: '2026-09-30', q: 'deliver' })).rows.map((r) => r.id)).toEqual([b.id]);
    expect((await t.call('sales.list', { from: '2026-09-01', to: '2026-09-30', q: '0002' })).rows.map((r) => r.id)).toEqual([b.id]);
    expect((await t.call('sales.list', { from: '2026-09-01', to: '2026-09-30', q: 'sugar' })).rows).toHaveLength(1);
    expect((await t.call('sales.list', { from: '2026-09-01', to: '2026-09-30', status: 'cancelled' })).rows).toHaveLength(1);
    expect((await t.call('sales.list', { from: '2026-09-01', to: '2026-09-30', paymentMode: 'cash' })).rows).toHaveLength(1);
    expect((await t.call('sales.list', { from: '2026-09-01', to: '2026-09-30', customerId: c.id })).rows).toHaveLength(1);
    const page = await t.call('sales.list', { from: '2026-09-01', to: '2026-09-30', limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.totals.count).toBe(3);
  });

  it("limits users without 'view bills' to today's bills", async () => {
    const t = await createTestApp();
    const { a, b } = await seed(t);
    await t.loginAs('cashier');
    const list = await t.call('sales.list', { from: '2026-09-01', to: '2026-09-30' });
    expect(list.todayOnly).toBe(true);
    expect(list.from).toBe('2026-09-28');
    expect(list.rows.every((r) => r.date === '2026-09-28')).toBe(true);
    expect(list.rows).toHaveLength(2);
    expect((await t.fails('sales.get', { id: a.id })).code).toBe('FORBIDDEN');
    expect((await t.fails('sales.receiptHtml', { id: a.id })).code).toBe('FORBIDDEN');
    expect((await t.fails('sales.revisions', { id: a.id })).code).toBe('FORBIDDEN');
    expect((await t.fails('sales.print', { id: a.id })).code).toBe('FORBIDDEN');
    const got = await t.call('sales.get', { id: b.id });
    expect(got.customer?.balance).toBe(12000);
    await t.loginAs('manager');
    expect((await t.call('sales.get', { id: a.id })).billNo).toBe(a.billNo);
  });

  it('returns the full detail with credit notes and revisions', async () => {
    const t = await createTestApp();
    const { b } = await seed(t);
    await t.call('returns.create', { kind: 'return', billId: b.id, items: [{ billItemId: b.items[0].id, qty: 1 }], refundMode: 'credit' });
    const got = await t.call('sales.get', { id: b.id });
    expect(got.creditNotes).toHaveLength(1);
    expect(got.creditNotes[0]).toMatchObject({ kind: 'return', total: 6000, status: 'active', refundMode: 'credit' });
    expect(got.returnedTotal).toBe(6000);
    expect(got.revisions.map((r) => r.action)).toEqual(['created']);
    expect(got.customer?.balance).toBe(6000);
    expect((await t.fails('sales.get', { id: 9999 })).code).toBe('NOT_FOUND');
  });
});

describe('receipts and printing', () => {
  it('builds an Indian shop receipt with totals, words, flags and UPI QR', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    const bill = await t.call('sales.create', {
      customerId: c.id,
      items: [
        { itemName: 'Basmati Rice', unit: 'kg', qty: 2, rate: 12050, discountPct: 10 },
        { itemName: 'Ghee', qty: 1, rate: 55000 },
      ],
      billDiscount: 1000,
      payments: [{ mode: 'cash', amount: 30000 }],
      remarks: 'Home delivery',
    });
    let { html, paperWidth } = await t.call('sales.receiptHtml', { id: bill.id });
    expect(paperWidth).toBe(80);
    expect(html).toContain('<div class="title">BILL</div>');
    expect(html).toContain('INV/26-27/0001');
    expect(html).toContain('28-09-2026');
    expect(html).toContain('Ravi Sharma'); // cashier
    expect(html).toContain('Anita Desai');
    expect(html).toContain('Basmati Rice');
    expect(html).toContain('2 kg');
    expect(html).toContain('Less discount 10%: -24.10');
    expect(html).toContain('Subtotal');
    expect(html).toContain('TOTAL');
    expect(html).toContain('Paid by Cash');
    expect(html).toContain('Balance on credit');
    expect(html).toContain('Total due from you');
    expect(html).toContain('Remarks: Home delivery');
    expect(html).not.toContain('DUPLICATE');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('Rupees');

    updateSection(t.app.ctx(), 'business', { upiId: 'sharma@okaxis' });
    updateSection(t.app.ctx(), 'receipt', { upiQr: 'unpaid', showAmountInWords: true, showCashier: false });
    ({ html } = await t.call('sales.receiptHtml', { id: bill.id, duplicate: true }));
    expect(html).toContain('DUPLICATE');
    expect(html).toContain('<svg');
    expect(html).toMatch(/Scan to pay ₹[\d,.]+ by UPI/);
    expect(html).toContain('Rupees');
    expect(html).not.toContain('Cashier');

    // fully paid bills get a QR only with "always"
    const paid = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'upi', amount: 1000 }] });
    expect((await t.call('sales.receiptHtml', { id: paid.id })).html).not.toContain('<svg');
    updateSection(t.app.ctx(), 'receipt', { upiQr: 'always' });
    expect((await t.call('sales.receiptHtml', { id: paid.id })).html).toContain('Scan to pay ₹10.00 by UPI');

    await t.call('sales.cancel', { id: paid.id, reason: 'Wrong item' });
    ({ html } = await t.call('sales.receiptHtml', { id: paid.id }));
    expect(html).toContain('CANCELLED');
    expect(html).toContain('Wrong item');
    expect(html).not.toContain('<svg');
  });

  it('prints originals, then duplicates with the reprint permission and logs reprints', async () => {
    const t = await createTestApp();
    updateSection(t.app.ctx(), 'receipt', { printerName: 'POS-80', copies: 2 });
    const bill = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    const first = await t.call('sales.print', { id: bill.id });
    expect(first).toMatchObject({ printed: true, duplicate: false });
    expect(t.platform.printed).toHaveLength(1);
    expect(t.platform.printed[0].opts).toEqual({ printerName: 'POS-80', silent: true, paperWidthMm: 80, copies: 2 });
    expect(t.platform.printed[0].html).not.toContain('DUPLICATE');
    expect((await t.call('sales.get', { id: bill.id })).printCount).toBe(1);

    const again = await t.call('sales.print', { id: bill.id });
    expect(again).toMatchObject({ printed: true, duplicate: true });
    expect(t.platform.printed[1].html).toContain('DUPLICATE');
    expect(t.platform.printed[1].opts.copies).toBe(1);
    expect(activity(t, 'bill.reprint')).toHaveLength(1);
    expect((await t.call('sales.get', { id: bill.id })).printCount).toBe(2);

    // After an edit the first print of the new version is not a duplicate.
    await t.call('sales.update', { id: bill.id, items: [{ itemName: 'Pen', qty: 2, rate: 1000 }], payments: [{ mode: 'cash', amount: 2000 }] });
    expect((await t.call('sales.get', { id: bill.id })).printedCurrent).toBe(false);
    expect((await t.call('sales.print', { id: bill.id })).duplicate).toBe(false);

    // Without the setting the reprint is not marked, but still logged
    updateSection(t.app.ctx(), 'receipt', { markDuplicate: false, printerName: '' });
    const r = await t.call('sales.print', { id: bill.id });
    expect(r.duplicate).toBe(false);
    expect(t.platform.printed.at(-1)!.opts.silent).toBe(false);
    expect(activity(t, 'bill.reprint')).toHaveLength(2);
  });

  it('needs the reprint permission for a second print', async () => {
    const t = await createTestApp();
    removePermission(t, 'cashier', 'billing.reprint');
    await t.loginAs('cashier');
    const bill = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect((await t.call('sales.print', { id: bill.id })).printed).toBe(true);
    const e = await t.fails('sales.print', { id: bill.id });
    expect(e.code).toBe('FORBIDDEN');
    expect(e.message).toMatch(/reprint/);
    expect((await t.call('sales.get', { id: bill.id })).printCount).toBe(1);
  });

  it('does not count a print the user cancelled', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    t.platform.printHtml = async () => ({ printed: false, message: 'Printer is offline' });
    const r = await t.call('sales.print', { id: bill.id });
    expect(r).toMatchObject({ printed: false, message: 'Printer is offline' });
    expect((await t.call('sales.get', { id: bill.id })).printCount).toBe(0);
  });
});

describe('quick repeat', () => {
  it('prefills from a past bill, lists customer items and finds the last bill', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    const sugar = await item(t, 'Sugar', 4500, 'kg');
    const bill = await t.call('sales.create', {
      customerId: c.id,
      items: [
        { itemId: sugar.id, itemName: 'Sugar', qty: 2, rate: 4200, discountPct: 5 },
        { itemName: 'Loose tea', qty: 0.25, rate: 40000 },
      ],
      billDiscount: 100,
      payments: [],
    });
    await t.call('items.update', { id: sugar.id, name: 'Sugar', unit: 'kg', rate: 4800 });
    const rep = await t.call('sales.repeatData', { billId: bill.id });
    expect(rep.sourceBillNo).toBe(bill.billNo);
    expect(rep.customer?.id).toBe(c.id);
    expect(rep.lines).toEqual([
      { itemId: sugar.id, itemName: 'Sugar', unit: 'kg', qty: 2, rate: 4200, defaultRate: 4800, discount: null, discountPct: 5, gstRate: null, hsn: null },
      { itemId: null, itemName: 'Loose tea', unit: null, qty: 0.25, rate: 40000, defaultRate: null, discount: null, discountPct: null, gstRate: null, hsn: null },
    ]);
    expect(rep.billDiscount).toBe(100);
    expect(rep.rateChanges).toBe(1);

    const items = await t.call('sales.customerItems', { customerId: c.id });
    expect(items.map((i) => i.itemName)).toEqual(['Sugar', 'Loose tea']);
    expect(items[0]).toMatchObject({ lastRate: 4200, defaultRate: 4800, lastQty: 2, times: 1 });

    expect((await t.call('sales.lastBill'))?.id).toBe(bill.id);
    await t.loginAs('cashier');
    expect(await t.call('sales.lastBill')).toBeNull();
    // cashiers without discount permission get the lines without discounts
    removePermission(t, 'cashier', 'billing.discount');
    await t.loginAs('cashier');
    const rep2 = await t.call('sales.repeatData', { billId: bill.id });
    expect(rep2.lines[0].discountPct).toBeNull();
    expect(rep2.billDiscount).toBeNull();
  });

  it('gives the billing screen its settings', async () => {
    const t = await createTestApp();
    await t.loginAs('cashier');
    const cfg = await t.call('sales.posConfig');
    expect(cfg).toMatchObject({ today: '2026-09-28', nextBillNo: 'INV/26-27/0001', roundOff: true, defaultPaymentMode: 'cash', autoPrint: true, paperWidth: 80 });
    await t.loginOwner();
    const c = await customer(t);
    await t.loginAs('cashier');
    expect(await t.call('sales.customer', { id: c.id })).toMatchObject({ id: c.id, name: 'Anita Desai', balance: 0, isActive: true });
  });
});

describe('items (price list)', () => {
  it('changes only the rate, logs it and keeps billed items from being deleted', async () => {
    const t = await createTestApp();
    const soap = await item(t, 'Bath Soap', 3500);
    const updated = await t.call('items.setRate', { id: soap.id, rate: 3800 });
    expect(updated).toMatchObject({ rate: 3800, name: 'Bath Soap', unit: 'pcs' });
    const log = activity(t, 'item.update');
    expect(log.at(-1)!.summary).toBe('Changed rate of "Bath Soap": ₹35.00 → ₹38.00/pcs');
    // same rate again: no new log line
    await t.call('items.setRate', { id: soap.id, rate: 3800 });
    expect(activity(t, 'item.update')).toHaveLength(log.length);

    await t.call('sales.create', { items: [{ itemId: soap.id, itemName: 'Bath Soap', qty: 1, rate: 3800 }], payments: [{ mode: 'cash', amount: 3800 }] });
    expect(await t.call('items.remove', { id: soap.id })).toEqual({ deleted: false });
    expect((await t.call('items.get', { id: soap.id })).isActive).toBe(false);
    const unused = await item(t, 'Never sold', 100);
    expect(await t.call('items.remove', { id: unused.id })).toEqual({ deleted: true });

    await t.loginAs('cashier');
    expect((await t.fails('items.setRate', { id: soap.id, rate: 1 })).code).toBe('FORBIDDEN');
    expect((await t.call('items.list', {})).length).toBeGreaterThanOrEqual(0);
  });

  it('lets a cashier repeat their own older bill but not open it', async () => {
    const t = await createTestApp();
    await t.loginAs('cashier');
    const bill = await t.call('sales.create', { items: [{ itemName: 'Tea', qty: 2, rate: 1500 }], payments: [{ mode: 'cash', amount: 3000 }] });
    t.setToday('2026-09-29');
    expect((await t.fails('sales.get', { id: bill.id })).code).toBe('FORBIDDEN');
    const rep = await t.call('sales.repeatData', { billId: bill.id });
    expect(rep.lines[0]).toMatchObject({ itemName: 'Tea', qty: 2, rate: 1500 });
    expect((await t.call('sales.lastBill'))?.id).toBe(bill.id);
    // someone else's old bill cannot be repeated without "view bills"
    await t.loginOwner();
    const other = await t.call('sales.create', { date: '2026-09-28', items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    await t.loginAs('cashier');
    expect((await t.fails('sales.repeatData', { billId: other.id })).code).toBe('FORBIDDEN');
  });

  it('does not allow bills in a closed financial year', async () => {
    const t = await createTestApp({ booksStart: '2025-04-01' });
    const bill = await t.call('sales.create', { date: '2026-03-10', items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    t.app.db.run("UPDATE financial_years SET is_closed = 1 WHERE name = '2025-26'");
    const e = await t.fails('sales.create', { date: '2026-03-11', items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(e.code).toBe('PERIOD_CLOSED');
    expect((await t.fails('sales.cancel', { id: bill.id, reason: 'late' })).code).toBe('PERIOD_CLOSED');
    expect((await t.fails('sales.update', { id: bill.id, items: [{ itemName: 'Pen', qty: 2, rate: 1000 }], payments: [{ mode: 'cash', amount: 2000 }] })).code).toBe('PERIOD_CLOSED');
    expect(t.app.db.value("SELECT status FROM bills WHERE id = ?", [bill.id])).toBe('active');
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('changing item rates needs "billing.rate"', () => {
  it('refuses a changed rate on a catalogue item, and one-time items, but not items without a list rate', async () => {
    const t = await createTestApp();
    const rice = await item(t, 'Rice 25kg', 150000, 'bag');
    const loose = await item(t, 'Loose tea', 0, 'kg');
    removePermission(t, 'cashier', 'billing.rate');
    removePermission(t, 'cashier', 'billing.discount');
    await t.loginAs('cashier');
    const e = await t.fails('sales.create', { items: [{ itemId: rice.id, itemName: 'Rice 25kg', qty: 1, rate: 100 }], payments: [{ mode: 'cash', amount: 100 }] });
    expect(e).toMatchObject({
      code: 'FORBIDDEN',
      message: 'You are not allowed to change the rate of "Rice 25kg" (list rate ₹1,500.00). Bill it at the list rate or ask the owner for permission.',
      fields: { 'items.0.rate': 'Rate changes need permission' },
    });
    expect((await t.fails('sales.create', { items: [{ itemId: rice.id, itemName: 'Rice 25kg', qty: 1, rate: 160000 }], payments: [] })).code).toBe('FORBIDDEN');
    // A one-time (free-text) line sets its own price: not allowed without "Change rates", not even
    // under the name of a catalogue item.
    for (const name of ['Carry bag', 'Rice 25kg', 'rice 25KG']) {
      const one = await t.fails('sales.create', { items: [{ itemName: name, qty: 1, rate: 100 }], payments: [{ mode: 'cash', amount: 100 }] });
      expect(one).toMatchObject({
        code: 'FORBIDDEN',
        message: `"${name}" is not in the item list. Choose the item from the item list — your role cannot set prices.`,
        fields: { 'items.0.itemName': 'Choose an item from the list' },
      });
    }
    const ok = await t.call('sales.create', {
      items: [
        { itemId: rice.id, itemName: 'Rice 25kg', qty: 1, rate: 150000 },
        { itemId: loose.id, itemName: 'Loose tea', qty: 0.5, rate: 40000 },
      ],
      payments: [{ mode: 'cash', amount: 170000 }],
    });
    expect(ok.total).toBe(170000);
    expect(t.app.db.value('SELECT COUNT(*) FROM bills')).toBe(1);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('allows one-time items with "billing.rate" (cashiers by default) and logs their rates', async () => {
    const t = await createTestApp();
    await t.loginAs('cashier');
    const bill = await t.call('sales.create', { items: [{ itemName: 'Carry bag', qty: 2, rate: 500 }], payments: [{ mode: 'cash', amount: 1000 }] });
    expect(bill.items[0]).toMatchObject({ itemId: null, itemName: 'Carry bag', rate: 500 });
    const row = t.app.db.get<{ details: string }>("SELECT details FROM activity_log WHERE action = 'bill.create' ORDER BY id DESC LIMIT 1")!;
    expect(JSON.parse(row.details).oneTimeLines).toEqual([{ itemName: 'Carry bag', qty: 2, rate: 500 }]);
  });

  it('does not let an edit without "billing.rate" turn a catalogue line into a one-time line', async () => {
    const t = await createTestApp();
    const rice = await item(t, 'Rice 25kg', 150000, 'bag');
    const bill = await t.call('sales.create', {
      items: [
        { itemId: rice.id, itemName: 'Rice 25kg', qty: 1, rate: 150000 },
        { itemName: 'Carry bag', qty: 1, rate: 500 },
      ],
      payments: [{ mode: 'cash', amount: 150500 }],
    });
    removePermission(t, 'manager', 'billing.rate');
    await t.loginAs('manager');
    // The catalogue line sent without its item, at ₹1: refused.
    const e = await t.fails('sales.update', {
      id: bill.id,
      items: [
        { itemName: 'Rice 25kg', qty: 1, rate: 100 },
        { itemName: 'Carry bag', qty: 1, rate: 500 },
      ],
      payments: [{ mode: 'cash', amount: 600 }],
    });
    expect(e).toMatchObject({ code: 'FORBIDDEN', fields: { 'items.0.itemName': 'Choose an item from the list' } });
    // The one-time line already on the bill may stay at its saved rate (its quantity may change) ...
    const kept = await t.call('sales.update', {
      id: bill.id,
      items: [
        { itemId: rice.id, itemName: 'Rice 25kg', qty: 1, rate: 150000 },
        { itemName: 'Carry bag', qty: 2, rate: 500 },
      ],
      payments: [{ mode: 'cash', amount: 151000 }],
    });
    expect(kept.total).toBe(151000);
    // ... but not at a new rate.
    const e2 = await t.fails('sales.update', {
      id: bill.id,
      items: [
        { itemId: rice.id, itemName: 'Rice 25kg', qty: 1, rate: 150000 },
        { itemName: 'Carry bag', qty: 2, rate: 100 },
      ],
      payments: [{ mode: 'cash', amount: 150200 }],
    });
    expect(e2.code).toBe('FORBIDDEN');
    expect(t.app.db.value('SELECT total FROM bills WHERE id = ?', [bill.id])).toBe(151000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('lets cashiers change rates by default and logs the changed rate', async () => {
    const t = await createTestApp();
    const sugar = await item(t, 'Sugar', 4800, 'kg');
    await t.loginAs('cashier');
    const bill = await t.call('sales.create', { items: [{ itemId: sugar.id, itemName: 'Sugar', qty: 2, rate: 4500 }], payments: [{ mode: 'cash', amount: 9000 }] });
    const log = activity(t, 'bill.create').at(-1)!;
    expect(log.summary).toBe(`Created bill ${bill.billNo} for ₹90.00 (Cash). Rate changed: Sugar ₹45.00 (list ₹48.00)`);
  });

  it('keeps the saved rates of an edited bill without the permission', async () => {
    const t = await createTestApp();
    const oil = await item(t, 'Oil 1L', 15000, 'pcs');
    const bill = await t.call('sales.create', { items: [{ itemId: oil.id, itemName: 'Oil 1L', qty: 2, rate: 14000 }], payments: [{ mode: 'cash', amount: 28000 }] });
    await t.call('items.update', { id: oil.id, name: 'Oil 1L', unit: 'pcs', rate: 16000 });
    removePermission(t, 'manager', 'billing.rate');
    await t.loginAs('manager');
    const same = await t.call('sales.update', { id: bill.id, items: [{ itemId: oil.id, itemName: 'Oil 1L', qty: 3, rate: 14000 }], payments: [{ mode: 'cash', amount: 42000 }], reason: 'One more' });
    expect(same.total).toBe(42000);
    const e = await t.fails('sales.update', { id: bill.id, items: [{ itemId: oil.id, itemName: 'Oil 1L', qty: 3, rate: 13000 }], payments: [{ mode: 'cash', amount: 39000 }] });
    expect(e.code).toBe('FORBIDDEN');
    // Repeating the bill uses today's list rate for someone who may not change rates.
    const rep = await t.call('sales.repeatData', { billId: bill.id });
    expect(rep.lines[0]).toMatchObject({ rate: 16000, defaultRate: 16000 });
    await t.loginOwner();
    expect((await t.call('sales.repeatData', { billId: bill.id })).lines[0].rate).toBe(14000);
  });
});

describe('editing a bill keeps its payment accounts', () => {
  it('keeps a split row on the account it was received in when no account is sent', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    const hdfc = await t.call('accounts.create', { name: 'HDFC Current', groupCode: 'bank' });
    const sbi = await t.call('accounts.create', { name: 'SBI Savings', groupCode: 'bank' });
    updateSection(t.app.ctx(), 'accounts', { upiAccountId: hdfc.id });
    const input = { customerId: c.id, items: [{ itemName: 'Cooler', qty: 1, rate: 100000 }] };
    const bill = await t.call('sales.create', { ...input, payments: [{ mode: 'upi', amount: 60000, reference: 'UTR123' }] });
    expect(bill.payments[0]).toMatchObject({ accountName: 'HDFC Current', reference: 'UTR123' });
    expect(bill.paymentMode).toBe('split');

    updateSection(t.app.ctx(), 'accounts', { upiAccountId: sbi.id });
    // What the billing screen sent before the fix: the same row without its account.
    const edited = await t.call('sales.update', { id: bill.id, ...input, payments: [{ mode: 'upi', amount: 60000 }], remarks: 'Deliver Sunday' });
    expect(edited.payments[0]).toMatchObject({ accountId: hdfc.id, accountName: 'HDFC Current', reference: 'UTR123' });
    expect(accountBal(t, hdfc.id)).toBe(60000);
    expect(accountBal(t, sbi.id)).toBe(0);
    // A changed amount (or an explicit account) is taken as sent.
    const kept = await t.call('sales.update', { id: bill.id, ...input, payments: [{ mode: 'upi', amount: 60000, accountId: hdfc.id }] });
    expect(kept.payments[0]).toMatchObject({ accountName: 'HDFC Current', reference: 'UTR123' });
    const moved = await t.call('sales.update', { id: bill.id, ...input, payments: [{ mode: 'upi', amount: 60000, accountId: sbi.id }] });
    expect(moved.payments[0]).toMatchObject({ accountName: 'SBI Savings', reference: null });
    const more = await t.call('sales.update', { id: bill.id, ...input, payments: [{ mode: 'upi', amount: 70000 }] });
    expect(more.payments[0].accountName).toBe('SBI Savings');
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('bill receipts and labels', () => {
  it('prints an advance, not a negative due, when the customer has paid in advance', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    await t.call('returns.create', { kind: 'adjustment', customerId: c.id, amount: 100000, reason: 'Advance', refundMode: 'credit' });
    const bill = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Kettle', qty: 1, rate: 20000 }], payments: [] });
    const { html } = await t.call('sales.receiptHtml', { id: bill.id });
    expect(html).toContain('Advance with us: ₹800.00 (as on 28-09-2026)');
    expect(html).not.toContain('Total due from you: -');
  });

  it('prints the real balance on the receipt even when the user printing it may not see balances', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Rice', qty: 3, rate: 10000 }], payments: [] });
    removePermission(t, 'cashier', 'customers.view');
    removePermission(t, 'cashier', 'customers.receive');
    await t.loginAs('cashier');
    const bill = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Oil', qty: 1, rate: 10000 }], payments: [{ mode: 'cash', amount: 5000 }] });
    // On screen the balance stays hidden ...
    expect(bill.customer).toMatchObject({ balance: 0, balanceHidden: true });
    // ... but the slip the customer takes home shows what they owe, never a false "Nothing due".
    const { html } = await t.call('sales.receiptHtml', { id: bill.id });
    expect(html).toContain('Total due from you: ₹350.00 (as on 28-09-2026)');
    expect(html).not.toContain('Nothing due');
    // A credit-mode return printed by the same cashier.
    const cn = await t.call('returns.create', { kind: 'return', billId: bill.id, items: [{ billItemId: bill.items[0].id, qty: 1 }], refundMode: 'credit' });
    expect(cn.customer).toMatchObject({ balance: 0, balanceHidden: true });
    const note = await t.call('returns.receiptHtml', { id: cn.id });
    expect(note.html).toContain('Total due from you: ₹250.00 (as on 28-09-2026)');
    expect(note.html).not.toContain('Nothing due');
  });

  it('calls a bill with a credit part "Part paid", not "Split"', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    const bill = await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Fan', qty: 1, rate: 200000 }], payments: [{ mode: 'cash', amount: 50000 }] });
    expect(bill.paymentMode).toBe('split');
    expect(activity(t, 'bill.create').at(-1)!.summary).toBe(`Created bill ${bill.billNo} for ₹2,000.00 (Part paid) - Anita Desai`);
    const { billPaymentLabel } = await import('../src/shared/billing');
    expect(billPaymentLabel('split', 150000)).toBe('Part paid');
    expect(billPaymentLabel('split', 0)).toBe('Split');
    expect(billPaymentLabel('cash')).toBe('Cash');
  });
});

describe('customer balances on the billing screen', () => {
  it('hides the balance and credit limit from users who may not see customer balances', async () => {
    const t = await createTestApp();
    const c = await customer(t);
    await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Rice', qty: 1, rate: 10000 }], payments: [] });
    const owner = await t.call('sales.customer', { id: c.id });
    expect(owner.balance).toBe(10000);
    expect(owner.balanceHidden).toBeUndefined();
    removePermission(t, 'cashier', 'customers.view');
    removePermission(t, 'cashier', 'customers.receive');
    await t.loginAs('cashier');
    const hidden = await t.call('sales.customer', { id: c.id });
    expect(hidden).toMatchObject({ id: c.id, balance: 0, creditLimit: null, balanceHidden: true });
  });
});
