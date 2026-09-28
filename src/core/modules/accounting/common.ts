/**
 * Helpers shared by the accounting module: voucher dates, entry snapshots,
 * "particulars" text for books and ledgers, and user names.
 */
import type { Ctx } from '../../context';
import { can, today } from '../../context';
import { AppError, fail } from '../../errors';
import { formatDate, fyOf, isValidISODate } from '../../../shared/dates';
import { VOUCHER_TYPE_LABELS, type PartyType, type SettlementMode, type VoucherType } from '../../../shared/constants';
import {
  accountBalance,
  getEntry,
  getEntryLines,
  getAccount,
  negativeBalanceWarning,
  paymentAccountId,
  systemAccountId,
  voidEntry,
  type AccountRow,
  type EntryLineInput,
  type JournalEntryRow,
} from '../../accounting/ledger';
import { isDateInClosedYear } from '../../accounting/periods';
import { getSection } from '../../settings';
import { formatDrCr } from '../../../shared/money';

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

/**
 * An account a document being edited already uses: it may have been deactivated since
 * (e.g. an expense head no longer used), which is fine as long as it stays the same account.
 */
export function savedAccount(ctx: Ctx, id: number, what = 'account'): AccountRow {
  try {
    return getAccount(ctx, id);
  } catch {
    throw fail.validation(`The ${what} was not found. Please choose it again.`);
  }
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

/* ------------------------------ Money going out, and entries touching closed accounts ------------------------------ */

function lineAccountId(ctx: Ctx, l: EntryLineInput): number {
  return typeof l.account === 'number' ? l.account : systemAccountId(ctx, l.account);
}

/** Net (debit - credit) per account of some ledger lines. */
function netByAccount(ctx: Ctx, lines: EntryLineInput[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const l of lines) {
    const id = lineAccountId(ctx, l);
    out.set(id, (out.get(id) ?? 0) + (l.debit ?? 0) - (l.credit ?? 0));
  }
  return out;
}

/**
 * Warnings (not errors) for money these lines take out of cash / bank / UPI
 * accounts when that would leave the account below zero on `date` or today.
 * Call before posting. For an edit pass the entry id: its old version is
 * cancelled first so it is not counted twice (the caller then replaces it,
 * which brings the entry back with its new lines).
 */
export function outflowWarnings(ctx: Ctx, lines: EntryLineInput[], date: string, editedEntryId?: number): string[] {
  const outflows = [...netByAccount(ctx, lines)].filter(([, net]) => net < 0);
  if (!outflows.length) return [];
  if (editedEntryId && !getEntry(ctx, editedEntryId).is_void) voidEntry(ctx, editedEntryId, 'Being edited');
  return outflows.map(([id, net]) => negativeBalanceWarning(ctx, id, -net, date)).filter((w): w is string => !!w);
}

export interface PaymentCheckInput {
  mode: SettlementMode;
  /** Cash / bank account paid from; default = the account for the mode. */
  accountId?: number | null;
  /** Money going out, in paise. */
  amount: number;
  date?: string | null;
  /** When editing a saved document: its ledger entry, which is left out (it is replaced on saving). */
  entryId?: number | null;
}

export interface PaymentCheck {
  accountId: number;
  accountName: string;
  date: string;
  /** Balance at the end of `date` before this payment; null when the user may not see balances. */
  balance: number | null;
  /** The warning the payment would get after saving ("Cash in Hand will be short by ..."); null = enough money. */
  warning: string | null;
}

/**
 * Check a payment before it is saved (salary, advance, expense, drawings ...), so the
 * form can show the balance next to "Paid from" and ask before money goes below zero.
 */
export function paymentCheck(ctx: Ctx, input: PaymentCheckInput): PaymentCheck {
  const date = input.date && isValidISODate(input.date) ? input.date : today(ctx);
  const accountId = paymentAccountId(ctx, input.mode, input.accountId);
  const acct = getAccount(ctx, accountId);
  const seesBalances = can(ctx, 'accounts.view');
  let balance: number | null = null;
  if (seesBalances) {
    const skip = input.entryId ? ' AND e.id <> ?' : '';
    balance = ctx.db.value<number>(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = ? AND e.is_void = 0 AND e.date <= ?${skip}`,
      input.entryId ? [accountId, date, input.entryId] : [accountId, date],
      0,
    );
  }
  return { accountId, accountName: acct.name, date, balance, warning: negativeBalanceWarning(ctx, accountId, input.amount, date, input.entryId) };
}

/** A closed loan's transactions cannot be cancelled or changed until the loan is re-opened. */
export function assertLoanOpen(ctx: Ctx, e: Pick<JournalEntryRow, 'source_type' | 'source_id'>, action: 'cancel' | 'change'): void {
  if (e.source_type !== 'loan' || !e.source_id) return;
  const loan = ctx.db.get<{ name: string; is_active: number }>('SELECT name, is_active FROM loans WHERE id = ?', [e.source_id]);
  if (loan && !loan.is_active) {
    throw fail.validation(`The loan "${loan.name}" is closed. Re-open it from Accounts > Loans before ${action === 'cancel' ? 'cancelling' : 'changing'} this entry.`);
  }
}

/**
 * Refuse to cancel an entry (newLines = null) or change its lines when that
 * would move money in or out of a closed loan or an inactive balance-sheet
 * account: a loan is only closed, and an account only deactivated, at a zero
 * balance. Income and expense accounts may be inactive with a balance.
 */
export function assertClosedAccountsUntouched(
  ctx: Ctx,
  entryId: number,
  newLines: EntryLineInput[] | null,
  action: 'cancel' | 'change',
  what = 'this entry',
): void {
  const e = getEntry(ctx, entryId);
  const verb = action === 'cancel' ? 'cancelling' : 'changing';
  assertLoanOpen(ctx, e, action);
  const before = new Map(
    ctx.db
      .all<{ account_id: number; net: number }>('SELECT account_id, SUM(debit - credit) AS net FROM journal_lines WHERE entry_id = ? GROUP BY account_id', [entryId])
      .map((r) => [r.account_id, e.is_void ? 0 : r.net]),
  );
  const after = newLines ? netByAccount(ctx, newLines) : new Map<number, number>();
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const change = (after.get(id) ?? 0) - (before.get(id) ?? 0);
    if (!change) continue;
    const acct = getAccount(ctx, id);
    if (acct.is_active || acct.type === 'income' || acct.type === 'expense') continue;
    const newBalance = accountBalance(ctx, id) + change;
    if (newBalance === 0) continue;
    const loan = ctx.db.get<{ name: string }>('SELECT name FROM loans WHERE account_id = ?', [id]);
    throw fail.validation(
      loan
        ? `The loan "${loan.name}" is closed, and ${verb} ${what} would change what is outstanding on it. Re-open the loan from Accounts > Loans first.`
        : `"${acct.name}" is inactive — activate it first in Accounts > Chart of accounts. ${verb[0].toUpperCase()}${verb.slice(1)} ${what} would give it a balance of ${formatDrCr(newBalance)}.`,
    );
  }
}

/**
 * Guard for cancelling a document (bill, payment, purchase, advance ...): refuse
 * when voiding its ledger entry would leave an inactive cash / bank (or other
 * balance-sheet) account, or a closed loan, with a balance. An account is only
 * deactivated at zero, and must stay there. Call before voidEntry.
 * `what` names the document in the message, e.g. "this bill".
 */
export function assertCancelKeepsClosedAccounts(ctx: Ctx, entryId: number | null | undefined, what: string): void {
  if (!entryId) return;
  assertClosedAccountsUntouched(ctx, entryId, null, 'cancel', what);
}

/** Why opening balances can no longer be entered (the first financial year is closed); null when they can. */
export function openingLockedReason(ctx: Ctx): string | null {
  const start = getSection(ctx, 'accounts').booksStartDate;
  if (!start || !isDateInClosedYear(ctx, start)) return null;
  return `Financial year ${fyOf(start).name}, when your books start, is closed, so opening balances can no longer be added or changed. Record money brought into the business as capital, a transfer or a loan received instead.`;
}
