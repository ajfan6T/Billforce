import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems } from './helpers';
import { nextDocNumber } from '../src/core/numbering';
import { DEFAULT_ROLE_PERMISSIONS } from '../src/shared/permissions';

describe('settings', () => {
  it('returns all settings with defaults to any logged-in user', async () => {
    const t = await createTestApp();
    await t.loginAs('cashier');
    const s = await t.call('settings.get');
    expect(s.business.name).toBe('Sharma General Store');
    expect(s.receipt).toMatchObject({ paperWidth: 80, copies: 1, footer: 'Thank you! Visit again.' });
    expect(s.billing.prefixes.bill).toBe('INV');
    await t.call('auth.logout');
    expect((await t.fails('settings.get')).code).toBe('UNAUTHENTICATED');
  });

  it('merges partial business updates and logs before / after', async () => {
    const t = await createTestApp();
    const res = await t.call('settings.update', { section: 'business', values: { phone: '020 2345 6789 / 98200 12345', upiId: 'sharmastore@okaxis' } });
    expect(res.changed.sort()).toEqual(['phone', 'upiId']);
    const s = await t.call('settings.get');
    expect(s.business).toMatchObject({ name: 'Sharma General Store', address: '12 MG Road, Pune 411001', phone: '020 2345 6789 / 98200 12345', upiId: 'sharmastore@okaxis' });
    const log = t.app.db.get<{ summary: string; details: string; entity_type: string }>("SELECT summary, details, entity_type FROM activity_log WHERE action = 'settings.update'");
    expect(log?.summary).toBe('Changed business settings: phone "98200 12345" → "020 2345 6789 / 98200 12345", UPI ID blank → "sharmastore@okaxis"');
    expect(JSON.parse(log!.details)).toEqual({
      section: 'business',
      before: { phone: '98200 12345', upiId: '' },
      after: { phone: '020 2345 6789 / 98200 12345', upiId: 'sharmastore@okaxis' },
    });
    // The top bar shows the new name immediately.
    await t.call('settings.update', { section: 'business', values: { name: '  Sharma Stores ' } });
    expect((await t.call('app.status')).businessName).toBe('Sharma Stores');
    // Saving the same values again changes nothing and logs nothing.
    const again = await t.call('settings.update', { section: 'business', values: { name: 'Sharma Stores' } });
    expect(again.changed).toEqual([]);
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action = 'settings.update'")).toBe(2);
  });

  it('validates each section with clear messages', async () => {
    const t = await createTestApp();
    const cases: Array<[string, Record<string, unknown>, RegExp, string]> = [
      ['business', { name: '   ' }, /Enter the business name/, 'name'],
      ['business', { email: 'not-an-email' }, /valid email/, 'email'],
      ['business', { upiId: 'shop at bank' }, /valid UPI ID/, 'upiId'],
      ['business', { phone: 'call me' }, /Phone can contain only/, 'phone'],
      ['receipt', { header: 'x'.repeat(501) }, /at most 500 characters/, 'header'],
      ['receipt', { paperWidth: 70 }, /80 mm or 58 mm/, 'paperWidth'],
      ['receipt', { copies: 6 }, /At most 5/, 'copies'],
      ['receipt', { copies: 0 }, /at least 1/, 'copies'],
      ['receipt', { upiQr: 'sometimes' }, /when to print the UPI QR/, 'upiQr'],
      ['billing', { prefixes: { bill: 'IN V' } }, /1 to 8 letters or digits/, 'prefixes.bill'],
      ['billing', { prefixes: { bill: 'TOOLONGPREFIX' } }, /1 to 8 letters/, 'prefixes.bill'],
      ['billing', { defaultPaymentMode: 'cheque' }, /Cash, UPI, Bank or Credit/, 'defaultPaymentMode'],
      ['security', { autoLockMinutes: 300 }, /At most 240/, 'autoLockMinutes'],
      ['security', { autoLockMinutes: -1 }, /negative/, 'autoLockMinutes'],
      ['backup', { keepCount: 2 }, /at least 3/, 'keepCount'],
      ['backup', { keepCount: 400 }, /At most 365/, 'keepCount'],
      ['backup', { lastBackupAt: '2026-01-01 00:00:00' }, /Unknown setting/, '_'],
    ];
    for (const [section, values, msg, field] of cases) {
      const err = await t.fails('settings.update', { section, values });
      expect(err.code, `${section} ${JSON.stringify(values)}`).toBe('VALIDATION');
      expect(err.message, `${section} ${JSON.stringify(values)}`).toMatch(msg);
      expect(Object.keys(err.fields ?? {}), `${section} ${JSON.stringify(values)}`).toContain(field);
    }
    expect((await t.fails('settings.update', { section: 'accounts', values: { booksStartDate: '2026-01-01' } })).message).toMatch(/changed in Accounts/);
    expect((await t.fails('settings.update', { section: 'secret', values: {} })).message).toMatch(/Unknown settings section/);
    // Nothing was saved by the failed attempts.
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action = 'settings.update'")).toBe(0);
  });

  it('saves receipt settings including multi-line header and footer', async () => {
    const t = await createTestApp();
    await t.call('settings.update', {
      section: 'receipt',
      values: { header: 'Open 8 am - 10 pm\r\nHome delivery: 98200 12345  \n', footer: 'Thank you!\nGoods once sold will not be taken back', paperWidth: 58, copies: 2, printerName: 'POS-80', upiQr: 'unpaid' },
    });
    const r = (await t.call('settings.get')).receipt;
    expect(r).toMatchObject({ header: 'Open 8 am - 10 pm\nHome delivery: 98200 12345', paperWidth: 58, copies: 2, printerName: 'POS-80', upiQr: 'unpaid', autoPrint: true });
  });

  it('keeps document number prefixes valid and unique across series', async () => {
    const t = await createTestApp();
    await t.call('settings.update', { section: 'billing', values: { prefixes: { bill: 'bl' }, roundOff: false } });
    const s = (await t.call('settings.get')).billing;
    expect(s.prefixes).toMatchObject({ bill: 'BL', credit_note: 'CN', receipt: 'RCT' });
    expect(s.roundOff).toBe(false);
    expect(nextDocNumber(t.app.ctx(), 'bill', '2026-09-28').number).toBe('BL/26-27/0001');
    const err = await t.fails('settings.update', { section: 'billing', values: { prefixes: { receipt: 'BL' } } });
    expect(err.message).toMatch(/Each document series needs its own prefix/);
    expect(err.fields).toHaveProperty('prefixes.receipt');
    const log = t.app.db.value<string>("SELECT summary FROM activity_log WHERE action = 'settings.update'");
    expect(log).toBe('Changed billing settings: round off on → off, sales bills prefix INV → BL');
    // The settings screen sends the whole prefixes object.
    const full = { ...(await t.call('settings.get')).billing.prefixes, receipt: 'PR' };
    expect((await t.call('settings.update', { section: 'billing', values: { prefixes: full } })).changed).toEqual(['prefixes']);
    expect((await t.call('settings.get')).billing.prefixes).toEqual(full);
    // Sending unchanged prefixes (whole or partial) is not a change.
    expect((await t.call('settings.update', { section: 'billing', values: { prefixes: full } })).changed).toEqual([]);
    expect((await t.call('settings.update', { section: 'billing', values: { prefixes: { bill: 'BL' } } })).changed).toEqual([]);
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action = 'settings.update'")).toBe(2);
  });

  it('applies security settings to the app status', async () => {
    const t = await createTestApp();
    await t.call('settings.update', { section: 'security', values: { autoLockMinutes: 15 } });
    expect((await t.call('app.status')).autoLockMinutes).toBe(15);
  });

  it('checks permissions: settings.manage for most sections, data.backup is enough for backup options', async () => {
    const t = await createTestApp();
    await t.loginAs('cashier');
    expect((await t.fails('settings.update', { section: 'business', values: { name: 'X' } })).code).toBe('FORBIDDEN');
    expect((await t.fails('settings.receiptPreview', {})).code).toBe('FORBIDDEN');
    await t.loginAs('manager');
    expect(DEFAULT_ROLE_PERMISSIONS.manager).toContain('data.backup');
    expect((await t.fails('settings.update', { section: 'receipt', values: { copies: 2 } })).code).toBe('FORBIDDEN');
    await t.call('settings.update', { section: 'backup', values: { keepCount: 10, autoBackup: false } });
    expect((await t.call('settings.get')).backup).toMatchObject({ keepCount: 10, autoBackup: false });
  });

  it('checks that a new backup folder is usable', async () => {
    const t = await createTestApp();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-settings-'));
    const file = path.join(dir, 'a-file.txt');
    fs.writeFileSync(file, 'x');
    const err = await t.fails('settings.update', { section: 'backup', values: { folder: path.join(file, 'sub') } });
    expect(err.message).toMatch(/cannot save files/);
    expect((await t.fails('settings.update', { section: 'backup', values: { folder: 'relative/path' } })).message).toMatch(/full folder path/);
    await t.call('settings.update', { section: 'backup', values: { folder: path.join(dir, 'Backups') } });
    expect(fs.existsSync(path.join(dir, 'Backups'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('receipt preview & test print', () => {
  it('renders a realistic sample bill with UNSAVED values and does not save them', async () => {
    const t = await createTestApp();
    const saved = await t.call('settings.receiptPreview', {});
    expect(saved.paperWidth).toBe(80);
    expect(saved.html).toContain('Sharma General Store');
    expect(saved.html).toContain('Thank you! Visit again.');
    expect(saved.html).toContain('INV/26-27/0042');
    expect(saved.html).toContain('Anita Desai');
    expect(saved.html).not.toContain('<svg');

    const p = await t.call('settings.receiptPreview', {
      business: { name: 'Sharma Kirana & Sons', upiId: 'sharma@okaxis' },
      receipt: { header: 'Open 8 am - 10 pm\nFree home delivery', paperWidth: 58, showCustomer: false, showAmountInWords: true, upiQr: 'unpaid', footer: '' },
    });
    expect(p.paperWidth).toBe(58);
    expect(p.html).toContain('size: 58mm auto');
    expect(p.html).toContain('Sharma Kirana &amp; Sons');
    expect(p.html).toContain('Open 8 am - 10 pm<br>Free home delivery');
    expect(p.html).not.toContain('Anita Desai');
    expect(p.html).not.toContain('Thank you! Visit again.');
    expect(p.html).toMatch(/Rupees .* Only/);
    // The sample has an unpaid balance, so the UPI QR is printed.
    expect(p.html).toContain('<svg');
    expect(p.html).toContain('Scan to pay');

    // Reprint preview shows DUPLICATE only when the setting is on.
    expect((await t.call('settings.receiptPreview', { duplicate: true })).html).toContain('DUPLICATE');
    expect((await t.call('settings.receiptPreview', { duplicate: true, receipt: { markDuplicate: false } })).html).not.toContain('DUPLICATE');

    // Half-typed / invalid values fall back to the saved ones instead of failing.
    const loose = await t.call('settings.receiptPreview', { receipt: { paperWidth: 70, copies: 'many' } });
    expect(loose.paperWidth).toBe(80);

    // Nothing was saved.
    const s = await t.call('settings.get');
    expect(s.business.name).toBe('Sharma General Store');
    expect(s.receipt.paperWidth).toBe(80);
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action = 'settings.update'")).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('uses the saved billing prefix and cashier name', async () => {
    const t = await createTestApp();
    await t.call('settings.update', { section: 'billing', values: { prefixes: { bill: 'SGS' } } });
    const p = await t.call('settings.receiptPreview', { receipt: { showCashier: true } });
    expect(p.html).toContain('SGS/26-27/0042');
    expect(p.html).toContain('Ravi Sharma');
  });

  it('test-prints on the chosen printer', async () => {
    const t = await createTestApp();
    const res = await t.call('settings.testPrint', { printerName: 'POS-80', receipt: { paperWidth: 58 } });
    expect(res).toMatchObject({ printed: true, message: 'Test receipt sent to POS-80' });
    const job = t.platform.printed.at(-1)!;
    expect(job.opts).toMatchObject({ printerName: 'POS-80', silent: true, paperWidthMm: 58, copies: 1 });
    expect(job.html).toContain('BILL');
    await t.call('settings.testPrint', { printerName: '' });
    expect(t.platform.printed.at(-1)!.opts).toMatchObject({ printerName: undefined, silent: false, paperWidthMm: 80 });
  });

  it('describes the installation', async () => {
    const t = await createTestApp();
    const a = await t.call('settings.about');
    expect(a).toMatchObject({ version: 'test', dataDir: '/tmp/billforce-test', dbPath: ':memory:', platform: 'test', booksStartDate: '2026-04-01' });
    expect(a.backupFolder).toBe(path.join('/tmp/billforce-test-docs', 'Billforce Backups'));
  });
});
