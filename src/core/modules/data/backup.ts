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
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../../context';
import { now } from '../../context';
import { AppError } from '../../errors';
import { getSection, updateSection } from '../../settings';

export type BackupKind = 'auto' | 'manual' | 'safety';

export const BACKUP_EXTENSION = 'bfbackup';

export function backupFolder(ctx: Ctx): string {
  return getSection(ctx, 'backup').folder || ctx.info.defaultBackupDir;
}

function stamp(ts: string): string {
  return ts.replace(/[-:]/g, '').replace(' ', '_');
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Billforce';
}

export interface BackupInfo {
  path: string;
  sizeBytes: number;
  at: string;
  kind: BackupKind;
}

/** Write a compressed snapshot of the database into the backup folder (or targetPath). */
export function createBackup(ctx: Ctx, kind: BackupKind, opts: { note?: string; targetPath?: string } = {}): BackupInfo {
  if (ctx.db.inTransaction) throw new AppError('INTERNAL', 'createBackup cannot run inside a transaction');
  const at = now(ctx);
  const business = safeName(getSection(ctx, 'business').name);
  const dir = opts.targetPath ? path.dirname(opts.targetPath) : backupFolder(ctx);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new AppError('VALIDATION', `Cannot create the backup folder "${dir}": ${(e as Error).message}`);
  }
  const file = opts.targetPath ?? path.join(dir, `${business}_${kind}_${stamp(at)}.${BACKUP_EXTENSION}`);
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
  const sizeBytes = fs.statSync(file).size;
  ctx.db.insert('backup_history', { at, kind, path: file, size_bytes: sizeBytes, user_id: ctx.session?.userId ?? null, note: opts.note ?? null });
  updateSection(ctx, 'backup', {
    lastBackupAt: at,
    lastBackupPath: file,
    ...(kind === 'auto' ? { lastAutoBackupAt: at } : {}),
  });
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
