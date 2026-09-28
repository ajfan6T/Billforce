import type { Db } from './db/database';
import { ACCOUNT_GROUPS, DEFAULT_ACCOUNTS, SYSTEM_ACCOUNTS } from './accounting/chart';
import { DEFAULT_ROLE_PERMISSIONS } from '../shared/permissions';

/**
 * Idempotent reference data, run on every start: account groups, system
 * accounts (re-created if missing) and default role permissions (only when a
 * role has none yet, so the owner's changes are kept).
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
    for (const a of SYSTEM_ACCOUNTS) {
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
    for (const role of Object.keys(DEFAULT_ROLE_PERMISSIONS) as Array<keyof typeof DEFAULT_ROLE_PERMISSIONS>) {
      const count = db.value<number>('SELECT COUNT(*) FROM role_permissions WHERE role = ?', [role], 0);
      if (count) continue;
      for (const p of DEFAULT_ROLE_PERMISSIONS[role]) {
        db.run('INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?, ?)', [role, p]);
      }
    }
  });
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
