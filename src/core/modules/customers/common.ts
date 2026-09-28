/**
 * Helpers shared by the customers, suppliers and purchases modules:
 * phone matching, document dates, opening balances, running balances and
 * short descriptions of source documents for statements.
 */
import type { Ctx } from '../../context';
import { can, today } from '../../context';
import { AppError, fail } from '../../errors';
import type { Permission } from '../../../shared/permissions';
import { formatDate, fyOf, isValidISODate } from '../../../shared/dates';
import { formatINR, formatQty } from '../../../shared/money';
import { PAYMENT_MODE_LABELS, type PartyType, type SettlementMode } from '../../../shared/constants';
import { getEntryLines, systemAccountId } from '../../accounting/ledger';
import type { SystemKey } from '../../accounting/chart';

/** Digits of a phone number used to spot duplicates: "+91 98200-12345" and "09820012345" both give "9820012345". */
export function phoneKey(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, '');
  if (d.length > 10 && (d.startsWith('91') || d.startsWith('0'))) d = d.slice(-10);
  return d || null;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = email?.trim();
  if (!e) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw fail.validation('Enter a valid email address, e.g. name@example.com', { email: 'Enter a valid email address' });
  return e;
}

/**
 * Date for a new or edited document: defaults to today, may not be in the
 * future, and a date other than today needs `backdatePermission` (if given).
 * When editing, pass the saved date as `unchangedDate`: keeping it never needs permission.
 */
export function resolveDocDate(
  ctx: Ctx,
  date: string | null | undefined,
  opts: { what: string; backdatePermission?: Permission; unchangedDate?: string },
): string {
  const t = today(ctx);
  const d = date || opts.unchangedDate || t;
  if (!isValidISODate(d)) throw fail.validation('Enter a valid date', { date: 'Enter a valid date' });
  if (d > t) {
    throw fail.validation(`${opts.what} cannot be dated later than today (${formatDate(t)}).`, { date: 'Date cannot be in the future' });
  }
  if (d !== t && d !== opts.unchangedDate && opts.backdatePermission && !can(ctx, opts.backdatePermission)) {
    throw new AppError('FORBIDDEN', `You can only use today's date (${formatDate(t)}). Ask the owner for permission to enter entries with a past date.`, {
      date: "Only today's date is allowed",
    });
  }
  return d;
}

/** Document numbers belong to a financial year, so an edit may not move a document into another year. */
export function assertSameFinancialYear(oldDate: string, newDate: string, what: string): void {
  if (fyOf(oldDate).start !== fyOf(newDate).start) {
    throw fail.validation(
      `${what} belongs to financial year ${fyOf(oldDate).name}. To move it to ${fyOf(newDate).name}, cancel it and enter a new one.`,
      { date: `Keep the date within ${fyOf(oldDate).name}` },
    );
  }
}

/** "Sugar 2 kg, Tea 1, Rice 5 kg +2 more" */
export function itemsSummary(items: Array<{ name: string; qty: number; unit?: string | null }>, max = 3): string {
  const parts = items.slice(0, max).map((i) => `${i.name} ${formatQty(i.qty)}${i.unit && i.unit !== 'pcs' ? ' ' + i.unit : ''}`);
  const more = items.length - max;
  return parts.join(', ') + (more > 0 ? ` +${more} more` : '');
}

/** "UPI · Ref 4521" */
export function modeText(mode: SettlementMode | string, reference?: string | null): string {
  const label = PAYMENT_MODE_LABELS[mode as SettlementMode] ?? mode;
  return reference ? `${label} · Ref ${reference}` : label;
}

/** Opening balance held in a party's opening entry (debit - credit on the control account), 0 if none / void. */
export function openingDebit(ctx: Ctx, partyType: PartyType, partyId: number, entryId: number | null): number {
  if (!entryId) return 0;
  return ctx.db.value<number>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.id = ? AND e.is_void = 0 AND l.party_type = ? AND l.party_id = ?`,
    [entryId, partyType, partyId],
    0,
  );
}

/**
 * Party balance on its control account including everything up to a document:
 * all entries dated before `date`, plus entries on that date up to and including `entryId`.
 */
export function balanceThroughEntry(ctx: Ctx, partyType: PartyType, partyId: number, account: SystemKey, date: string, entryId: number): number {
  return ctx.db.value<number>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.party_type = ? AND l.party_id = ? AND l.account_id = ? AND e.is_void = 0
        AND (e.date < ? OR (e.date = ? AND e.id <= ?))`,
    [partyType, partyId, systemAccountId(ctx, account), date, date, entryId],
    0,
  );
}

export function userName(ctx: Ctx, userId: number | null | undefined): string | null {
  if (!userId) return null;
  return ctx.db.value<string | null>('SELECT full_name FROM users WHERE id = ?', [userId], null);
}

export interface PostingLine {
  account: string;
  party: string | null;
  debit: number;
  credit: number;
}

/** The ledger lines of a document's journal entry, for "How this was recorded in the accounts". */
export function postingLines(ctx: Ctx, entryId: number | null): PostingLine[] {
  if (!entryId) return [];
  return getEntryLines(ctx, entryId).map((l) => ({ account: l.account_name, party: l.party_name, debit: l.debit, credit: l.credit }));
}

/** "₹500.00 will be kept as advance" style warning when a payment is more than what is due. */
export function advanceWarning(partyName: string, dueBefore: number, settled: number, kind: 'customer' | 'supplier'): string | null {
  const after = dueBefore - settled;
  if (after >= 0 || settled <= 0) return null;
  const extra = Math.min(-after, settled);
  if (dueBefore <= 0) {
    return kind === 'customer'
      ? `${partyName} had nothing due, so ${formatINR(extra)} is kept as an advance from the customer.`
      : `Nothing was payable to ${partyName}, so ${formatINR(extra)} is recorded as an advance paid to the supplier.`;
  }
  return kind === 'customer'
    ? `This is ${formatINR(extra)} more than the amount due. The extra ${formatINR(extra)} is kept as an advance from ${partyName}.`
    : `This is ${formatINR(extra)} more than the amount payable. The extra ${formatINR(extra)} is recorded as an advance paid to ${partyName}.`;
}

/** Status text for a balance, from the business's point of view. */
export function balanceText(balance: number, kind: 'customer' | 'supplier'): string {
  if (kind === 'customer') {
    if (balance > 0) return `Customer owes you ${formatINR(balance)}`;
    if (balance < 0) return `Advance of ${formatINR(-balance)} with you`;
    return 'Nothing due';
  }
  // supplier balances: negative (credit) = you owe the supplier
  if (balance < 0) return `You owe ${formatINR(-balance)}`;
  if (balance > 0) return `Advance of ${formatINR(balance)} paid`;
  return 'Nothing payable';
}
