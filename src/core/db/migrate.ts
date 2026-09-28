import type { Db } from './database';
import { SCHEMA_V1 } from './schema';

export interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

/**
 * Ordered list of schema migrations. Never edit a released migration; add a
 * new one instead. Each runs in its own transaction and bumps user_version.
 */
export const MIGRATIONS: Migration[] = [{ version: 1, name: 'initial schema', up: (db) => db.exec(SCHEMA_V1) }];

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
