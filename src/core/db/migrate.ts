import type { Db } from './database';
import { SCHEMA_V1 } from './schema';
import { GST_COLUMNS, GST_INDEXES } from './schema/gst';
import { STOCK_COLUMNS, STOCK_SCHEMA } from './schema/stock';
import { MENU_COLUMNS, MENU_SCHEMA } from './schema/menu';

export interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

/**
 * Ordered list of schema migrations. Never edit a released migration; add a
 * new one instead. Each runs in its own transaction and bumps user_version.
 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial schema', up: (db) => db.exec(SCHEMA_V1) },
  { version: 2, name: 'bring pre-release v1 data files up to date', up: (db) => repairPreReleaseV1(db) },
  { version: 3, name: 'GST', up: (db) => addColumns(db, GST_COLUMNS, GST_INDEXES) },
  { version: 4, name: 'stock', up: (db) => addColumns(db, STOCK_COLUMNS, STOCK_SCHEMA) },
  { version: 5, name: 'restaurant menu', up: (db) => addColumns(db, MENU_COLUMNS, MENU_SCHEMA) },
];

/** Add columns that are not there yet (so a half-applied or repeated migration is harmless), then indexes. */
function addColumns(db: Db, columns: Array<[table: string, column: string, definition: string]>, indexes = ''): void {
  for (const [table, column, definition] of columns) {
    const has = db.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  if (indexes) db.exec(indexes);
}

/**
 * Columns added to the version 1 schema while Billforce was being built (before release).
 * Data files created by those early builds lack them; fresh files already have them.
 */
const LATE_V1_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  ['bills', 'bill_discount_pct', 'REAL'],
  ['bills', 'printed_revision', 'INTEGER'],
  ['customer_receipts', 'print_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['supplier_payments', 'print_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['employees', 'opening_entry_id', 'INTEGER REFERENCES journal_entries (id)'],
  ['salaries', 'details', 'TEXT'],
  ['salaries', 'print_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['salary_payments', 'cancel_reason', 'TEXT'],
];

function repairPreReleaseV1(db: Db): void {
  for (const [table, column, definition] of LATE_V1_COLUMNS) {
    const has = db.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  // Indexes whose definition changed keep their name, so rebuild those; then create any that are missing.
  db.exec('DROP INDEX IF EXISTS idx_jl_account');
  const party = db.value<string | null>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_jl_party'", undefined, null);
  if (party && !/debit/i.test(party)) db.exec('DROP INDEX idx_jl_party');
  for (const m of SCHEMA_V1.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(\w+)\s+ON\s+([^;]+);/g)) {
    db.exec(`CREATE ${m[1] ?? ''}INDEX IF NOT EXISTS ${m[2]} ON ${m[3]}`);
  }
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function schemaVersion(db: Db): number {
  return db.value<number>('PRAGMA user_version', undefined, 0);
}

export function migrate(db: Db): { from: number; to: number } {
  const from = schemaVersion(db);
  if (from > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `This data file was created by a newer version of Billforce (data version ${from}). Please install the latest version.`,
    );
  }
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.tx(() => {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return { from, to: schemaVersion(db) };
}
