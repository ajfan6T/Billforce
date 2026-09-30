import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, OWNER, testDir } from './helpers';
import { BillforceApp } from '../src/core/app';
import { TestPlatform } from '../src/core/platform';
import { ALREADY_SET_UP_MESSAGE } from '../src/core/modules/data/backup';

const tmpDirs: string[] = [];
const openApps: BillforceApp[] = [];
afterEach(() => {
  for (const a of openApps.splice(0)) {
    try {
      a.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** One computer: Billforce with a real data file in its own folder (restore swaps files, so no :memory:). */
function computer(name: string, at = '2026-09-28T10:00:00') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bf-${name}-`));
  tmpDirs.push(dir);
  let current = new Date(at);
  const platform = new TestPlatform(path.join(dir, 'Documents'));
  const app = new BillforceApp({ dataDir: path.join(dir, 'AppData', 'Billforce'), platform, version: 'test', clock: () => new Date(current) });
  openApps.push(app);
  const events: string[] = [];
  app.onEvent((e) => events.push(e));
  const call = async (route: string, input?: unknown): Promise<any> => {
    const r = await app.invoke(route, input);
    if (!r.ok) throw new Error(`${route}: [${r.error.code}] ${r.error.message}`);
    return r.data;
  };
  const fails = async (route: string, input?: unknown) => {
    const r = await app.invoke(route, input);
    if (r.ok) throw new Error(`Expected ${route} to fail, got ${JSON.stringify(r.data).slice(0, 200)}`);
    return r.error;
  };
  return { dir, app, platform, events, call, fails, setTime: (iso: string) => (current = new Date(iso)), backupDir: path.join(dir, 'Documents', 'Billforce Backups') };
}

/** The shop's old computer: set up, some data, and a backup copied to a "pen drive". */
async function oldComputerBackup() {
  const old = computer('old-pc', '2026-09-27T18:00:00');
  await old.call('setup.complete', {
    business: { name: 'Sharma General Store', address: '12 MG Road, Pune', phone: '98200 12345' },
    owner: { fullName: 'Ravi Sharma', username: OWNER.username, password: OWNER.password },
    booksStartDate: '2026-04-01',
    openingCash: 500000,
  });
  await old.call('users.create', { username: 'priya', fullName: 'Priya', role: 'cashier', password: 'cash1234' });
  const anita = await old.call('customers.create', { name: 'Anita Desai', phone: '98200 11111' });
  await old.call('sales.create', { customerId: anita.id, items: [{ itemName: 'Tea', qty: 2, rate: 1500 }], payments: [] });
  await old.call('sales.create', { items: [{ itemName: 'Sugar', qty: 1, rate: 4800 }], payments: [{ mode: 'cash', amount: 4800 }] });
  const b = await old.call('backup.create', { note: 'Evening backup' });
  const penDrive = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-pendrive-'));
  tmpDirs.push(penDrive);
  const file = path.join(penDrive, path.basename(b.path));
  fs.copyFileSync(b.path, file);
  old.app.close();
  return { file, penDrive };
}

describe('first run on a new computer: restore instead of setting up', () => {
  it('fresh install -> choose the backup -> see what is in it -> restore -> log in with the backup owner', async () => {
    const { file } = await oldComputerBackup();
    const pc = computer('new-pc');
    expect(await pc.call('app.status')).toMatchObject({ setupDone: false, session: null });

    // Only the file chosen in the dialog can be read or restored without a login.
    expect((await pc.fails('setup.inspectBackup', { path: file })).message).toBe('Choose the backup file again.');
    expect((await pc.fails('setup.restoreBackup', { path: file })).message).toBe('Choose the backup file again.');
    expect(await pc.call('setup.pickBackup')).toEqual({ path: null, fileName: null }); // dialog cancelled
    pc.platform.nextPickFile = file;
    expect(await pc.call('setup.pickBackup')).toEqual({ path: file, fileName: path.basename(file) });
    const info = await pc.call('setup.inspectBackup', { path: file });
    expect(info).toMatchObject({ businessName: 'Sharma General Store', backupAt: '2026-09-27 18:00:00', healthy: true, lastBillDate: '2026-09-27' });
    expect(info.counts).toMatchObject({ bills: 2, customers: 1, users: 2 });
    // "Choose another file", then Cancel: the file chosen before can still be restored.
    pc.platform.nextPickFile = null;
    expect(await pc.call('setup.pickBackup')).toEqual({ path: null, fileName: null });

    const res = await pc.call('setup.restoreBackup', { path: file });
    expect(res).toMatchObject({ restoredFrom: file, businessName: 'Sharma General Store' });
    expect(res).not.toHaveProperty('safetyBackupPath');
    expect(pc.events).toContain('database-replaced');

    // The login screen of the restored business; nobody is logged in.
    expect(await pc.call('app.status')).toMatchObject({ setupDone: true, businessName: 'Sharma General Store', session: null });
    expect((await pc.call('auth.loginUsers')).map((u: any) => u.username).sort()).toEqual(['owner', 'priya']);
    expect((await pc.fails('customers.list', {})).code).toBe('UNAUTHENTICATED');
    await pc.call('auth.login', OWNER);
    expect((await pc.call('customers.list', {})).map((c: any) => c.name)).toEqual(['Anita Desai']);
    expect(pc.app.db.value<number>("SELECT COUNT(*) FROM bills WHERE status = 'active'")).toBe(2);
    expect(ledgerProblems(pc.app)).toEqual([]);

    // No safety copy (there was nothing to keep); an automatic backup of the restored data on THIS computer is the last backup.
    expect(pc.app.db.value<number>("SELECT COUNT(*) FROM backup_history WHERE kind = 'safety'")).toBe(0);
    expect(path.dirname(res.backupAfterRestore)).toBe(pc.backupDir);
    expect(fs.readdirSync(pc.backupDir)).toEqual([path.basename(res.backupAfterRestore)]);
    const st = await pc.call('backup.status');
    expect(st.lastBackup).toMatchObject({ path: res.backupAfterRestore, kind: 'auto', exists: true, damaged: false });
    expect((await pc.call('backup.inspect', { path: res.backupAfterRestore })).counts).toMatchObject({ bills: 2, customers: 1 });
    const log = pc.app.db.get<{ summary: string; username: string | null }>("SELECT summary, username FROM activity_log WHERE action = 'backup.restore'");
    expect(log).toEqual({ summary: `Restored data from ${path.basename(file)} (Sharma General Store) while setting up Billforce on this computer`, username: null });

    // Once set up, the first-run routes refuse, logged in or not.
    pc.platform.nextPickFile = file;
    for (const [route, input] of [['setup.pickBackup', undefined], ['setup.inspectBackup', { path: file }], ['setup.restoreBackup', { path: file }]] as const) {
      expect(await pc.fails(route, input)).toMatchObject({ code: 'FORBIDDEN', message: ALREADY_SET_UP_MESSAGE });
    }
    await pc.call('auth.logout');
    for (const [route, input] of [['setup.pickBackup', undefined], ['setup.inspectBackup', { path: file }], ['setup.restoreBackup', { path: file }]] as const) {
      expect(await pc.fails(route, input)).toMatchObject({ code: 'FORBIDDEN', message: ALREADY_SET_UP_MESSAGE });
    }
    expect(await pc.call('app.status')).toMatchObject({ setupDone: true, businessName: 'Sharma General Store' });
  });

  it('keeps the checks of a normal restore: a wrong file changes nothing and set-up can still be done', async () => {
    const pc = computer('new-pc');
    const junk = path.join(pc.dir, 'letter.bfbackup');
    fs.writeFileSync(junk, 'Dear sir, this is not a backup');
    pc.platform.nextPickFile = junk;
    await pc.call('setup.pickBackup');
    expect((await pc.fails('setup.inspectBackup', { path: junk })).message).toMatch(/not a Billforce backup/);
    expect((await pc.fails('setup.restoreBackup', { path: junk })).message).toMatch(/not a Billforce backup/);

    // Another computer's data file from before its set-up is not a backup either.
    const blank = computer('blank-pc');
    const blankCopy = path.join(pc.dir, 'blank.db');
    blank.app.db.vacuumInto(blankCopy);
    pc.platform.nextPickFile = blankCopy;
    await pc.call('setup.pickBackup');
    expect((await pc.fails('setup.restoreBackup', { path: blankCopy })).message).toMatch(/not a Billforce backup/);

    // The data file this Billforce is using cannot be picked as a "backup".
    pc.platform.nextPickFile = pc.app.info.dbPath;
    await pc.call('setup.pickBackup');
    expect((await pc.fails('setup.restoreBackup', { path: pc.app.info.dbPath })).message).toMatch(/data file Billforce is using right now/);

    // A file other than the one chosen is refused.
    const { file } = await oldComputerBackup();
    pc.platform.nextPickFile = junk;
    await pc.call('setup.pickBackup');
    expect((await pc.fails('setup.restoreBackup', { path: file })).message).toBe('Choose the backup file again.');

    expect(pc.events).not.toContain('database-replaced');
    expect(await pc.call('app.status')).toMatchObject({ setupDone: false });
    expect(fs.existsSync(pc.backupDir)).toBe(false);
    await pc.call('setup.complete', {
      business: { name: 'New Shop' },
      owner: { fullName: 'Owner', username: 'owner', password: 'pass1234' },
      booksStartDate: '2026-04-01',
    });
    expect(await pc.call('app.status')).toMatchObject({ setupDone: true, businessName: 'New Shop' });
  });

  it('a restored backup whose backup folder is missing on this computer is still restored (no backup after it)', async () => {
    const old = computer('old-pc');
    await old.call('setup.complete', {
      business: { name: 'Sharma General Store' },
      owner: { fullName: 'Ravi Sharma', username: OWNER.username, password: OWNER.password },
      booksStartDate: '2026-04-01',
    });
    // The old computer kept its backups in a folder this computer cannot use (here: the path is now a file).
    const oldFolder = path.join(old.dir, 'Backups D');
    await old.call('settings.update', { section: 'backup', values: { folder: oldFolder } });
    const b = await old.call('backup.create', {});
    fs.mkdirSync(path.join(old.dir, 'pen'));
    const file = path.join(old.dir, 'pen', 'shop.bfbackup');
    fs.copyFileSync(b.path, file);
    old.app.close();
    fs.rmSync(oldFolder, { recursive: true, force: true });
    fs.writeFileSync(oldFolder, 'now a file, so the folder cannot be made');

    const pc = computer('new-pc');
    pc.platform.nextPickFile = file;
    await pc.call('setup.pickBackup');
    const res = await pc.call('setup.restoreBackup', { path: file });
    expect(res.backupAfterRestore).toBeNull();
    expect(await pc.call('app.status')).toMatchObject({ setupDone: true, businessName: 'Sharma General Store' });
    await pc.call('auth.login', OWNER);
    expect(ledgerProblems(pc.app)).toEqual([]);
  });

  it('is not available for an in-memory database', async () => {
    const { file } = await oldComputerBackup();
    const root = testDir();
    const platform = new TestPlatform(path.join(root, 'docs'));
    const app = new BillforceApp({ dataDir: path.join(root, 'data'), dbPath: ':memory:', platform, version: 'test' });
    openApps.push(app);
    platform.nextPickFile = file;
    expect((await app.invoke('setup.pickBackup')).ok).toBe(true);
    expect(await app.invoke('setup.restoreBackup', { path: file })).toMatchObject({ ok: false, error: { message: 'Restore is not available in this mode.' } });
    // A set-up app refuses before anything else.
    const t = await createTestApp();
    expect((await t.fails('setup.pickBackup')).code).toBe('FORBIDDEN');
  });
});

describe('"Last backup" after a restore', () => {
  it('is never the safety copy of the data the restore replaced', async () => {
    const pc = computer('shop');
    await pc.call('setup.complete', {
      business: { name: 'Sharma General Store' },
      owner: { fullName: 'Ravi Sharma', username: OWNER.username, password: OWNER.password },
      booksStartDate: '2026-04-01',
    });
    // Automatic backup off: no backup is taken after the restore, so only the files in the folder decide.
    await pc.call('settings.update', { section: 'backup', values: { autoBackup: false } });
    await pc.call('customers.create', { name: 'Anita Desai' });
    const good = await pc.call('backup.create', { note: 'Good copy' });
    pc.setTime('2026-09-28T12:00:00');
    await pc.call('customers.create', { name: 'Typed by mistake' });
    const res = await pc.call('backup.restore', { path: good.path });
    expect(res.backupAfterRestore).toBeNull();
    await pc.call('auth.login', OWNER);
    const st = await pc.call('backup.status');
    // The safety copy (12:00) is the newest file, but it holds the replaced data; the restored backup is a copy of these books.
    expect(st.backups.map((b: any) => b.kind)).toEqual(['safety', 'manual']);
    expect(st.lastBackup).toMatchObject({ path: good.path, kind: 'manual', at: '2026-09-28 10:00:00', exists: true });
  });
});
