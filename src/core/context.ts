import type { Db } from './db/database';
import type { Platform } from './platform';
import type { Role } from '../shared/constants';
import type { Permission } from '../shared/permissions';
import { toISODate, toTimestamp } from '../shared/dates';
import { AppError } from './errors';

export interface Session {
  userId: number;
  username: string;
  fullName: string;
  role: Role;
  permissions: Permission[];
  loginAt: string;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  dbPath: string;
  /** Default folder for backups (Documents\Billforce Backups). */
  defaultBackupDir: string;
}

/**
 * Everything a service function needs. A fresh Ctx is built for every API
 * call; services must not keep references to it.
 */
export interface Ctx {
  db: Db;
  session: Session | null;
  platform: Platform;
  /** Current time. Injectable so tests can control dates. */
  clock: () => Date;
  info: AppInfo;
  /** Hooks into the running app (session changes, database swap on restore). */
  app: AppHooks;
}

export interface AppHooks {
  setSession(session: Session | null): void;
  /** Replace the open database with the given file (used by restore). */
  replaceDatabase(sourcePath: string): void;
  /** Note that data changed (used to decide when to back up). */
  markDirty(): void;
}

/** Local timestamp "YYYY-MM-DD HH:MM:SS". */
export function now(ctx: Ctx): string {
  return toTimestamp(ctx.clock());
}

/** Today's date "YYYY-MM-DD". */
export function today(ctx: Ctx): string {
  return toISODate(ctx.clock());
}

export function requireSession(ctx: Ctx): Session {
  if (!ctx.session) throw new AppError('UNAUTHENTICATED', 'Please log in to continue');
  return ctx.session;
}

export function can(ctx: Ctx, permission: Permission): boolean {
  const s = ctx.session;
  if (!s) return false;
  return s.role === 'owner' || s.permissions.includes(permission);
}

export function assertCan(ctx: Ctx, permission: Permission, message?: string): void {
  requireSession(ctx);
  if (!can(ctx, permission)) {
    throw new AppError('FORBIDDEN', message ?? 'You do not have permission to do this. Ask the owner to allow it.');
  }
}

export function currentUserId(ctx: Ctx): number | null {
  return ctx.session?.userId ?? null;
}
