/**
 * How stock enters the financial statements (periodic method, average cost).
 *
 * The ledger keeps purchases as an expense. The "Stock in Hand" account holds
 * the opening stock (opening balance entry) and, after each year-end closing,
 * that year's closing stock. Between closings the stock value comes from the
 * stock movements:
 *   Profit & loss:  cost of goods sold = opening stock + purchases - closing stock
 *   Balance sheet:  Stock in hand = value on the date; the profit lines carry the
 *                   change since the ledger balance, so the two sides still agree
 *   Year-end:       the closing entry moves Stock in Hand to the closing value and
 *                   takes the change to capital along with the year's profit
 * This applies while stock tracking is on, and afterwards for as long as stock is
 * in the books: turning tracking off takes the stock left out (a stock adjustment),
 * so the next year-end closing brings Stock in Hand to zero and nothing stays behind.
 */
import type { Ctx } from '../../context';
import { fyOf, type FinancialYear } from '../../../shared/dates';
import { stockEnabled, stockValue } from './valuation';

function stockAccountId(ctx: Ctx): number | null {
  return ctx.db.value<number | null>("SELECT id FROM accounts WHERE system_key = 'STOCK'", undefined, null);
}

/** Stock is part of the accounts: tracking is on, or stock was tracked before (movements or a Stock in Hand balance). */
export function stockInBooks(ctx: Ctx): boolean {
  if (stockEnabled(ctx)) return true;
  if (ctx.db.value<number>('SELECT EXISTS (SELECT 1 FROM stock_moves)', undefined, 0)) return true;
  const id = stockAccountId(ctx);
  return !!id && !!ctx.db.value<number>('SELECT EXISTS (SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_id = ? AND e.is_void = 0)', [id], 0);
}

/** Opening and closing stock of a period (null when stock was never tracked). */
export function periodStock(ctx: Ctx, from: string, to: string): { opening: number; closing: number } | null {
  if (!stockInBooks(ctx)) return null;
  return { opening: stockValue(ctx, from, 'start'), closing: stockValue(ctx, to, 'end') };
}

/** Balance of Stock in Hand in the ledger up to a date, leaving out closing entries dated from `excludeClosingFrom`. */
function ledgerStock(ctx: Ctx, to: string, excludeClosingFrom: string): number {
  const id = stockAccountId(ctx);
  if (!id) return 0;
  return ctx.db.value<number>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ? AND e.is_void = 0 AND e.date <= ? AND NOT (e.voucher_type = 'closing' AND e.date >= ?)`,
    [id, to, excludeClosingFrom],
    0,
  );
}

export interface BalanceSheetStock {
  accountId: number | null;
  /** Stock in hand at average cost on the date (shown instead of the ledger balance). */
  value: number;
  /** Ledger balance of Stock in Hand (the opening stock or the last closing stock). */
  ledger: number;
  /** Added to "Profit & loss (current year)": closing stock - opening stock of the year. */
  currentYear: number;
  /** Added to "Profit & loss (previous years, not closed)". */
  previousYears: number;
}

export function balanceSheetStock(ctx: Ctx, asOf: string): BalanceSheetStock | null {
  if (!stockInBooks(ctx)) return null;
  const fy = fyOf(asOf);
  const value = stockValue(ctx, asOf, 'end');
  const atYearStart = stockValue(ctx, fy.start, 'start');
  const ledger = ledgerStock(ctx, asOf, fy.start);
  return { accountId: stockAccountId(ctx), value, ledger, currentYear: value - atYearStart, previousYears: atYearStart - ledger };
}

/** Year-end closing: closing stock of the year and the change to post to Stock in Hand. */
export function closingStock(ctx: Ctx, fy: FinancialYear): { accountId: number; value: number; ledger: number; change: number } | null {
  if (!stockInBooks(ctx)) return null;
  const accountId = stockAccountId(ctx);
  if (!accountId) return null;
  const value = stockValue(ctx, fy.end, 'end');
  const ledger = ledgerStock(ctx, fy.end, fy.start);
  return { accountId, value, ledger, change: value - ledger };
}

/**
 * Stock result of a year for the list of years: closed years as the closing entry posted it,
 * open years closing stock - stock at the start of the year (what its Profit & loss shows).
 */
export function yearStock(ctx: Ctx, fy: FinancialYear, closingEntryId: number | null): { value: number; change: number } | null {
  if (!stockInBooks(ctx)) return null;
  const value = stockValue(ctx, fy.end, 'end');
  const id = stockAccountId(ctx);
  if (closingEntryId) {
    const posted = id ? ctx.db.value<number>('SELECT COALESCE(SUM(debit - credit), 0) FROM journal_lines WHERE entry_id = ? AND account_id = ?', [closingEntryId, id], 0) : 0;
    return { value, change: posted };
  }
  return { value, change: value - stockValue(ctx, fy.start, 'start') };
}
