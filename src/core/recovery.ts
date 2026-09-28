/**
 * Start-up recovery: what to tell the shopkeeper when billforce.db cannot be opened, and how to put a
 * backup back in place without the app running. Used by the Electron main process before any window
 * exists (the in-app Backup & restore screen needs an open database, so it cannot help here).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BillforceApp } from './app';
import { extractBackup, parseBackupFileName } from './modules/data/backup';
import { toTimestamp } from '../shared/dates';

export type OpenFailureKind = 'newer-version' | 'damaged' | 'in-use' | 'no-access' | 'other';

export interface OpenFailure {
  kind: OpenFailureKind;
  /** One line for the dialog heading. */
  title: string;
  /** What happened and what to do, in plain English. */
  detail: string;
  /** Offer "Restore from a backup" (not for a newer version: that data is fine, only this Billforce is too old). */
  canRestore: boolean;
}

/** Turn the error from opening the database into a message a shopkeeper can act on. */
export function describeOpenFailure(e: unknown): OpenFailure {
  const msg = (e as Error)?.message ?? String(e);
  const code = (e as NodeJS.ErrnoException)?.code ?? '';
  if (/newer version of Billforce/i.test(msg)) {
    return {
      kind: 'newer-version',
      title: 'Your data was saved by a newer version of Billforce',
      detail: 'Install the latest version of Billforce on this computer to open it. Your data has not been changed.',
      canRestore: false,
    };
  }
  if (/database is locked|SQLITE_BUSY|busy/i.test(msg)) {
    return {
      kind: 'in-use',
      title: 'Your data file is in use by another program',
      detail: 'Close any other copy of Billforce (or a program that has billforce.db open) and start Billforce again.',
      canRestore: false,
    };
  }
  if (/EACCES|EPERM|permission denied|readonly|read-only|unable to open/i.test(`${code} ${msg}`)) {
    return {
      kind: 'no-access',
      title: 'Billforce cannot read or write its data folder',
      detail: `Windows did not allow Billforce to open its data file (${msg}). Check that the data folder is not read-only and that your antivirus is not blocking Billforce, then start it again. You can also restore a backup.`,
      canRestore: true,
    };
  }
  if (/not a database|malformed|corrupt|disk image|file is encrypted|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(msg)) {
    return {
      kind: 'damaged',
      title: 'Your data file is damaged',
      detail: `Billforce could not read billforce.db (${msg}). This can happen after a power cut or a disk problem. Restore your data from a Billforce backup (a .bfbackup file; Billforce makes one every day in Documents\\Billforce Backups). The damaged file is kept in the data folder.`,
      canRestore: true,
    };
  }
  return {
    kind: 'other',
    title: 'Billforce could not open your data',
    detail: `${msg}\n\nYou can restore your data from a Billforce backup (a .bfbackup file, normally in Documents\\Billforce Backups). The current file is kept in the data folder.`,
    canRestore: true,
  };
}

/**
 * The backup folder chosen in Settings, read (read-only) from a data file that no longer opens normally.
 * Often still readable when only part of the file is damaged; null when it cannot be read.
 */
export function backupFolderFromDamagedFile(dbPath: string): string | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'backup'").get() as { value?: string } | undefined;
    const folder = row?.value ? (JSON.parse(row.value) as { folder?: unknown }).folder : null;
    return typeof folder === 'string' && folder.trim() ? folder : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

export interface FoundBackup {
  path: string;
  fileName: string;
  /** When it was taken ("YYYY-MM-DD HH:MM:SS"), from the file name or its modified time. */
  at: string;
}

/** Billforce backups in a folder, newest first (used to suggest the latest one). */
export function findBackups(folder: string): FoundBackup[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.bfbackup'));
  } catch {
    return [];
  }
  const out: FoundBackup[] = [];
  for (const f of names) {
    const full = path.join(folder, f);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size < 64) continue;
      out.push({ path: full, fileName: f, at: parseBackupFileName(f)?.at ?? toTimestamp(st.mtime) });
    } catch {
      /* unreadable entry */
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export interface RecoveryResult {
  restoredFrom: string;
  /** Where the file that could not be opened was moved to (null if there was none). */
  damagedCopy: string | null;
  businessName: string;
}

function stamp(d: Date): string {
  return toTimestamp(d).replace(/[-:]/g, '').replace(' ', '-');
}

/** A reason the chosen file cannot be restored; the message is shown to the user as it is. */
export class RecoveryError extends Error {}

const NOT_A_BACKUP = 'This file is not a Billforce backup. Choose a file ending in .bfbackup made by Billforce.';

/** Open (and migrate) a copy of the backup and check it is a set-up Billforce database with an owner. */
function checkRestorable(dbFile: string, at: Date): { businessName: string } {
  let db;
  try {
    db = BillforceApp.openDatabase(dbFile, at);
  } catch (e) {
    if (/newer version/i.test((e as Error)?.message ?? '')) throw new RecoveryError('This backup was made by a newer version of Billforce. Install the latest version of Billforce first.');
    throw new RecoveryError(NOT_A_BACKUP);
  }
  try {
    const integrity = db.value<string>('PRAGMA integrity_check', undefined, '');
    if (integrity !== 'ok') throw new RecoveryError('This backup file is damaged. Try an older backup.');
    if (db.value<string | null>("SELECT value FROM settings WHERE key = 'meta.setup_done'", undefined, null) !== '1') throw new RecoveryError(NOT_A_BACKUP);
    if (!db.value<number>("SELECT COUNT(*) FROM users WHERE role = 'owner'", undefined, 0)) throw new RecoveryError('This backup has no owner login, so it cannot be restored.');
    let businessName = '';
    try {
      businessName = JSON.parse(db.value<string>("SELECT value FROM settings WHERE key = 'business'", undefined, '{}')).name ?? '';
    } catch {
      businessName = '';
    }
    return { businessName };
  } finally {
    db.close();
  }
}

/**
 * Put a backup (.bfbackup or a plain .db copy) in place of a database that cannot be opened:
 * extract it, check it opens as a set-up Billforce database, move the damaged file (and its -wal / -shm
 * files, which must not be replayed onto the restored data) aside as billforce-damaged-<time>.db in the
 * same folder, then copy the backup in. Nothing is changed if the backup is not usable.
 */
export function restoreDamagedDatabase(dbPath: string, backupFile: string, at: Date = new Date()): RecoveryResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billforce-recover-'));
  try {
    if (!fs.existsSync(backupFile)) throw new RecoveryError('The backup file could not be found.');
    let raw: string;
    try {
      raw = extractBackup(backupFile, tmpDir);
    } catch (e) {
      throw new RecoveryError(/damaged/i.test((e as Error)?.message ?? '') ? 'This backup file is damaged. Try an older backup.' : NOT_A_BACKUP);
    }
    // Validate on a copy, so the file that goes into place is exactly the backup.
    const probe = path.join(tmpDir, 'probe.db');
    fs.copyFileSync(raw, probe);
    const info = checkRestorable(probe, at);

    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    let damagedCopy: string | null = null;
    const base = path.join(dir, `billforce-damaged-${stamp(at)}`);
    let target = `${base}.db`;
    for (let i = 2; fs.existsSync(target); i++) target = `${base}-${i}.db`;
    if (fs.existsSync(dbPath)) {
      fs.renameSync(dbPath, target);
      damagedCopy = target;
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.existsSync(dbPath + suffix)) fs.renameSync(dbPath + suffix, target + suffix);
    }
    const incoming = `${dbPath}.restore-tmp`;
    try {
      fs.copyFileSync(raw, incoming);
      fs.renameSync(incoming, dbPath);
    } catch (e) {
      fs.rmSync(incoming, { force: true });
      // Put the original file back so nothing is lost.
      if (damagedCopy && !fs.existsSync(dbPath)) fs.renameSync(damagedCopy, dbPath);
      throw e;
    }
    return { restoredFrom: backupFile, damagedCopy, businessName: info.businessName };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
