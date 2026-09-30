import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BillforceApp } from '../src/core/app';
import { TestPlatform } from '../src/core/platform';
import type { ApiInput, ApiOutput, RouteName } from '../src/core/api/routes';
import type { SerializedError } from '../src/core/errors';
import { hashPassword } from '../src/core/modules/auth/passwords';
import { toTimestamp } from '../src/shared/dates';
import type { Role } from '../src/shared/constants';

export const OWNER = { username: 'owner', password: 'owner-pass' };

/** A folder path of its own for one test app (not created until used). */
export function testDir(): string {
  return path.join(os.tmpdir(), `bf-test-${randomUUID()}`);
}

export class ApiCallError extends Error {
  constructor(
    public readonly route: string,
    public readonly error: SerializedError,
  ) {
    super(`${route}: [${error.code}] ${error.message}`);
  }
}

export interface TestApp {
  app: BillforceApp;
  platform: TestPlatform;
  /** Call a route; throws ApiCallError on failure. */
  call<K extends RouteName>(name: K, input?: ApiInput<K>): Promise<ApiOutput<K>>;
  /** Call a route and return the raw result. */
  raw(name: string, input?: unknown): ReturnType<BillforceApp['invoke']>;
  /** Expect the call to fail; returns the error. */
  fails(name: string, input?: unknown): Promise<SerializedError>;
  /** Move the clock to a date (YYYY-MM-DD, time 10:00). */
  setToday(date: string): void;
  /** Create a user directly (bypassing the users module) and log in as them. */
  loginAs(role: Role, username?: string): Promise<void>;
  loginOwner(): Promise<void>;
  close(): void;
}

/**
 * A fresh in-memory Billforce with setup completed and the owner logged in.
 * Books start 01-04-2026; "today" is 28-09-2026 unless changed.
 */
export async function createTestApp(opts: { today?: string; booksStart?: string; openingCash?: number } = {}): Promise<TestApp> {
  let current = new Date(`${opts.today ?? '2026-09-28'}T10:00:00`);
  // Each app gets its own folders (created only when something is saved there): test files run in
  // parallel with the same fixed clock, so shared folders would mix up their backups and exports.
  const root = testDir();
  const platform = new TestPlatform(path.join(root, 'docs'));
  const app = new BillforceApp({ dataDir: path.join(root, 'data'), dbPath: ':memory:', platform, version: 'test', clock: () => new Date(current) });

  const t: TestApp = {
    app,
    platform,
    async call(name, input) {
      const r = await app.invoke(name, input);
      if (!r.ok) throw new ApiCallError(name, r.error);
      return r.data as any;
    },
    raw: (name, input) => app.invoke(name, input),
    async fails(name, input) {
      const r = await app.invoke(name, input);
      if (r.ok) throw new Error(`Expected ${name} to fail, but it succeeded: ${JSON.stringify(r.data).slice(0, 200)}`);
      return r.error;
    },
    setToday(date) {
      current = new Date(`${date}T10:00:00`);
    },
    async loginAs(role, username) {
      const name = username ?? `${role}1`;
      const exists = app.db.value<number>('SELECT COUNT(*) FROM users WHERE username = ?', [name], 0);
      if (!exists) {
        app.db.insert('users', {
          username: name,
          full_name: `Test ${role}`,
          role,
          password_hash: hashPassword('pass1234'),
          created_at: toTimestamp(current),
        });
      }
      await t.call('auth.login', { username: name, password: 'pass1234' });
    },
    async loginOwner() {
      await t.call('auth.login', OWNER);
    },
    close: () => {
      app.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };

  await t.call('setup.complete', {
    business: { name: 'Sharma General Store', address: '12 MG Road, Pune 411001', phone: '98200 12345' },
    owner: { fullName: 'Ravi Sharma', username: OWNER.username, password: OWNER.password },
    booksStartDate: opts.booksStart ?? '2026-04-01',
    openingCash: opts.openingCash ?? 0,
  });
  return t;
}

/** Ledger-wide invariants that must hold after any sequence of operations. */
export function ledgerProblems(app: BillforceApp): string[] {
  const problems: string[] = [];
  const unbalanced = app.db.all<{ entry_id: number; d: number }>(
    'SELECT entry_id, SUM(debit) - SUM(credit) AS d FROM journal_lines GROUP BY entry_id HAVING d <> 0',
  );
  for (const u of unbalanced) problems.push(`entry ${u.entry_id} is off by ${u.d}`);
  const empty = app.db.value<number>(
    'SELECT COUNT(*) FROM journal_entries e WHERE NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id)',
    undefined,
    0,
  );
  if (empty) problems.push(`${empty} entries have no lines`);
  const missingParty = app.db.value<number>(
    `SELECT COUNT(*) FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE a.party_type IS NOT NULL AND (l.party_type IS NOT a.party_type OR l.party_id IS NULL)`,
    undefined,
    0,
  );
  if (missingParty) problems.push(`${missingParty} control-account lines have no party`);
  const total = app.db.get<{ dr: number; cr: number }>(
    'SELECT COALESCE(SUM(l.debit),0) AS dr, COALESCE(SUM(l.credit),0) AS cr FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.is_void = 0',
  )!;
  if (total.dr !== total.cr) problems.push(`ledger total debit ${total.dr} != credit ${total.cr}`);
  return problems;
}

/** Balance (debit - credit) of a system account across all non-void entries. */
export function systemBalance(app: BillforceApp, key: string, to?: string): number {
  return app.db.value<number>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE a.system_key = ? AND e.is_void = 0 ${to ? 'AND e.date <= ?' : ''}`,
    to ? [key, to] : [key],
    0,
  );
}
