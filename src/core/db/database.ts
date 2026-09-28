import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type SqlParams = unknown[] | Record<string, unknown>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

function normalizeValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function normalizeParams(params: SqlParams | undefined): unknown[] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(normalizeValue);
  const named: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) named[k] = normalizeValue(v);
  return [named];
}

/**
 * Thin synchronous wrapper around node:sqlite (built into Electron / Node).
 * - Positional params: db.all('select * from t where a = ? and b = ?', [1, 2])
 * - Named params:      db.all('select * from t where a = :a', { a: 1 })
 * Booleans are stored as 0/1 and undefined as NULL.
 */
export class Db {
  private raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private txDepth = 0;
  private savepointCounter = 0;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL');
      // FULL survives power cuts (common for small shops) at a small cost in write speed.
      this.raw.exec('PRAGMA synchronous = FULL');
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  all<T = Record<string, any>>(sql: string, params?: SqlParams): T[] {
    const rows = this.stmt(sql).all(...(normalizeParams(params) as any[])) as object[];
    return rows.map((r) => ({ ...r })) as T[];
  }

  get<T = Record<string, any>>(sql: string, params?: SqlParams): T | undefined {
    const row = this.stmt(sql).get(...(normalizeParams(params) as any[])) as object | undefined;
    return row ? ({ ...row } as T) : undefined;
  }

  /** First column of the first row, or the fallback. */
  value<T = number>(sql: string, params?: SqlParams, fallback?: T): T {
    const row = this.stmt(sql).get(...(normalizeParams(params) as any[])) as Record<string, unknown> | undefined;
    if (!row) return fallback as T;
    const v = Object.values(row)[0];
    return (v === null || v === undefined ? fallback : v) as T;
  }

  run(sql: string, params?: SqlParams): RunResult {
    const r = this.stmt(sql).run(...(normalizeParams(params) as any[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Insert a row from an object and return the new id. */
  insert(table: string, row: Record<string, unknown>): number {
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => ':' + k).join(', ')})`;
    return this.run(sql, row).lastInsertRowid;
  }

  /** Update columns of a row by id. */
  update(table: string, id: number, row: Record<string, unknown>): number {
    const keys = Object.keys(row);
    if (!keys.length) return 0;
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :__id`;
    return this.run(sql, { ...row, __id: id }).changes;
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  /**
   * Run fn inside a transaction (nested calls use savepoints). fn must be
   * synchronous; if it throws, everything it did is rolled back.
   */
  tx<T>(fn: () => T): T {
    if (this.txDepth === 0) {
      this.raw.exec('BEGIN IMMEDIATE');
      this.txDepth++;
      try {
        const result = fn();
        if (result && typeof (result as any).then === 'function') {
          throw new Error('Db.tx callback must be synchronous');
        }
        this.raw.exec('COMMIT');
        return result;
      } catch (e) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw e;
      } finally {
        this.txDepth--;
      }
    }
    const name = `sp_${++this.savepointCounter}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    this.txDepth++;
    try {
      const result = fn();
      this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (e) {
      this.raw.exec(`ROLLBACK TO ${name}`);
      this.raw.exec(`RELEASE ${name}`);
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  /** Consistent point-in-time copy of the database into a new file. */
  vacuumInto(targetPath: string): void {
    this.raw.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.cache.clear();
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    this.raw.close();
  }
}

/** Build "?, ?, ?" for an IN (...) clause. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}
