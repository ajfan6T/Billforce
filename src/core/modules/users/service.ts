/**
 * User logins and role permissions.
 *
 * Rules:
 *  - Only the owner may add an owner, or change / reset another owner's login.
 *  - There must always be at least one active owner.
 *  - Nobody can deactivate themselves or change their own role.
 *  - Logins are deactivated, never deleted (the activity log keeps referring to them).
 *  - Manager / cashier permissions can be changed by the owner only; the owner always has everything.
 */
import type { Ctx } from '../../context';
import { now, requireSession } from '../../context';
import { AppError, fail } from '../../errors';
import { logActivity } from '../../audit';
import { hashPassword, passwordProblem } from '../auth/passwords';
import { permissionsForRole, type UserRow } from '../auth/service';
import { ROLE_LABELS, type Role } from '../../../shared/constants';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, isPermission, type Permission } from '../../../shared/permissions';

export type EditableRole = Exclude<Role, 'owner'>;

/**
 * Stored when the owner removes every permission from a role, so the start-up
 * seeding (which fills roles that have no rows) does not bring the defaults back.
 * permissionsForRole() ignores it because it is not a real permission.
 */
export const NO_PERMISSIONS_MARKER = '__none__';

export interface UserListItem {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  /** Temporarily locked after too many wrong passwords. */
  isLocked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  /** This is the logged-in user. */
  isSelf: boolean;
}

function toItem(ctx: Ctx, r: UserRow & { updated_at: string | null }): UserListItem {
  const ts = now(ctx);
  return {
    id: r.id,
    username: r.username,
    fullName: r.full_name,
    role: r.role,
    isActive: !!r.is_active,
    mustChangePassword: !!r.must_change_password,
    isLocked: !!r.locked_until && r.locked_until > ts,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    isSelf: ctx.session?.userId === r.id,
  };
}

function getUserRow(ctx: Ctx, id: number): UserRow & { updated_at: string | null } {
  const r = ctx.db.get<UserRow & { updated_at: string | null }>('SELECT * FROM users WHERE id = ?', [id]);
  if (!r) throw fail.notFound('User');
  return r;
}

export function listUsers(ctx: Ctx): UserListItem[] {
  return ctx.db
    .all<UserRow & { updated_at: string | null }>(
      `SELECT * FROM users ORDER BY is_active DESC,
         CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, full_name COLLATE NOCASE`,
    )
    .map((r) => toItem(ctx, r));
}

export function getUser(ctx: Ctx, id: number): UserListItem {
  return toItem(ctx, getUserRow(ctx, id));
}

function activeOwnerCount(ctx: Ctx, exceptId = 0): number {
  return ctx.db.value<number>("SELECT COUNT(*) FROM users WHERE role = 'owner' AND is_active = 1 AND id <> ?", [exceptId], 0);
}

function assertUsernameFree(ctx: Ctx, username: string, exceptId = 0): void {
  const clash = ctx.db.get<{ id: number; full_name: string; is_active: number }>(
    'SELECT id, full_name, is_active FROM users WHERE username = ? COLLATE NOCASE AND id <> ?',
    [username, exceptId],
  );
  if (clash) {
    const who = clash.is_active ? clash.full_name : `${clash.full_name} (inactive)`;
    throw fail.validation(`The username "${username}" is already used by ${who}. Choose another one.`, { username: 'Username already taken' });
  }
}

function assertPassword(password: string, field = 'password'): void {
  const problem = passwordProblem(password);
  if (problem) throw fail.validation(problem, { [field]: problem });
}

/** Only the owner may touch owner logins or make someone an owner. */
function assertMayManage(ctx: Ctx, target: { role: Role } | null, newRole?: Role): void {
  const s = requireSession(ctx);
  if (s.role === 'owner') return;
  if (target?.role === 'owner') throw fail.forbidden("Only the owner can change the owner's login.");
  if (newRole === 'owner') throw fail.forbidden('Only the owner can make someone an owner.');
}

export interface CreateUserInput {
  username: string;
  fullName: string;
  role: Role;
  password: string;
  /** Ask the user to choose their own password at first login. Default true. */
  mustChangePassword?: boolean;
}

export function createUser(ctx: Ctx, input: CreateUserInput): UserListItem {
  assertMayManage(ctx, null, input.role);
  const username = input.username.trim();
  const fullName = input.fullName.trim().replace(/\s+/g, ' ');
  if (!fullName) throw fail.validation('Enter the full name', { fullName: 'Enter the full name' });
  assertUsernameFree(ctx, username);
  assertPassword(input.password);
  const mustChange = input.mustChangePassword ?? true;
  const id = ctx.db.insert('users', {
    username,
    full_name: fullName,
    role: input.role,
    password_hash: hashPassword(input.password),
    must_change_password: mustChange ? 1 : 0,
    created_at: now(ctx),
  });
  logActivity(ctx, 'user.create', `Added ${ROLE_LABELS[input.role]} login "${username}" for ${fullName}`, {
    entityType: 'user',
    entityId: id,
    details: { username, fullName, role: input.role, mustChangePassword: mustChange },
  });
  return getUser(ctx, id);
}

export interface UpdateUserInput {
  fullName: string;
  role: Role;
  isActive: boolean;
  /** Optional new username (e.g. to fix a typo). */
  username?: string | null;
}

export function updateUser(ctx: Ctx, id: number, input: UpdateUserInput): UserListItem {
  const s = requireSession(ctx);
  const before = getUserRow(ctx, id);
  assertMayManage(ctx, before, input.role);
  const fullName = input.fullName.trim().replace(/\s+/g, ' ');
  if (!fullName) throw fail.validation('Enter the full name', { fullName: 'Enter the full name' });
  const username = input.username?.trim() || before.username;
  const isSelf = id === s.userId;
  if (isSelf && !input.isActive) throw fail.validation('You cannot deactivate your own login.');
  if (isSelf && input.role !== before.role) throw fail.validation('You cannot change your own role. Ask another owner to do it.', { role: 'You cannot change your own role' });
  const losesOwner = before.role === 'owner' && !!before.is_active && (input.role !== 'owner' || !input.isActive);
  if (losesOwner && activeOwnerCount(ctx, id) === 0) {
    throw fail.validation(
      `${before.full_name} is the only active owner. Make another user an owner first - Billforce always needs at least one owner.`,
      { role: 'At least one active owner is needed' },
    );
  }
  if (username !== before.username) assertUsernameFree(ctx, username, id);

  const reactivated = !before.is_active && input.isActive;
  ctx.db.update('users', id, {
    username,
    full_name: fullName,
    role: input.role,
    is_active: input.isActive ? 1 : 0,
    ...(reactivated ? { failed_attempts: 0, locked_until: null } : {}),
    updated_at: now(ctx),
  });

  const changes: string[] = [];
  if (before.full_name !== fullName) changes.push(`name "${before.full_name}" → "${fullName}"`);
  if (before.username !== username) changes.push(`username "${before.username}" → "${username}"`);
  if (before.role !== input.role) changes.push(`role ${ROLE_LABELS[before.role]} → ${ROLE_LABELS[input.role]}`);
  const deactivated = !!before.is_active && !input.isActive;
  if (!changes.length && !deactivated && !reactivated) return getUser(ctx, id);
  const action = deactivated ? 'user.deactivate' : reactivated ? 'user.activate' : 'user.update';
  const head = deactivated ? `Deactivated login "${username}" (${fullName})` : reactivated ? `Re-activated login "${username}" (${fullName})` : `Updated login "${username}"`;
  logActivity(ctx, action, `${head}${changes.length ? ': ' + changes.join(', ') : ''}`, {
    entityType: 'user',
    entityId: id,
    details: {
      before: { username: before.username, fullName: before.full_name, role: before.role, isActive: !!before.is_active },
      after: { username, fullName, role: input.role, isActive: input.isActive },
    },
  });
  return getUser(ctx, id);
}

/** Set a new password for another user; they must choose their own at next login. */
export function resetUserPassword(ctx: Ctx, id: number, newPassword: string): UserListItem {
  const s = requireSession(ctx);
  const user = getUserRow(ctx, id);
  assertMayManage(ctx, user);
  if (id === s.userId) {
    throw fail.validation('To change your own password, use "Change password" in the menu under your name (top right).');
  }
  assertPassword(newPassword, 'newPassword');
  ctx.db.update('users', id, {
    password_hash: hashPassword(newPassword),
    must_change_password: 1,
    failed_attempts: 0,
    locked_until: null,
    updated_at: now(ctx),
  });
  logActivity(ctx, 'user.reset_password', `Reset the password of "${user.username}" (${user.full_name}); they must choose a new one at next login`, {
    entityType: 'user',
    entityId: id,
  });
  return getUser(ctx, id);
}

/* ------------------------------ Roles ------------------------------ */

export interface PermissionGroup {
  group: string;
  permissions: Array<{ key: Permission; label: string }>;
}

export function permissionGroups(): PermissionGroup[] {
  const out: PermissionGroup[] = [];
  for (const p of PERMISSIONS) {
    let g = out.find((x) => x.group === p.group);
    if (!g) {
      g = { group: p.group, permissions: [] };
      out.push(g);
    }
    g.permissions.push({ key: p.key, label: p.label });
  }
  return out;
}

export interface RolesInfo {
  roles: Record<Role, Permission[]>;
  groups: PermissionGroup[];
  defaults: Record<EditableRole, Permission[]>;
  /** Only the owner can change role permissions. */
  canEdit: boolean;
  /** Number of active users per role. */
  userCounts: Record<Role, number>;
}

export function getRoles(ctx: Ctx): RolesInfo {
  const s = requireSession(ctx);
  const counts = { owner: 0, manager: 0, cashier: 0 } as Record<Role, number>;
  for (const r of ctx.db.all<{ role: Role; n: number }>('SELECT role, COUNT(*) AS n FROM users WHERE is_active = 1 GROUP BY role')) counts[r.role] = r.n;
  return {
    roles: {
      owner: [...ALL_PERMISSIONS],
      manager: permissionsForRole(ctx, 'manager'),
      cashier: permissionsForRole(ctx, 'cashier'),
    },
    groups: permissionGroups(),
    defaults: { manager: [...DEFAULT_ROLE_PERMISSIONS.manager], cashier: [...DEFAULT_ROLE_PERMISSIONS.cashier] },
    canEdit: s.role === 'owner',
    userCounts: counts,
  };
}

const labelOf = (p: Permission) => PERMISSIONS.find((x) => x.key === p)?.label ?? p;

/** Replace the permissions of the manager or cashier role (owner only). Applies from the next action of users with that role. */
export function updateRolePermissions(ctx: Ctx, role: EditableRole, permissions: string[]): RolesInfo {
  const s = requireSession(ctx);
  if (s.role !== 'owner') throw fail.forbidden('Only the owner can change what each role is allowed to do.');
  if ((role as string) === 'owner') throw fail.validation('The owner always has every permission.');
  const unknown = permissions.filter((p) => !isPermission(p));
  if (unknown.length) throw new AppError('VALIDATION', `Unknown permission: ${unknown.join(', ')}`);
  const next = ALL_PERMISSIONS.filter((p) => permissions.includes(p));
  const before = permissionsForRole(ctx, role);
  const added = next.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !next.includes(p));
  if (!added.length && !removed.length) return getRoles(ctx);
  ctx.db.run('DELETE FROM role_permissions WHERE role = ?', [role]);
  for (const p of next) ctx.db.run('INSERT INTO role_permissions (role, permission) VALUES (?, ?)', [role, p]);
  if (!next.length) ctx.db.run('INSERT INTO role_permissions (role, permission) VALUES (?, ?)', [role, NO_PERMISSIONS_MARKER]);
  const parts: string[] = [];
  if (added.length) parts.push(`allowed ${added.map(labelOf).join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.map(labelOf).join(', ')}`);
  logActivity(ctx, 'role.update', `Changed ${ROLE_LABELS[role]} permissions: ${parts.join('; ')}`, {
    entityType: 'role',
    details: { role, before, after: next, added, removed },
  });
  return getRoles(ctx);
}
