import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance, type TestApp } from './helpers';
import { partyBalance, postEntry } from '../src/core/accounting/ledger';
import { nextDocNumber } from '../src/core/numbering';
import { lineAmount } from '../src/shared/money';

/**
 * Bills belong to the sales module; to test statements independently we write
 * a bill row and its ledger entry exactly as the posting contract describes.
 */
function addBill(t: TestApp, opts: { customerId: number; date: string; items: Array<{ name: string; qty: number; rate: number }>; paid?: number }) {
  const ctx = t.app.ctx();
  return t.app.db.tx(() => {
    const total = opts.items.reduce((s, i) => s + lineAmount(i.qty, i.rate), 0);
    const paid = opts.paid ?? 0;
    const num = nextDocNumber(ctx, 'bill', opts.date);
    const name = t.app.db.value<string>('SELECT name FROM customers WHERE id = ?', [opts.customerId]);
    const id = t.app.db.insert('bills', {
      bill_no: num.number,
      seq: num.seq,
      fy_start: num.fyStart,
      date: opts.date,
      customer_id: opts.customerId,
      customer_name: name,
      subtotal: total,
      total,
      paid,
      credit: total - paid,
      payment_mode: paid === 0 ? 'credit' : paid === total ? 'cash' : 'split',
      created_at: `${opts.date} 10:00:00`,
    });
    opts.items.forEach((it, i) =>
      t.app.db.insert('bill_items', { bill_id: id, line_no: i + 1, item_name: it.name, qty: it.qty, rate: it.rate, amount: lineAmount(it.qty, it.rate) }),
    );
    const entryId = postEntry(ctx, {
      date: opts.date,
      voucherType: 'sale',
      voucherNo: num.number,
      sourceType: 'bill',
      sourceId: id,
      lines: [
        { account: 'CASH', debit: paid },
        { account: 'AR', debit: total - paid, partyType: 'customer', partyId: opts.customerId },
        { account: 'SALES', credit: total },
      ],
    });
    t.app.db.update('bills', id, { journal_entry_id: entryId });
    return { id, billNo: num.number, total };
  });
}

const bal = (t: TestApp, id: number) => partyBalance(t.app.ctx(), 'customer', id, { account: 'AR' });

describe('customer records', () => {
  it('creates customers with opening balances in both directions', async () => {
    const t = await createTestApp();
    const anita = await t.call('customers.create', {
      name: 'Anita Desai',
      phone: '98200 11111',
      address: 'Kothrud, Pune',
      email: 'anita@example.com',
      creditLimit: 500000,
      openingBalance: { amount: 125000, direction: 'receivable' },
    });
    expect(anita.balance).toBe(125000);
    expect(anita.openingBalance).toEqual({ amount: 125000, direction: 'receivable' });
    expect(anita.creditLimit).toBe(500000);
    expect(anita.overLimit).toBe(false);
    expect(systemBalance(t.app, 'AR')).toBe(125000);
    expect(systemBalance(t.app, 'OPENING_EQUITY')).toBe(-125000);
    const entry = t.app.db.get<any>('SELECT * FROM journal_entries WHERE id = (SELECT opening_entry_id FROM customers WHERE id = ?)', [anita.id]);
    expect(entry).toMatchObject({ date: '2026-04-01', voucher_type: 'opening', source_type: 'opening', source_id: anita.id });

    const ravi = await t.call('customers.create', { name: 'Ravi Kumar', openingBalance: { amount: 20000, direction: 'advance' } });
    expect(ravi.balance).toBe(-20000);
    expect(ravi.openingBalance).toEqual({ amount: 20000, direction: 'advance' });
    expect(systemBalance(t.app, 'AR')).toBe(105000);

    const plain = await t.call('customers.create', { name: 'Walk-in regular', openingBalance: { amount: 0, direction: 'receivable' } });
    expect(plain.openingBalance).toBeNull();
    expect(t.app.db.value('SELECT opening_entry_id FROM customers WHERE id = ?', [plain.id], null)).toBeNull();

    const log = t.app.db.get<any>("SELECT * FROM activity_log WHERE action = 'customer.create' AND entity_id = ?", [anita.id]);
    expect(log.summary).toContain('opening balance ₹1,250.00 due');
    expect(log.username).toBe('owner');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('edits, replaces and removes the opening balance', async () => {
    const t = await createTestApp();
    const c = await t.call('customers.create', { name: 'Meena', openingBalance: { amount: 50000, direction: 'receivable' } });
    const entryId = t.app.db.value<number>('SELECT opening_entry_id FROM customers WHERE id = ?', [c.id]);

    let u = await t.call('customers.update', { id: c.id, name: 'Meena Joshi', openingBalance: { amount: 30000, direction: 'advance' } });
    expect(u.balance).toBe(-30000);
    expect(u.name).toBe('Meena Joshi');
    expect(t.app.db.value('SELECT opening_entry_id FROM customers WHERE id = ?', [c.id])).toBe(entryId);
    expect(t.app.db.value('SELECT COUNT(*) FROM journal_entries WHERE voucher_type = ?', ['opening'])).toBe(1);

    // Leaving openingBalance out keeps it.
    u = await t.call('customers.update', { id: c.id, name: 'Meena Joshi', phone: '99887 76655' });
    expect(u.openingBalance).toEqual({ amount: 30000, direction: 'advance' });

    // Removing it voids the entry.
    u = await t.call('customers.update', { id: c.id, name: 'Meena Joshi', phone: '99887 76655', openingBalance: null });
    expect(u.openingBalance).toBeNull();
    expect(u.balance).toBe(0);
    expect(t.app.db.value('SELECT is_void FROM journal_entries WHERE id = ?', [entryId])).toBe(1);

    // Setting it again re-uses the same entry.
    u = await t.call('customers.update', { id: c.id, name: 'Meena Joshi', openingBalance: { amount: 10000, direction: 'receivable' } });
    expect(u.balance).toBe(10000);
    expect(t.app.db.value('SELECT is_void FROM journal_entries WHERE id = ?', [entryId])).toBe(0);
    expect(systemBalance(t.app, 'AR')).toBe(10000);

    const logs = t.app.db.all<any>("SELECT summary FROM activity_log WHERE action = 'customer.update' ORDER BY id");
    expect(logs[0].summary).toContain('renamed from "Meena"');
    expect(logs[0].summary).toContain('opening balance ₹500.00 due → opening advance ₹300.00');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('keeps phone numbers unique among active customers and validates details', async () => {
    const t = await createTestApp();
    const a = await t.call('customers.create', { name: 'Anita', phone: '98200 11111' });
    let err = await t.fails('customers.create', { name: 'Someone', phone: '+91 9820011111' });
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('This phone number already belongs to Anita');
    expect(err.fields?.phone).toMatch(/Anita/);
    err = await t.fails('customers.quickCreate', { name: 'Someone', phone: '09820011111' });
    expect(err.message).toMatch(/already belongs to Anita/);
    const b = await t.call('customers.create', { name: 'Bala', phone: '98200 22222' });
    err = await t.fails('customers.update', { id: b.id, name: 'Bala', phone: '9820011111' });
    expect(err.message).toMatch(/Anita/);
    // Saving the same customer with its own number is fine.
    await t.call('customers.update', { id: a.id, name: 'Anita D', phone: '98200 11111' });

    // A deactivated customer's number can be reused; re-activating then conflicts.
    await t.call('customers.setActive', { id: a.id, active: false });
    const c = await t.call('customers.create', { name: 'Chitra', phone: '98200-11111' });
    expect(c.phone).toBe('98200-11111');
    err = await t.fails('customers.setActive', { id: a.id, active: true });
    expect(err.message).toMatch(/Chitra/);

    expect((await t.fails('customers.create', { name: '  ' })).message).toMatch(/Enter the customer name/);
    expect((await t.fails('customers.create', { name: 'X', email: 'not-an-email' })).fields?.email).toBeTruthy();
    expect((await t.fails('customers.create', { name: 'X', phone: 'abc' })).code).toBe('VALIDATION');
    expect((await t.fails('customers.create', { name: 'X', creditLimit: -5 })).code).toBe('VALIDATION');
    expect((await t.fails('customers.get', { id: 999 })).code).toBe('NOT_FOUND');
  });

  it('lists customers with balances, last bill and this year billing', async () => {
    const t = await createTestApp();
    const a = await t.call('customers.create', { name: 'Anita', phone: '98200 11111', openingBalance: { amount: 10000, direction: 'receivable' } });
    const b = await t.call('customers.create', { name: 'Bala', phone: '98200 22222' });
    const c = await t.call('customers.create', { name: 'Chitra' });
    addBill(t, { customerId: b.id, date: '2026-09-01', items: [{ name: 'Rice', qty: 2, rate: 6000 }] });
    addBill(t, { customerId: b.id, date: '2026-09-20', items: [{ name: 'Oil', qty: 1, rate: 15000 }], paid: 15000 });
    await t.call('customers.setActive', { id: c.id, active: false });

    let rows = await t.call('customers.list', {});
    expect(rows.map((r) => r.name)).toEqual(['Anita', 'Bala']);
    const bala = rows.find((r) => r.id === b.id)!;
    expect(bala).toMatchObject({ balance: 12000, lastBillDate: '2026-09-20', billedThisFy: 27000 });

    rows = await t.call('customers.list', { includeInactive: true });
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === c.id)!.isActive).toBe(false);

    rows = await t.call('customers.list', { q: '22222' });
    expect(rows.map((r) => r.id)).toEqual([b.id]);
    rows = await t.call('customers.list', { q: 'ani' });
    expect(rows.map((r) => r.id)).toEqual([a.id]);

    await t.call('customers.create', { name: 'Dev' });
    rows = await t.call('customers.list', { onlyWithBalance: true });
    expect(rows.map((r) => r.name)).toEqual(['Anita', 'Bala']);

    const detail = await t.call('customers.get', { id: b.id });
    expect(detail.totals).toMatchObject({ bills: 2, billed: 27000, paidAtBilling: 15000, receipts: 0, received: 0 });
    expect(detail.lastBillDate).toBe('2026-09-20');
    expect(detail.canRemove).toBe(false);

    const bills = await t.call('customers.bills', { customerId: b.id });
    expect(bills.rows.map((r) => r.date)).toEqual(['2026-09-20', '2026-09-01']);
    expect(bills.rows[1].items).toBe('Rice 2');
    expect(bills.totals).toEqual({ count: 2, total: 27000, paid: 15000, credit: 12000 });
    const sept = await t.call('customers.bills', { customerId: b.id, from: '2026-09-10', to: '2026-09-30' });
    expect(sept.rows).toHaveLength(1);
  });

  it('removes customers without history and asks to deactivate otherwise', async () => {
    const t = await createTestApp();
    const fresh = await t.call('customers.create', { name: 'Fresh' });
    expect((await t.call('customers.get', { id: fresh.id })).canRemove).toBe(true);
    expect(await t.call('customers.remove', { id: fresh.id })).toEqual({ deleted: true });
    expect(t.app.db.value('SELECT COUNT(*) FROM customers WHERE id = ?', [fresh.id])).toBe(0);
    expect(t.app.db.value("SELECT COUNT(*) FROM activity_log WHERE action = 'customer.delete'")).toBe(1);

    const withOpening = await t.call('customers.create', { name: 'Opening', openingBalance: { amount: 100, direction: 'receivable' } });
    let err = await t.fails('customers.remove', { id: withOpening.id });
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/Deactivate the customer instead/);
    // Even after the opening balance is removed, the (void) history stays.
    await t.call('customers.update', { id: withOpening.id, name: 'Opening', openingBalance: null });
    expect((await t.fails('customers.remove', { id: withOpening.id })).code).toBe('CONFLICT');

    const billed = await t.call('customers.create', { name: 'Billed' });
    addBill(t, { customerId: billed.id, date: '2026-09-28', items: [{ name: 'Tea', qty: 1, rate: 1000 }], paid: 1000 });
    err = await t.fails('customers.remove', { id: billed.id });
    expect(err.code).toBe('CONFLICT');

    const d = await t.call('customers.setActive', { id: billed.id, active: false });
    expect(d.isActive).toBe(false);
    expect((await t.call('customers.search', { q: 'Billed' })).length).toBe(0);
    expect(t.app.db.value("SELECT COUNT(*) FROM activity_log WHERE action = 'customer.deactivate'")).toBe(1);
    await t.call('customers.setActive', { id: billed.id, active: true });
    expect((await t.call('customers.search', { q: 'Billed' })).length).toBe(1);
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('payments received', () => {
  it('records a payment with discount and posts it per the contract', async () => {
    const t = await createTestApp();
    const c = await t.call('customers.create', { name: 'Anita', phone: '98200 11111' });
    addBill(t, { customerId: c.id, date: '2026-09-10', items: [{ name: 'Rice', qty: 10, rate: 5000 }] });
    expect(bal(t, c.id)).toBe(50000);

    const r = await t.call('receipts.create', { customerId: c.id, amount: 49000, discount: 1000, mode: 'cash', reference: null, remarks: 'Full settlement' });
    expect(r.receiptNo).toBe('RCT/26-27/0001');
    expect(r.date).toBe('2026-09-28');
    expect(r.warnings).toEqual([]);
    expect(r).toMatchObject({ amount: 49000, discount: 1000, mode: 'cash', status: 'active', revision: 1, accountName: 'Cash in Hand' });
    expect(bal(t, c.id)).toBe(0);
    expect(systemBalance(t.app, 'CASH')).toBe(49000);
    expect(systemBalance(t.app, 'DISCOUNT_ALLOWED')).toBe(1000);
    expect(systemBalance(t.app, 'AR')).toBe(0);

    const entry = t.app.db.get<any>('SELECT * FROM journal_entries WHERE id = ?', [r.journalEntryId]);
    expect(entry).toMatchObject({ voucher_type: 'receipt', voucher_no: 'RCT/26-27/0001', source_type: 'receipt', source_id: r.id, is_void: 0 });

    const detail = await t.call('receipts.get', { id: r.id });
    expect(detail.balanceBefore).toBe(50000);
    expect(detail.balanceAfter).toBe(0);
    expect(detail.revisions).toHaveLength(1);
    expect(detail.revisions[0]).toMatchObject({ revision: 1, action: 'created', username: 'owner' });
    expect(detail.posting.map((p) => [p.account, p.debit, p.credit])).toEqual([
      ['Cash in Hand', 49000, 0],
      ['Discount Allowed', 1000, 0],
      ['Sundry Debtors', 0, 50000],
    ]);
    const log = t.app.db.get<any>("SELECT * FROM activity_log WHERE action = 'receipt.create'");
    expect(log.summary).toBe('Received ₹490.00 from Anita by Cash - RCT/26-27/0001 (discount ₹10.00)');

    const cust = await t.call('customers.get', { id: c.id });
    expect(cust.totals).toMatchObject({ receipts: 1, received: 49000, discount: 1000 });
    expect(cust.lastPaymentDate).toBe('2026-09-28');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('warns when a payment becomes an advance and validates amounts and accounts', async () => {
    const t = await createTestApp();
    const c = await t.call('customers.create', { name: 'Ravi', openingBalance: { amount: 30000, direction: 'receivable' } });
    const r = await t.call('receipts.create', { customerId: c.id, amount: 50000, mode: 'upi', reference: 'UPI123456' });
    expect(r.warnings[0]).toMatch(/₹200.00 more than the amount due/);
    expect(r.accountName).toBe('UPI Account');
    expect(bal(t, c.id)).toBe(-20000);
    const again = await t.call('receipts.create', { customerId: c.id, amount: 1000, mode: 'cash' });
    expect(again.warnings[0]).toMatch(/had nothing due/);

    let err = await t.fails('receipts.create', { customerId: c.id, amount: 0, mode: 'cash' });
    expect(err.message).toBe('Enter the amount received');
    err = await t.fails('receipts.create', { customerId: c.id, amount: 100, discount: 100, mode: 'cash' });
    expect(err.message).toMatch(/has nothing due, so a discount cannot be given/);
    const d = await t.call('customers.create', { name: 'Dev', openingBalance: { amount: 5000, direction: 'receivable' } });
    err = await t.fails('receipts.create', { customerId: d.id, amount: 1000, discount: 4500, mode: 'cash' });
    expect(err.message).toMatch(/cannot be more than the amount still due after this payment \(₹40.00\)/);
    const ok = await t.call('receipts.create', { customerId: d.id, amount: 1000, discount: 4000, mode: 'cash' });
    expect(ok.warnings).toEqual([]);
    expect(bal(t, d.id)).toBe(0);
    await t.call('receipts.cancel', { id: ok.id, reason: 'test' });
    err = await t.fails('receipts.create', { customerId: d.id, amount: -1, mode: 'cash' });
    expect(err.code).toBe('VALIDATION');
    err = await t.fails('receipts.create', { amount: 1000, mode: 'cash' });
    expect(err.message).toMatch(/Choose a customer/);
    err = await t.fails('receipts.create', { customerId: 999, amount: 1000, mode: 'cash' });
    expect(err.code).toBe('NOT_FOUND');

    // Explicit accounts must match the mode.
    const bank = t.app.db.value<number>("SELECT id FROM accounts WHERE system_key = 'BANK'");
    err = await t.fails('receipts.create', { customerId: d.id, amount: 1000, mode: 'cash', accountId: bank });
    expect(err.message).toMatch(/must go to a cash account/);
    const sales = t.app.db.value<number>("SELECT id FROM accounts WHERE system_key = 'SALES'");
    err = await t.fails('receipts.create', { customerId: d.id, amount: 1000, mode: 'bank', accountId: sales });
    expect(err.message).toMatch(/is not a cash or bank account/);
    const viaBank = await t.call('receipts.create', { customerId: d.id, amount: 1000, mode: 'upi', accountId: bank, reference: 'X1' });
    expect(viaBank.accountName).toBe('Bank Account');
    expect(systemBalance(t.app, 'BANK')).toBe(1000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('edits and cancels payments with a full audit trail', async () => {
    const t = await createTestApp();
    const a = await t.call('customers.create', { name: 'Anita', openingBalance: { amount: 100000, direction: 'receivable' } });
    const b = await t.call('customers.create', { name: 'Bala', openingBalance: { amount: 40000, direction: 'receivable' } });
    const r = await t.call('receipts.create', { customerId: a.id, amount: 30000, mode: 'cash' });

    const e = await t.call('receipts.update', {
      id: r.id,
      customerId: a.id,
      amount: 25000,
      discount: 500,
      mode: 'upi',
      reference: 'T-99',
      reason: 'Typed the wrong amount',
    });
    expect(e.revision).toBe(2);
    expect(e.receiptNo).toBe(r.receiptNo);
    expect(e.journalEntryId).toBe(r.journalEntryId);
    expect(bal(t, a.id)).toBe(100000 - 25500);
    expect(systemBalance(t.app, 'CASH')).toBe(0);
    expect(systemBalance(t.app, 'UPI')).toBe(25000);
    expect(systemBalance(t.app, 'DISCOUNT_ALLOWED')).toBe(500);

    // Move the payment to the other customer.
    await t.call('receipts.update', { id: r.id, customerId: b.id, amount: 25000, mode: 'upi', reference: 'T-99' });
    expect(bal(t, a.id)).toBe(100000);
    expect(bal(t, b.id)).toBe(15000);

    const cancelled = await t.call('receipts.cancel', { id: r.id, reason: 'Cheque bounced' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('Cheque bounced');
    expect(cancelled.receiptNo).toBe(r.receiptNo);
    expect(bal(t, b.id)).toBe(40000);
    expect(systemBalance(t.app, 'UPI')).toBe(0);
    expect(t.app.db.value('SELECT is_void FROM journal_entries WHERE id = ?', [r.journalEntryId])).toBe(1);

    const revs = t.app.db.all<any>("SELECT revision, action, reason FROM document_revisions WHERE doc_type = 'receipt' AND doc_id = ? ORDER BY revision", [r.id]);
    expect(revs).toEqual([
      { revision: 1, action: 'created', reason: null },
      { revision: 2, action: 'edited', reason: 'Typed the wrong amount' },
      { revision: 3, action: 'edited', reason: null },
      { revision: 4, action: 'cancelled', reason: 'Cheque bounced' },
    ]);
    const snap = JSON.parse(t.app.db.value<string>("SELECT snapshot FROM document_revisions WHERE doc_type = 'receipt' AND revision = 2"));
    expect(snap).toMatchObject({ amount: 25000, discount: 500, mode: 'upi' });
    const acts = t.app.db.all<any>("SELECT action, summary FROM activity_log WHERE entity_type = 'receipt' ORDER BY id").map((x) => x.action);
    expect(acts).toEqual(['receipt.create', 'receipt.update', 'receipt.update', 'receipt.cancel']);
    const upd = t.app.db.value<string>("SELECT summary FROM activity_log WHERE action = 'receipt.update' ORDER BY id LIMIT 1");
    expect(upd).toContain('amount ₹300.00 → ₹250.00');
    expect(upd).toContain('reason: Typed the wrong amount');

    expect((await t.fails('receipts.cancel', { id: r.id, reason: 'again' })).message).toMatch(/already cancelled/);
    expect((await t.fails('receipts.update', { id: r.id, customerId: b.id, amount: 100, mode: 'cash' })).message).toMatch(/cancelled and cannot be edited/);
    expect((await t.fails('receipts.cancel', { id: r.id, reason: '  ' })).code).toBe('VALIDATION');

    // Cancelled payments stay in the list but not in the totals.
    const list = await t.call('receipts.list', {});
    expect(list.rows).toHaveLength(1);
    expect(list.totals).toMatchObject({ count: 0, amount: 0, cancelled: 1 });
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('enforces dates: past dates need permission, no future dates, no moving across years', async () => {
    const t = await createTestApp();
    const c = await t.call('customers.create', { name: 'Anita', openingBalance: { amount: 100000, direction: 'receivable' } });
    const past = await t.call('receipts.create', { customerId: c.id, date: '2026-09-01', amount: 1000, mode: 'cash' });
    expect(past.date).toBe('2026-09-01');
    let err = await t.fails('receipts.create', { customerId: c.id, date: '2026-09-29', amount: 1000, mode: 'cash' });
    expect(err.message).toMatch(/cannot be dated later than today \(28-09-2026\)/);
    err = await t.fails('receipts.create', { customerId: c.id, date: '2026-03-31', amount: 1000, mode: 'cash' });
    expect(err.message).toMatch(/before your books start/);

    await t.loginAs('cashier');
    const today = await t.call('receipts.create', { customerId: c.id, amount: 1000, mode: 'cash' });
    expect(today.date).toBe('2026-09-28');
    err = await t.fails('receipts.create', { customerId: c.id, date: '2026-09-27', amount: 1000, mode: 'cash' });
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toMatch(/only use today's date/);

    await t.loginOwner();
    t.setToday('2027-04-05');
    err = await t.fails('receipts.update', { id: past.id, customerId: c.id, date: '2027-04-02', amount: 1000, mode: 'cash' });
    expect(err.message).toMatch(/belongs to financial year 2026-27/);
    const next = await t.call('receipts.create', { customerId: c.id, amount: 500, mode: 'cash' });
    expect(next.receiptNo).toBe('RCT/27-28/0001');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('lets a cashier receive payments but not change or cancel them', async () => {
    const t = await createTestApp();
    const c = await t.call('customers.create', { name: 'Anita', openingBalance: { amount: 100000, direction: 'receivable' } });
    await t.loginAs('cashier');
    const r = await t.call('receipts.create', { customerId: c.id, amount: 1000, mode: 'cash' });
    expect(r.createdBy).toBe('Test cashier');
    let err = await t.fails('receipts.update', { id: r.id, customerId: c.id, amount: 2000, mode: 'cash' });
    expect(err.code).toBe('FORBIDDEN');
    err = await t.fails('receipts.cancel', { id: r.id, reason: 'oops' });
    expect(err.code).toBe('FORBIDDEN');
    expect((await t.call('receipts.list', {})).rows).toHaveLength(1);
    expect((await t.call('customers.statement', { customerId: c.id, from: '2026-04-01', to: '2026-09-28' })).rows.length).toBeGreaterThan(0);
    // Suppliers and purchases are not for cashiers.
    expect((await t.fails('suppliers.list', {})).code).toBe('FORBIDDEN');
    expect((await t.fails('purchases.list', {})).code).toBe('FORBIDDEN');

    await t.loginAs('manager');
    const e = await t.call('receipts.update', { id: r.id, customerId: c.id, amount: 2000, mode: 'cash', reason: 'Correction' });
    expect(e.updatedBy).toBe('Test manager');
    await t.call('receipts.cancel', { id: r.id, reason: 'Duplicate entry' });

    // Without the permission the owner can take away, customer management is refused.
    t.app.db.run("DELETE FROM role_permissions WHERE role = 'cashier' AND permission IN ('customers.manage', 'customers.receive')");
    await t.loginAs('cashier');
    expect((await t.fails('customers.create', { name: 'New' })).code).toBe('FORBIDDEN');
    expect((await t.fails('receipts.create', { customerId: c.id, amount: 100, mode: 'cash' })).code).toBe('FORBIDDEN');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('refuses changes to payments in a closed financial year', async () => {
    const t = await createTestApp({ booksStart: '2025-04-01' });
    const c = await t.call('customers.create', { name: 'Anita', openingBalance: { amount: 100000, direction: 'receivable' } });
    const r = await t.call('receipts.create', { customerId: c.id, date: '2026-02-10', amount: 1000, mode: 'cash' });
    t.app.db.run("UPDATE financial_years SET is_closed = 1 WHERE name = '2025-26'");
    expect((await t.fails('receipts.cancel', { id: r.id, reason: 'late' })).code).toBe('PERIOD_CLOSED');
    expect((await t.fails('receipts.update', { id: r.id, customerId: c.id, amount: 500, mode: 'cash' })).code).toBe('PERIOD_CLOSED');
    expect((await t.call('receipts.get', { id: r.id })).status).toBe('active');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('lists and filters payments with totals by mode', async () => {
    const t = await createTestApp();
    const a = await t.call('customers.create', { name: 'Anita', phone: '98200 11111', openingBalance: { amount: 100000, direction: 'receivable' } });
    const b = await t.call('customers.create', { name: 'Bala', openingBalance: { amount: 100000, direction: 'receivable' } });
    await t.call('receipts.create', { customerId: a.id, date: '2026-09-01', amount: 1000, mode: 'cash' });
    await t.call('receipts.create', { customerId: a.id, date: '2026-09-15', amount: 2000, discount: 100, mode: 'upi', reference: 'GPAY-777' });
    await t.call('receipts.create', { customerId: b.id, date: '2026-09-20', amount: 4000, mode: 'bank', reference: 'CHQ 000123' });

    let list = await t.call('receipts.list', { from: '2026-09-01', to: '2026-09-30' });
    expect(list.rows.map((r) => r.amount)).toEqual([4000, 2000, 1000]);
    expect(list.totals).toEqual({ count: 3, amount: 7000, discount: 100, byMode: { cash: 1000, upi: 2000, bank: 4000 }, cancelled: 0 });
    list = await t.call('receipts.list', { customerId: a.id });
    expect(list.rows).toHaveLength(2);
    list = await t.call('receipts.list', { mode: 'bank' });
    expect(list.rows.map((r) => r.customerName)).toEqual(['Bala']);
    list = await t.call('receipts.list', { q: 'GPAY' });
    expect(list.rows).toHaveLength(1);
    list = await t.call('receipts.list', { q: '11111' });
    expect(list.rows).toHaveLength(2);
    list = await t.call('receipts.list', { from: '2026-09-10', to: '2026-09-16' });
    expect(list.rows).toHaveLength(1);
  });

  it('prints a thermal payment receipt and marks reprints as duplicate', async () => {
    const t = await createTestApp();
    const c = await t.call('customers.create', { name: 'Anita <Desai>', phone: '98200 11111', openingBalance: { amount: 150000, direction: 'receivable' } });
    const r = await t.call('receipts.create', { customerId: c.id, amount: 123450, discount: 50, mode: 'upi', reference: 'UPI-42', remarks: 'Thanks' });
    const { html } = await t.call('receipts.receiptHtml', { id: r.id });
    expect(html).toContain('PAYMENT RECEIPT');
    expect(html).toContain('RCT/26-27/0001');
    expect(html).toContain('Anita &lt;Desai&gt;');
    expect(html).toContain('₹1,234.50');
    expect(html).toContain('Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only');
    expect(html).toContain('Previous balance: ₹1,500.00 Dr');
    expect(html).toContain('Balance now: ₹265.00 due');
    expect(html).toContain('UPI · Ref UPI-42');
    expect(html).toContain('Sharma General Store');
    expect(html).not.toContain('DUPLICATE');

    expect(await t.call('receipts.print', { id: r.id })).toEqual({ printed: true });
    expect(t.platform.printed).toHaveLength(1);
    expect(t.platform.printed[0].opts).toMatchObject({ paperWidthMm: 80, copies: 1, silent: false });
    await t.call('receipts.print', { id: r.id });
    expect(t.platform.printed[1].html).toContain('DUPLICATE');
    expect((await t.call('receipts.get', { id: r.id })).printCount).toBe(2);
    expect(t.app.db.value("SELECT COUNT(*) FROM activity_log WHERE action = 'receipt.print'")).toBe(2);

    await t.call('receipts.cancel', { id: r.id, reason: 'Wrong customer' });
    const cancelled = (await t.call('receipts.receiptHtml', { id: r.id })).html;
    expect(cancelled).toContain('CANCELLED');
    expect(cancelled).not.toContain('Balance now');
  });
});

describe('statements and outstanding', () => {
  it('builds a statement with opening, running balance and closing equal to the ledger', async () => {
    const t = await createTestApp();
    const c = await t.call('customers.create', { name: 'Anita', phone: '98200 11111', openingBalance: { amount: 20000, direction: 'receivable' } });
    const b1 = addBill(t, { customerId: c.id, date: '2026-05-10', items: [{ name: 'Rice', qty: 5, rate: 6000 }, { name: 'Dal', qty: 2, rate: 12000 }] });
    await t.call('receipts.create', { customerId: c.id, date: '2026-06-01', amount: 25000, mode: 'cash' });
    addBill(t, { customerId: c.id, date: '2026-07-15', items: [{ name: 'Oil', qty: 1, rate: 18000 }], paid: 8000 });
    const r2 = await t.call('receipts.create', { customerId: c.id, date: '2026-08-01', amount: 10000, discount: 500, mode: 'upi', reference: 'U-1' });
    const cancelled = await t.call('receipts.create', { customerId: c.id, date: '2026-08-05', amount: 5000, mode: 'cash' });
    await t.call('receipts.cancel', { id: cancelled.id, reason: 'Entered twice' });

    // Whole year: opening row is zero, the opening entry itself shows as a line.
    const full = await t.call('customers.statement', { customerId: c.id, from: '2026-04-01', to: '2026-09-28' });
    expect(full.title).toBe('Statement of account - Anita');
    expect(full.subtitle).toBe('01-04-2026 to 28-09-2026');
    expect(full.notes?.[0]).toBe('Customer: Anita, Ph: 98200 11111');
    const body = full.rows.slice(1, -1);
    expect(body.map((r) => r.cells.type)).toEqual(['Opening balance', 'Sales bill', 'Payment received', 'Sales bill', 'Payment received']);
    expect(body.map((r) => r.cells.balance)).toEqual([20000, 74000, 49000, 59000, 48500]);
    expect(body[1].cells).toMatchObject({ number: b1.billNo, particulars: 'Rice 5, Dal 2', debit: 54000, credit: null });
    expect(body[1].link).toEqual({ kind: 'bill', id: b1.id });
    expect(body[3].cells.particulars).toBe('Oil 1 (bill ₹180.00, paid ₹80.00)');
    expect(body[4].cells).toMatchObject({ particulars: 'UPI · Ref U-1 · incl. discount ₹5.00', credit: 10500 });
    expect(body[4].link).toEqual({ kind: 'receipt', id: r2.id });
    const closing = full.rows[full.rows.length - 1];
    expect(closing.style).toBe('total');
    expect(closing.cells.balance).toBe(bal(t, c.id));
    expect(closing.cells).toMatchObject({ debit: 84000, credit: 35500 });
    expect(full.summary?.find((s) => s.label === 'Status')?.value).toBe('Customer owes you ₹485.00');

    // A later period starts from the balance carried forward.
    const part = await t.call('customers.statement', { customerId: c.id, from: '2026-07-01', to: '2026-07-31' });
    expect(part.rows[0].cells).toMatchObject({ particulars: 'Balance brought forward', balance: 49000 });
    expect(part.rows).toHaveLength(3);
    expect(part.rows[2].cells.balance).toBe(59000);

    expect((await t.fails('customers.statement', { customerId: c.id, from: '2026-09-01', to: '2026-08-01' })).code).toBe('VALIDATION');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('reports outstanding dues and advances as on a date', async () => {
    const t = await createTestApp();
    const a = await t.call('customers.create', { name: 'Anita', phone: '98200 11111' });
    const b = await t.call('customers.create', { name: 'Bala' });
    const c = await t.call('customers.create', { name: 'Chitra' });
    await t.call('customers.create', { name: 'Zero' });
    addBill(t, { customerId: a.id, date: '2026-08-01', items: [{ name: 'Rice', qty: 10, rate: 5000 }] });
    await t.call('receipts.create', { customerId: a.id, date: '2026-09-08', amount: 10000, mode: 'cash' });
    addBill(t, { customerId: b.id, date: '2026-09-20', items: [{ name: 'Tea', qty: 3, rate: 2500 }] });
    await t.call('receipts.create', { customerId: c.id, date: '2026-09-01', amount: 3000, mode: 'cash' });

    const rep = await t.call('customers.outstanding', { asOf: '2026-09-28' });
    expect(rep.subtitle).toBe('As on 28-09-2026');
    expect(rep.rows.map((r) => r.cells.name)).toEqual(['Anita', 'Bala', 'Chitra', 'Total (3 customers)']);
    expect(rep.rows[0].cells).toMatchObject({ phone: '98200 11111', due: 40000, advance: null, lastPayment: '2026-09-08', days: 20 });
    expect(rep.rows[1].cells).toMatchObject({ due: 7500, lastPayment: null, days: null, lastBill: '2026-09-20' });
    expect(rep.rows[2].cells).toMatchObject({ due: null, advance: 3000 });
    expect(rep.rows[3].cells).toMatchObject({ due: 47500, advance: 3000 });
    expect(rep.rows[0].link).toEqual({ kind: 'customer', id: a.id });
    expect(rep.summary?.map((s) => s.value)).toEqual([2, 47500, 3000, 44500]);

    const earlier = await t.call('customers.outstanding', { asOf: '2026-08-31' });
    expect(earlier.rows.map((r) => r.cells.name)).toEqual(['Anita', 'Total (1 customers)']);
    expect(earlier.rows[0].cells.due).toBe(50000);
  });
});
