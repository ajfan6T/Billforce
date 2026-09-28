import type { Ctx } from '../context';
import { AppError } from '../errors';
import { fyOf, formatDate, isValidISODate, type FinancialYear } from '../../shared/dates';
import { getSection } from '../settings';

export interface FinancialYearRow {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  is_closed: number;
  closed_at: string | null;
  closed_by: number | null;
  closing_entry_id: number | null;
}

/** Get (creating if needed) the financial year row that contains the date. */
export function ensureFinancialYear(ctx: Ctx, date: string): FinancialYearRow {
  const fy = fyOf(date);
  let row = ctx.db.get<FinancialYearRow>('SELECT * FROM financial_years WHERE start_date = ?', [fy.start]);
  if (!row) {
    ctx.db.run('INSERT INTO financial_years (name, start_date, end_date) VALUES (?, ?, ?)', [fy.name, fy.start, fy.end]);
    row = ctx.db.get<FinancialYearRow>('SELECT * FROM financial_years WHERE start_date = ?', [fy.start])!;
  }
  return row;
}

export function getFinancialYear(ctx: Ctx, date: string): FinancialYear & { closed: boolean; id: number | null } {
  const fy = fyOf(date);
  const row = ctx.db.get<FinancialYearRow>('SELECT * FROM financial_years WHERE start_date = ?', [fy.start]);
  return { ...fy, closed: !!row?.is_closed, id: row?.id ?? null };
}

export function isDateInClosedYear(ctx: Ctx, date: string): boolean {
  return ctx.db.value<number>('SELECT is_closed FROM financial_years WHERE start_date = ?', [fyOf(date).start], 0) === 1;
}

/**
 * Throw unless transactions may be entered / changed on this date:
 * the date must be valid, on or after the books start date, and its
 * financial year must not be closed.
 */
export function assertDateOpen(ctx: Ctx, date: string, what = 'This transaction'): void {
  if (!isValidISODate(date)) throw new AppError('VALIDATION', 'Enter a valid date', { date: 'Enter a valid date' });
  const booksStart = getSection(ctx, 'accounts').booksStartDate;
  if (booksStart && date < booksStart) {
    throw new AppError(
      'VALIDATION',
      `${what} is dated ${formatDate(date)}, which is before your books start (${formatDate(booksStart)}).`,
      { date: 'Date is before the start of your books' },
    );
  }
  if (isDateInClosedYear(ctx, date)) {
    throw new AppError(
      'PERIOD_CLOSED',
      `Financial year ${fyOf(date).name} is closed, so entries dated ${formatDate(date)} cannot be added or changed. The owner can re-open the year from Accounts > Year-end closing.`,
    );
  }
}

export function listFinancialYears(ctx: Ctx): FinancialYearRow[] {
  return ctx.db.all<FinancialYearRow>('SELECT * FROM financial_years ORDER BY start_date DESC');
}
