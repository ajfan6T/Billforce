/**
 * Helpers shared by the accounting module: voucher dates, entry snapshots,
 * "particulars" text for books and ledgers, and user names.
 */
import type { Ctx } from '../../context';
import { today } from '../../context';
import { AppError, fail } from '../../errors';
import { formatDate, fyOf, isValidISODate } from '../../../shared/dates';
import { VOUCHER_TYPE_LABELS, type PartyType, type VoucherType } from '../../../shared/constants';
import { getEntry, getEntryLines, type AccountRow, getAccount, type JournalEntryRow } from '../../accounting/ledger';
import { isDateInClosedYear } from '../../accounting/periods';

/** Source types whose entries can be edited / cancelled from the Accounts pages. */
export const EDITABLE_SOURCES = ['manual', 'loan'] as const;

/** Friendly names of the documents that produce journal entries. */
export const SOURCE_LABELS: Record<string, string> = {
  bill: 'Sales bill',
  credit_note: 'Sales return / credit note',
  receipt: 'Payment received',
  purchase: 'Purchase bill',
  supplier_payment: 'Payment to supplier',
  expense: 'Expense',
  salary: 'Salary slip',
  salary_payment: 'Salary payment',
  advance: 'Employee advance',
  loan: 'Loan',
  manual: 'Accounts entry',
  opening: 'Opening balance',
  closing: 'Year-end closing',
};

/** Where the user must go to change an entry that belongs to a document. */
export const SOURCE_CHANGE_HINT: Record<string, string> = {
  bill: 'Open the bill to edit or cancel it.',
  credit_note: 'Open the return / credit note to change it.',
  receipt: 'Open the payment received to change it.',
  purchase: 'Open the purchase bill to change it.',
  supplier_payment: 'Open the supplier payment to change it.',
  expense: 'Open the expense to edit or cancel it.',
  salary: 'Open the salary slip to change it.',
  salary_payment: 'Open the salary slip to change the payment.',
  advance: 'Change it from Employees > Advances.',
  opening: 'Opening balances are changed from the customer, supplier, employee or account they belong to.',
  closing: 'Re-open the financial year from Accounts > Year-end closing to remove it.',
};

export function voucherLabel(type: string): string {
  return VOUCHER_TYPE_LABELS[type as VoucherType] ?? type;
}

export function userName(ctx: Ctx, userId: number | null | undefined): string | null {
  if (!userId) return null;
  return ctx.db.value<string | null>('SELECT full_name FROM users WHERE id = ?', [userId], null);
}

/**
 * Date for a new or edited voucher: defaults to today and may not be later
 * than today. (Books-start and closed-year checks happen in the ledger engine.)
 */
export function resolveVoucherDate(ctx: Ctx, date: string | null | undefined, what: string): string {
  const t = today(ctx);
  const d = date || t;
  if (!isValidISODate(d)) throw fail.validation('Enter a valid date', { date: 'Enter a valid date' });
  if (d > t) throw fail.validation(`${what} cannot be dated later than today (${formatDate(t)}).`, { date: 'Date cannot be in the future' });
  return d;
}

/** Voucher numbers belong to a financial year, so an edit may not move a voucher into another year. */
export function assertSameYear(oldDate: string, newDate: string, what: string): void {
  if (fyOf(oldDate).start !== fyOf(newDate).start) {
    throw fail.validation(
      `${what} belongs to financial year ${fyOf(oldDate).name}. To move it to ${fyOf(newDate).name}, cancel it and enter a new one.`,
      { date: `Keep the date within ${fyOf(oldDate).name}` },
    );
  }
}

/** An account that the user may post to: must exist and be active. */
export function activeAccount(ctx: Ctx, id: number, what = 'account'): AccountRow {
  let acct: AccountRow;
  try {
    acct = getAccount(ctx, id);
  } catch {
    throw fail.validation(`The ${what} was not found. Please choose it again.`);
  }
  if (!acct.is_active) throw fail.validation(`"${acct.name}" is inactive. Re-activate it in the chart of accounts or choose another ${what}.`);
  return acct;
}

export interface EntryLineView {
  lineNo: number;
  accountId: number;
  accountName: string;
  accountCode: string | null;
  partyType: PartyType | null;
  partyId: number | null;
  partyName: string | null;
  debit: number;
  credit: number;
  memo: string | null;
}

export function entryLines(ctx: Ctx, entryId: number): EntryLineView[] {
  return getEntryLines(ctx, entryId).map((l) => ({
    lineNo: l.line_no,
    accountId: l.account_id,
    accountName: l.account_name,
    accountCode: l.account_code,
    partyType: l.party_type,
    partyId: l.party_id,
    partyName: l.party_name,
    debit: l.debit,
    credit: l.credit,
    memo: l.memo,
  }));
}

/** Full snapshot of an entry for the audit trail (document_revisions). */
export function entrySnapshot(ctx: Ctx, entryId: number): Record<string, unknown> {
  const e = getEntry(ctx, entryId);
  const lines = entryLines(ctx, entryId);
  return {
    entryId: e.id,
    date: e.date,
    voucherType: e.voucher_type,
    voucherNo: e.voucher_no,
    narration: e.narration,
    status: e.is_void ? 'cancelled' : 'active',
    total: lines.reduce((s, l) => s + l.debit, 0),
    lines: lines.map((l) => ({
      account: l.accountName,
      accountId: l.accountId,
      party: l.partyName,
      partyType: l.partyType,
      partyId: l.partyId,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo,
    })),
  };
}

/** Why an entry cannot be changed from the Accounts pages (null = it can). */
export function lockReason(e: Pick<JournalEntryRow, 'source_type' | 'is_void' | 'voucher_type'>): string | null {
  if (e.voucher_type === 'closing') return SOURCE_CHANGE_HINT.closing;
  if (e.is_void) return 'This entry is cancelled.';
  if (e.voucher_type === 'opening' || e.source_type === 'opening') return `This is an opening balance. ${SOURCE_CHANGE_HINT.opening}`;
  if (!e.source_type || !(EDITABLE_SOURCES as readonly string[]).includes(e.source_type)) {
    const hint = SOURCE_CHANGE_HINT[e.source_type ?? ''] ?? 'Change it from the document it belongs to.';
    const what = (SOURCE_LABELS[e.source_type ?? ''] ?? 'another document').toLowerCase();
    return `This entry was made automatically from ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what}. ${hint}`;
  }
  return null;
}

/** Message when the entry's financial year is closed (null = open). */
export function closedYearReason(ctx: Ctx, date: string): string | null {
  if (!isDateInClosedYear(ctx, date)) return null;
  return `Financial year ${fyOf(date).name} is closed, so this cannot be changed. The owner can re-open the year from Accounts > Year-end closing.`;
}

/** Throw unless the entry was entered from the Accounts pages. */
export function assertEditableEntry(ctx: Ctx, entryId: number): JournalEntryRow {
  const e = getEntry(ctx, entryId);
  if (e.is_void) throw fail.validation('This entry is already cancelled.');
  const reason = lockReason(e);
  if (reason) throw new AppError('VALIDATION', reason);
  return e;
}

/** Short list of names: "Rent, Electricity and 2 more". */
export function joinNames(names: string[], max = 3): string {
  const uniq = [...new Set(names.filter(Boolean))];
  if (uniq.length <= max) return uniq.join(', ');
  return `${uniq.slice(0, max).join(', ')} and ${uniq.length - max} more`;
}

/** Display name of a line: the party's name for customer / supplier / employee lines, otherwise the account. */
export function lineName(l: { account_name: string; party_name: string | null }): string {
  return l.party_name ? l.party_name : l.account_name;
}

/** In-clause helper. */
export function inList(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}
