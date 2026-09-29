import type { Ctx, Session } from '../../context';
import { now } from '../../context';
import { AppError } from '../../errors';
import { ALL_PERMISSIONS, type Permission } from '../../../shared/permissions';
import { WRONG_LOGIN_MESSAGE, type Role } from '../../../shared/constants';
import { logActivity } from '../../audit';
import { getMeta, getSection, setMeta, updateSection } from '../../settings';
import { generateRecoveryCode, hashPassword, normalizeRecoveryCode, passwordProblem, verifyPassword } from './passwords';
import { seedDefaultAccounts } from '../../seed';
import { ensureFinancialYear } from '../../accounting/periods';
import { postEntry } from '../../accounting/ledger';
import { toTimestamp } from '../../../shared/dates';
import { gstConfig, gstKinds } from '../gst/common';
import type { GstMode } from '../../../shared/gst';

export interface UserRow {
  id: number;
  username: string;
  full_name: string;
  role: Role;
  password_hash: string;
  is_active: number;
  must_change_password: number;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
}

export interface SessionInfo {
  userId: number;
  username: string;
  fullName: string;
  role: Role;
  permissions: Permission[];
  mustChangePassword: boolean;
}

const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 60;

export function isSetupDone(ctx: Ctx): boolean {
  return getMeta(ctx, 'setup_done') === '1';
}

export function permissionsForRole(ctx: Ctx, role: Role): Permission[] {
  if (role === 'owner') return [...ALL_PERMISSIONS];
  return ctx.db
    .all<{ permission: string }>('SELECT permission FROM role_permissions WHERE role = ?', [role])
    .map((r) => r.permission as Permission)
    .filter((p) => (ALL_PERMISSIONS as string[]).includes(p));
}

function buildSession(ctx: Ctx, user: UserRow): Session {
  return {
    userId: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    permissions: permissionsForRole(ctx, user.role),
    loginAt: now(ctx),
  };
}

export function sessionInfo(ctx: Ctx): SessionInfo | null {
  const s = ctx.session;
  if (!s) return null;
  const user = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [s.userId]);
  if (!user || !user.is_active) return null;
  // Refresh permissions so changes made by the owner apply immediately.
  const perms = permissionsForRole(ctx, user.role);
  if (perms.join() !== s.permissions.join() || user.role !== s.role) {
    ctx.app.setSession({ ...s, role: user.role, permissions: perms, fullName: user.full_name });
  }
  return {
    userId: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    permissions: perms,
    mustChangePassword: !!user.must_change_password,
  };
}

export interface SetupInput {
  business: { name: string; address?: string | null; phone?: string | null; email?: string | null };
  owner: { fullName: string; username: string; password: string };
  booksStartDate: string;
  openingCash?: number;
  openingBank?: number;
  openingUpi?: number;
}

/** First-run setup: business details, owner account, opening cash / bank balances. */
export function completeSetup(ctx: Ctx, input: SetupInput): { recoveryCode: string; session: SessionInfo } {
  if (isSetupDone(ctx)) throw new AppError('CONFLICT', 'Billforce is already set up');
  const problem = passwordProblem(input.owner.password);
  if (problem) throw new AppError('VALIDATION', problem, { password: problem });
  const ts = now(ctx);

  updateSection(ctx, 'business', {
    name: input.business.name,
    address: input.business.address ?? '',
    phone: input.business.phone ?? '',
    email: input.business.email ?? '',
  });
  updateSection(ctx, 'accounts', { booksStartDate: input.booksStartDate });
  seedDefaultAccounts(ctx.db, ts);
  ensureFinancialYear(ctx, input.booksStartDate);

  const ownerId = ctx.db.insert('users', {
    username: input.owner.username,
    full_name: input.owner.fullName,
    role: 'owner',
    password_hash: hashPassword(input.owner.password),
    last_login_at: ts,
    created_at: ts,
  });
  const recoveryCode = generateRecoveryCode();
  setMeta(ctx, 'recovery_hash', hashPassword(recoveryCode));
  setMeta(ctx, 'setup_done', '1');
  setMeta(ctx, 'setup_at', ts);

  const owner = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [ownerId])!;
  ctx.app.setSession(buildSession(ctx, owner));
  ctx.session = buildSession(ctx, owner);

  const openings: Array<[number | undefined, 'CASH' | 'BANK' | 'UPI', string]> = [
    [input.openingCash, 'CASH', 'Opening cash in hand'],
    [input.openingBank, 'BANK', 'Opening bank balance'],
    [input.openingUpi, 'UPI', 'Opening UPI account balance'],
  ];
  for (const [amount, key, narration] of openings) {
    if (!amount) continue;
    postEntry(ctx, {
      date: input.booksStartDate,
      voucherType: 'opening',
      sourceType: 'opening',
      narration,
      lines:
        amount > 0
          ? [
              { account: key, debit: amount },
              { account: 'OPENING_EQUITY', credit: amount },
            ]
          : [
              { account: 'OPENING_EQUITY', debit: -amount },
              { account: key, credit: -amount },
            ],
    });
  }
  logActivity(ctx, 'setup.complete', `Set up Billforce for ${input.business.name}`, { entityType: 'user', entityId: ownerId });
  return { recoveryCode, session: sessionInfo(ctx)! };
}

export function login(ctx: Ctx, username: string, password: string): SessionInfo {
  if (!isSetupDone(ctx)) throw new AppError('SETUP_REQUIRED', 'Please complete the first-time setup');
  const user = ctx.db.get<UserRow>('SELECT * FROM users WHERE username = ?', [username.trim()]);
  const ts = now(ctx);
  if (!user || !user.is_active) {
    logActivity(ctx, 'user.login_failed', `Failed login for "${username}" (unknown or inactive user)`);
    throw new AppError('UNAUTHENTICATED', WRONG_LOGIN_MESSAGE);
  }
  if (user.locked_until && user.locked_until > ts) {
    throw new AppError('UNAUTHENTICATED', 'Too many wrong attempts. Please wait a minute and try again.');
  }
  if (!verifyPassword(password, user.password_hash)) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= MAX_ATTEMPTS ? toTimestamp(new Date(ctx.clock().getTime() + LOCK_SECONDS * 1000)) : null;
    ctx.db.update('users', user.id, { failed_attempts: lock ? 0 : attempts, locked_until: lock });
    logActivity(ctx, 'user.login_failed', `Failed login for ${user.username}`, { entityType: 'user', entityId: user.id });
    throw new AppError(
      'UNAUTHENTICATED',
      lock ? 'Too many wrong attempts. Please wait a minute and try again.' : WRONG_LOGIN_MESSAGE,
    );
  }
  ctx.db.update('users', user.id, { failed_attempts: 0, locked_until: null, last_login_at: ts });
  const session = buildSession(ctx, user);
  ctx.app.setSession(session);
  ctx.session = session;
  logActivity(ctx, 'user.login', `${user.full_name} logged in`, { entityType: 'user', entityId: user.id });
  return sessionInfo(ctx)!;
}

export function logout(ctx: Ctx): void {
  if (ctx.session) {
    logActivity(ctx, 'user.logout', `${ctx.session.fullName} logged out`, { entityType: 'user', entityId: ctx.session.userId });
  }
  ctx.app.setSession(null);
  ctx.session = null;
}

export function changePassword(ctx: Ctx, currentPassword: string, newPassword: string): void {
  const s = ctx.session;
  if (!s) throw new AppError('UNAUTHENTICATED', 'Please log in');
  const user = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [s.userId])!;
  if (!verifyPassword(currentPassword, user.password_hash)) {
    throw new AppError('VALIDATION', 'Current password is wrong', { currentPassword: 'Current password is wrong' });
  }
  const problem = passwordProblem(newPassword);
  if (problem) throw new AppError('VALIDATION', problem, { newPassword: problem });
  ctx.db.update('users', user.id, { password_hash: hashPassword(newPassword), must_change_password: 0, updated_at: now(ctx) });
  logActivity(ctx, 'user.change_password', `${user.full_name} changed their password`, { entityType: 'user', entityId: user.id });
}

/** Reset the owner's password using the recovery code shown at setup. Returns a fresh recovery code. */
export function recoverOwner(ctx: Ctx, recoveryCode: string, newPassword: string): { username: string; recoveryCode: string } {
  const stored = getMeta(ctx, 'recovery_hash');
  if (!stored || !verifyPassword(normalizeRecoveryCode(recoveryCode), stored)) {
    logActivity(ctx, 'user.recovery_failed', 'Wrong recovery code entered');
    throw new AppError('VALIDATION', 'The recovery code is not correct', { recoveryCode: 'The recovery code is not correct' });
  }
  const problem = passwordProblem(newPassword);
  if (problem) throw new AppError('VALIDATION', problem, { newPassword: problem });
  const owner = ctx.db.get<UserRow>("SELECT * FROM users WHERE role = 'owner' ORDER BY is_active DESC, id LIMIT 1");
  if (!owner) throw new AppError('NOT_FOUND', 'Owner account not found');
  ctx.db.update('users', owner.id, {
    password_hash: hashPassword(newPassword),
    is_active: 1,
    failed_attempts: 0,
    locked_until: null,
    updated_at: now(ctx),
  });
  const fresh = generateRecoveryCode();
  setMeta(ctx, 'recovery_hash', hashPassword(fresh));
  logActivity(ctx, 'user.recovered', `Owner password reset with recovery code`, { entityType: 'user', entityId: owner.id });
  return { username: owner.username, recoveryCode: fresh };
}

/** Generate a new recovery code (owner only). */
export function regenerateRecoveryCode(ctx: Ctx, password: string): string {
  const s = ctx.session;
  if (!s || s.role !== 'owner') throw new AppError('FORBIDDEN', 'Only the owner can do this');
  const user = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', [s.userId])!;
  if (!verifyPassword(password, user.password_hash)) throw new AppError('VALIDATION', 'Password is wrong', { password: 'Password is wrong' });
  const code = generateRecoveryCode();
  setMeta(ctx, 'recovery_hash', hashPassword(code));
  logActivity(ctx, 'user.recovery_regenerated', 'Generated a new owner recovery code');
  return code;
}

export function loginUsers(ctx: Ctx): Array<{ username: string; fullName: string; role: Role }> {
  if (!isSetupDone(ctx)) return [];
  return ctx.db
    .all<UserRow>("SELECT * FROM users WHERE is_active = 1 ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, full_name")
    .map((u) => ({ username: u.username, fullName: u.full_name, role: u.role }));
}

export function appStatus(ctx: Ctx) {
  const setupDone = isSetupDone(ctx);
  const business = getSection(ctx, 'business');
  return {
    setupDone,
    businessName: business.name,
    session: setupDone ? sessionInfo(ctx) : null,
    version: ctx.info.version,
    autoLockMinutes: getSection(ctx, 'security').autoLockMinutes,
    platform: ctx.platform.kind,
    /** Optional features the business has turned on (the UI shows their screens only then). */
    features: setupDone ? enabledFeatures(ctx) : NO_FEATURES,
  };
}

export interface EnabledFeatures {
  /** GST treatment of new documents: 'none' = not registered. */
  gst: GstMode;
  /** Usual GST rate (for items without their own rate). */
  gstDefaultRate: number;
  /** Item rates include GST. */
  gstInclusive: boolean;
  /** Regular GST to report / pay: registered now, or tax invoices from an earlier registration. */
  gstRegular: boolean;
  /** Composition tax to report / pay (now or from an earlier registration). */
  gstComposition: boolean;
  /** Stock tracking is on. */
  stock: boolean;
  /** Restaurant menu (dishes with recipes) is on. */
  menu: boolean;
}

const NO_FEATURES: EnabledFeatures = { gst: 'none', gstDefaultRate: 18, gstInclusive: true, gstRegular: false, gstComposition: false, stock: false, menu: false };

export function enabledFeatures(ctx: Ctx): EnabledFeatures {
  const g = gstConfig(ctx);
  const kinds = gstKinds(ctx);
  return {
    gst: g.mode,
    gstDefaultRate: g.defaultRate,
    gstInclusive: g.inclusive,
    gstRegular: kinds.regular,
    gstComposition: kinds.composition,
    stock: getSection(ctx, 'stock').enabled === true,
    menu: getSection(ctx, 'menu').enabled === true,
  };
}
