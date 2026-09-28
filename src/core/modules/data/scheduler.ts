import type { BillforceApp } from '../../app';

export interface BackupScheduler {
  stop(): void;
  /** Called when the app is closing: take a backup if data changed since the last one. */
  backupOnExit(): void;
}

/**
 * TODO(data module): automatic daily backups. Runs shortly after start-up and
 * then hourly; takes one automatic backup per day (and on exit if data changed),
 * keeping the newest `keepCount` automatic backups.
 */
export function startBackupScheduler(app: BillforceApp): BackupScheduler {
  void app;
  return { stop() {}, backupOnExit() {} };
}
