import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, ledgerProblems, OWNER, systemBalance, type TestApp } from './helpers';
import { BillforceApp } from '../src/core/app';
import { LATEST_SCHEMA_VERSION } from '../src/core/db/migrate';
import { TestPlatform } from '../src/core/platform';
import { partyBalance } from '../src/core/accounting/ledger';
import { updateSection } from '../src/core/settings';
import { runAutoBackup, runExitBackup, startBackupScheduler } from '../src/core/modules/data/scheduler';
import { backupLabel, backupLooksComplete, createBackup } from '../src/core/modules/data/backup';
import { parseAmount, parseDateCell, decodeText, parseCsvText } from '../src/core/modules/data/sheet';
import { normalizeUnit } from '../src/core/modules/data/import';
import { DEFAULT_ROLE_PERMISSIONS } from '../src/shared/permissions';

const tmpDirs: string[] = [];
function tmpDir(prefix = 'bf-data-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
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

async function withBackupFolder(t: TestApp): Promise<string> {
  const dir = path.join(tmpDir(), 'Backups');
  await t.call('settings.update', { section: 'backup', values: { folder: dir } });
  return dir;
}

/** A Billforce with a real database file (restore swaps files, so it cannot use :memory:). */
async function createFileApp() {
  const dir = tmpDir('bf-restore-');
  let current = new Date('2026-09-28T10:00:00');
  const platform = new TestPlatform(path.join(dir, 'docs'));
  const app = new BillforceApp({ dataDir: path.join(dir, 'data'), platform, version: 'test', clock: () => new Date(current) });
  openApps.push(app);
  const events: string[] = [];
  app.onEvent((e) => events.push(e));
  const call = async (name: string, input?: unknown): Promise<any> => {
    const r = await app.invoke(name, input);
    if (!r.ok) throw new Error(`${name}: [${r.error.code}] ${r.error.message}`);
    return r.data;
  };
  const fails = async (name: string, input?: unknown) => {
    const r = await app.invoke(name, input);
    if (r.ok) throw new Error(`Expected ${name} to fail`);
    return r.error;
  };
  await call('setup.complete', {
    business: { name: 'Sharma General Store', address: '12 MG Road, Pune', phone: '98200 12345' },
    owner: { fullName: 'Ravi Sharma', username: OWNER.username, password: OWNER.password },
    booksStartDate: '2026-04-01',
    openingCash: 500000,
  });
  const backupDir = path.join(dir, 'Backups');
  await call('settings.update', { section: 'backup', values: { folder: backupDir } });
  return { app, platform, call, fails, events, dir, backupDir, setTime: (iso: string) => (current = new Date(iso)) };
}

describe('manual backups', () => {
  it('backs up into the chosen folder and lists backups with their status', async () => {
    const t = await createTestApp({ openingCash: 250000 });
    const dir = await withBackupFolder(t);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'copied-from-shop.bfbackup'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a backup');
    const b = await t.call('backup.create', { note: 'Before year end' });
    expect(b.path).toBe(path.join(dir, 'Sharma-General-Store_manual_20260928_100000.bfbackup'));
    expect(fs.existsSync(b.path)).toBe(true);
    // Pressing the button twice in the same second must not overwrite the first file.
    const b2 = await t.call('backup.create', {});
    expect(b2.path).not.toBe(b.path);

    const st = await t.call('backup.status');
    expect(st).toMatchObject({ folder: dir, isDefaultFolder: false, autoBackup: true, keepCount: 30, canRestore: false });
    expect(st.lastBackup).toMatchObject({ at: '2026-09-28 10:00:00', path: b2.path, exists: true });
    expect(st.backups.map((x) => x.kind).sort()).toEqual(['manual', 'manual', 'other']);
    const first = st.backups.find((x) => x.path === b.path)!;
    expect(first).toMatchObject({ note: 'Before year end', inFolder: true, at: '2026-09-28 10:00:00' });
    expect(first.sizeBytes).toBeGreaterThan(100);
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action = 'backup.create'")).toBe(2);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('saves a fresh copy wherever the user chooses', async () => {
    const t = await createTestApp();
    const res = await t.call('backup.saveAs');
    expect(res.path).toBe('/tmp/billforce-test-docs/Sharma-General-Store_manual_20260928_100000.bfbackup');
    const saved = t.platform.saved.at(-1)!;
    const raw = zlib.gunzipSync(Buffer.from(saved.data as Uint8Array));
    expect(raw.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    expect((await t.call('settings.get')).backup.lastBackupPath).toBe(res.path);
    expect(t.app.db.value<string>("SELECT action FROM activity_log WHERE action LIKE 'backup.%'")).toBe('backup.copy');
  });

  it('changes the backup folder through the folder picker', async () => {
    const t = await createTestApp();
    const target = path.join(tmpDir(), 'Pen Drive', 'Backups');
    t.platform.nextPickFolder = target;
    const r = await t.call('backup.chooseFolder');
    expect(r).toEqual({ folder: target, changed: true });
    expect((await t.call('backup.status')).folder).toBe(target);
    t.platform.nextPickFolder = null;
    expect(await t.call('backup.chooseFolder')).toEqual({ folder: null, changed: false });
    const file = path.join(tmpDir(), 'file.txt');
    fs.writeFileSync(file, 'x');
    t.platform.nextPickFolder = path.join(file, 'inside');
    expect((await t.fails('backup.chooseFolder')).message).toMatch(/cannot save files/);
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action = 'backup.folder'")).toBe(1);
  });

  it('needs the backup / restore permissions', async () => {
    const t = await createTestApp();
    await t.loginAs('cashier');
    expect((await t.fails('backup.create', {})).code).toBe('FORBIDDEN');
    expect((await t.fails('backup.status')).code).toBe('FORBIDDEN');
    await t.loginAs('manager');
    await t.call('backup.status');
    expect((await t.fails('backup.restore', { path: '/tmp/x.bfbackup' })).code).toBe('FORBIDDEN');
    expect((await t.fails('backup.pickFile')).code).toBe('FORBIDDEN');
  });
});

describe('automatic backups', () => {
  it('takes one automatic backup a day and keeps only the newest keepCount', async () => {
    const t = await createTestApp();
    const dir = await withBackupFolder(t);
    await t.call('settings.update', { section: 'backup', values: { keepCount: 3 } });
    fs.mkdirSync(dir, { recursive: true });
    // Files that must never be deleted by pruning.
    fs.writeFileSync(path.join(dir, 'Other-Shop_auto_20200101_100000.bfbackup'), 'other business');
    fs.writeFileSync(path.join(dir, 'Sharma-General-Store_auto_notes.txt'), 'not a backup');
    const days = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'];
    for (const d of days) {
      t.setToday(d);
      expect((await runAutoBackup(t.app)).status).toBe('done');
      expect(await runAutoBackup(t.app)).toMatchObject({ status: 'skipped', reason: 'Already backed up today' });
    }
    const manual = await t.call('backup.create', {});
    const autoFiles = fs.readdirSync(dir).filter((f) => f.startsWith('Sharma-General-Store_auto_')).sort();
    expect(autoFiles).toEqual([
      'Sharma-General-Store_auto_20260922_100000.bfbackup',
      'Sharma-General-Store_auto_20260923_100000.bfbackup',
      'Sharma-General-Store_auto_20260924_100000.bfbackup',
      'Sharma-General-Store_auto_notes.txt',
    ]);
    expect(fs.existsSync(path.join(dir, 'Other-Shop_auto_20200101_100000.bfbackup'))).toBe(true);
    expect(fs.existsSync(manual.path)).toBe(true);
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM backup_history WHERE kind = 'auto'")).toBe(3);
    const st = await t.call('backup.status');
    expect(st.lastAutoBackupAt).toBe('2026-09-24 10:00:00');
    const log = t.app.db.all<{ summary: string; username: string | null }>("SELECT summary, username FROM activity_log WHERE action = 'backup.auto' ORDER BY id");
    expect(log).toHaveLength(5);
    expect(log[4].summary).toMatch(/removed 1 older automatic backup\)$/);
    expect(log[4].username).toBeNull(); // done by the system, not the logged-in user
  });

  it('respects the on / off switch and never throws; failures are logged once a day', async () => {
    const t = await createTestApp();
    await t.call('settings.update', { section: 'backup', values: { autoBackup: false } });
    expect(await runAutoBackup(t.app)).toMatchObject({ status: 'skipped', reason: 'Automatic backup is off' });
    await t.call('settings.update', { section: 'backup', values: { autoBackup: true } });
    const file = path.join(tmpDir(), 'file.txt');
    fs.writeFileSync(file, 'x');
    // A folder that cannot be created (e.g. a pen drive that was removed).
    updateSection(t.app.ctx(), 'backup', { folder: path.join(file, 'gone') });
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      expect((await runAutoBackup(t.app)).status).toBe('failed');
      expect((await runAutoBackup(t.app)).status).toBe('failed');
      expect(runExitBackup(t.app).status).toBe('failed');
    } finally {
      console.error = orig;
    }
    expect(errors.length).toBe(3);
    const failed = t.app.db.all<{ summary: string }>("SELECT summary FROM activity_log WHERE action = 'backup.failed'");
    expect(failed).toHaveLength(1);
    expect(failed[0].summary).toMatch(/^Automatic backup failed: Cannot create the backup folder/);
  });

  it('backs up on exit only when data changed since the last backup', async () => {
    const t = await createTestApp();
    const dir = await withBackupFolder(t);
    t.app.lastChangeAt = null;
    expect(runExitBackup(t.app).status).toBe('done'); // never backed up before
    expect(runExitBackup(t.app)).toMatchObject({ status: 'skipped', reason: 'No changes since the last backup' });
    // Logging in and out is not a change.
    t.app.clock = () => new Date('2026-09-28T11:00:00');
    await t.call('auth.logout');
    await t.loginOwner();
    expect(runExitBackup(t.app).status).toBe('skipped');
    // A new customer is.
    t.app.clock = () => new Date('2026-09-28T12:00:00');
    await t.call('customers.create', { name: 'Anita Desai' });
    expect(runExitBackup(t.app).status).toBe('done');
    // Ledger postings mark the app as changed too.
    t.app.clock = () => new Date('2026-09-28T13:00:00');
    expect(runExitBackup(t.app).status).toBe('skipped');
    t.app.lastChangeAt = new Date('2026-09-28T11:30:00').getTime(); // before the 12:00 backup
    t.app.clock = () => new Date('2026-09-28T14:00:00');
    expect(runExitBackup(t.app).status).toBe('skipped');
    t.app.lastChangeAt = new Date('2026-09-28T15:00:00').getTime();
    expect(runExitBackup(t.app).status).toBe('done');
    expect(fs.readdirSync(dir).filter((f) => f.includes('_auto_'))).toHaveLength(3);
  });

  it('runs on a timer and stops cleanly', async () => {
    const t = await createTestApp();
    const dir = await withBackupFolder(t);
    const s = startBackupScheduler(t.app, { initialDelayMs: 5, intervalMs: 20 });
    // The daily backup is written in the background: wait for it to land.
    const autoFiles = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.includes('_auto_')) : []);
    for (let i = 0; i < 100 && !autoFiles().some((f) => f.endsWith('.bfbackup')); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 60));
    s.stop();
    expect(autoFiles()).toHaveLength(1);
    // backupOnExit is safe to call after stop.
    s.backupOnExit();
  });
});

describe('backups never leave a damaged file behind', () => {
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28 });
  const isGzip = (b: unknown) => Buffer.isBuffer(b) && b.length > 20 && b[0] === 0x1f && b[1] === 0x8b;

  /** The backup folder runs out of space part-way through writing (a full pen drive), for the background writer. */
  function failStreamWrites(mode: 'full' | 'corrupt') {
    const real = fs.createWriteStream;
    return vi.spyOn(fs, 'createWriteStream').mockImplementation(((p: fs.PathLike, o?: any) => {
      if (!String(p).endsWith('.partial')) return real(p, o);
      const chunks: Buffer[] = [];
      return new Writable({
        write(chunk: Buffer, _enc, cb) {
          if (mode === 'full') {
            fs.appendFileSync(p, chunk.subarray(0, 100)); // what fitted on the disk
            cb(enospc());
          } else {
            chunks.push(chunk);
            cb();
          }
        },
        final(cb) {
          const all = Buffer.concat(chunks);
          all[Math.floor(all.length / 2)] ^= 0xff; // a bad sector / flaky pen drive
          fs.writeFileSync(p, all);
          cb();
        },
      });
    }) as typeof fs.createWriteStream);
  }

  /** Same for synchronous writes of compressed data (backup on exit, safety backups), however they are done. */
  function failSyncWrites() {
    const realWriteSync = fs.writeSync;
    const realWriteFileSync = fs.writeFileSync;
    const a = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, buf: any, off?: any, len?: any) => {
      if (!isGzip(buf)) return (realWriteSync as any)(fd, buf, off, len);
      (realWriteSync as any)(fd, buf, 0, 64);
      throw enospc();
    }) as typeof fs.writeSync);
    const b = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: any, data: any, o?: any) => {
      if (!isGzip(data)) return (realWriteFileSync as any)(file, data, o);
      (realWriteFileSync as any)(file, data.subarray(0, 64));
      throw enospc();
    }) as typeof fs.writeFileSync);
    return { mockRestore: () => (a.mockRestore(), b.mockRestore()) };
  }

  const quietly = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  };

  it('a full disk or pen drive: no file is left, nothing is recorded as the last backup, the reason is clear', async () => {
    const t = await createTestApp();
    const dir = await withBackupFolder(t);
    const spy = failStreamWrites('full');
    const spySync = failSyncWrites();
    let auto;
    let manual;
    try {
      auto = await quietly(() => runAutoBackup(t.app));
      manual = await t.fails('backup.create', {});
    } finally {
      spy.mockRestore();
      spySync.mockRestore();
    }
    expect(auto).toMatchObject({ status: 'failed' });
    expect(auto.reason).toMatch(/pen drive .*is full/);
    expect(manual.message).toMatch(/^The disk or pen drive with the backup folder ".*" is full, so the backup could not be saved/);
    const sync = failSyncWrites();
    let exit;
    try {
      exit = await quietly(() => runExitBackup(t.app));
    } finally {
      sync.mockRestore();
    }
    expect(exit).toMatchObject({ status: 'failed' });
    expect(exit.reason).toMatch(/is full/);

    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]); // no .bfbackup, no .partial
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM backup_history')).toBe(0);
    const st = await t.call('backup.status');
    expect(st.lastBackup).toBeNull();
    expect(st.backups).toEqual([]);
    expect((await t.call('settings.get')).backup).toMatchObject({ lastBackupAt: null, lastAutoBackupAt: null, lastBackupPath: null });
    // Once there is space again it works, and the daily backup is not skipped because of the failure.
    expect((await runAutoBackup(t.app)).status).toBe('done');
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it('a file that does not read back exactly (faulty drive) is deleted instead of being kept as a backup', async () => {
    const t = await createTestApp();
    const dir = await withBackupFolder(t);
    const spy = failStreamWrites('corrupt');
    try {
      expect((await t.fails('backup.create', {})).message).toMatch(/could not be read back correctly, so it was deleted/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM backup_history')).toBe(0);
    // A good backup reads back and restores its content exactly.
    const b = await t.call('backup.create', {});
    expect(backupLooksComplete(b.path)).toBe(true);
    const raw = zlib.gunzipSync(fs.readFileSync(b.path));
    expect(raw.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });

  it('"Save a copy to…": a full pen drive is reported clearly and a copy that is not exact is deleted, not recorded', async () => {
    const t = await createTestApp();
    t.platform.saveFile = async () => {
      throw enospc();
    };
    expect((await t.fails('backup.saveAs')).message).toMatch(/^The pen drive or disk you chose is full, so the copy could not be saved\. If a file was created there, delete it/);
    const target = path.join(tmpDir(), 'Pen drive copy.bfbackup');
    t.platform.saveFile = async (o) => {
      const b = Buffer.from(o.data as Uint8Array);
      b[b.length >> 1] ^= 0xff;
      fs.writeFileSync(target, b);
      return target;
    };
    expect((await t.fails('backup.saveAs')).message).toMatch(/could not be read back correctly, so it was deleted/);
    expect(fs.existsSync(target)).toBe(false);
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM backup_history')).toBe(0);
    t.platform.saveFile = async (o) => {
      fs.writeFileSync(target, Buffer.from(o.data as Uint8Array));
      return target;
    };
    expect((await t.call('backup.saveAs')).path).toBe(target);
    expect(backupLooksComplete(target)).toBe(true);
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM backup_history')).toBe(1);
  });

  it('writes in the background: other requests are answered while a backup is being saved', async () => {
    const t = await createTestApp();
    await withBackupFolder(t);
    const order: string[] = [];
    const backup = t.call('backup.create', {}).then(() => order.push('backup'));
    const status = t.call('app.status').then(() => order.push('status'));
    await Promise.all([backup, status]);
    expect(order).toEqual(['status', 'backup']);
  });

  it('cleans up leftovers of interrupted backups, but not a backup being written', async () => {
    const t = await createTestApp();
    const dir = await withBackupFolder(t);
    fs.mkdirSync(dir, { recursive: true });
    const old = (Date.now() - 60 * 60_000) / 1000;
    for (const f of ['Sharma-General-Store_auto_20260901_100000.bfbackup.partial', '.billforce-tmp-1a2b3c4d.db']) {
      fs.writeFileSync(path.join(dir, f), 'half a backup');
      fs.utimesSync(path.join(dir, f), old, old);
    }
    fs.writeFileSync(path.join(dir, 'Sharma-General-Store_manual_20260928_095959.bfbackup.partial'), 'being written right now');
    const st = await t.call('backup.status');
    expect(st.backups).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(['Sharma-General-Store_manual_20260928_095959.bfbackup.partial']);
  });

  it('a damaged backup file is marked, never counts as the last backup and never pushes out a good one', async () => {
    const t = await createTestApp();
    const dir = await withBackupFolder(t);
    await t.call('settings.update', { section: 'backup', values: { keepCount: 3 } });
    for (const d of ['2026-09-20', '2026-09-21', '2026-09-22']) {
      t.setToday(d);
      expect((await runAutoBackup(t.app)).status).toBe('done');
    }
    // What an older version left when the pen drive filled up: a newer, cut-short automatic backup.
    const good = path.join(dir, 'Sharma-General-Store_auto_20260922_100000.bfbackup');
    const cut = path.join(dir, 'Sharma-General-Store_auto_20260923_100000.bfbackup');
    fs.writeFileSync(cut, fs.readFileSync(good).subarray(0, 1000));

    const st = await t.call('backup.status');
    expect(st.backups.find((b) => b.path === cut)).toMatchObject({ damaged: true, kind: 'auto' });
    expect(st.backups.find((b) => b.path === good)).toMatchObject({ damaged: false });
    expect(st.lastBackup).toMatchObject({ path: good, damaged: false });

    t.setToday('2026-09-24');
    const r = await runAutoBackup(t.app);
    expect(r.status).toBe('done');
    expect(r.pruned?.map((p) => path.basename(p)).sort()).toEqual(['Sharma-General-Store_auto_20260920_100000.bfbackup', 'Sharma-General-Store_auto_20260923_100000.bfbackup']);
    expect(fs.readdirSync(dir).sort()).toEqual([
      'Sharma-General-Store_auto_20260921_100000.bfbackup',
      'Sharma-General-Store_auto_20260922_100000.bfbackup',
      'Sharma-General-Store_auto_20260924_100000.bfbackup',
    ]);
  });

  it('labels safety backups by why they were taken', async () => {
    expect(backupLabel('safety', 'Before restoring Shop_manual_20260928_100000.bfbackup')).toBe('Before restore');
    expect(backupLabel('safety', 'Before closing financial year 2025-26')).toBe('Before year-end close');
    expect(backupLabel('safety', 'Before re-opening financial year 2025-26')).toBe('Before re-opening year');
    expect(backupLabel('safety', null)).toBe('Safety copy');
    expect(backupLabel('auto', 'Daily automatic backup')).toBe('Automatic');
    const t = await createTestApp();
    await withBackupFolder(t);
    createBackup(t.app.ctx(), 'safety', { note: 'Before closing financial year 2025-26' });
    await t.call('backup.create', {});
    const st = await t.call('backup.status');
    expect(st.backups.map((b) => b.label).sort()).toEqual(['Before year-end close', 'Manual']);
  });
});

describe('restore', () => {
  it('restores a backup end-to-end: data back, session cleared, safety backup kept, restore logged', async () => {
    const f = await createFileApp();
    const anita = await f.call('customers.create', { name: 'Anita Desai', phone: '98200 11111', openingBalance: { amount: 100000, direction: 'receivable' } });
    await f.call('items.create', { name: 'Tea', unit: 'cup', rate: 1500 });
    const backupFile = (await f.call('backup.create', { note: 'Good copy' })).path;

    // Things change after the backup.
    f.setTime('2026-09-28T12:00:00');
    await f.call('customers.create', { name: 'Rahul Traders', phone: '98765 43210' });
    await f.call('settings.update', { section: 'business', values: { name: 'Renamed Store' } });
    await f.call('sales.create', { items: [{ itemName: 'Tea', qty: 2, rate: 1500 }], payments: [{ mode: 'cash', amount: 3000 }] });

    f.platform.nextPickFile = backupFile;
    expect(await f.call('backup.pickFile')).toEqual({ path: backupFile, fileName: path.basename(backupFile) });
    const info = await f.call('backup.inspect', { path: backupFile });
    expect(info).toMatchObject({ businessName: 'Sharma General Store', backupAt: '2026-09-28 10:00:00', schemaVersion: LATEST_SCHEMA_VERSION, healthy: true, lastBillDate: null });
    expect(info.counts).toMatchObject({ customers: 1, items: 1, bills: 0, users: 1 });

    const res = await f.call('backup.restore', { path: backupFile });
    expect(res.businessName).toBe('Sharma General Store');
    expect(fs.existsSync(res.safetyBackupPath)).toBe(true);
    expect(path.basename(res.safetyBackupPath)).toMatch(/^Renamed-Store_safety_20260928_120000\.bfbackup$/);
    expect(f.events).toContain('database-replaced');

    // The session ended.
    expect(f.app.session).toBeNull();
    expect((await f.call('app.status')).session).toBeNull();
    expect((await f.fails('customers.list', {})).code).toBe('UNAUTHENTICATED');

    await f.call('auth.login', OWNER);
    const customers = await f.call('customers.list', {});
    expect(customers.map((c: any) => c.name)).toEqual(['Anita Desai']);
    expect(partyBalance(f.app.ctx(), 'customer', anita.id)).toBe(100000);
    expect((await f.call('app.status')).businessName).toBe('Sharma General Store');
    expect(f.app.db.value<number>('SELECT COUNT(*) FROM bills')).toBe(0);
    const restoreLog = f.app.db.get<{ summary: string; username: string; user_id: number }>("SELECT summary, username, user_id FROM activity_log WHERE action = 'backup.restore'");
    expect(restoreLog?.summary).toMatch(/^Restored data from Sharma-General-Store_manual_20260928_100000\.bfbackup \(Sharma General Store\)\. The data from before the restore was saved to /);
    expect(restoreLog?.username).toBe('owner');
    expect(ledgerProblems(f.app)).toEqual([]);
    // The restored data knows about the safety copy, and the newest file counts as the last backup.
    expect(f.app.db.value<string>("SELECT path FROM backup_history WHERE kind = 'safety'")).toBe(res.safetyBackupPath);
    const st = await f.call('backup.status');
    expect(st.lastBackup).toMatchObject({ path: res.safetyBackupPath, kind: 'safety', exists: true });
    expect(st.backups.map((b: any) => b.kind)).toEqual(['safety', 'manual']);

    // The safety backup holds the data from just before the restore.
    const safety = await f.call('backup.inspect', { path: res.safetyBackupPath });
    expect(safety).toMatchObject({ businessName: 'Renamed Store' });
    expect(safety.counts).toMatchObject({ customers: 2, bills: 1 });

    // A raw .db file (e.g. copied by hand) can be restored too.
    const rawDb = path.join(f.dir, 'plain-copy.db');
    f.app.db.vacuumInto(rawDb);
    await f.call('backup.restore', { path: rawDb });
    await f.call('auth.login', OWNER);
    expect((await f.call('customers.list', {})).length).toBe(1);
  });

  it('refuses files that are not Billforce backups and leaves the current data alone', async () => {
    const f = await createFileApp();
    await f.call('customers.create', { name: 'Anita Desai' });
    const text = path.join(f.dir, 'letter.bfbackup');
    fs.writeFileSync(text, 'Dear sir, this is not a backup');
    expect((await f.fails('backup.restore', { path: text })).message).toMatch(/not a Billforce backup/);
    const gz = path.join(f.dir, 'zipped.bfbackup');
    fs.writeFileSync(gz, zlib.gzipSync(Buffer.from('hello')));
    expect((await f.fails('backup.restore', { path: gz })).message).toMatch(/not a Billforce backup/);
    const broken = path.join(f.dir, 'broken.bfbackup');
    fs.writeFileSync(broken, Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('garbage')]));
    expect((await f.fails('backup.restore', { path: broken })).message).toMatch(/damaged/);
    // Some other program's SQLite database.
    const other = path.join(f.dir, 'other-app.db');
    const db = new DatabaseSync(other);
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO notes (text) VALUES (\'hi\')');
    db.close();
    expect((await f.fails('backup.restore', { path: other })).message).toMatch(/not a Billforce backup/);
    expect((await f.fails('backup.inspect', { path: other })).message).toMatch(/not a Billforce backup/);
    expect((await f.fails('backup.restore', { path: path.join(f.dir, 'missing.bfbackup') })).code).toBe('NOT_FOUND');

    // Nothing happened to the live data or the session, and no safety backup was needed.
    expect(f.app.session?.username).toBe('owner');
    expect((await f.call('customers.list', {})).length).toBe(1);
    expect(f.app.db.value<number>("SELECT COUNT(*) FROM backup_history WHERE kind = 'safety'")).toBe(0);
    expect(f.events).not.toContain('database-replaced');
  });

  it('refuses the data file Billforce is using right now (it is not a backup; its newest entries are in the -wal file)', async () => {
    const f = await createFileApp();
    for (let i = 0; i < 3; i++) await f.call('customers.create', { name: `Customer ${i}` });
    const live = f.app.info.dbPath;
    for (const p of [live, `${live}-wal`, path.join(path.dirname(live), '.', path.basename(live))]) {
      if (!fs.existsSync(p)) continue;
      expect((await f.fails('backup.restore', { path: p })).message).toMatch(/data file Billforce is using right now/);
      expect((await f.fails('backup.inspect', { path: p })).message).toMatch(/data file Billforce is using right now/);
    }
    // Nothing happened.
    expect(f.app.session?.username).toBe('owner');
    expect((await f.call('customers.list', {})).length).toBe(3);
    expect(f.events).not.toContain('database-replaced');
  });

  it('restores a plain .db copy together with the entries still in its -wal file', async () => {
    const f = await createFileApp();
    await f.call('customers.create', { name: 'Saved to the main file' });
    f.app.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (let i = 0; i < 3; i++) await f.call('customers.create', { name: `Only in the WAL ${i}` });
    const copyDir = path.join(f.dir, 'Pen drive');
    fs.mkdirSync(copyDir);
    const copy = path.join(copyDir, 'billforce.db');
    fs.copyFileSync(f.app.info.dbPath, copy);
    fs.copyFileSync(`${f.app.info.dbPath}-wal`, `${copy}-wal`);
    expect(fs.statSync(`${copy}-wal`).size).toBeGreaterThan(0);

    expect((await f.call('backup.inspect', { path: copy })).counts.customers).toBe(4);
    await f.call('customers.create', { name: 'After the copy' });
    await f.call('backup.restore', { path: copy });
    await f.call('auth.login', OWNER);
    expect((await f.call('customers.list', {})).map((c: any) => c.name).sort()).toEqual(['Only in the WAL 0', 'Only in the WAL 1', 'Only in the WAL 2', 'Saved to the main file']);
    expect(ledgerProblems(f.app)).toEqual([]);
    // The copy itself was not touched.
    expect(fs.existsSync(`${copy}-wal`)).toBe(true);
  });

  it('does not restore while a backup is still being written, and labels the safety copy "Before restore"', async () => {
    const f = await createFileApp();
    const first = await f.call('backup.create', {});
    const pending = f.call('backup.create', {});
    expect((await f.fails('backup.restore', { path: first.path })).message).toMatch(/being saved right now/);
    await pending;
    const res = await f.call('backup.restore', { path: first.path });
    await f.call('auth.login', OWNER);
    const st = await f.call('backup.status');
    expect(st.backups.find((b: any) => b.path === res.safetyBackupPath)?.label).toBe('Before restore');
  });

  it('is not available for an in-memory database', async () => {
    const t = await createTestApp();
    const dir = await withBackupFolder(t);
    const b = await t.call('backup.create', {});
    expect((await t.fails('backup.restore', { path: b.path })).message).toMatch(/not available/);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });
});

/* ------------------------------ Import ------------------------------ */

async function writeXlsx(file: string, rows: unknown[][], sheetName = 'Sheet1') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(file);
  return file;
}

function writeCsv(file: string, rows: string[][], opts: { bom?: boolean; delimiter?: string } = {}) {
  const d = opts.delimiter ?? ',';
  const body = rows.map((r) => r.map((c) => (/[",\n;]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(d)).join('\r\n');
  fs.writeFileSync(file, (opts.bom === false ? '' : '﻿') + body);
  return file;
}

describe('import: parsing helpers', () => {
  it('understands Indian amounts', () => {
    expect(parseAmount('₹ 1,23,456.50')).toEqual({ ok: true, value: 12345650 });
    expect(parseAmount('Rs. 500/-')).toEqual({ ok: true, value: 50000 });
    expect(parseAmount('INR 2,500')).toEqual({ ok: true, value: 250000 });
    expect(parseAmount(1250.5)).toEqual({ ok: true, value: 125050 });
    expect(parseAmount('(500)', { allowNegative: true })).toEqual({ ok: true, value: -50000 });
    expect(parseAmount('-500')).toEqual({ ok: false, error: 'Amount cannot be negative' });
    expect(parseAmount('abc')).toMatchObject({ ok: false });
    expect(parseAmount('  ')).toBeNull();
    expect(parseAmount('-')).toBeNull();
  });

  it('understands Indian dates, Excel dates and serial numbers', () => {
    const now = new Date('2026-09-28T10:00:00');
    expect(parseDateCell('15-06-2024', now)).toEqual({ ok: true, value: '2024-06-15' });
    expect(parseDateCell('15/06/2024', now)).toEqual({ ok: true, value: '2024-06-15' });
    expect(parseDateCell('5.6.24', now)).toEqual({ ok: true, value: '2024-06-05' });
    expect(parseDateCell('01-01-98', now)).toEqual({ ok: true, value: '1998-01-01' });
    expect(parseDateCell('2024-06-15', now)).toEqual({ ok: true, value: '2024-06-15' });
    expect(parseDateCell('15 Jun 2024', now)).toEqual({ ok: true, value: '2024-06-15' });
    expect(parseDateCell('15-January-2024', now)).toEqual({ ok: true, value: '2024-01-15' });
    expect(parseDateCell('Jun 15, 2024', now)).toEqual({ ok: true, value: '2024-06-15' });
    expect(parseDateCell(45306, now)).toEqual({ ok: true, value: '2024-01-15' });
    expect(parseDateCell('45306', now)).toEqual({ ok: true, value: '2024-01-15' });
    expect(parseDateCell(new Date(Date.UTC(2024, 5, 1)), now)).toEqual({ ok: true, value: '2024-06-01' });
    expect(parseDateCell('31-02-2024', now)).toMatchObject({ ok: false });
    expect(parseDateCell('someday', now)).toMatchObject({ ok: false });
  });

  it('reads CSV in UTF-8, UTF-8 with BOM and Windows-1252', () => {
    expect(decodeText(Buffer.from('﻿Name\r\nCafé', 'utf8'))).toBe('Name\r\nCafé');
    expect(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe('Café');
    expect(parseCsvText('a;b;c\n1;2;3').map((r) => r.cells)).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(normalizeUnit('Kgs')).toBe('kg');
    expect(normalizeUnit('Nos.')).toBe('pcs');
    expect(normalizeUnit('tray')).toBe('tray');
  });
});

describe('import: items', () => {
  it('previews and imports items from CSV with duplicates, errors and update mode', async () => {
    const t = await createTestApp();
    await t.call('items.create', { name: 'Tea', unit: 'cup', rate: 1000 });
    const file = writeCsv(path.join(tmpDir(), 'items.csv'), [
      ['Item Name', 'Rate (₹)', ' UNIT ', 'Category', 'Code'],
      ['Sugar 1 kg', '48', 'Kgs', 'Grocery', 'SUG'],
      ['Big Tin', '1,23,456.50', 'box', '', ''],
      ['sugar 1 KG', '50', '', '', ''],
      ['Salt', 'abc', '', '', ''],
      ['', '10', '', '', ''],
      ['TEA', '1,200', 'cup', 'Drinks', ''],
      ['Free Sample', '', '', '', ''],
      ['', '', '', '', ''],
    ]);
    const p = await t.call('import.preview', { type: 'items', path: file });
    expect(p.mapping).toEqual({ name: 0, code: 4, unit: 2, rate: 1, category: 3 });
    expect(p.counts).toEqual({ total: 7, create: 3, update: 0, skip: 1, errors: 3 });
    const byRow = new Map(p.rows.map((r) => [r.rowNo, r]));
    expect(byRow.get(2)).toMatchObject({ action: 'create', values: { name: 'Sugar 1 kg', rate: '₹48.00', unit: 'kg', category: 'Grocery', code: 'SUG' } });
    expect(byRow.get(3)!.values.rate).toBe('₹1,23,456.50');
    expect(byRow.get(4)!.errors).toEqual(['Item name: same item as row 2']);
    expect(byRow.get(5)!.fieldErrors.rate).toBe('"abc" is not an amount');
    expect(byRow.get(6)!.errors).toEqual(['Item name is required']);
    expect(byRow.get(7)).toMatchObject({ action: 'skip', note: 'Already exists - skipped' });
    expect(byRow.get(8)!.warnings[0]).toMatch(/No rate/);

    const upd = await t.call('import.preview', { type: 'items', path: file, duplicateMode: 'update' });
    expect(upd.rows.find((r) => r.rowNo === 7)).toMatchObject({ action: 'update', note: 'Will update name, rate, category' });

    const res = await t.call('import.commit', { type: 'items', path: file, duplicateMode: 'update' });
    expect(res).toMatchObject({ created: 3, updated: 1, skipped: 0, errors: 3, fileName: 'items.csv' });
    const items = await t.call('items.list', {});
    const byName = new Map(items.map((i) => [i.name, i]));
    expect(byName.get('Sugar 1 kg')).toMatchObject({ rate: 4800, unit: 'kg', category: 'Grocery', code: 'SUG' });
    expect(byName.get('Big Tin')!.rate).toBe(12345650);
    expect(byName.get('TEA')).toMatchObject({ rate: 120000, unit: 'cup', category: 'Drinks' });
    expect(byName.get('Free Sample')).toMatchObject({ rate: 0, unit: 'pcs' });
    const log = t.app.db.get<{ summary: string }>("SELECT summary FROM activity_log WHERE action = 'import.items'");
    expect(log?.summary).toBe('Imported items & rates from items.csv: 3 added, 1 updated, 3 with errors not imported');
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action = 'item.create'")).toBe(4);

    // Importing the same file again: nothing new.
    const again = await t.call('import.preview', { type: 'items', path: file, duplicateMode: 'update' });
    expect(again.counts.create).toBe(0);
    expect(again.rows.find((r) => r.rowNo === 2)).toMatchObject({ action: 'skip', note: 'Already exists with the same details' });
    expect((await t.fails('import.commit', { type: 'items', path: file, duplicateMode: 'skip' })).message).toBe('There is nothing to import: 4 already exist and 3 have errors. Fix the errors shown and try again.');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('lets the user change the column mapping and finds the header row below a title', async () => {
    const t = await createTestApp();
    const file = await writeXlsx(path.join(tmpDir(), 'price list.xlsx'), [
      ['Sharma Store price list'],
      [],
      ['Product', 'MRP', 'Selling Price'],
      ['Ghee 1 L', 650, 620],
      ['Butter 500 g', 280, 265],
    ]);
    const p = await t.call('import.preview', { type: 'items', path: file });
    expect(p.headerRowNo).toBe(3);
    expect(p.columns.map((c) => c.header)).toEqual(['Product', 'MRP', 'Selling Price']);
    expect(p.mapping.rate).toBe(2); // "selling price" is a better match than "mrp"
    expect(p.columns[1].samples).toEqual(['650', '280']);
    const remapped = await t.call('import.preview', { type: 'items', path: file, mapping: { rate: 1 } });
    expect(remapped.rows[0].values.rate).toBe('₹650.00');
    expect((await t.fails('import.preview', { type: 'items', path: file, mapping: { rate: 0 } })).message).toMatch(/chosen for both "Item name" and "Rate"/);
    const noName = await t.call('import.preview', { type: 'items', path: file, mapping: { name: null } });
    expect(noName.missingRequired).toEqual(['Item name']);
    expect(noName.counts.errors).toBe(2);
    expect((await t.fails('import.commit', { type: 'items', path: file, mapping: { name: null }, duplicateMode: 'skip' })).message).toMatch(/Choose the column that has the item name/);
    const res = await t.call('import.commit', { type: 'items', path: file, mapping: { rate: 1 }, duplicateMode: 'skip' });
    expect(res.created).toBe(2);
    expect((await t.call('items.list', {})).find((i) => i.name === 'Ghee 1 L')!.rate).toBe(65000);
  });

  it('rejects unsupported and missing files, and checks permissions', async () => {
    const t = await createTestApp();
    const xls = path.join(tmpDir(), 'old.xls');
    fs.writeFileSync(xls, 'x');
    expect((await t.fails('import.preview', { type: 'items', path: xls })).message).toMatch(/Old Excel files/);
    expect((await t.fails('import.preview', { type: 'items', path: '/nope/items.csv' })).code).toBe('NOT_FOUND');
    const broken = path.join(tmpDir(), 'broken.xlsx');
    fs.writeFileSync(broken, 'not a zip');
    expect((await t.fails('import.preview', { type: 'items', path: broken })).message).toMatch(/could not be read/);
    const empty = writeCsv(path.join(tmpDir(), 'empty.csv'), []);
    expect((await t.fails('import.preview', { type: 'items', path: empty })).message).toMatch(/file is empty/);

    const file = writeCsv(path.join(tmpDir(), 'c.csv'), [['Name'], ['Anita']]);
    await t.loginAs('cashier');
    expect((await t.fails('import.preview', { type: 'customers', path: file })).code).toBe('FORBIDDEN');
    // A manager may import, but only the kinds of records they may add.
    await t.loginOwner();
    await t.call('roles.update', { role: 'manager', permissions: DEFAULT_ROLE_PERMISSIONS.manager.filter((p) => p !== 'employees.manage') });
    await t.loginAs('manager');
    await t.call('import.preview', { type: 'customers', path: file });
    const err = await t.fails('import.preview', { type: 'employees', path: file });
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toMatch(/cannot import them/);
    const types = await t.call('import.types');
    expect(types.find((x) => x.type === 'employees')!.allowed).toBe(false);
  });
});

describe('import: customers & suppliers', () => {
  it('imports customers from Excel with opening balances posted to the ledger', async () => {
    const t = await createTestApp();
    const existing = await t.call('customers.create', { name: 'Old Friend', phone: '99999 00000', creditLimit: 100000 });
    const file = await writeXlsx(path.join(tmpDir(), 'customers.xlsx'), [
      ['Customer Name', 'Mobile No', 'Address', 'Email', 'Credit Limit', 'Opening Balance', 'Dr/Cr'],
      ['Anita Desai', '98200 11111', 'Kothrud, Pune', 'anita@example.com', '5,000', '1,250.50', 'Dr'],
      ['Rahul Traders', 9876543210, 'MG Road', '', '', '500 Cr', ''],
      ['Meena', '+91 98111 22222', '', '', '', -300, ''],
      ['Anil', '098200-11111', '', '', '', '', ''],
      ['Bad Mail', '', '', 'bad@', '', '', ''],
      ['Kiran', '', '', '', '', '100', 'maybe'],
      ['Friend Again', '9999900000', '', '', '2,000', '750', 'Receivable'],
      ['Lena Wala', '', '', '', '', '200', 'lena'],
    ]);
    const p = await t.call('import.preview', { type: 'customers', path: file });
    expect(p.mapping).toMatchObject({ name: 0, phone: 1, address: 2, email: 3, creditLimit: 4, opening: 5, openingType: 6 });
    expect(p.counts).toEqual({ total: 8, create: 4, update: 0, skip: 1, errors: 3 });
    const row = (n: number) => p.rows.find((r) => r.rowNo === n)!;
    expect(row(2).values).toMatchObject({ opening: '₹1,250.50 receivable', creditLimit: '₹5,000.00', phone: '98200 11111' });
    expect(row(3).values).toMatchObject({ opening: '₹500.00 advance', phone: '9876543210' });
    expect(row(4).values.opening).toBe('₹300.00 advance');
    expect(row(5).errors).toEqual(['Phone: same phone number as row 2']);
    expect(row(6).fieldErrors.email).toMatch(/not a valid email/);
    expect(row(7).fieldErrors.openingType).toMatch(/Use Receivable or Advance/);
    expect(row(8)).toMatchObject({ action: 'skip' });
    expect(row(9).values.opening).toBe('₹200.00 receivable');

    const res = await t.call('import.commit', { type: 'customers', path: file, duplicateMode: 'update' });
    expect(res).toMatchObject({ created: 4, updated: 1, errors: 3 });
    const list = await t.call('customers.list', {});
    const id = (name: string) => list.find((c) => c.name === name)!.id;
    const bal = (cid: number) => partyBalance(t.app.ctx(), 'customer', cid, { account: 'AR' });
    expect(bal(id('Anita Desai'))).toBe(125050);
    expect(bal(id('Rahul Traders'))).toBe(-50000);
    expect(bal(id('Meena'))).toBe(-30000);
    expect(bal(id('Lena Wala'))).toBe(20000);
    // Matched by phone: renamed, credit limit and opening balance updated.
    expect(bal(existing.id)).toBe(75000);
    expect((await t.call('customers.get', { id: existing.id }))).toMatchObject({ name: 'Friend Again', creditLimit: 200000, email: null });
    expect(systemBalance(t.app, 'OPENING_EQUITY')).toBe(-(125050 - 50000 - 30000 + 20000 + 75000));
    expect(systemBalance(t.app, 'AR')).toBe(125050 - 50000 - 30000 + 20000 + 75000);
    expect((await t.call('customers.get', { id: id('Anita Desai') }))).toMatchObject({ email: 'anita@example.com', address: 'Kothrud, Pune', creditLimit: 500000 });
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('imports suppliers from CSV with payable / advance balances', async () => {
    const t = await createTestApp();
    const file = writeCsv(
      path.join(tmpDir(), 'suppliers.csv'),
      [
        ['Supplier Name', 'Phone', 'Contact Person', 'Opening Balance', 'Balance Type'],
        ['Balaji Distributors', '98220 55555', 'Suresh Patil', '12,500.00', 'Payable'],
        ['Fresh Dairy Farm', '', 'Mahesh', '2,000', 'Advance'],
        ['Gupta & Sons', '', '', '5000', ''],
        ['Wrong Type', '', '', '10', 'maybe'],
        ['balaji distributors', '', '', '', ''],
      ],
      { bom: false },
    );
    const p = await t.call('import.preview', { type: 'suppliers', path: file });
    expect(p.counts).toEqual({ total: 5, create: 3, update: 0, skip: 0, errors: 2 });
    const res = await t.call('import.commit', { type: 'suppliers', path: file, duplicateMode: 'skip' });
    expect(res.created).toBe(3);
    const list = await t.call('suppliers.list', {});
    const bal = (name: string) => partyBalance(t.app.ctx(), 'supplier', list.find((s) => s.name === name)!.id, { account: 'AP' });
    expect(bal('Balaji Distributors')).toBe(-1250000);
    expect(bal('Fresh Dairy Farm')).toBe(200000);
    expect(bal('Gupta & Sons')).toBe(-500000);
    expect(list.find((s) => s.name === 'Balaji Distributors')).toMatchObject({ contactPerson: 'Suresh Patil', payable: 1250000 });
    expect(systemBalance(t.app, 'AP')).toBe(-1250000 + 200000 - 500000);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('blocks opening balances when the first financial year is closed', async () => {
    const t = await createTestApp();
    t.app.db.run("UPDATE financial_years SET is_closed = 1 WHERE start_date = '2026-04-01'");
    const file = writeCsv(path.join(tmpDir(), 'c.csv'), [
      ['Name', 'Opening balance'],
      ['Anita', '500'],
      ['Rahul', ''],
    ]);
    const p = await t.call('import.preview', { type: 'customers', path: file });
    expect(p.rows[0].fieldErrors.opening).toMatch(/2026-27 \(your first year\) is closed/);
    expect(p.counts).toMatchObject({ create: 1, errors: 1 });
    await t.call('import.commit', { type: 'customers', path: file, duplicateMode: 'skip' });
    expect((await t.call('customers.list', {})).map((c) => c.name)).toEqual(['Rahul']);
  });
});

describe('import: employees', () => {
  it('imports employees with Excel dates, serial numbers, DD/MM/YYYY and salary types', async () => {
    const t = await createTestApp();
    const file = await writeXlsx(path.join(tmpDir(), 'staff.xlsx'), [
      ['Employee Name', 'Designation', 'Date of Joining', 'Salary Type', 'Salary', 'Advance', 'Mobile'],
      ['Ramesh Kumar', 'Salesman', new Date(Date.UTC(2024, 5, 1)), 'Monthly', '15,000', '2,000', 9890012345],
      ['Sunita Pawar', 'Helper', '15/01/2025', 'Daily', 600, '', ''],
      ['Karan', '', 45306, 'per month', '12000', '', ''],
      ['Bad Date', '', '31-02-2024', 'Monthly', '100', '', ''],
      ['Weekly Guy', '', '', 'weekly', '100', '', ''],
      ['No Pay', '', '', '', '', '', ''],
    ]);
    const p = await t.call('import.preview', { type: 'employees', path: file });
    expect(p.mapping).toMatchObject({ name: 0, designation: 1, joinDate: 2, salaryType: 3, salaryAmount: 4, openingAdvance: 5, phone: 6 });
    expect(p.counts).toEqual({ total: 6, create: 4, update: 0, skip: 0, errors: 2 });
    expect(p.rows[0].values).toMatchObject({ joinDate: '01-06-2024', salaryType: 'Monthly', salaryAmount: '₹15,000.00', openingAdvance: '₹2,000.00', phone: '9890012345' });
    expect(p.rows[3].fieldErrors.joinDate).toMatch(/is not a date/);
    expect(p.rows[4].fieldErrors.salaryType).toMatch(/Use Monthly or Daily/);
    expect(p.rows[5].warnings[0]).toMatch(/No salary amount/);

    const res = await t.call('import.commit', { type: 'employees', path: file, duplicateMode: 'skip' });
    expect(res.created).toBe(4);
    const rows = t.app.db.all<{ name: string; join_date: string | null; salary_type: string; salary_amount: number; id: number }>('SELECT * FROM employees ORDER BY id');
    expect(rows.map((r) => [r.name, r.join_date, r.salary_type, r.salary_amount])).toEqual([
      ['Ramesh Kumar', '2024-06-01', 'monthly', 1500000],
      ['Sunita Pawar', '2025-01-15', 'daily', 60000],
      ['Karan', '2024-01-15', 'monthly', 1200000],
      ['No Pay', null, 'monthly', 0],
    ]);
    expect(partyBalance(t.app.ctx(), 'employee', rows[0].id, { account: 'EMP_ADV' })).toBe(200000);
    expect(systemBalance(t.app, 'EMP_ADV')).toBe(200000);

    // Update mode: raise Karan's salary, keep everything else.
    const upd = writeCsv(path.join(tmpDir(), 'raise.csv'), [
      ['Name', 'Salary'],
      ['karan', '13,500'],
    ]);
    const up = await t.call('import.preview', { type: 'employees', path: upd, duplicateMode: 'update' });
    expect(up.rows[0]).toMatchObject({ action: 'update', note: 'Will update name, salary' });
    await t.call('import.commit', { type: 'employees', path: upd, duplicateMode: 'update' });
    expect(t.app.db.get<any>("SELECT name, salary_amount, join_date FROM employees WHERE id = ?", [rows[2].id])).toEqual({ name: 'karan', salary_amount: 1350000, join_date: '2024-01-15' });
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('import: templates', () => {
  it('makes Excel and CSV templates that import cleanly', async () => {
    const t = await createTestApp();
    const dir = tmpDir();
    for (const type of ['items', 'customers', 'suppliers', 'employees'] as const) {
      for (const format of ['xlsx', 'csv'] as const) {
        const res = await t.call('import.template', { type, format });
        expect(res.path).toMatch(new RegExp(`\\.${format}$`));
        const saved = t.platform.saved.at(-1)!;
        const file = path.join(dir, `${type}.${format}`);
        fs.writeFileSync(file, typeof saved.data === 'string' ? saved.data : Buffer.from(saved.data));
        const p = await t.call('import.preview', { type, path: file });
        expect(p.counts, `${type} ${format}`).toEqual({ total: 2, create: 2, update: 0, skip: 0, errors: 0 });
        expect(p.missingRequired).toEqual([]);
        // Every template column is recognised.
        expect(Object.values(p.mapping).every((v) => v !== null), `${type} ${format}`).toBe(true);
        if (format === 'xlsx') {
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.readFile(file);
          expect(wb.worksheets.map((w) => w.name)).toContain('Instructions');
        }
      }
    }
    const types = await t.call('import.types');
    expect(types.find((x) => x.type === 'customers')!.notes.join(' ')).toContain('01-04-2026');
  });
});
