import type { Ctx } from './context';
import type { SequenceKey } from '../shared/constants';
import { fyOf } from '../shared/dates';
import { getSection } from './settings';

export interface DocNumber {
  seq: number;
  /** Formatted number, e.g. "INV/26-27/0012". */
  number: string;
  /** Start date of the financial year the number belongs to. */
  fyStart: string;
}

export function formatDocNumber(prefix: string, fyShort: string, seq: number): string {
  const n = String(seq).padStart(4, '0');
  return prefix ? `${prefix}/${fyShort}/${n}` : `${fyShort}/${n}`;
}

/**
 * Take the next number in a document series. Numbers restart every
 * financial year and are never reused (cancelled documents keep theirs).
 * Must be called inside the transaction that saves the document.
 */
export function nextDocNumber(ctx: Ctx, key: SequenceKey, date: string): DocNumber {
  const fy = fyOf(date);
  ctx.db.run(
    `INSERT INTO sequences (key, fy_start, last_value) VALUES (?, ?, 1)
     ON CONFLICT (key, fy_start) DO UPDATE SET last_value = last_value + 1`,
    [key, fy.start],
  );
  const seq = ctx.db.value<number>('SELECT last_value FROM sequences WHERE key = ? AND fy_start = ?', [key, fy.start]);
  const prefix = getSection(ctx, 'billing').prefixes[key] ?? '';
  return { seq, number: formatDocNumber(prefix, fy.short, seq), fyStart: fy.start };
}

/** Preview the number the next document would get, without taking it. */
export function peekDocNumber(ctx: Ctx, key: SequenceKey, date: string): string {
  const fy = fyOf(date);
  const last = ctx.db.value<number>('SELECT last_value FROM sequences WHERE key = ? AND fy_start = ?', [key, fy.start], 0);
  const prefix = getSection(ctx, 'billing').prefixes[key] ?? '';
  return formatDocNumber(prefix, fy.short, last + 1);
}
