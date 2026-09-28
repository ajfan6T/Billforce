import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance, type TestApp } from './helpers';
import { partyBalance } from '../src/core/accounting/ledger';

const payable = (t: TestApp, id: number) => 0 - partyBalance(t.app.ctx(), 'supplier', id, { account: 'AP' });
const accountId = (t: TestApp, name: string) => t.app.db.value<number>('SELECT id FROM accounts WHERE name = ?', [name]);
const accountBal = (t: TestApp, id: number) =>
  t.app.db.value<number>(
    'SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.is_void = 0',
    [id],
    0,
  );

describe('purchase bills', () => {
  it('records a cash purchase to the Purchases account', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const s = await t.call('suppliers.create', { name: 'Gupta Traders' });
    const p = await t.call('purchases.create', {
      supplierId: s.id,
      supplierBillNo: 'GT/5501',
      supplierBillDate: '2026-09-27',
      items: [
        { description: 'Sugar', qty: 25, unit: 'kg', rate: 4200 },
        { description: 'Tea powder', qty: 2, unit: 'kg', rate: 38000 },
      ],
      payments: [{ mode: 'cash', amount: 181000 }],
    });
    expect(p.purchaseNo).toBe('PUR/26-27/0001');
    expect(p).toMatchObject({ subtotal: 181000, total: 181000, paid: 181000, credit: 0, paymentMode: 'cash', expenseAccountName: 'Purchases', supplierName: 'Gupta Traders' });
    expect(p.items.map((i) => i.amount)).toEqual([105000, 76000]);
    expect(p.warnings).toEqual([]);
    expect(systemBalance(t.app, 'PURCHASES')).toBe(181000);
    expect(systemBalance(t.app, 'CASH')).toBe(1000000 - 181000);
    expect(payable(t, s.id)).toBe(0);
    const entry = t.app.db.get<any>('SELECT * FROM journal_entries WHERE id = ?', [p.journalEntryId]);
    expect(entry).toMatchObject({ voucher_type: 'purchase', voucher_no: 'PUR/26-27/0001', source_type: 'purchase', source_id: p.id });
    expect(entry.narration).toBe('Purchase from Gupta Traders, bill GT/5501');

    const d = await t.call('purchases.get', { id: p.id });
    expect(d.revisions).toHaveLength(1);
    expect(d.posting.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['Purchases', 181000, 0],
      ['Cash in Hand', 0, 181000],
    ]);
    expect(t.app.db.value<string>("SELECT summary FROM activity_log WHERE action = 'purchase.create'")).toBe(
      'Entered purchase PUR/26-27/0001 of ₹1,810.00 from Gupta Traders',
    );
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('records credit and split purchases against the supplier', async () => {
    const t = await createTestApp();
    const s = await t.call('suppliers.create', { name: 'Gupta Traders' });
    const credit = await t.call('purchases.create', { supplierId: s.id, items: [{ description: 'Rice', qty: 10, rate: 5000 }] });
    expect(credit).toMatchObject({ total: 50000, paid: 0, credit: 50000, paymentMode: 'credit' });
    expect(payable(t, s.id)).toBe(50000);
    expect(systemBalance(t.app, 'AP')).toBe(-50000);

    const split = await t.call('purchases.create', {
      supplierId: s.id,
      items: [{ description: 'Oil', qty: 4, unit: 'ltr', rate: 15000 }],
      payments: [
        { mode: 'upi', amount: 20000, reference: 'UPI-1' },
        { mode: 'cash', amount: 10000 },
      ],
    });
    expect(split).toMatchObject({ total: 60000, paid: 30000, credit: 30000, paymentMode: 'split' });
    expect(split.payments.map((p) => [p.mode, p.accountName, p.amount, p.reference])).toEqual([
      ['upi', 'UPI Account', 20000, 'UPI-1'],
      ['cash', 'Cash in Hand', 10000, null],
    ]);
    expect(payable(t, s.id)).toBe(80000);
    expect(systemBalance(t.app, 'UPI')).toBe(-20000);
    expect(systemBalance(t.app, 'CASH')).toBe(-10000);
    expect(systemBalance(t.app, 'PURCHASES')).toBe(110000);

    // One payment that does not cover the total is a part payment ("split").
    const part = await t.call('purchases.create', { supplierId: s.id, items: [{ description: 'Dal', qty: 1, rate: 10000 }], payments: [{ mode: 'bank', amount: 4000 }] });
    expect(part.paymentMode).toBe('split');
    expect(payable(t, s.id)).toBe(86000);
    expect((await t.call('purchases.get', { id: part.id })).supplierPayable).toBe(86000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('applies discount, other charges and round off', async () => {
    const t = await createTestApp();
    const s = await t.call('suppliers.create', { name: 'Gupta Traders' });
    // 3 x 33.33 = 99.99; -10.00 discount; +5.50 freight = 95.49; rounded to 95.00
    const p = await t.call('purchases.create', {
      supplierId: s.id,
      items: [{ description: 'Biscuits', qty: 3, unit: 'box', rate: 3333 }],
      discount: 1000,
      otherCharges: 550,
    });
    expect(p).toMatchObject({ subtotal: 9999, discount: 1000, otherCharges: 550, roundOff: -49, total: 9500, credit: 9500 });
    expect(systemBalance(t.app, 'PURCHASES')).toBe(9500);
    expect(payable(t, s.id)).toBe(9500);
    // Rounded up
    const up = await t.call('purchases.create', { supplierId: s.id, items: [{ description: 'Salt', qty: 1, rate: 1060 }] });
    expect(up).toMatchObject({ roundOff: 40, total: 1100 });
    // Round off can be turned off to match the supplier's bill exactly.
    const exact = await t.call('purchases.create', { supplierId: s.id, items: [{ description: 'Salt', qty: 1, rate: 1060 }], roundOff: false });
    expect(exact).toMatchObject({ roundOff: 0, total: 1060 });
    // And follows the setting when not given.
    t.app.db.run("INSERT INTO settings (key, value) VALUES ('billing', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [
      JSON.stringify({ roundOff: false }),
    ]);
    const noRound = await t.call('purchases.create', { supplierId: s.id, items: [{ description: 'Salt', qty: 1.5, rate: 1001 }] });
    expect(noRound).toMatchObject({ roundOff: 0, total: 1502 });
    expect((await t.call('purchases.formOptions')).roundOff).toBe(false);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('books to the chosen expense or fixed asset account and refuses other accounts', async () => {
    const t = await createTestApp();
    const s = await t.call('suppliers.create', { name: 'Computer World' });
    const computers = accountId(t, 'Computers & Equipment');
    const freight = accountId(t, 'Freight Inward');
    const asset = await t.call('purchases.create', { supplierId: s.id, expenseAccountId: computers, items: [{ description: 'Billing printer', qty: 1, rate: 850000 }] });
    expect(asset.expenseAccountName).toBe('Computers & Equipment');
    expect(accountBal(t, computers)).toBe(850000);
    await t.call('purchases.create', { supplierName: 'Tempo driver', expenseAccountId: freight, items: [{ description: 'Transport', qty: 1, rate: 50000 }], payments: [{ mode: 'cash', amount: 50000 }] });
    expect(accountBal(t, freight)).toBe(50000);
    expect(systemBalance(t.app, 'PURCHASES')).toBe(0);

    for (const key of ['SALES', 'CASH', 'CAPITAL', 'AP']) {
      const id = t.app.db.value<number>('SELECT id FROM accounts WHERE system_key = ?', [key]);
      const err = await t.fails('purchases.create', { supplierId: s.id, expenseAccountId: id, items: [{ description: 'X', qty: 1, rate: 100 }] });
      expect(err.code).toBe('VALIDATION');
      expect(err.message).toMatch(/expense account .* or a fixed asset account/);
    }
    t.app.db.run('UPDATE accounts SET is_active = 0 WHERE id = ?', [freight]);
    expect((await t.fails('purchases.create', { supplierId: s.id, expenseAccountId: freight, items: [{ description: 'X', qty: 1, rate: 100 }] })).message).toMatch(
      /deactivated/,
    );

    const opts = await t.call('purchases.formOptions');
    expect(opts.accounts[0]).toMatchObject({ name: 'Purchases', isDefault: true });
    const names = opts.accounts.map((a) => a.name);
    expect(names).toContain('Computers & Equipment');
    expect(names).toContain('Rent');
    expect(names).not.toContain('Sales');
    expect(names).not.toContain('Freight Inward');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('validates purchases in plain words', async () => {
    const t = await createTestApp();
    const s = await t.call('suppliers.create', { name: 'Gupta Traders' });
    const item = [{ description: 'Rice', qty: 1, rate: 10000 }];
    let err = await t.fails('purchases.create', { supplierName: 'Somebody', items: item });
    expect(err.message).toBe('₹100.00 is unpaid. Choose the supplier to buy on credit, or record the full amount as paid.');
    expect(err.fields?.supplierId).toBeTruthy();
    err = await t.fails('purchases.create', { items: item, payments: [{ mode: 'cash', amount: 6000 }] });
    expect(err.message).toMatch(/₹40.00 is unpaid/);
    err = await t.fails('purchases.create', { supplierId: s.id, items: item, payments: [{ mode: 'cash', amount: 10001 }] });
    expect(err.message).toBe('The amount paid (₹100.01) is more than the purchase total (₹100.00).');
    err = await t.fails('purchases.create', { supplierId: s.id, items: [] });
    expect(err.message).toMatch(/Add at least one item/);
    err = await t.fails('purchases.create', { supplierId: s.id, items: [{ description: ' ', qty: 1, rate: 100 }] });
    expect(err.code).toBe('VALIDATION');
    err = await t.fails('purchases.create', { supplierId: s.id, items: [{ description: 'Rice', qty: 0, rate: 100 }] });
    expect(err.message).toMatch(/Quantity must be more than zero/);
    err = await t.fails('purchases.create', { supplierId: s.id, items: item, discount: 10001 });
    expect(err.message).toMatch(/discount \(₹100.01\) cannot be more than the items total/);
    err = await t.fails('purchases.create', { supplierId: s.id, items: [{ description: 'Free sample', qty: 1, rate: 0 }] });
    expect(err.message).toBe('The purchase total must be more than zero');
    err = await t.fails('purchases.create', { supplierId: s.id, date: '2026-09-29', items: item });
    expect(err.message).toMatch(/later than today/);
    err = await t.fails('purchases.create', { supplierId: s.id, date: '2026-09-20', supplierBillDate: '2026-09-21', items: item });
    expect(err.message).toMatch(/cannot be after the purchase date/);
    err = await t.fails('purchases.create', { supplierId: 999, items: item });
    expect(err.code).toBe('NOT_FOUND');
    await t.call('suppliers.setActive', { id: s.id, active: false });
    err = await t.fails('purchases.create', { supplierId: s.id, items: item });
    expect(err.message).toMatch(/deactivated/);

    // A fully paid purchase does not need a supplier record.
    const cash = await t.call('purchases.create', { supplierName: 'Local market', items: item, payments: [{ mode: 'cash', amount: 10000 }] });
    expect(cash).toMatchObject({ supplierId: null, supplierName: 'Local market', paymentMode: 'cash' });
    const anon = await t.call('purchases.create', { items: item, payments: [{ mode: 'cash', amount: 10000 }] });
    expect(anon.supplierName).toBeNull();
    expect(t.app.db.value('SELECT COUNT(*) FROM purchases')).toBe(2);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('warns about a duplicate supplier bill number', async () => {
    const t = await createTestApp();
    const s = await t.call('suppliers.create', { name: 'Gupta Traders' });
    const other = await t.call('suppliers.create', { name: 'Other' });
    const first = await t.call('purchases.create', { supplierId: s.id, supplierBillNo: 'GT/77', items: [{ description: 'Rice', qty: 1, rate: 10000 }] });
    const dup = await t.call('purchases.create', { supplierId: s.id, supplierBillNo: 'gt/77', items: [{ description: 'Rice', qty: 1, rate: 10000 }] });
    expect(dup.warnings[0]).toBe(`Bill no. gt/77 from Gupta Traders was already entered as ${first.purchaseNo} on 28-09-2026. Please check it is not entered twice.`);
    const fine = await t.call('purchases.create', { supplierId: other.id, supplierBillNo: 'GT/77', items: [{ description: 'Rice', qty: 1, rate: 10000 }] });
    expect(fine.warnings).toEqual([]);
    expect((await t.call('purchases.checkBillNo', { supplierId: s.id, supplierBillNo: 'GT/77' })).duplicate?.id).toBe(first.id);
    expect((await t.call('purchases.checkBillNo', { supplierId: s.id, supplierBillNo: 'GT/78' })).duplicate).toBeNull();
    // Editing a bill does not warn about itself.
    await t.call('purchases.cancel', { id: dup.id, reason: 'Entered twice' });
    const edited = await t.call('purchases.update', { id: first.id, supplierId: s.id, supplierBillNo: 'GT/77', items: [{ description: 'Rice', qty: 2, rate: 10000 }] });
    expect(edited.warnings).toEqual([]);
  });

  it('edits and cancels purchases with a full audit trail', async () => {
    const t = await createTestApp();
    const a = await t.call('suppliers.create', { name: 'Anand Dairy' });
    const b = await t.call('suppliers.create', { name: 'Bharat Wholesale' });
    const p = await t.call('purchases.create', {
      supplierId: a.id,
      date: '2026-09-20',
      items: [{ description: 'Milk', qty: 20, unit: 'ltr', rate: 5000 }],
      payments: [{ mode: 'cash', amount: 40000 }],
    });
    expect(payable(t, a.id)).toBe(60000);

    const e = await t.call('purchases.update', {
      id: p.id,
      supplierId: b.id,
      date: '2026-09-21',
      items: [
        { description: 'Milk', qty: 20, unit: 'ltr', rate: 5000 },
        { description: 'Curd', qty: 5, unit: 'kg', rate: 8000 },
      ],
      discount: 2000,
      payments: [{ mode: 'upi', amount: 100000, reference: 'U-5' }],
      reason: 'Wrong supplier and missed curd',
    });
    expect(e).toMatchObject({ revision: 2, purchaseNo: p.purchaseNo, journalEntryId: p.journalEntryId, total: 138000, paid: 100000, credit: 38000, supplierName: 'Bharat Wholesale' });
    expect(e.items).toHaveLength(2);
    expect(payable(t, a.id)).toBe(0);
    expect(payable(t, b.id)).toBe(38000);
    expect(systemBalance(t.app, 'CASH')).toBe(0);
    expect(systemBalance(t.app, 'UPI')).toBe(-100000);
    expect(systemBalance(t.app, 'PURCHASES')).toBe(138000);
    expect(t.app.db.value('SELECT COUNT(*) FROM purchase_items WHERE purchase_id = ?', [p.id])).toBe(2);
    expect(t.app.db.value('SELECT COUNT(*) FROM purchase_payments WHERE purchase_id = ?', [p.id])).toBe(1);
    const upd = t.app.db.value<string>("SELECT summary FROM activity_log WHERE action = 'purchase.update'");
    expect(upd).toContain('total ₹1,000.00 → ₹1,380.00');
    expect(upd).toContain('supplier Anand Dairy → Bharat Wholesale');
    expect(upd).toContain('reason: Wrong supplier and missed curd');

    const c = await t.call('purchases.cancel', { id: p.id, reason: 'Goods returned in full' });
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Goods returned in full', revision: 3 });
    expect(payable(t, b.id)).toBe(0);
    expect(systemBalance(t.app, 'PURCHASES')).toBe(0);
    expect(systemBalance(t.app, 'UPI')).toBe(0);
    expect(t.app.db.value('SELECT is_void FROM journal_entries WHERE id = ?', [p.journalEntryId])).toBe(1);

    const d = await t.call('purchases.get', { id: p.id });
    expect(d.revisions.map((r) => [r.revision, r.action, r.reason])).toEqual([
      [1, 'created', null],
      [2, 'edited', 'Wrong supplier and missed curd'],
      [3, 'cancelled', 'Goods returned in full'],
    ]);
    expect((d.revisions[0].snapshot as any).total).toBe(100000);
    expect((d.revisions[1].snapshot as any).items).toHaveLength(2);
    expect(t.app.db.all<any>("SELECT action FROM activity_log WHERE entity_type = 'purchase' ORDER BY id").map((r) => r.action)).toEqual([
      'purchase.create',
      'purchase.update',
      'purchase.cancel',
    ]);
    expect((await t.fails('purchases.update', { id: p.id, supplierId: b.id, items: [{ description: 'X', qty: 1, rate: 1 }] })).message).toMatch(/cancelled/);
    expect((await t.fails('purchases.cancel', { id: p.id, reason: 'x' })).message).toMatch(/already cancelled/);

    // Documents keep their number: the next purchase gets a new one.
    const next = await t.call('purchases.create', { supplierId: a.id, items: [{ description: 'Milk', qty: 1, rate: 5000 }] });
    expect(next.purchaseNo).toBe('PUR/26-27/0002');
    t.setToday('2027-04-02');
    expect((await t.fails('purchases.update', { id: next.id, supplierId: a.id, date: '2027-04-01', items: [{ description: 'Milk', qty: 1, rate: 5000 }] })).message).toMatch(
      /belongs to financial year 2026-27/,
    );
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('lists purchases with filters and totals, and suggests past items', async () => {
    const t = await createTestApp();
    const a = await t.call('suppliers.create', { name: 'Anand Dairy' });
    const b = await t.call('suppliers.create', { name: 'Bharat Wholesale' });
    await t.call('purchases.create', { supplierId: a.id, date: '2026-09-01', supplierBillNo: 'AD-1', items: [{ description: 'Milk', qty: 10, unit: 'ltr', rate: 5000 }] });
    await t.call('purchases.create', { supplierId: b.id, date: '2026-09-10', items: [{ description: 'Milk powder', qty: 2, unit: 'kg', rate: 40000 }], payments: [{ mode: 'cash', amount: 80000 }] });
    const c = await t.call('purchases.create', { supplierId: a.id, date: '2026-09-15', items: [{ description: 'Milk', qty: 5, unit: 'ltr', rate: 5200 }] });
    await t.call('purchases.cancel', { id: c.id, reason: 'test' });

    let list = await t.call('purchases.list', { from: '2026-09-01', to: '2026-09-30' });
    expect(list.rows).toHaveLength(3);
    expect(list.totals).toEqual({ count: 2, total: 130000, paid: 80000, credit: 50000, cancelled: 1 });
    list = await t.call('purchases.list', { supplierId: a.id, status: 'active' });
    expect(list.rows.map((r) => r.supplierBillNo)).toEqual(['AD-1']);
    list = await t.call('purchases.list', { q: 'powder' });
    expect(list.rows.map((r) => r.supplierName)).toEqual(['Bharat Wholesale']);
    list = await t.call('purchases.list', { q: 'AD-1' });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].items).toBe('Milk 10 ltr');

    const sugg = await t.call('purchases.descriptions', { q: 'milk' });
    expect(sugg.map((s) => s.description)).toEqual(['Milk powder', 'Milk']);
    expect(sugg.find((s) => s.description === 'Milk')).toMatchObject({ unit: 'ltr', rate: 5000 });
    const fromA = await t.call('purchases.descriptions', { q: 'milk', supplierId: a.id });
    expect(fromA[0].description).toBe('Milk');
  });

  it('allows only users with purchase permission to enter purchases', async () => {
    const t = await createTestApp();
    const s = await t.call('suppliers.create', { name: 'Gupta Traders' });
    const p = await t.call('purchases.create', { supplierId: s.id, items: [{ description: 'Rice', qty: 1, rate: 10000 }] });
    await t.loginAs('cashier');
    expect((await t.fails('purchases.create', { supplierId: s.id, items: [{ description: 'Rice', qty: 1, rate: 10000 }] })).code).toBe('FORBIDDEN');
    expect((await t.fails('purchases.get', { id: p.id })).code).toBe('FORBIDDEN');
    expect((await t.fails('purchases.cancel', { id: p.id, reason: 'x' })).code).toBe('FORBIDDEN');
    expect((await t.fails('purchases.formOptions')).code).toBe('FORBIDDEN');
    await t.loginAs('manager');
    const e = await t.call('purchases.update', { id: p.id, supplierId: s.id, items: [{ description: 'Rice', qty: 2, rate: 10000 }], reason: 'qty' });
    expect(e.updatedBy).toBe('Test manager');
    // A view-only role can see purchases but not change them.
    t.app.db.run("DELETE FROM role_permissions WHERE role = 'manager' AND permission = 'purchases.manage'");
    await t.loginAs('manager');
    expect((await t.call('purchases.list', {})).rows).toHaveLength(1);
    expect((await t.fails('purchases.cancel', { id: p.id, reason: 'x' })).code).toBe('FORBIDDEN');
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});
