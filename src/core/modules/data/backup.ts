/**
 * Backups: a consistent snapshot of the SQLite database (VACUUM INTO),
 * gzip-compressed into a single ".bfbackup" file. Restoring accepts these
 * files or a plain SQLite ".db" copy (with its -wal file, if one is next to it),
 * but never the database file Billforce is using right now.
 *
 * NOTE: createBackup / createBackupAsync must not be called inside a database transaction
 * (SQLite cannot VACUUM inside one). Routes that back up first and then
 * change data must do the backup before opening their transaction.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
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
import { SaveFileError } from '../../platform';

export type BackupKind = 'auto' | 'manual' | 'safety';

export const BACKUP_EXTENSION = 'bfbackup';

export const BACKUP_FILE_FILTERS = [
  { name: 'Billforce backup', extensions: [BACKUP_EXTENSION, 'db'] },
  { name: 'All files', extensions: ['*'] },
];

/** Comparable form of a file path (Windows paths are not case-sensitive). */
const pathKey = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

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

/* ------------------------------ Writing a backup file safely ------------------------------ */
/*
 * A backup must never leave a damaged file that looks like a good one (a full pen drive, a drive pulled out,
 * a crash half-way). So every backup is written like this:
 *   1. VACUUM INTO a private temp folder on this computer (a consistent snapshot; this step is synchronous,
 *      SQLite has no asynchronous API) and check the snapshot: SQLite header, opens, PRAGMA quick_check.
 *   2. Compress it into "<final name>.partial" in the backup folder and fsync it.
 *   3. Read the partial file back, gunzip it and compare it (SHA-256 and size) with the snapshot, so the file
 *      on the disk / pen drive is exactly the checked snapshot.
 *   4. Rename it to the final ".bfbackup" name. Only then is the backup recorded (backup_history, lastBackupAt).
 * On any failure the partial file is deleted and a plain-English error is thrown.
 *
 * Two variants: createBackupAsync (manual and daily automatic backups) compresses and verifies with zlib
 * streams on the libuv thread pool, so the app keeps working while the backup is written. createBackup is
 * fully synchronous; it is kept for callers that must finish before going on: the backup when Billforce closes
 * (the app is quitting and cannot wait for a promise), the safety backups before year-end close / re-open and
 * before a restore (they run right before changing all the data). It uses a faster compression level so the
 * pause is short.
 */

/** Compression levels: the asynchronous path does not block, so it can afford a better ratio. */
const ASYNC_GZIP_LEVEL = 6;
const SYNC_GZIP_LEVEL = 1;
const PARTIAL_SUFFIX = '.partial';
/** Leftovers of a backup interrupted by a crash / power cut are removed once they are this old. */
const STALE_TEMP_MS = 15 * 60_000;
/** Temp files older versions of Billforce wrote into the backup folder itself. */
const LEGACY_TEMP_RE = /^\.billforce-tmp-[0-9a-f]+\.db(-wal|-shm|-journal)?$/i;

/** Backups being written right now (final paths): gives same-second backups different names, keeps the sweep off them. */
const inProgress = new Set<string>();

/** Is a backup being written at this moment (e.g. the daily one, in the background)? */
export function backupInProgress(): boolean {
  return inProgress.size > 0;
}

interface SnapshotDigest {
  sha256: string;
  size: number;
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureFolder(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new AppError('VALIDATION', `Cannot create the backup folder "${dir}": ${(e as Error).message}`);
  }
}

/** Plain-English reason for a failed backup. `stage` says which step failed. */
function backupError(e: unknown, dir: string, stage: 'snapshot' | 'write' | 'verify'): AppError {
  if (e instanceof AppError) return e;
  const err = e as NodeJS.ErrnoException | undefined;
  const code = err?.code ?? '';
  const msg = err?.message ?? String(e);
  if (stage === 'snapshot') {
    if (code === 'ENOSPC' || /disk is full|database or disk is full|SQLITE_FULL/i.test(msg)) {
      return new AppError('VALIDATION', "There is not enough free space on this computer's disk to prepare the backup. Free some space and try again.");
    }
    return new AppError('VALIDATION', `The data could not be copied for the backup (${msg}). Try again; if it keeps failing, restart Billforce.`);
  }
  if (stage === 'verify') {
    return new AppError(
      'VALIDATION',
      `The backup saved in "${dir}" could not be read back correctly, so it was deleted. The disk or pen drive may be faulty or full. Try again or choose another backup folder.`,
    );
  }
  if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EFBIG') {
    return new AppError('VALIDATION', `The disk or pen drive with the backup folder "${dir}" is full, so the backup could not be saved. Free some space or choose another backup folder.`);
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new AppError('VALIDATION', `Billforce is not allowed to save files in the backup folder "${dir}" (it may be read-only). Choose another backup folder.`);
  }
  if (['ENOENT', 'ENODEV', 'ENXIO', 'EIO', 'ENOTDIR', 'ENOTCONN', 'ESTALE'].includes(code)) {
    return new AppError('VALIDATION', `The backup folder "${dir}" is not available (was the pen drive removed?). Connect it again or choose another backup folder.`);
  }
  return new AppError('VALIDATION', `The backup could not be saved in "${dir}": ${msg}`);
}

/** A healthy SQLite database: right header, opens, passes PRAGMA quick_check and has a schema version. */
function checkSnapshot(file: string): void {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1') !== 'SQLite format 3\u0000') throw new Error('the copy is not an SQLite database');
  const db = new DatabaseSync(file);
  try {
    const check = (db.prepare('PRAGMA quick_check(1)').get() as { quick_check?: string } | undefined)?.quick_check;
    if (check !== 'ok') throw new Error(`the copy failed the health check (${check ?? 'no result'})`);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0;
    if (!version) throw new Error('the copy has no Billforce data');
  } finally {
    db.close();
  }
}

let tempDirsSwept = false;

/**
 * Snapshot folders in the system temp folder are removed when a backup ends; a crash or power cut can
 * leave one behind (as large as the database). Once per run, remove those older than a few hours
 * (never one a running backup - of this or another Billforce - is using).
 */
function sweepOldTempDirs(): void {
  if (tempDirsSwept) return;
  tempDirsSwept = true;
  const tmp = os.tmpdir();
  const cutoff = Date.now() - 6 * 60 * 60_000;
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (!/^billforce-(backup|copy)-/.test(name)) continue;
      const full = path.join(tmp, name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory() && st.mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
      } catch {
        /* in use or gone */
      }
    }
  } catch {
    /* temp folder not readable */
  }
}

/** Step 1: consistent snapshot in a private temp folder (the caller removes `dir`). */
function takeSnapshot(ctx: Ctx, backupDir: string): { dir: string; file: string } {
  if (ctx.db.inTransaction) throw new AppError('INTERNAL', 'createBackup cannot run inside a transaction');
  sweepOldTempDirs();
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billforce-backup-'));
  } catch (e) {
    throw backupError(e, backupDir, 'snapshot');
  }
  const file = path.join(dir, 'snapshot.db');
  try {
    ctx.db.vacuumInto(file);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw backupError(e, backupDir, 'snapshot');
  }
  try {
    checkSnapshot(file);
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new AppError('VALIDATION', `The backup was not saved because ${(e as Error).message}. Restart Billforce and try again.`);
  }
  return { dir, file };
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return; // Windows cannot open a folder for fsync; NTFS journals the rename.
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* best effort */
  }
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Steps 2-4, synchronously. */
function writeCompressedSync(snapshot: string, file: string): number {
  const dir = path.dirname(file);
  const partial = file + PARTIAL_SUFFIX;
  let digest: SnapshotDigest;
  try {
    const raw = fs.readFileSync(snapshot);
    digest = { sha256: sha256(raw), size: raw.length };
    const gz = zlib.gzipSync(raw, { level: SYNC_GZIP_LEVEL });
    const fd = fs.openSync(partial, 'w');
    try {
      let off = 0;
      while (off < gz.length) off += fs.writeSync(fd, gz, off, gz.length - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    fs.rmSync(partial, { force: true });
    throw backupError(e, dir, 'write');
  }
  try {
    const back = zlib.gunzipSync(fs.readFileSync(partial));
    if (back.length !== digest.size || sha256(back) !== digest.sha256) throw new Error('mismatch');
  } catch (e) {
    fs.rmSync(partial, { force: true });
    throw backupError(e, dir, 'verify');
  }
  try {
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(partial, file);
        break;
      } catch (e) {
        // Antivirus / indexing can hold a brand-new file for a moment on Windows.
        if (i >= 4 || !RETRYABLE_RENAME.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
        sleepSync(100);
      }
    }
  } catch (e) {
    fs.rmSync(partial, { force: true });
    throw backupError(e, dir, 'write');
  }
  fsyncDir(dir);
  return fs.statSync(file).size;
}

/** Hash + size of everything that passes through. */
function digestTap(): { tap: Transform; result: () => SnapshotDigest } {
  const hash = createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  return { tap, result: () => ({ sha256: hash.digest('hex'), size }) };
}

/** Steps 2-4, with zlib streams (compression and decompression run on the thread pool). */
async function writeCompressedAsync(snapshot: string, file: string): Promise<number> {
  const dir = path.dirname(file);
  const partial = file + PARTIAL_SUFFIX;
  let digest: SnapshotDigest;
  try {
    const src = digestTap();
    await pipeline(fs.createReadStream(snapshot), src.tap, zlib.createGzip({ level: ASYNC_GZIP_LEVEL }), fs.createWriteStream(partial, { flush: true }));
    digest = src.result();
  } catch (e) {
    await fsp.rm(partial, { force: true });
    throw backupError(e, dir, 'write');
  }
  try {
    const back = digestTap();
    await pipeline(
      fs.createReadStream(partial),
      zlib.createGunzip(),
      back.tap,
      new Writable({
        write(_chunk, _enc, cb) {
          cb();
        },
      }),
    );
    const got = back.result();
    if (got.size !== digest.size || got.sha256 !== digest.sha256) throw new Error('mismatch');
  } catch (e) {
    await fsp.rm(partial, { force: true });
    throw backupError(e, dir, 'verify');
  }
  try {
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(partial, file);
        break;
      } catch (e) {
        if (i >= 4 || !RETRYABLE_RENAME.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  } catch (e) {
    await fsp.rm(partial, { force: true });
    throw backupError(e, dir, 'write');
  }
  fsyncDir(dir);
  return (await fsp.stat(file)).size;
}

/**
 * Remove what interrupted backups left in the backup folder: "<name>.bfbackup.partial" files and the
 * ".billforce-tmp-*.db" snapshots older versions wrote there. Only files older than STALE_TEMP_MS that
 * no running backup is writing.
 */
function sweepStaleTemps(folder: string, names?: string[]): void {
  let files: string[];
  try {
    files = names ?? fs.readdirSync(folder);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TEMP_MS;
  for (const f of files) {
    const partial = f.toLowerCase().endsWith(`.${BACKUP_EXTENSION}${PARTIAL_SUFFIX}`);
    if (!partial && !LEGACY_TEMP_RE.test(f)) continue;
    const full = path.join(folder, f);
    if (partial && inProgress.has(pathKey(full.slice(0, -PARTIAL_SUFFIX.length)))) continue;
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.mtimeMs < cutoff) fs.rmSync(full, { force: true });
    } catch {
      /* gone already / cannot delete: try again next time */
    }
  }
}

/** Choose the file name for a new backup and mark it as being written. */
function reserveTarget(ctx: Ctx, kind: BackupKind, at: string, targetPath?: string): string {
  let file = targetPath ?? path.join(backupFolder(ctx), defaultFileName(ctx, kind, at));
  // Two backups in the same second (e.g. "Back up now" pressed twice) must not overwrite each other.
  if (!targetPath) {
    while (fs.existsSync(file) || inProgress.has(pathKey(file))) file = file.replace(/(_[0-9a-f]{4})?\.bfbackup$/, `_${randomBytes(2).toString('hex')}.bfbackup`);
  }
  inProgress.add(pathKey(file));
  return file;
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

export interface CreateBackupOptions {
  note?: string;
  targetPath?: string;
}

/**
 * Write a verified, compressed snapshot of the database into the backup folder (or targetPath), synchronously.
 * Blocks the app while it runs: use createBackupAsync unless the caller must finish first (see above).
 * Nothing is recorded, and no file is left behind, when it fails.
 */
export function createBackup(ctx: Ctx, kind: BackupKind, opts: CreateBackupOptions = {}): BackupInfo {
  if (ctx.db.inTransaction) throw new AppError('INTERNAL', 'createBackup cannot run inside a transaction');
  const at = now(ctx);
  const file = reserveTarget(ctx, kind, at, opts.targetPath);
  let sizeBytes: number;
  try {
    const dir = path.dirname(file);
    ensureFolder(dir);
    sweepStaleTemps(dir);
    const snap = takeSnapshot(ctx, dir);
    try {
      sizeBytes = writeCompressedSync(snap.file, file);
    } finally {
      fs.rmSync(snap.dir, { recursive: true, force: true });
    }
  } finally {
    inProgress.delete(pathKey(file));
  }
  recordBackup(ctx, kind, file, sizeBytes, at, opts.note ?? null);
  return { path: file, sizeBytes, at, kind };
}

/**
 * Same as createBackup, but compresses and verifies off the main thread, so billing goes on while the
 * backup is written. Only the snapshot itself (VACUUM INTO + quick check) runs synchronously.
 */
export async function createBackupAsync(ctx: Ctx, kind: BackupKind, opts: CreateBackupOptions = {}): Promise<BackupInfo> {
  if (ctx.db.inTransaction) throw new AppError('INTERNAL', 'createBackup cannot run inside a transaction');
  const at = now(ctx);
  const file = reserveTarget(ctx, kind, at, opts.targetPath);
  let sizeBytes: number;
  try {
    const dir = path.dirname(file);
    ensureFolder(dir);
    sweepStaleTemps(dir);
    const snap = takeSnapshot(ctx, dir);
    try {
      sizeBytes = await writeCompressedAsync(snap.file, file);
    } finally {
      await fsp.rm(snap.dir, { recursive: true, force: true });
    }
  } finally {
    inProgress.delete(pathKey(file));
  }
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
  // A plain .db copied together with its "-wal" file: the newest changes are still in the -wal file.
  // Bring them into the copy (open + checkpoint), otherwise they would be silently lost.
  if (raw !== buf) return out;
  let wal: fs.Stats | null = null;
  try {
    wal = fs.statSync(`${file}-wal`);
  } catch {
    wal = null;
  }
  if (wal?.isFile() && wal.size > 0) {
    fs.copyFileSync(`${file}-wal`, `${out}-wal`);
    try {
      const db = new DatabaseSync(out);
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.exec('PRAGMA journal_mode = DELETE');
      } finally {
        db.close();
      }
    } catch {
      throw new AppError('VALIDATION', 'This backup file is damaged and cannot be read');
    } finally {
      for (const suffix of ['-wal', '-shm']) fs.rmSync(out + suffix, { force: true });
    }
  }
  return out;
}

/** Comparable identity of a file (same file under another name, e.g. a Windows short name or a hard link). */
function sameFile(a: string, b: string): boolean {
  if (pathKey(a) === pathKey(b)) return true;
  try {
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    return sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

export const LIVE_DATABASE_MESSAGE =
  'This is the data file Billforce is using right now, not a backup. Restoring it would lose your latest entries. Choose a backup file (.bfbackup) from the backup folder or your pen drive instead.';

/** Refuse the live database file (and its -wal / -shm files): it is not a backup, and its newest changes are in the -wal file. */
function refuseLiveDatabase(ctx: Ctx, file: string): void {
  const live = ctx.info.dbPath;
  if (!live || live === ':memory:') return;
  const candidates = [live, `${live}-wal`, `${live}-shm`, `${live}-journal`, `${live}.restore-tmp`];
  if (candidates.some((c) => sameFile(file, c))) throw fail.validation(LIVE_DATABASE_MESSAGE);
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
  /** What kind of backup this is, in words ("Automatic", "Before year-end close", ...). */
  label: string;
  /** The file is in the current backup folder. */
  inFolder: boolean;
  /** The file is cut short or is not a backup at all (e.g. a copy that ran out of space): it cannot be restored. */
  damaged: boolean;
}

/**
 * Words for the type of a backup. Safety copies are taken before a restore and before closing or
 * re-opening a financial year; their note says which.
 */
export function backupLabel(kind: BackupKind | 'other', note: string | null): string {
  if (kind === 'auto') return 'Automatic';
  if (kind === 'manual') return 'Manual';
  if (kind === 'other') return 'Backup file';
  const n = note ?? '';
  if (/^before restoring/i.test(n)) return 'Before restore';
  if (/before closing (the )?financial year/i.test(n)) return 'Before year-end close';
  if (/before re-?opening (the )?financial year/i.test(n)) return 'Before re-opening year';
  return 'Safety copy';
}

/**
 * Cheap check that a backup file is complete, without reading it all: a Billforce backup is gzip, and the
 * gzip trailer holds the uncompressed size, which for an SQLite file is a whole number of pages (multiple
 * of 512). A file cut short ends in the middle of compressed data, so that number is almost never valid.
 * A plain SQLite file renamed to .bfbackup counts as complete.
 */
export function backupLooksComplete(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('latin1') === 'SQLite format 3\u0000') return size % 512 === 0;
    if (head[0] !== 0x1f || head[1] !== 0x8b || size < 18 + 20) return false;
    const tail = Buffer.alloc(4);
    fs.readSync(fd, tail, 0, 4, size - 4);
    const isize = tail.readUInt32LE(0);
    return isize > 0 && isize % 512 === 0;
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

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
    const all = fs.readdirSync(folder);
    sweepStaleTemps(folder, all);
    files = all.filter((f) => f.toLowerCase().endsWith(`.${BACKUP_EXTENSION}`));
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
      label: '',
      inFolder: true,
      damaged: !backupLooksComplete(full),
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
      byPath.set(key, {
        path: h.path,
        fileName: path.basename(h.path),
        at: h.at,
        kind: h.kind,
        sizeBytes: st.size,
        note: h.note,
        label: '',
        inFolder: false,
        damaged: !backupLooksComplete(h.path),
      });
    } catch {
      /* file no longer there (pen drive removed / deleted) */
    }
  }
  for (const b of byPath.values()) b.label = backupLabel(b.kind, b.note);
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
  let lastBackup: { at: string; path: string | null; sizeBytes: number | null; kind: BackupKind | 'other' | null; exists: boolean; damaged: boolean } | null = s.lastBackupAt
    ? {
        at: s.lastBackupAt,
        path: s.lastBackupPath,
        sizeBytes: last && last.path === s.lastBackupPath ? last.size_bytes : null,
        kind: last?.kind ?? null,
        exists: lastExists,
        damaged: lastExists && !!s.lastBackupPath && !backupLooksComplete(s.lastBackupPath),
      }
    : null;
  // After a restore the database cannot know about backups taken later (e.g. the backup it came from),
  // so a newer Billforce backup file in the folder counts as the last backup (files dated only by
  // their modified time, e.g. copied in from elsewhere, do not).
  // A damaged file (e.g. left by an older version when the disk was full) never counts as a backup.
  const newest = backups.find((b) => b.kind !== 'other' && !b.damaged);
  if (newest && (!lastBackup || newest.at > lastBackup.at || lastBackup.damaged)) {
    lastBackup = { at: newest.at, path: newest.path, sizeBytes: newest.sizeBytes, kind: newest.kind, exists: true, damaged: false };
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
 * backups are ever deleted. A damaged automatic backup (cut short) never takes
 * one of the `keepCount` places and is removed.
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
  const byDate = (a: { at: string }, b: { at: string }) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
  const isDamaged = (p: string) => fs.existsSync(p) && !backupLooksComplete(p);
  const all = [...items.values()];
  const damaged = all.filter((it) => isDamaged(it.path));
  const good = all.filter((it) => !damaged.includes(it)).sort(byDate);
  const deleted: string[] = [];
  for (const it of [...good.slice(Math.max(0, keepCount)), ...damaged]) {
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

/** "Back up now". Written in the background (see createBackupAsync), so the app stays usable meanwhile. */
export async function manualBackup(ctx: Ctx, note?: string | null): Promise<BackupInfo> {
  const info = await createBackupAsync(ctx, 'manual', { note: note ?? undefined });
  logActivity(ctx, 'backup.create', `Backed up data to ${info.path}${note ? ` (${note})` : ''}`, { details: { path: info.path, sizeBytes: info.sizeBytes } });
  return info;
}

/** Take a fresh backup and let the user save it anywhere (e.g. a pen drive). */
/**
 * Plain words for a backup copy that could not be saved. The desktop app saves through "<name>.partial" and
 * removes it on failure (writeFileSafely -> SaveFileError), so nothing that looks like a backup is left on the
 * pen drive; any other failure may have left a piece of a file behind, and the user is told to delete it.
 */
function backupCopyError(e: unknown): AppError {
  const cleaned = e instanceof SaveFileError;
  // Already plain words (a SaveFileError without a known reason says what went wrong and that nothing was left).
  if (e instanceof SaveFileError ? e.reason === 'other' || e.reason === 'in-use' : e instanceof AppError) return e as AppError;
  const code = (e as NodeJS.ErrnoException)?.code ?? '';
  const reason =
    e instanceof SaveFileError
      ? e.reason
      : code === 'ENOSPC' || code === 'EDQUOT' || code === 'EFBIG'
        ? 'full'
        : code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
          ? 'read-only'
          : 'other';
  const why =
    reason === 'full'
      ? 'The pen drive or disk you chose is full, so the copy could not be saved.'
      : reason === 'read-only'
        ? 'Billforce is not allowed to save files there (it may be read-only), so the copy could not be saved.'
        : reason === 'unavailable'
          ? 'The pen drive or folder you chose is not available (was the pen drive removed?), so the copy could not be saved.'
          : reason === 'incomplete'
            ? 'The copy could not be written completely (the pen drive may be full or faulty).'
            : `The copy could not be saved (${(e as Error)?.message ?? e}).`;
  const left = cleaned ? 'Nothing was left there.' : 'If a file was created there, delete it: it is not a complete backup.';
  return new AppError('VALIDATION', `${why} ${left} ${reason === 'full' ? 'Free some space or choose another place' : 'Choose another place'} and try again.`);
}

export async function saveBackupCopy(ctx: Ctx): Promise<{ path: string | null; sizeBytes: number }> {
  const at = now(ctx);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'billforce-copy-'));
  try {
    const tmpFile = path.join(dir, 'copy.bfbackup');
    const snap = takeSnapshot(ctx, dir);
    let sizeBytes: number;
    try {
      sizeBytes = await writeCompressedAsync(snap.file, tmpFile);
    } finally {
      await fsp.rm(snap.dir, { recursive: true, force: true });
    }
    const data = await fsp.readFile(tmpFile);
    let saved: string | null;
    try {
      saved = await ctx.platform.saveFile({
        defaultName: defaultFileName(ctx, 'manual', at),
        data: new Uint8Array(data),
        filters: [{ name: 'Billforce backup', extensions: [BACKUP_EXTENSION] }],
      });
    } catch (e) {
      throw backupCopyError(e);
    }
    if (!saved) return { path: null, sizeBytes };
    // The copy must be exactly the backup (a pen drive can be full or pulled out while writing).
    let written: Buffer | null = null;
    try {
      written = await fsp.readFile(saved);
    } catch {
      written = null; // not readable from here (e.g. the test platform does not write files)
    }
    if (written && !written.equals(data)) {
      await fsp.rm(saved, { force: true }).catch(() => undefined);
      throw backupError(new Error('mismatch'), path.dirname(saved), 'verify');
    }
    ctx.db.tx(() => {
      recordBackup(ctx, 'manual', saved, sizeBytes, at, 'Copy saved by you');
      logActivity(ctx, 'backup.copy', `Saved a backup copy to ${saved}`, { details: { path: saved, sizeBytes } });
    });
    return { path: saved, sizeBytes };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
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
  if (!fs.existsSync(file)) throw fail.notFound('Backup file');
  refuseLiveDatabase(ctx, file);
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
  refuseLiveDatabase(ctx, file);
  // A backup still being written in the background holds the current database; wait for it to finish.
  if (backupInProgress()) throw fail.conflict('A backup is being saved right now. Wait a few seconds and try again.');
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
