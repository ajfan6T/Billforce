import type { Db } from './db/database';
import { ACCOUNT_GROUPS, DEFAULT_ACCOUNTS, GST_ACCOUNTS, SYSTEM_ACCOUNTS, type AccountSeed } from './accounting/chart';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, type Permission } from '../shared/permissions';

/** Permissions added in the same version that started tracking known permissions (meta.known_permissions). */
const PERMISSIONS_ADDED_WITH_TRACKING: Permission[] = ['billing.rate', 'returns.adjust', 'customers.credit'];

/**
 * Idempotent reference data, run on every start: account groups, system
 * accounts (re-created if missing) and default role permissions (granted only
 * for permissions the database has not seen before, so the owner's changes are kept).
 */
export function seedReferenceData(db: Db, timestamp: string): void {
  db.tx(() => {
    for (const g of ACCOUNT_GROUPS) {
      db.run(
        `INSERT INTO account_groups (code, name, type, sort_order, allow_user_accounts, description)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (code) DO UPDATE SET name = excluded.name, type = excluded.type, sort_order = excluded.sort_order,
           allow_user_accounts = excluded.allow_user_accounts, description = excluded.description`,
        [g.code, g.name, g.type, g.sort, g.allowUserAccounts ? 1 : 0, g.description],
      );
    }
    ensureAccounts(db, SYSTEM_ACCOUNTS, timestamp);
    if (gstRegistered(db)) ensureAccounts(db, GST_ACCOUNTS, timestamp);
    // Grant defaults for permissions this database has never seen (new install, or a
    // permission added in a newer version). Permissions the owner already reviewed are
    // left exactly as the owner set them.
    let known: string[] = [];
    try {
      known = JSON.parse(db.value<string>("SELECT value FROM settings WHERE key = 'meta.known_permissions'", undefined, '[]'));
    } catch {
      known = [];
    }
    const hasRoles = db.value<number>('SELECT COUNT(*) FROM role_permissions', undefined, 0) > 0;
    // A data file from before permissions were tracked (or a restored older backup): it already knew
    // every permission except the ones introduced together with the tracking, so only those get defaults.
    if (!known.length && hasRoles) known = ALL_PERMISSIONS.filter((p) => !PERMISSIONS_ADDED_WITH_TRACKING.includes(p));
    const knownSet = new Set(known);
    const firstRun = !hasRoles && !known.length;
    for (const role of Object.keys(DEFAULT_ROLE_PERMISSIONS) as Array<keyof typeof DEFAULT_ROLE_PERMISSIONS>) {
      for (const p of DEFAULT_ROLE_PERMISSIONS[role]) {
        if (firstRun || !knownSet.has(p)) db.run('INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?, ?)', [role, p]);
      }
    }
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES ('meta.known_permissions', ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [JSON.stringify(ALL_PERMISSIONS), timestamp],
    );
  });
}

/** Create the system accounts in `seeds` that are missing (matched by system key). */
function ensureAccounts(db: Db, seeds: AccountSeed[], timestamp: string): void {
  for (const a of seeds) {
    const exists = db.value<number>('SELECT COUNT(*) FROM accounts WHERE system_key = ?', [a.systemKey], 0);
    if (exists) continue;
    // Avoid clashing with an account the user created with the same name or code.
    const nameTaken = db.value<number>('SELECT COUNT(*) FROM accounts WHERE name = ?', [a.name], 0);
    const codeTaken = db.value<number>('SELECT COUNT(*) FROM accounts WHERE code = ?', [a.code], 0);
    db.insert('accounts', {
      code: codeTaken ? null : a.code,
      name: nameTaken ? `${a.name} (system)` : a.name,
      group_code: a.group,
      system_key: a.systemKey,
      party_type: a.partyType ?? null,
      description: a.description ?? null,
      created_at: timestamp,
    });
  }
}

function gstRegistered(db: Db): boolean {
  try {
    const gst = JSON.parse(db.value<string>("SELECT value FROM settings WHERE key = 'gst'", undefined, '{}'));
    return gst?.registration === 'regular' || gst?.registration === 'composition';
  } catch {
    return false;
  }
}

/** The GST accounts (output / input tax, composition tax). Called when the business registers for GST. */
export function ensureGstAccounts(db: Db, timestamp: string): void {
  db.tx(() => ensureAccounts(db, GST_ACCOUNTS, timestamp));
}

/** Common expense heads etc. Created once when the business is set up. */
export function seedDefaultAccounts(db: Db, timestamp: string): void {
  db.tx(() => {
    for (const a of DEFAULT_ACCOUNTS) {
      db.run('INSERT OR IGNORE INTO accounts (code, name, group_code, description, created_at) VALUES (?, ?, ?, ?, ?)', [
        a.code,
        a.name,
        a.group,
        a.description ?? null,
        timestamp,
      ]);
    }
  });
}
