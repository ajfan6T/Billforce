/**
 * Backups: a consistent snapshot of the SQLite database (VACUUM INTO),
 * gzip-compressed into a single ".bfbackup" file. Restoring accepts these
 * files or a plain SQLite ".db" copy.
 *
 * NOTE: createBackup must not be called inside a database transaction
 * (SQLite cannot VACUUM inside one). Routes that back up first and then
 * change data must do the backup before opening their transaction.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Ctx } from '../../context';
import { now } from '../../context';
import { AppError, fail } from '../../errors';
import { getSection, updateSection } from '../../settings';
import { logActivity } from '../../audit';
import { Db } from '../../db/database';
import { LATEST_SCHEMA_VERSION, migrate } from '../../db/migrate';
import { seedReferenceData } from '../../seed';
import { toTimestamp } from '../../../shared/dates';

export type BackupKind = 'auto' | 'manual' | 'safety';

export const BACKUP_EXTENSION = 'bfbackup';

export const BACKUP_FILE_FILTERS = [
  { name: 'Billforce backup', extensions: [BACKUP_EXTENSION, 'db'] },
  { name: 'All files', extensions: ['*'] },
];

export function backupFolder(ctx: Ctx): string {
  return getSection(ctx, 'backup').folder || ctx.info.defaultBackupDir;
}

function stamp(ts: string): string {
  return ts.replace(/[-:]/g, '').replace(' ', '_');
}

export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Billforce';
}

/** "Sharma-General-Store_auto_20260928_101500.bfbackup" -> { kind: 'auto', at: '2026-09-28 10:15:00' } */
export function parseBackupFileName(fileName: string): { prefix: string; kind: BackupKind; at: string } | null {
  const m = /^(.*)_(auto|manual|safety)_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.bfbackup$/i.exec(fileName);
  if (!m) return null;
  return { prefix: m[1], kind: m[2].toLowerCase() as BackupKind, at: `${m[3]}-${m[4]}-${m[5]} ${m[6]}:${m[7]}:${m[8]}` };
}

export interface BackupInfo {
  path: string;
  sizeBytes: number;
  at: string;
  kind: BackupKind;
}

/** VACUUM INTO a temp file and gzip it into `file`. Returns the size of `file`. */
function writeSnapshot(ctx: Ctx, file: string): number {
  if (ctx.db.inTransaction) throw new AppError('INTERNAL', 'createBackup cannot run inside a transaction');
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new AppError('VALIDATION', `Cannot create the backup folder "${dir}": ${(e as Error).message}`);
  }
  const tmp = path.join(dir, `.billforce-tmp-${randomBytes(4).toString('hex')}.db`);
  try {
    ctx.db.vacuumInto(tmp);
    const gz = zlib.gzipSync(fs.readFileSync(tmp), { level: 6 });
    fs.writeFileSync(file, gz);
  } catch (e) {
    throw new AppError('VALIDATION', `Backup failed: ${(e as Error).message}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return fs.statSync(file).size;
}

function recordBackup(ctx: Ctx, kind: BackupKind, file: string, sizeBytes: number, at: string, note: string | null): void {
  ctx.db.insert('backup_history', { at, kind, path: file, size_bytes: sizeBytes, user_id: ctx.session?.userId ?? null, note });
  updateSection(ctx, 'backup', {
    lastBackupAt: at,
    lastBackupPath: file,
    ...(kind === 'auto' ? { lastAutoBackupAt: at } : {}),
  });
}

function defaultFileName(ctx: Ctx, kind: BackupKind, at: string): string {
  return `${safeName(getSection(ctx, 'business').name)}_${kind}_${stamp(at)}.${BACKUP_EXTENSION}`;
}

/** Write a compressed snapshot of the database into the backup folder (or targetPath). */
export function createBackup(ctx: Ctx, kind: BackupKind, opts: { note?: string; targetPath?: string } = {}): BackupInfo {
  if (ctx.db.inTransaction) throw new AppError('INTERNAL', 'createBackup cannot run inside a transaction');
  const at = now(ctx);
  let file = opts.targetPath ?? path.join(backupFolder(ctx), defaultFileName(ctx, kind, at));
  // Two backups in the same second (e.g. "Back up now" pressed twice) must not overwrite each other.
  if (!opts.targetPath && fs.existsSync(file)) file = file.replace(/\.bfbackup$/, `_${randomBytes(2).toString('hex')}.bfbackup`);
  const sizeBytes = writeSnapshot(ctx, file);
  recordBackup(ctx, kind, file, sizeBytes, at, opts.note ?? null);
  return { path: file, sizeBytes, at, kind };
}

/**
 * Turn a backup file (.bfbackup = gzip, or a raw SQLite file) into a
 * temporary SQLite file ready to be opened. Caller deletes it afterwards.
 */
export function extractBackup(file: string, tmpDir: string): string {
  if (!fs.existsSync(file)) throw new AppError('NOT_FOUND', 'Backup file not found');
  const buf = fs.readFileSync(file);
  let raw: Buffer;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      raw = zlib.gunzipSync(buf);
    } catch {
      throw new AppError('VALIDATION', 'This backup file is damaged and cannot be read');
    }
  } else {
    raw = buf;
  }
  if (raw.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
    throw new AppError('VALIDATION', 'This is not a Billforce backup file');
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  const out = path.join(tmpDir, `restore-${randomBytes(4).toString('hex')}.db`);
  fs.writeFileSync(out, raw);
  return out;
}

/** Same as BillforceApp.openDatabase (open, migrate, seed) without importing the app (avoids a module cycle). */
function openAndMigrate(file: string, at: Date): Db {
  const db = new Db(file);
  try {
    migrate(db);
    seedReferenceData(db, toTimestamp(at));
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billforce-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------ Listing & status ------------------------------ */

export interface BackupListItem {
  path: string;
  fileName: string;
  at: string;
  kind: BackupKind | 'other';
  sizeBytes: number;
  note: string | null;
  /** The file is in the current backup folder. */
  inFolder: boolean;
}

const pathKey = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

function toTimestampLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Backups in the backup folder plus any recorded elsewhere (e.g. copies on a pen drive) that still exist. Newest first. */
export function listBackups(ctx: Ctx, limit = 200): BackupListItem[] {
  const folder = backupFolder(ctx);
  const history = ctx.db.all<{ at: string; kind: BackupKind; path: string; size_bytes: number | null; note: string | null }>(
    'SELECT at, kind, path, size_bytes, note FROM backup_history ORDER BY at DESC, id DESC LIMIT 2000',
  );
  const byPath = new Map<string, BackupListItem>();
  const folderKey = pathKey(folder);
  const inFolder = (p: string) => pathKey(path.dirname(p)) === folderKey;
  let files: string[] = [];
  try {
    files = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith(`.${BACKUP_EXTENSION}`));
  } catch {
    files = [];
  }
  for (const f of files) {
    const full = path.join(folder, f);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    const parsed = parseBackupFileName(f);
    byPath.set(pathKey(full), {
      path: full,
      fileName: f,
      at: parsed?.at ?? toTimestampLocal(st.mtime),
      kind: parsed?.kind ?? 'other',
      sizeBytes: st.size,
      note: null,
      inFolder: true,
    });
  }
  for (const h of history) {
    const key = pathKey(h.path);
    const existing = byPath.get(key);
    if (existing) {
      if (!existing.note) existing.note = h.note;
      existing.kind = h.kind;
      existing.at = h.at;
      continue;
    }
    if (inFolder(h.path)) continue; // recorded but deleted since
    try {
      const st = fs.statSync(h.path);
      byPath.set(key, { path: h.path, fileName: path.basename(h.path), at: h.at, kind: h.kind, sizeBytes: st.size, note: h.note, inFolder: false });
    } catch {
      /* file no longer there (pen drive removed / deleted) */
    }
  }
  return [...byPath.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

export function backupStatus(ctx: Ctx) {
  const s = getSection(ctx, 'backup');
  const folder = backupFolder(ctx);
  let lastExists = false;
  if (s.lastBackupPath) {
    try {
      lastExists = fs.statSync(s.lastBackupPath).isFile();
    } catch {
      lastExists = false;
    }
  }
  const last = ctx.db.get<{ at: string; kind: BackupKind; path: string; size_bytes: number | null }>(
    'SELECT at, kind, path, size_bytes FROM backup_history ORDER BY at DESC, id DESC LIMIT 1',
  );
  const backups = listBackups(ctx);
  let lastBackup: { at: string; path: string | null; sizeBytes: number | null; kind: BackupKind | 'other' | null; exists: boolean } | null = s.lastBackupAt
    ? { at: s.lastBackupAt, path: s.lastBackupPath, sizeBytes: last && last.path === s.lastBackupPath ? last.size_bytes : null, kind: last?.kind ?? null, exists: lastExists }
    : null;
  // After a restore the database cannot know about backups taken later (e.g. the backup it came from),
  // so a newer Billforce backup file in the folder counts as the last backup (files dated only by
  // their modified time, e.g. copied in from elsewhere, do not).
  const newest = backups.find((b) => b.kind !== 'other');
  if (newest && (!lastBackup || newest.at > lastBackup.at)) {
    lastBackup = { at: newest.at, path: newest.path, sizeBytes: newest.sizeBytes, kind: newest.kind, exists: true };
  }
  return {
    folder,
    isDefaultFolder: !s.folder,
    defaultFolder: ctx.info.defaultBackupDir,
    autoBackup: s.autoBackup,
    keepCount: s.keepCount,
    lastAutoBackupAt: s.lastAutoBackupAt,
    lastBackup,
    backups,
    canRestore: ctx.info.dbPath !== ':memory:',
  };
}

/* ------------------------------ Pruning ------------------------------ */

const AUTO_NAME_RE = /_auto_\d{8}_\d{6}(_[0-9a-f]{4})?\.bfbackup$/i;

/**
 * Keep only the newest `keepCount` automatic backups: older automatic backup
 * files are deleted together with their history rows. Manual and safety
 * backups are never touched, and only files named like Billforce automatic
 * backups are ever deleted.
 */
export function pruneAutoBackups(ctx: Ctx, keepCount = getSection(ctx, 'backup').keepCount): string[] {
  const folder = backupFolder(ctx);
  const prefix = `${safeName(getSection(ctx, 'business').name)}_`;
  const items = new Map<string, { path: string; at: string; ids: number[] }>();
  for (const h of ctx.db.all<{ id: number; at: string; path: string }>("SELECT id, at, path FROM backup_history WHERE kind = 'auto'")) {
    const key = pathKey(h.path);
    const it = items.get(key) ?? { path: h.path, at: h.at, ids: [] };
    it.ids.push(h.id);
    if (h.at > it.at) it.at = h.at;
    items.set(key, it);
  }
  try {
    for (const f of fs.readdirSync(folder)) {
      if (!AUTO_NAME_RE.test(f) || !f.startsWith(prefix)) continue;
      const full = path.join(folder, f);
      const key = pathKey(full);
      if (items.has(key)) continue;
      const parsed = parseBackupFileName(f.replace(/_[0-9a-f]{4}\.bfbackup$/i, '.bfbackup'));
      if (parsed) items.set(key, { path: full, at: parsed.at, ids: [] });
    }
  } catch {
    /* folder missing: nothing to prune there */
  }
  const sorted = [...items.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const deleted: string[] = [];
  for (const it of sorted.slice(Math.max(0, keepCount))) {
    if (AUTO_NAME_RE.test(path.basename(it.path))) {
      try {
        fs.rmSync(it.path, { force: true });
        deleted.push(it.path);
      } catch (e) {
        console.error(`[backup] could not delete old backup ${it.path}:`, e);
        continue;
      }
    }
    for (const id of it.ids) ctx.db.run('DELETE FROM backup_history WHERE id = ?', [id]);
  }
  return deleted;
}

/* ------------------------------ Manual backup, copy, folder ------------------------------ */

export function manualBackup(ctx: Ctx, note?: string | null): BackupInfo {
  const info = createBackup(ctx, 'manual', { note: note ?? undefined });
  logActivity(ctx, 'backup.create', `Backed up data to ${info.path}${note ? ` (${note})` : ''}`, { details: { path: info.path, sizeBytes: info.sizeBytes } });
  return info;
}

/** Take a fresh backup and let the user save it anywhere (e.g. a pen drive). */
export async function saveBackupCopy(ctx: Ctx): Promise<{ path: string | null; sizeBytes: number }> {
  const at = now(ctx);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billforce-copy-'));
  try {
    const tmpFile = path.join(dir, 'copy.bfbackup');
    const sizeBytes = writeSnapshot(ctx, tmpFile);
    const saved = await ctx.platform.saveFile({
      defaultName: defaultFileName(ctx, 'manual', at),
      data: new Uint8Array(fs.readFileSync(tmpFile)),
      filters: [{ name: 'Billforce backup', extensions: [BACKUP_EXTENSION] }],
    });
    if (!saved) return { path: null, sizeBytes };
    ctx.db.tx(() => {
      recordBackup(ctx, 'manual', saved, sizeBytes, at, 'Copy saved by you');
      logActivity(ctx, 'backup.copy', `Saved a backup copy to ${saved}`, { details: { path: saved, sizeBytes } });
    });
    return { path: saved, sizeBytes };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------ Inspect & restore ------------------------------ */

export interface BackupInspection {
  path: string;
  fileName: string;
  sizeBytes: number;
  businessName: string;
  /** When the backup was taken (from the file name), or the time of the last activity in it. */
  backupAt: string | null;
  lastActivityAt: string | null;
  schemaVersion: number;
  counts: { bills: number; customers: number; suppliers: number; items: number; employees: number; users: number };
  lastBillDate: string | null;
  /** SQLite quick check passed. */
  healthy: boolean;
}

function notBillforce(): AppError {
  return new AppError('VALIDATION', 'This file is not a Billforce backup. Choose a file ending in .bfbackup made by Billforce.');
}

/** Read what is inside a backup (without changing anything) for the restore confirmation. */
export function inspectBackup(ctx: Ctx, file: string): BackupInspection {
  void ctx;
  if (!fs.existsSync(file)) throw fail.notFound('Backup file');
  const sizeBytes = fs.statSync(file).size;
  return withTempDir((dir) => {
    const raw = extractBackup(file, dir);
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(raw);
    } catch {
      throw notBillforce();
    }
    try {
      const one = <T>(sql: string, fallback: T): T => {
        const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
        const v = row ? Object.values(row)[0] : undefined;
        return (v === undefined || v === null ? fallback : v) as T;
      };
      let schemaVersion = 0;
      let settings: Array<{ key: string; value: string }> = [];
      try {
        schemaVersion = one<number>('PRAGMA user_version', 0);
        settings = db.prepare('SELECT key, value FROM settings').all() as any;
      } catch {
        throw notBillforce();
      }
      if (!schemaVersion) throw notBillforce();
      if (schemaVersion > LATEST_SCHEMA_VERSION) {
        throw fail.validation('This backup was made by a newer version of Billforce. Install the latest version of Billforce to restore it.');
      }
      const meta = new Map(settings.map((s) => [s.key, s.value]));
      if (meta.get('meta.setup_done') !== '1') throw notBillforce();
      let businessName = '';
      try {
        businessName = JSON.parse(meta.get('business') ?? '{}').name ?? '';
      } catch {
        businessName = '';
      }
      const count = (table: string) => {
        try {
          return one<number>(`SELECT COUNT(*) FROM ${table}`, 0);
        } catch {
          return 0;
        }
      };
      let lastBillDate: string | null = null;
      let lastActivityAt: string | null = null;
      try {
        lastBillDate = one<string | null>("SELECT MAX(date) FROM bills WHERE status = 'active'", null);
        lastActivityAt = one<string | null>('SELECT MAX(at) FROM activity_log', null);
      } catch {
        /* older layouts */
      }
      const healthy = one<string>('PRAGMA quick_check', '') === 'ok';
      return {
        path: file,
        fileName: path.basename(file),
        sizeBytes,
        businessName,
        backupAt: parseBackupFileName(path.basename(file))?.at ?? lastActivityAt,
        lastActivityAt,
        schemaVersion,
        counts: {
          bills: count('bills'),
          customers: count('customers'),
          suppliers: count('suppliers'),
          items: count('items'),
          employees: count('employees'),
          users: count('users'),
        },
        lastBillDate,
        healthy,
      };
    } finally {
      db.close();
    }
  });
}

export interface RestoreResult {
  restoredFrom: string;
  businessName: string;
  safetyBackupPath: string;
}

/**
 * Replace all current data with a backup:
 * extract -> validate a copy (opens and migrates, integrity check, set-up business)
 * -> safety backup of the current data -> swap the database -> log in the NEW database.
 * The logged-in session ends (the app shows the login screen again).
 */
export function restoreBackup(ctx: Ctx, file: string): RestoreResult {
  if (ctx.info.dbPath === ':memory:') throw fail.validation('Restore is not available in this mode.');
  if (ctx.db.inTransaction) throw new AppError('INTERNAL', 'restoreBackup cannot run inside a transaction');
  if (!fs.existsSync(file)) throw fail.notFound('Backup file');
  const session = ctx.session;
  return withTempDir((dir) => {
    const raw = extractBackup(file, dir);
    // Validate on a copy so the file we swap in is exactly the backup.
    const probePath = path.join(dir, 'probe.db');
    fs.copyFileSync(raw, probePath);
    let probe: Db;
    try {
      probe = openAndMigrate(probePath, ctx.clock());
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (/newer version/i.test(msg)) throw fail.validation('This backup was made by a newer version of Billforce. Install the latest version of Billforce to restore it.');
      throw notBillforce();
    }
    let businessName = '';
    try {
      const integrity = probe.value<string>('PRAGMA integrity_check', undefined, '');
      if (integrity !== 'ok') throw fail.validation('This backup file is damaged and cannot be restored. Try an older backup.');
      if (probe.value<string | null>("SELECT value FROM settings WHERE key = 'meta.setup_done'", undefined, null) !== '1') throw notBillforce();
      const owners = probe.value<number>("SELECT COUNT(*) FROM users WHERE role = 'owner'", undefined, 0);
      if (!owners) throw fail.validation('This backup has no owner login, so it cannot be restored.');
      try {
        businessName = JSON.parse(probe.value<string>("SELECT value FROM settings WHERE key = 'business'", undefined, '{}')).name ?? '';
      } catch {
        businessName = '';
      }
    } finally {
      probe.close();
    }

    const safety = createBackup(ctx, 'safety', { note: `Before restoring ${path.basename(file)}` });
    ctx.app.replaceDatabase(raw);

    // Record the restore in the NEW database (a fresh context on the swapped-in file),
    // attributed to the same person when their login exists there.
    const fresh = new Db(ctx.info.dbPath);
    try {
      const userId = session ? fresh.value<number | null>('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [session.username], null) : null;
      const freshCtx: Ctx = { ...ctx, db: fresh, session: session && userId ? { ...session, userId } : null };
      const by = session && !userId ? ` by ${session.fullName}` : '';
      // The safety copy belongs to the history of this installation, so keep a record of it in the new data too.
      fresh.insert('backup_history', {
        at: safety.at,
        kind: 'safety',
        path: safety.path,
        size_bytes: safety.sizeBytes,
        user_id: freshCtx.session?.userId ?? null,
        note: `Before restoring ${path.basename(file)}`,
      });
      logActivity(freshCtx, 'backup.restore', `Restored data from ${path.basename(file)}${businessName ? ` (${businessName})` : ''}${by}. The data from before the restore was saved to ${safety.path}`, {
        details: { from: file, safetyBackup: safety.path, by: session?.username ?? null },
      });
    } finally {
      fresh.close();
    }
    return { restoredFrom: file, businessName, safetyBackupPath: safety.path };
  });
}
