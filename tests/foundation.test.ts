import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance } from './helpers';
import { postEntry, replaceEntry, voidEntry, partyBalance } from '../src/core/accounting/ledger';
import { nextDocNumber } from '../src/core/numbering';
import { amountInWords, formatINR, lineAmount, parseMoney, roundOffAdjustment, formatQty } from '../src/shared/money';
import { fyOf, presetRange, formatDate } from '../src/shared/dates';
import { reportToCsv } from '../src/core/export/csv';
import { reportToXlsx } from '../src/core/export/xlsx';
import { renderReceiptHtml } from '../src/core/print/receipt';
import { defaultSettings } from '../src/shared/settings';

describe('money & dates', () => {
  it('formats rupees the Indian way', () => {
    expect(formatINR(12345650)).toBe('₹1,23,456.50');
    expect(formatINR(1234567890)).toBe('₹1,23,45,678.90');
    expect(formatINR(-50000)).toBe('-₹500.00');
    expect(formatINR(99)).toBe('₹0.99');
    expect(formatINR(0)).toBe('₹0.00');
  });
  it('parses user input', () => {
    expect(parseMoney('₹1,23,456.50')).toBe(12345650);
    expect(parseMoney('10.005')).toBe(1001);
    expect(parseMoney('1.5k')).toBe(150000);
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('')).toBeNull();
  });
  it('computes line amounts and round off exactly', () => {
    expect(lineAmount(1.5, 4550)).toBe(6825);
    expect(lineAmount(0.1, 4500)).toBe(450);
    expect(lineAmount(3, 3333)).toBe(9999);
    expect(roundOffAdjustment(12345)).toBe(-45);
    expect(roundOffAdjustment(12350)).toBe(50);
    expect(formatQty(2.5)).toBe('2.5');
    expect(formatQty(1000)).toBe('1,000');
  });
  it('writes amounts in words (lakh / crore)', () => {
    expect(amountInWords(12345650)).toBe('Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only');
    expect(amountInWords(100)).toBe('Rupees One Only');
  });
  it('knows the Indian financial year', () => {
    expect(fyOf('2026-09-28')).toMatchObject({ name: '2026-27', start: '2026-04-01', end: '2027-03-31', short: '26-27' });
    expect(fyOf('2027-03-31').name).toBe('2026-27');
    expect(fyOf('2027-04-01').name).toBe('2027-28');
    expect(presetRange('this_fy', '2026-09-28')).toEqual({ from: '2026-04-01', to: '2026-09-28' });
    expect(presetRange('last_fy', '2026-09-28')).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(presetRange('this_quarter', '2026-09-28')).toEqual({ from: '2026-07-01', to: '2026-09-28' });
    expect(presetRange('this_quarter', '2027-02-10')).toEqual({ from: '2027-01-01', to: '2027-02-10' });
    expect(formatDate('2026-09-28')).toBe('28-09-2026');
  });
});

describe('setup & login', () => {
  it('sets up the business and logs the owner in', async () => {
    const t = await createTestApp({ openingCash: 1000000 });
    const status = await t.call('app.status');
    expect(status.setupDone).toBe(true);
    expect(status.businessName).toBe('Sharma General Store');
    expect(status.session?.role).toBe('owner');
    expect(systemBalance(t.app, 'CASH')).toBe(1000000);
    expect(systemBalance(t.app, 'OPENING_EQUITY')).toBe(-1000000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('rejects wrong passwords and locks after 5 attempts', async () => {
    const t = await createTestApp();
    await t.call('auth.logout');
    for (let i = 0; i < 4; i++) expect((await t.fails('auth.login', { username: 'owner', password: 'x' })).message).toMatch(/Wrong/);
    expect((await t.fails('auth.login', { username: 'owner', password: 'x' })).message).toMatch(/wait/);
    expect((await t.fails('auth.login', { username: 'owner', password: 'owner-pass' })).message).toMatch(/wait/);
    const failed = t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action = 'user.login_failed'");
    expect(failed).toBe(5);
  });

  it('protects routes by login and permission', async () => {
    const t = await createTestApp();
    await t.call('auth.logout');
    expect((await t.fails('auth.changePassword', { currentPassword: 'a', newPassword: 'bbbb' })).code).toBe('UNAUTHENTICATED');
    await t.loginAs('cashier');
    const me = await t.call('auth.me');
    expect(me?.role).toBe('cashier');
    expect(me?.permissions).toContain('billing.create');
    expect(me?.permissions).not.toContain('reports.financial');
  });

  it('recovers the owner password with the recovery code', async () => {
    const t = await createTestApp();
    const users = t.app.db.all('SELECT * FROM users');
    expect(users).toHaveLength(1);
    await t.call('auth.logout');
    expect((await t.fails('auth.recover', { recoveryCode: 'AAAA-BBBB-CCCC-DDDD', newPassword: 'newpass' })).code).toBe('VALIDATION');
  });
});

describe('ledger engine', () => {
  it('posts balanced entries and rejects unbalanced ones', async () => {
    const t = await createTestApp();
    const ctx = t.app.ctx();
    const id = postEntry(ctx, {
      date: '2026-09-28',
      voucherType: 'capital',
      narration: 'Capital introduced',
      lines: [
        { account: 'CASH', debit: 50000 },
        { account: 'CAPITAL', credit: 50000 },
      ],
    });
    expect(id).toBeGreaterThan(0);
    expect(() =>
      postEntry(ctx, { date: '2026-09-28', voucherType: 'journal', lines: [{ account: 'CASH', debit: 100 }, { account: 'CAPITAL', credit: 99 }] }),
    ).toThrow(/must be equal/);
    expect(() =>
      postEntry(ctx, { date: '2026-09-28', voucherType: 'journal', lines: [{ account: 'AR', debit: 100 }, { account: 'SALES', credit: 100 }] }),
    ).toThrow(/Choose a customer/);
    expect(() =>
      postEntry(ctx, { date: '2026-03-31', voucherType: 'journal', lines: [{ account: 'CASH', debit: 100 }, { account: 'CAPITAL', credit: 100 }] }),
    ).toThrow(/before your books start/);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('replaces and voids entries; void entries do not count', async () => {
    const t = await createTestApp();
    const ctx = t.app.ctx();
    const cust = t.app.db.insert('customers', { name: 'Anita', created_at: '2026-09-28 10:00:00' });
    const id = postEntry(ctx, {
      date: '2026-09-28',
      voucherType: 'sale',
      lines: [
        { account: 'AR', debit: 1000, partyType: 'customer', partyId: cust },
        { account: 'SALES', credit: 1000 },
      ],
    });
    expect(partyBalance(ctx, 'customer', cust)).toBe(1000);
    replaceEntry(ctx, id, {
      date: '2026-09-28',
      voucherType: 'sale',
      lines: [
        { account: 'AR', debit: 1500, partyType: 'customer', partyId: cust },
        { account: 'SALES', credit: 1500 },
      ],
    });
    expect(partyBalance(ctx, 'customer', cust)).toBe(1500);
    voidEntry(ctx, id, 'cancelled');
    expect(partyBalance(ctx, 'customer', cust)).toBe(0);
    expect(systemBalance(t.app, 'SALES')).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('refuses entries in a closed financial year', async () => {
    const t = await createTestApp({ booksStart: '2025-04-01' });
    const ctx = t.app.ctx();
    postEntry(ctx, { date: '2025-06-01', voucherType: 'capital', lines: [{ account: 'CASH', debit: 100 }, { account: 'CAPITAL', credit: 100 }] });
    t.app.db.run("UPDATE financial_years SET is_closed = 1 WHERE name = '2025-26'");
    expect(() =>
      postEntry(ctx, { date: '2025-06-02', voucherType: 'capital', lines: [{ account: 'CASH', debit: 100 }, { account: 'CAPITAL', credit: 100 }] }),
    ).toThrow(/2025-26 is closed/);
  });

  it('numbers documents per financial year', async () => {
    const t = await createTestApp({ booksStart: '2026-04-01' });
    const ctx = t.app.ctx();
    expect(nextDocNumber(ctx, 'bill', '2026-09-28').number).toBe('INV/26-27/0001');
    expect(nextDocNumber(ctx, 'bill', '2026-09-28').number).toBe('INV/26-27/0002');
    expect(nextDocNumber(ctx, 'bill', '2027-04-01').number).toBe('INV/27-28/0001');
  });

  it('rolls back everything when a mutation fails', async () => {
    const t = await createTestApp();
    const before = t.app.db.value<number>('SELECT COUNT(*) FROM journal_entries');
    expect(() =>
      t.app.db.tx(() => {
        postEntry(t.app.ctx(), { date: '2026-09-28', voucherType: 'capital', lines: [{ account: 'CASH', debit: 100 }, { account: 'CAPITAL', credit: 100 }] });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM journal_entries')).toBe(before);
  });
});

describe('exports & receipts', () => {
  const report = {
    title: 'Test Report',
    subtitle: '01-04-2026 to 28-09-2026',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'amt', label: 'Amount', type: 'money' as const },
      { key: 'bal', label: 'Balance', type: 'drcr' as const },
    ],
    rows: [
      { cells: { name: 'Sugar, 1 kg', amt: 12345650, bal: -500 } },
      { cells: { name: 'Total', amt: 12345650, bal: -500 }, style: 'total' as const },
    ],
  };
  it('exports CSV with BOM and plain numbers', () => {
    const csv = reportToCsv(report);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('"Sugar, 1 kg",123456.50,5.00 Cr');
  });
  it('exports a real xlsx file', async () => {
    const buf = await reportToXlsx(report, 'Sharma General Store');
    expect(buf[0]).toBe(0x50); // "PK" zip signature
    expect(buf[1]).toBe(0x4b);
  });
  it('renders an 80mm receipt with QR', () => {
    const s = defaultSettings('2026-09-28');
    const html = renderReceiptHtml(
      {
        title: 'BILL',
        meta: [['Bill No', 'INV/26-27/0001']],
        items: [{ name: 'Tea <special>', qty: '2', rate: '15.00', amount: '30.00' }],
        totals: [{ label: 'TOTAL', value: '₹30.00', big: true }],
        qr: { data: 'upi://pay?pa=shop@upi&am=30.00', caption: 'Scan to pay' },
      },
      { ...s.business, name: 'Sharma General Store' },
      s.receipt,
    );
    expect(html).toContain('size: 80mm auto');
    expect(html).toContain('Tea &lt;special&gt;');
    expect(html).toContain('<svg');
  });
});

describe('backups', () => {
  it('creates a compressed backup that can be extracted and opened', async () => {
    const { createBackup, extractBackup } = await import('../src/core/modules/data/backup');
    const { BillforceApp } = await import('../src/core/app');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const t = await createTestApp({ openingCash: 12345 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-backup-'));
    const ctx = t.app.ctx();
    const info = createBackup(ctx, 'manual', { targetPath: path.join(dir, 'test.bfbackup') });
    expect(info.sizeBytes).toBeGreaterThan(100);
    const raw = extractBackup(info.path, dir);
    const db = BillforceApp.openDatabase(raw, new Date());
    expect(db.value<number>('SELECT COUNT(*) FROM users')).toBe(1);
    db.close();
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM backup_history')).toBe(1);
    expect(() => t.app.db.tx(() => createBackup(t.app.ctx(), 'manual', { targetPath: path.join(dir, 'x.bfbackup') }))).toThrow(/transaction/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('negative balance warning', () => {
  it('warns when a payment takes cash below zero', async () => {
    const { negativeBalanceWarning, systemAccountId } = await import('../src/core/accounting/ledger');
    const t = await createTestApp({ openingCash: 50000 });
    const ctx = t.app.ctx();
    const cash = systemAccountId(ctx, 'CASH');
    expect(negativeBalanceWarning(ctx, cash, 40000, '2026-09-28')).toBeNull();
    expect(negativeBalanceWarning(ctx, cash, 60000, '2026-09-28')).toMatch(/short by ₹100\.00/);
    expect(negativeBalanceWarning(ctx, systemAccountId(ctx, 'SALES'), 60000, '2026-09-28')).toBeNull();
  });
});
