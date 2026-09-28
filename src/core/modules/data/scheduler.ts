/**
 * Automatic daily backups. Runs shortly after start-up and then every hour;
 * takes one automatic backup per day (and one on exit when data changed since
 * the last backup) and keeps the newest `keepCount` automatic backups.
 * Never throws: failures are written to the console and the activity log.
 *
 * The daily backup is written in the background (createBackupAsync), so billing
 * goes on while it runs. The backup on exit is synchronous on purpose: the app
 * is quitting and the database is closed right after it.
 */
import type { BillforceApp } from '../../app';
import type { Ctx } from '../../context';
import { logActivity } from '../../audit';
import { getMeta, getSection } from '../../settings';
import { addDays, parseISODate, toISODate } from '../../../shared/dates';
import { createBackup, createBackupAsync, pruneAutoBackups, type BackupInfo } from './backup';

export interface BackupScheduler {
  stop(): void;
  /** Called when the app is closing: take a backup if data changed since the last one. */
  backupOnExit(): void;
}

export interface AutoBackupResult {
  status: 'done' | 'skipped' | 'failed';
  reason?: string;
  backup?: BackupInfo;
  pruned?: string[];
}

/** Scheduled work runs as "System", not as whoever happens to be logged in. */
function systemCtx(app: BillforceApp): Ctx {
  return { ...app.ctx(), session: null };
}

/** Actions that do not change business data (a backup is not needed because of them). */
const NON_DATA_ACTIONS = ['user.login', 'user.logout', 'user.login_failed', 'user.recovery_failed', 'report.export'];

function tsToMs(ts: string): number {
  const d = parseISODate(ts.slice(0, 10));
  const [h, m, s] = (ts.slice(11) || '00:00:00').split(':').map(Number);
  d.setHours(h || 0, m || 0, s || 0, 0);
  return d.getTime();
}

/** Did anything change since the last backup? Uses both the in-memory change marker and the activity log. */
export function changedSinceLastBackup(app: BillforceApp, ctx: Ctx): boolean {
  const last = getSection(ctx, 'backup').lastBackupAt;
  if (!last) return true;
  if (app.lastChangeAt !== null && app.lastChangeAt > tsToMs(last) + 999) return true;
  const latest = ctx.db.value<string | null>(
    `SELECT MAX(at) FROM activity_log WHERE action NOT LIKE 'backup.%' AND action NOT IN (${NON_DATA_ACTIONS.map(() => '?').join(', ')})`,
    NON_DATA_ACTIONS,
    null,
  );
  return !!latest && latest > last;
}

function autoBackupToday(ctx: Ctx, today: string): boolean {
  return (
    ctx.db.value<number>("SELECT COUNT(*) FROM backup_history WHERE kind = 'auto' AND at >= ? AND at < ?", [today, addDays(today, 1)], 0) > 0
  );
}

/** Day on which a failure was last written to the activity log, per running app. */
const lastFailureLoggedOn = new WeakMap<BillforceApp, string>();

function reportFailure(app: BillforceApp, when: string, e: unknown): AutoBackupResult {
  const message = ((e as Error)?.message ?? String(e)).replace(/\.\s*$/, '');
  console.error(`[backup] automatic backup (${when}) failed:`, e);
  try {
    const ctx = systemCtx(app);
    const day = toISODate(ctx.clock());
    // One activity entry per day is enough; the hourly retries would otherwise flood the log.
    if (lastFailureLoggedOn.get(app) !== day) {
      logActivity(ctx, 'backup.failed', `Automatic backup failed: ${message}. Check the backup folder in Settings > Backup & restore.`, {
        details: { when, message },
      });
      lastFailureLoggedOn.set(app, day);
    }
  } catch (logErr) {
    console.error('[backup] could not record the failure:', logErr);
  }
  return { status: 'failed', reason: message };
}

function takeAutoBackup(app: BillforceApp, ctx: Ctx, note: string): AutoBackupResult {
  return afterAutoBackup(app, ctx, createBackup(ctx, 'auto', { note }));
}

/** Remove old automatic backups and record the new one. */
function afterAutoBackup(app: BillforceApp, ctx: Ctx, backup: BackupInfo): AutoBackupResult {
  let pruned: string[] = [];
  try {
    pruned = pruneAutoBackups(ctx);
  } catch (e) {
    console.error('[backup] could not remove old automatic backups:', e);
  }
  logActivity(ctx, 'backup.auto', `Automatic backup saved to ${backup.path}${pruned.length ? ` (removed ${pruned.length} older automatic backup${pruned.length === 1 ? '' : 's'})` : ''}`, {
    details: { path: backup.path, sizeBytes: backup.sizeBytes, pruned },
  });
  lastFailureLoggedOn.delete(app);
  return { status: 'done', backup, pruned };
}

/** Apps whose daily backup is being written right now (a slow pen drive must not get a second one started). */
const running = new WeakSet<BillforceApp>();

/**
 * One scheduler tick: back up if automatic backups are on and none was taken today.
 * The backup is compressed and checked in the background; the promise never rejects.
 */
export async function runAutoBackup(app: BillforceApp): Promise<AutoBackupResult> {
  try {
    const ctx = systemCtx(app);
    if (getMeta(ctx, 'setup_done') !== '1') return { status: 'skipped', reason: 'Setup not finished' };
    if (!getSection(ctx, 'backup').autoBackup) return { status: 'skipped', reason: 'Automatic backup is off' };
    if (ctx.db.inTransaction) return { status: 'skipped', reason: 'Busy' };
    if (running.has(app)) return { status: 'skipped', reason: 'A backup is already being saved' };
    if (autoBackupToday(ctx, toISODate(ctx.clock()))) return { status: 'skipped', reason: 'Already backed up today' };
    running.add(app);
    try {
      const backup = await createBackupAsync(ctx, 'auto', { note: 'Daily automatic backup' });
      return afterAutoBackup(app, ctx, backup);
    } finally {
      running.delete(app);
    }
  } catch (e) {
    return reportFailure(app, 'daily', e);
  }
}

/**
 * On exit: back up if data changed since the last backup. Synchronous on purpose (the app is quitting and
 * closes the database right after this; it cannot wait for a background backup).
 */
export function runExitBackup(app: BillforceApp): AutoBackupResult {
  try {
    const ctx = systemCtx(app);
    if (getMeta(ctx, 'setup_done') !== '1') return { status: 'skipped', reason: 'Setup not finished' };
    if (!getSection(ctx, 'backup').autoBackup) return { status: 'skipped', reason: 'Automatic backup is off' };
    if (ctx.db.inTransaction) return { status: 'skipped', reason: 'Busy' };
    if (!changedSinceLastBackup(app, ctx)) return { status: 'skipped', reason: 'No changes since the last backup' };
    return takeAutoBackup(app, ctx, 'Backup when closing Billforce');
  } catch (e) {
    return reportFailure(app, 'on exit', e);
  }
}

export interface SchedulerOptions {
  /** Delay before the first check (default 20 seconds, so start-up stays fast). */
  initialDelayMs?: number;
  /** Time between checks (default 1 hour). */
  intervalMs?: number;
}

export function startBackupScheduler(app: BillforceApp, opts: SchedulerOptions = {}): BackupScheduler {
  const initialDelay = opts.initialDelayMs ?? 20_000;
  const interval = opts.intervalMs ?? 60 * 60 * 1000;
  let stopped = false;
  let hourly: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    if (!stopped) void runAutoBackup(app);
  };
  const first = setTimeout(() => {
    tick();
    if (!stopped) {
      hourly = setInterval(tick, interval);
      hourly.unref?.();
    }
  }, initialDelay);
  first.unref?.();
  return {
    stop() {
      stopped = true;
      clearTimeout(first);
      if (hourly) clearInterval(hourly);
    },
    backupOnExit() {
      runExitBackup(app);
    },
  };
}
