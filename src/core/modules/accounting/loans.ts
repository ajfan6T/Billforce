/**
 * Loans taken (a liability: bank loan, loan from a relative) and loans given
 * (an asset). Each loan has its own ledger account; its transactions are
 * journal entries with voucher type 'loan' and source ('loan', loan id).
 *
 *   Loan taken  - receive : Dr cash / bank                       Cr loan a/c
 *               - repay   : Dr loan a/c (principal) + INTEREST_EXPENSE (interest)   Cr cash / bank
 *   Loan given  - give    : Dr loan a/c                          Cr cash / bank
 *               - collect : Dr cash / bank                       Cr loan a/c (principal) + INTEREST_INCOME (interest)
 */
import type { Ctx } from '../../context';
import { currentUserId, now } from '../../context';
import { fail } from '../../errors';
import { logActivity } from '../../audit';
import { getSection } from '../../settings';
import { accountBalance, getAccount, paymentAccountId, systemAccountId, type EntryLineInput } from '../../accounting/ledger';
import { entrySourceLink } from '../../accounting/links';
import { formatINR } from '../../../shared/money';
import { addDays, describeRange, formatDate, fyOf } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS, type SettlementMode } from '../../../shared/constants';
import type { ReportData, ReportRow } from '../../../shared/report';
import { activeAccount, closedYearReason, lockReason, openingLockedReason, resolveVoucherDate, userName } from './common';
import { nextAccountCode, setAccountOpening } from './chart';
import { getEntryDetail, postManualVoucher, type EntryDetail } from './journals';

export type LoanDirection = 'taken' | 'given';
export type LoanKind = 'receive' | 'repay' | 'give' | 'collect';

const KINDS: Record<LoanDirection, LoanKind[]> = { taken: ['receive', 'repay'], given: ['give', 'collect'] };

export const LOAN_KIND_LABELS: Record<LoanKind | 'opening' | 'other', string> = {
  receive: 'Loan received',
  repay: 'Repayment',
  give: 'Loan given',
  collect: 'Repayment received',
  opening: 'Opening balance',
  other: 'Adjustment',
};

interface LoanRow {
  id: number;
  name: string;
  direction: LoanDirection;
  account_id: number;
  principal: number;
  interest_rate: number | null;
  start_date: string | null;
  notes: string | null;
  is_active: number;
  created_by: number | null;
  created_at: string;
  updated_at: string | null;
}

function loanRow(ctx: Ctx, id: number): LoanRow {
  const r = ctx.db.get<LoanRow>('SELECT * FROM loans WHERE id = ?', [id]);
  if (!r) throw fail.notFound('Loan');
  return r;
}

function accountNameFor(direction: LoanDirection, name: string): string {
  return direction === 'taken' ? `Loan - ${name}` : `Loan given - ${name}`;
}

function uniqueAccountName(ctx: Ctx, base: string, exceptId = 0): string {
  let candidate = base;
  for (let i = 2; ctx.db.value<number>('SELECT COUNT(*) FROM accounts WHERE name = ? AND id <> ?', [candidate, exceptId], 0); i++) {
    candidate = `${base} (${i})`;
  }
  return candidate;
}

/** Outstanding amount: what you still owe (taken) or are still owed (given). */
function outstandingOf(ctx: Ctx, loan: LoanRow, to?: string): number {
  const bal = accountBalance(ctx, loan.account_id, to ? { to } : {});
  return loan.direction === 'taken' ? 0 - bal : bal;
}

function interestOf(ctx: Ctx, loan: LoanRow): number {
  const key = loan.direction === 'taken' ? 'INTEREST_EXPENSE' : 'INTEREST_INCOME';
  return ctx.db.value<number>(
    `SELECT COALESCE(SUM(${loan.direction === 'taken' ? 'l.debit - l.credit' : 'l.credit - l.debit'}), 0)
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.is_void = 0 AND e.source_type = 'loan' AND e.source_id = ? AND l.account_id = ?`,
    [loan.id, systemAccountId(ctx, key)],
    0,
  );
}

export interface LoanSummary {
  id: number;
  name: string;
  direction: LoanDirection;
  accountId: number;
  accountName: string;
  principal: number;
  interestRate: number | null;
  startDate: string | null;
  notes: string | null;
  isActive: boolean;
  outstanding: number;
  /** Interest paid (taken) or received (given) so far. */
  interestToDate: number;
  /** Total principal received (taken) or given out (given). */
  disbursed: number;
  /** Total principal repaid (taken) or collected back (given). */
  repaid: number;
  lastDate: string | null;
}

function summarize(ctx: Ctx, loan: LoanRow): LoanSummary {
  const acct = getAccount(ctx, loan.account_id);
  const sums = ctx.db.get<{ dr: number; cr: number; last: string | null }>(
    `SELECT COALESCE(SUM(l.debit), 0) AS dr, COALESCE(SUM(l.credit), 0) AS cr, MAX(e.date) AS last
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.is_void = 0 AND l.account_id = ?`,
    [loan.account_id],
  )!;
  const lastInterest = ctx.db.value<string | null>(
    "SELECT MAX(date) FROM journal_entries WHERE is_void = 0 AND source_type = 'loan' AND source_id = ?",
    [loan.id],
    null,
  );
  const last = [sums.last, lastInterest].filter(Boolean).sort().pop() ?? null;
  return {
    id: loan.id,
    name: loan.name,
    direction: loan.direction,
    accountId: loan.account_id,
    accountName: acct.name,
    principal: loan.principal,
    interestRate: loan.interest_rate,
    startDate: loan.start_date,
    notes: loan.notes,
    isActive: !!loan.is_active,
    outstanding: outstandingOf(ctx, loan),
    interestToDate: interestOf(ctx, loan),
    disbursed: loan.direction === 'taken' ? sums.cr : sums.dr,
    repaid: loan.direction === 'taken' ? sums.dr : sums.cr,
    lastDate: last,
  };
}

/** Why an older loan can no longer be brought in with an opening balance (the first year is closed); null when it can. */
function loanOpeningLockedReason(ctx: Ctx): string | null {
  if (!openingLockedReason(ctx)) return null;
  const start = getSection(ctx, 'accounts').booksStartDate;
  return `Financial year ${fyOf(start).name}, when your books start, is closed, so an older loan can no longer be brought in with an opening balance. Save it with a start date from ${formatDate(start)} without recording any money, then enter the amount outstanding with a journal entry against the loan account.`;
}

export function listLoans(
  ctx: Ctx,
  opts: { includeClosed?: boolean } = {},
): {
  rows: LoanSummary[];
  totals: { taken: number; given: number; interestPaid: number; interestReceived: number };
  booksStartDate: string;
  /** Why an older loan's opening balance can no longer be entered (first year closed); null when it can. */
  openingLockedReason: string | null;
} {
  const rows = ctx.db
    .all<LoanRow>(`SELECT * FROM loans ${opts.includeClosed ? '' : 'WHERE is_active = 1'} ORDER BY is_active DESC, direction DESC, name COLLATE NOCASE`)
    .map((l) => summarize(ctx, l));
  const totals = { taken: 0, given: 0, interestPaid: 0, interestReceived: 0 };
  for (const r of rows) {
    if (r.direction === 'taken') {
      totals.taken += r.outstanding;
      totals.interestPaid += r.interestToDate;
    } else {
      totals.given += r.outstanding;
      totals.interestReceived += r.interestToDate;
    }
  }
  return { rows, totals, booksStartDate: getSection(ctx, 'accounts').booksStartDate, openingLockedReason: loanOpeningLockedReason(ctx) };
}

/* ------------------------------ Transactions ------------------------------ */

export interface LoanTransactionInput {
  loanId: number;
  date?: string | null;
  kind: LoanKind;
  principal: number;
  interest?: number;
  mode: SettlementMode;
  accountId?: number | null;
  narration?: string | null;
}

function kindNarration(loan: LoanRow, kind: LoanKind, principal: number, interest: number): string {
  const split = interest ? ` (principal ${formatINR(principal)}, interest ${formatINR(interest)})` : '';
  switch (kind) {
    case 'receive':
      return `Loan received from ${loan.name}`;
    case 'repay':
      return principal ? `Loan repayment to ${loan.name}${split}` : `Interest paid to ${loan.name}`;
    case 'give':
      return `Loan given to ${loan.name}`;
    case 'collect':
      return principal ? `Loan repayment received from ${loan.name}${split}` : `Interest received from ${loan.name}`;
  }
}

function postLoanTransaction(ctx: Ctx, loan: LoanRow, input: Omit<LoanTransactionInput, 'loanId'>): { id: number; warnings: string[] } {
  if (!loan.is_active) throw fail.validation(`The loan "${loan.name}" is closed. Re-open it to add transactions.`);
  if (!KINDS[loan.direction].includes(input.kind)) {
    throw fail.validation(loan.direction === 'taken' ? 'For a loan taken, choose "Loan received" or "Repayment".' : 'For a loan given, choose "Loan given" or "Repayment received".', {
      kind: 'Wrong kind of transaction',
    });
  }
  const date = resolveVoucherDate(ctx, input.date, 'A loan transaction');
  const principal = input.principal ?? 0;
  const interest = input.interest ?? 0;
  if (principal < 0 || interest < 0) throw fail.validation('Amounts cannot be negative');
  const inflow = input.kind === 'receive' || input.kind === 'give';
  if (inflow && interest) throw fail.validation('Interest is entered with repayments, not when the loan amount is received or given.', { interest: 'Leave interest at zero' });
  if (inflow && !principal) throw fail.validation('Enter the loan amount', { principal: 'Enter the amount' });
  if (!principal && !interest) throw fail.validation('Enter the principal and / or interest amount', { principal: 'Enter an amount' });
  if (!inflow && principal) {
    const outstanding = outstandingOf(ctx, loan);
    if (principal > outstanding) {
      throw fail.validation(
        outstanding > 0
          ? `The principal ${formatINR(principal)} is more than the outstanding ${formatINR(outstanding)}. Put the extra amount under interest if it is interest.`
          : `Nothing is outstanding on this loan. Enter the amount under interest if it is interest.`,
        { principal: `At most ${formatINR(Math.max(outstanding, 0))}` },
      );
    }
  }
  const pay = activeAccount(ctx, paymentAccountId(ctx, input.mode, input.accountId), `${PAYMENT_MODE_LABELS[input.mode]} account`);
  const total = principal + interest;
  let lines: EntryLineInput[];
  switch (input.kind) {
    case 'receive':
      lines = [
        { account: pay.id, debit: principal },
        { account: loan.account_id, credit: principal },
      ];
      break;
    case 'repay':
      lines = [
        { account: loan.account_id, debit: principal },
        { account: 'INTEREST_EXPENSE', debit: interest },
        { account: pay.id, credit: total },
      ];
      break;
    case 'give':
      lines = [
        { account: loan.account_id, debit: principal },
        { account: pay.id, credit: principal },
      ];
      break;
    case 'collect':
      lines = [
        { account: pay.id, debit: total },
        { account: loan.account_id, credit: principal },
        { account: 'INTEREST_INCOME', credit: interest },
      ];
      break;
  }
  const narration = input.narration?.trim() || kindNarration(loan, input.kind, principal, interest);
  return postManualVoucher(
    ctx,
    { date, voucherType: 'loan', narration, lines, sourceType: 'loan', sourceId: loan.id },
    {
      action: 'loan.transaction',
      entityType: 'loan',
      entityId: loan.id,
      summary: (no) => `${LOAN_KIND_LABELS[input.kind]} ${formatINR(total)} - ${loan.name} (${no})`,
    },
  );
}

/** Record a loan transaction; `warnings` when a repayment / loan given would leave the cash or bank account below zero. */
export function loanTransaction(ctx: Ctx, input: LoanTransactionInput): { entry: EntryDetail; loan: LoanSummary; warnings: string[] } {
  const loan = loanRow(ctx, input.loanId);
  const { id, warnings } = postLoanTransaction(ctx, loan, input);
  return { entry: getEntryDetail(ctx, id), loan: summarize(ctx, loanRow(ctx, loan.id)), warnings };
}

/* ------------------------------ Create / update ------------------------------ */

export interface LoanInput {
  name: string;
  direction: LoanDirection;
  /** Sanctioned / agreed amount (for reference). */
  principal: number;
  interestRate?: number | null;
  startDate: string;
  notes?: string | null;
  /** Amount still outstanding on the books start date, for loans that existed before you started using Billforce. */
  openingOutstanding?: number | null;
  /** First receipt (taken) or payment (given) of the loan money. */
  disburse?: { date?: string | null; mode: SettlementMode; accountId?: number | null; amount: number } | null;
}

export function createLoan(ctx: Ctx, input: LoanInput): LoanDetail & { warnings: string[] } {
  const name = input.name.trim();
  if (!name) throw fail.validation('Enter who the loan is from / to, e.g. "HDFC Bank"', { name: 'Enter a name' });
  const dup = ctx.db.value<number>('SELECT COUNT(*) FROM loans WHERE name = ? AND direction = ? AND is_active = 1', [name, input.direction], 0);
  if (dup) throw fail.validation(`An open loan named "${name}" already exists. Add the new amount to it, or use a different name.`, { name: 'Name already used' });
  if (input.interestRate !== null && input.interestRate !== undefined && (input.interestRate < 0 || input.interestRate > 100)) {
    throw fail.validation('Interest rate must be between 0 and 100% a year', { interestRate: 'Between 0 and 100' });
  }
  const booksStart = getSection(ctx, 'accounts').booksStartDate;
  if (input.openingOutstanding && input.startDate > booksStart) {
    throw fail.validation(`An opening balance is only for loans that started before your books start (${formatDate(booksStart)}). Record the loan money as received / given instead.`, {
      openingOutstanding: 'Only for older loans',
    });
  }
  const locked = input.openingOutstanding ? loanOpeningLockedReason(ctx) : null;
  if (locked) throw fail.validation(locked, { openingOutstanding: 'The first year is closed' });
  const ts = now(ctx);
  const group = input.direction === 'taken' ? 'loans' : 'loans_advances';
  const accountId = ctx.db.insert('accounts', {
    code: nextAccountCode(ctx, group),
    name: uniqueAccountName(ctx, accountNameFor(input.direction, name)),
    group_code: group,
    description: input.direction === 'taken' ? `Loan taken from ${name}` : `Loan given to ${name}`,
    created_at: ts,
  });
  const id = ctx.db.insert('loans', {
    name,
    direction: input.direction,
    account_id: accountId,
    principal: input.principal,
    interest_rate: input.interestRate ?? null,
    start_date: input.startDate,
    notes: input.notes?.trim() || null,
    created_by: currentUserId(ctx),
    created_at: ts,
  });
  if (input.openingOutstanding) {
    setAccountOpening(ctx, getAccount(ctx, accountId), input.direction === 'taken' ? -input.openingOutstanding : input.openingOutstanding);
  }
  logActivity(
    ctx,
    'loan.create',
    `Added loan ${input.direction === 'taken' ? 'taken from' : 'given to'} ${name}: ${formatINR(input.principal)}${input.interestRate ? ` at ${input.interestRate}% a year` : ''}`,
    { entityType: 'loan', entityId: id, details: input },
  );
  let warnings: string[] = [];
  if (input.disburse && input.disburse.amount > 0) {
    ({ warnings } = postLoanTransaction(ctx, loanRow(ctx, id), {
      date: input.disburse.date || input.startDate,
      kind: input.direction === 'taken' ? 'receive' : 'give',
      principal: input.disburse.amount,
      interest: 0,
      mode: input.disburse.mode,
      accountId: input.disburse.accountId,
    }));
  }
  return { ...getLoan(ctx, id), warnings };
}

export interface LoanUpdate {
  name: string;
  principal?: number;
  interestRate?: number | null;
  startDate?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export function updateLoan(ctx: Ctx, id: number, input: LoanUpdate): LoanDetail {
  const before = loanRow(ctx, id);
  const name = input.name.trim();
  if (!name) throw fail.validation('Enter who the loan is from / to', { name: 'Enter a name' });
  if (input.interestRate !== null && input.interestRate !== undefined && (input.interestRate < 0 || input.interestRate > 100)) {
    throw fail.validation('Interest rate must be between 0 and 100% a year', { interestRate: 'Between 0 and 100' });
  }
  const changes: string[] = [];
  const patch: Record<string, unknown> = { name, updated_at: now(ctx) };
  if (input.principal !== undefined) patch.principal = input.principal;
  if (input.interestRate !== undefined) patch.interest_rate = input.interestRate;
  if (input.startDate !== undefined) patch.start_date = input.startDate;
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  if (name !== before.name) {
    changes.push(`renamed from "${before.name}"`);
    ctx.db.update('accounts', before.account_id, { name: uniqueAccountName(ctx, accountNameFor(before.direction, name), before.account_id), updated_at: now(ctx) });
  }
  if (input.interestRate !== undefined && input.interestRate !== before.interest_rate) changes.push(`interest ${before.interest_rate ?? 0}% → ${input.interestRate ?? 0}%`);
  if (input.isActive !== undefined && input.isActive !== !!before.is_active) {
    if (!input.isActive) {
      const out = outstandingOf(ctx, before);
      if (out !== 0) {
        throw fail.validation(`${formatINR(Math.abs(out))} is still ${out > 0 ? 'outstanding' : 'overpaid'} on this loan. It can be closed when the balance is zero.`);
      }
    }
    patch.is_active = input.isActive ? 1 : 0;
    ctx.db.update('accounts', before.account_id, { is_active: input.isActive ? 1 : 0, updated_at: now(ctx) });
    changes.push(input.isActive ? 're-opened' : 'closed');
  }
  ctx.db.update('loans', id, patch);
  logActivity(ctx, 'loan.update', `Updated loan "${name}"${changes.length ? ': ' + changes.join(', ') : ''}`, {
    entityType: 'loan',
    entityId: id,
    details: { before, after: input },
  });
  return getLoan(ctx, id);
}

/* ------------------------------ Detail & ledger ------------------------------ */

export interface LoanTransactionRow {
  entryId: number;
  date: string;
  voucherNo: string | null;
  kind: LoanKind | 'opening' | 'other';
  kindLabel: string;
  principalIn: number;
  principalOut: number;
  interest: number;
  cashAccount: string | null;
  narration: string | null;
  balance: number;
  editable: boolean;
  link: { kind: string; id: number };
}

export interface LoanDetail extends LoanSummary {
  createdBy: string | null;
  createdAt: string;
  transactions: LoanTransactionRow[];
  ledger: ReportData;
}

export function getLoan(ctx: Ctx, id: number, range?: { from?: string | null; to?: string | null }): LoanDetail {
  const loan = loanRow(ctx, id);
  const summary = summarize(ctx, loan);
  const interestAcct = systemAccountId(ctx, loan.direction === 'taken' ? 'INTEREST_EXPENSE' : 'INTEREST_INCOME');
  const entries = ctx.db.all<{ id: number; date: string; voucher_no: string | null; voucher_type: string; narration: string | null; source_type: string | null; source_id: number | null; is_void: number }>(
    // The loan's own vouchers plus anything else posted to its account, found through the source and account indexes.
    `SELECT e.id, e.date, e.voucher_no, e.voucher_type, e.narration, e.source_type, e.source_id, e.is_void FROM journal_entries e
      WHERE e.is_void = 0 AND e.id IN (SELECT id FROM journal_entries WHERE source_type = 'loan' AND source_id = ?
                                       UNION SELECT entry_id FROM journal_lines WHERE account_id = ?)
      ORDER BY e.date, e.id`,
    [loan.id, loan.account_id],
  );
  const sign = loan.direction === 'taken' ? -1 : 1;
  let balance = 0;
  const transactions: LoanTransactionRow[] = entries.map((e) => {
    const lines = ctx.db.all<{ account_id: number; name: string; group_code: string; debit: number; credit: number }>(
      'SELECT l.account_id, a.name, a.group_code, l.debit, l.credit FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ?',
      [e.id],
    );
    const loanDr = lines.filter((l) => l.account_id === loan.account_id).reduce((s, l) => s + l.debit, 0);
    const loanCr = lines.filter((l) => l.account_id === loan.account_id).reduce((s, l) => s + l.credit, 0);
    const interest = lines.filter((l) => l.account_id === interestAcct).reduce((s, l) => s + (loan.direction === 'taken' ? l.debit - l.credit : l.credit - l.debit), 0);
    const cash = lines.filter((l) => l.group_code === 'cash' || l.group_code === 'bank').map((l) => l.name);
    // "In" increases the outstanding amount, "out" reduces it.
    const increase = loan.direction === 'taken' ? loanCr : loanDr;
    const decrease = loan.direction === 'taken' ? loanDr : loanCr;
    balance += sign * (loanDr - loanCr) || 0;
    let kind: LoanTransactionRow['kind'];
    if (e.voucher_type === 'opening') kind = 'opening';
    else if (e.source_type !== 'loan') kind = 'other';
    else if (loan.direction === 'taken') kind = increase > decrease ? 'receive' : 'repay';
    else kind = increase > decrease ? 'give' : 'collect';
    return {
      entryId: e.id,
      date: e.date,
      voucherNo: e.voucher_no,
      kind,
      kindLabel: kind === 'repay' && !decrease ? 'Interest paid' : kind === 'collect' && !decrease ? 'Interest received' : LOAN_KIND_LABELS[kind],
      principalIn: increase,
      principalOut: decrease,
      interest,
      cashAccount: [...new Set(cash)].join(', ') || null,
      narration: e.narration,
      balance,
      // A closed loan's transactions are frozen until it is re-opened.
      editable: !!loan.is_active && !lockReason({ source_type: e.source_type, is_void: e.is_void, voucher_type: e.voucher_type as any }) && !closedYearReason(ctx, e.date),
      // On the loan page, a loan transaction opens its journal voucher; anything else opens its own document.
      link: e.source_type === 'loan' ? { kind: 'journal', id: e.id } : entrySourceLink(ctx, e),
    };
  });
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  const inRange = transactions.filter((t) => (!from || t.date >= from) && (!to || t.date <= to));
  const openingBal = from ? outstandingOf(ctx, loan, addDays(from, -1)) : 0;
  const rows: ReportRow[] = [];
  if (from) rows.push({ cells: { date: from, particulars: 'Opening balance', no: null, taken: null, repaid: null, interest: null, balance: openingBal }, style: 'group' });
  for (const t of inRange) {
    rows.push({
      cells: {
        date: t.date,
        particulars: [t.kindLabel, t.cashAccount ? `(${t.cashAccount})` : '', t.narration && t.kind === 'other' ? `- ${t.narration}` : ''].filter(Boolean).join(' '),
        no: t.voucherNo,
        taken: t.principalIn || null,
        repaid: t.principalOut || null,
        interest: t.interest || null,
        balance: t.balance,
      },
      link: t.link,
    });
  }
  const tot = (k: 'principalIn' | 'principalOut' | 'interest') => inRange.reduce((s, t) => s + t[k], 0);
  rows.push({
    cells: { date: to ?? null, particulars: 'Outstanding', no: null, taken: tot('principalIn'), repaid: tot('principalOut'), interest: tot('interest'), balance: inRange.length ? inRange[inRange.length - 1].balance : openingBal },
    style: 'total',
  });
  const taken = loan.direction === 'taken';
  const ledger: ReportData = {
    title: summary.accountName,
    subtitle: from && to ? describeRange({ from, to }) : 'All transactions',
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 11 },
      { key: 'particulars', label: 'Particulars', width: 40 },
      { key: 'no', label: 'Voucher no', width: 15 },
      { key: 'taken', label: taken ? 'Received' : 'Given', type: 'money', width: 14 },
      { key: 'repaid', label: taken ? 'Repaid' : 'Collected', type: 'money', width: 14 },
      { key: 'interest', label: taken ? 'Interest paid' : 'Interest received', type: 'money', width: 14 },
      { key: 'balance', label: 'Outstanding', type: 'money', width: 15 },
    ],
    rows,
    summary: [
      { label: 'Outstanding', value: summary.outstanding, type: 'money' },
      { label: taken ? 'Interest paid' : 'Interest received', value: summary.interestToDate, type: 'money' },
    ],
  };
  return { ...summary, createdBy: userName(ctx, loan.created_by), createdAt: loan.created_at, transactions: transactions.reverse(), ledger };
}
