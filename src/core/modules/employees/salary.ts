/**
 * Salary slips and salary payments.
 *
 * How salary is worked out (also shown to the user in plain words):
 *   MONTHLY  paid days = days employed in the month - absent days - half of the half days
 *            (weekly offs, paid leave and days not marked are paid)
 *            gross = monthly salary x paid days / days in the month
 *   DAILY    paid days = present days + half of the half days + paid leave days
 *            (weekly offs, absent days and days not marked are not paid)
 *            gross = daily wage x paid days
 *
 * Postings (posting contract):
 *   slip     Dr Salaries & Wages (gross + bonus - deductions)
 *            Cr Employee Advances (employee) advance recovery
 *            Cr Salary Payable (employee) net
 *   payment  Dr Salary Payable (employee)  Cr cash / bank
 */
import type { Ctx } from '../../context';
import { currentUserId, now, today } from '../../context';
import { AppError, fail } from '../../errors';
import { listRevisions, logActivity, recordRevision, type RevisionRow } from '../../audit';
import { nextDocNumber } from '../../numbering';
import { getSection } from '../../settings';
import { getEntryLines, negativeBalanceWarning, partyBalances, paymentAccountId, postEntry, voidEntry } from '../../accounting/ledger';
import { renderReceiptHtml } from '../../print/receipt';
import type { ReceiptSettings } from '../../../shared/settings';
import { amountInWords, formatINR, formatIndianNumber } from '../../../shared/money';
import { datesBetween, endOfMonth, formatDate, monthKey, monthLabel } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS, type AttendanceStatus, type SettlementMode } from '../../../shared/constants';
import { assertCancelKeepsClosedAccounts } from '../accounting/common';
import {
  activeSlipFor,
  emptyCounts,
  employmentWindow,
  getEmployeeRow,
  outstandingAdvance,
  recoverableAdvance,
  recoverableAdvances,
  salaryText,
  type AttendanceCounts,
  type EmployeeRow,
  type SalaryType,
} from './service';
import { employeesInPeriod, monthRange } from './attendance';

/* ------------------------------ Calculation ------------------------------ */

export interface SalaryCalc {
  salaryType: SalaryType;
  /** Monthly salary or daily wage in paise. */
  rate: number;
  daysInMonth: number;
  employedFrom: string | null;
  employedTo: string | null;
  daysEmployed: number;
  /** Counts over the whole employment period in the month (unmarked includes days still to come). */
  counts: AttendanceCounts;
  paidDays: number;
  gross: number;
}

/** Pure salary maths for one employee and month, given the attendance marks. */
export function calculateSalary(
  emp: Pick<EmployeeRow, 'join_date' | 'leave_date' | 'salary_type' | 'salary_amount'>,
  month: string,
  marks: Map<string, AttendanceStatus> | Record<string, AttendanceStatus>,
): SalaryCalc {
  const { from, to } = monthRange(month);
  const dates = datesBetween(from, to);
  const daysInMonth = dates.length;
  const get = (d: string) => (marks instanceof Map ? marks.get(d) : marks[d]);
  const win = employmentWindow(emp, from, to);
  const counts = emptyCounts();
  let daysEmployed = 0;
  if (win) {
    for (const d of datesBetween(win.from, win.to)) {
      daysEmployed++;
      const s = get(d);
      if (s) counts[s]++;
      else counts.unmarked++;
    }
  }
  const rate = emp.salary_amount;
  let paidDays: number;
  let gross: number;
  if (emp.salary_type === 'monthly') {
    paidDays = daysEmployed - counts.A - 0.5 * counts.H;
    // Work in half days so the division stays exact before the final rounding.
    gross = Math.round((rate * Math.round(paidDays * 2)) / (daysInMonth * 2));
  } else {
    paidDays = counts.P + 0.5 * counts.H + counts.L;
    gross = Math.round((rate * Math.round(paidDays * 2)) / 2);
  }
  return { salaryType: emp.salary_type, rate, daysInMonth, employedFrom: win?.from ?? null, employedTo: win?.to ?? null, daysEmployed, counts, paidDays, gross };
}

function days(n: number): string {
  return `${formatIndianNumber(n, Number.isInteger(n) ? 0 : 1)} day${n === 1 ? '' : 's'}`;
}

/** The rule and the working for this calculation, in plain words. */
export function salaryRuleText(c: SalaryCalc): { rule: string; working: string } {
  if (c.salaryType === 'monthly') {
    return {
      rule: 'Monthly salary is paid for every day of the month the employee works here, except absent days. A half day counts as half a day. Weekly offs, paid leave and days not marked are paid.',
      working: `${formatINR(c.rate)} × ${formatIndianNumber(c.paidDays, Number.isInteger(c.paidDays) ? 0 : 1)} paid ${c.paidDays === 1 ? 'day' : 'days'} ÷ ${c.daysInMonth} days in the month = ${formatINR(c.gross)}`,
    };
  }
  return {
    rule: 'Daily wages are paid for each day present and each paid-leave day. A half day counts as half a day. Weekly offs, absent days and days not marked are not paid.',
    working: `${formatINR(c.rate)} × ${formatIndianNumber(c.paidDays, Number.isInteger(c.paidDays) ? 0 : 1)} paid ${c.paidDays === 1 ? 'day' : 'days'} = ${formatINR(c.gross)}`,
  };
}

function marksFor(ctx: Ctx, employeeId: number, month: string): Map<string, AttendanceStatus> {
  const { from, to } = monthRange(month);
  const rows = ctx.db.all<{ date: string; status: AttendanceStatus }>(
    'SELECT date, status FROM attendance WHERE employee_id = ? AND date >= ? AND date <= ?',
    [employeeId, from, to],
  );
  return new Map(rows.map((r) => [r.date, r.status]));
}

/** Default posting date for a month's salary: the month end, or today if the month is still running. */
function defaultSlipDate(ctx: Ctx, month: string): string {
  const t = today(ctx);
  const end = endOfMonth(`${month}-01`);
  return end < t ? end : t;
}

/** Why a month's salary cannot be processed yet (null = it can). */
function monthProblem(ctx: Ctx, month: string): string | null {
  const t = today(ctx);
  if (month > monthKey(t)) return `${monthLabel(month, true)} has not started yet.`;
  const booksStart = getSection(ctx, 'accounts').booksStartDate;
  if (booksStart && endOfMonth(`${month}-01`) < booksStart) {
    return `${monthLabel(month, true)} is before your books start (${formatDate(booksStart)}).`;
  }
  return null;
}

/* ------------------------------ Types ------------------------------ */

export type SalaryStatus = 'unpaid' | 'partly_paid' | 'paid' | 'cancelled';

interface SalaryRow {
  id: number;
  salary_no: string;
  seq: number;
  fy_start: string;
  employee_id: number;
  month: string;
  date: string;
  salary_type: SalaryType;
  rate: number;
  days_in_month: number;
  paid_days: number;
  gross: number;
  bonus: number;
  deductions: number;
  advance_recovery: number;
  net: number;
  paid: number;
  status: SalaryStatus;
  remarks: string | null;
  details: string | null;
  journal_entry_id: number | null;
  /** Times the slip was printed (later prints are marked DUPLICATE). */
  print_count: number;
  created_by: number | null;
  created_at: string;
  updated_by: number | null;
  updated_at: string | null;
  cancelled_by: number | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

type JoinedSalaryRow = SalaryRow & {
  employee_name: string;
  designation: string | null;
  employee_phone: string | null;
  created_by_name: string | null;
  cancelled_by_name: string | null;
};

interface SlipDetails {
  daysEmployed: number;
  employedFrom: string | null;
  employedTo: string | null;
  counts: AttendanceCounts;
}

export interface Salary {
  id: number;
  salaryNo: string;
  employeeId: number;
  employeeName: string;
  designation: string | null;
  employeePhone: string | null;
  month: string;
  monthLabel: string;
  date: string;
  salaryType: SalaryType;
  rate: number;
  daysInMonth: number;
  daysEmployed: number | null;
  employedFrom: string | null;
  employedTo: string | null;
  counts: AttendanceCounts | null;
  paidDays: number;
  gross: number;
  bonus: number;
  deductions: number;
  advanceRecovery: number;
  net: number;
  paid: number;
  /** Net still to be paid (0 when cancelled). */
  balance: number;
  status: SalaryStatus;
  remarks: string | null;
  journalEntryId: number | null;
  createdBy: string | null;
  createdAt: string;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface SalaryPayment {
  id: number;
  salaryId: number;
  date: string;
  amount: number;
  mode: SettlementMode;
  accountId: number;
  accountName: string;
  remarks: string | null;
  status: 'active' | 'cancelled';
  journalEntryId: number | null;
  createdBy: string | null;
  createdAt: string;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface PostingLine {
  account: string;
  party: string | null;
  debit: number;
  credit: number;
  /** Line belongs to a cancelled (void) entry. */
  void: boolean;
  entry: 'salary' | 'payment';
  date: string;
}

export interface SalaryDetail extends Salary {
  payments: SalaryPayment[];
  revisions: RevisionRow[];
  posting: PostingLine[];
  rule: { rule: string; working: string };
  /** Employee's advance outstanding today. */
  currentAdvance: number;
}

const SELECT = `SELECT s.*, e.name AS employee_name, e.designation, e.phone AS employee_phone,
    uc.full_name AS created_by_name, ux.full_name AS cancelled_by_name
  FROM salaries s
  JOIN employees e ON e.id = s.employee_id
  LEFT JOIN users uc ON uc.id = s.created_by
  LEFT JOIN users ux ON ux.id = s.cancelled_by`;

function toSalary(r: JoinedSalaryRow): Salary {
  let details: SlipDetails | null = null;
  try {
    details = r.details ? (JSON.parse(r.details) as SlipDetails) : null;
  } catch {
    details = null;
  }
  return {
    id: r.id,
    salaryNo: r.salary_no,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    designation: r.designation,
    employeePhone: r.employee_phone,
    month: r.month,
    monthLabel: monthLabel(r.month, true),
    date: r.date,
    salaryType: r.salary_type,
    rate: r.rate,
    daysInMonth: r.days_in_month,
    daysEmployed: details?.daysEmployed ?? null,
    employedFrom: details?.employedFrom ?? null,
    employedTo: details?.employedTo ?? null,
    counts: details?.counts ?? null,
    paidDays: r.paid_days,
    gross: r.gross,
    bonus: r.bonus,
    deductions: r.deductions,
    advanceRecovery: r.advance_recovery,
    net: r.net,
    paid: r.paid,
    balance: r.status === 'cancelled' ? 0 : r.net - r.paid,
    status: r.status,
    remarks: r.remarks,
    journalEntryId: r.journal_entry_id,
    createdBy: r.created_by_name,
    createdAt: r.created_at,
    cancelledBy: r.cancelled_by_name,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
  };
}

function getRow(ctx: Ctx, id: number): JoinedSalaryRow {
  const r = ctx.db.get<JoinedSalaryRow>(`${SELECT} WHERE s.id = ?`, [id]);
  if (!r) throw fail.notFound('Salary slip');
  return r;
}

export function getSalary(ctx: Ctx, id: number): Salary {
  return toSalary(getRow(ctx, id));
}

function listPayments(ctx: Ctx, salaryId: number): SalaryPayment[] {
  return ctx.db
    .all<any>(
      `SELECT p.*, a.name AS account_name, uc.full_name AS created_by_name, ux.full_name AS cancelled_by_name
         FROM salary_payments p
         JOIN accounts a ON a.id = p.account_id
         LEFT JOIN users uc ON uc.id = p.created_by
         LEFT JOIN users ux ON ux.id = p.cancelled_by
        WHERE p.salary_id = ? ORDER BY p.date, p.id`,
      [salaryId],
    )
    .map((p) => ({
      id: p.id,
      salaryId: p.salary_id,
      date: p.date,
      amount: p.amount,
      mode: p.mode,
      accountId: p.account_id,
      accountName: p.account_name,
      remarks: p.remarks,
      status: p.status,
      journalEntryId: p.journal_entry_id,
      createdBy: p.created_by_name,
      createdAt: p.created_at,
      cancelledBy: p.cancelled_by_name,
      cancelledAt: p.cancelled_at,
      cancelReason: p.cancel_reason,
    }));
}

/** Slip + payments, stored as the revision snapshot. */
function snapshot(ctx: Ctx, id: number) {
  return { ...getSalary(ctx, id), payments: listPayments(ctx, id) };
}

export function getSalaryDetail(ctx: Ctx, id: number): SalaryDetail {
  const s = getSalary(ctx, id);
  const payments = listPayments(ctx, id);
  const posting: PostingLine[] = [];
  const addLines = (entryId: number | null, entry: PostingLine['entry'], date: string) => {
    if (!entryId) return;
    const isVoid = ctx.db.value<number>('SELECT is_void FROM journal_entries WHERE id = ?', [entryId], 0) === 1;
    for (const l of getEntryLines(ctx, entryId)) {
      posting.push({ account: l.account_name, party: l.party_name, debit: l.debit, credit: l.credit, void: isVoid, entry, date });
    }
  };
  addLines(s.journalEntryId, 'salary', s.date);
  for (const p of payments) addLines(p.journalEntryId, 'payment', p.date);
  const calc: SalaryCalc = {
    salaryType: s.salaryType,
    rate: s.rate,
    daysInMonth: s.daysInMonth,
    employedFrom: s.employedFrom,
    employedTo: s.employedTo,
    daysEmployed: s.daysEmployed ?? 0,
    counts: s.counts ?? emptyCounts(),
    paidDays: s.paidDays,
    gross: s.gross,
  };
  return {
    ...s,
    payments,
    revisions: listRevisions(ctx, 'salary', id),
    posting,
    rule: salaryRuleText(calc),
    currentAdvance: outstandingAdvance(ctx, s.employeeId),
  };
}

/* ------------------------------ Preview ------------------------------ */

export interface SalaryPreview extends SalaryCalc {
  employeeId: number;
  employeeName: string;
  designation: string | null;
  isActive: boolean;
  month: string;
  monthLabel: string;
  /** Advance outstanding today. */
  outstandingAdvance: number;
  /**
   * The most a salary dated `date` may recover: the advance outstanding on that day (advances given
   * later are not counted), and never more than stays outstanding on any later day.
   */
  recoverableAdvance: number;
  /** Recovery we suggest: the whole recoverable advance, up to the gross salary. */
  suggestedRecovery: number;
  /**
   * Nothing is marked for the month (while employed). Monthly staff are then paid for every day,
   * which is a full month's salary if the owner simply forgot to mark attendance.
   */
  noAttendance: boolean;
  rule: string;
  working: string;
  /** Posting date used when none is chosen. */
  defaultDate: string;
  /** Salary date the advance figures are worked out for (the chosen date, or defaultDate). */
  date: string;
  existing: { id: number; salaryNo: string; status: SalaryStatus; net: number; paid: number } | null;
  /** Why the salary cannot be processed (null = it can). */
  problem: string | null;
  /** month = not started / before books; not_employed; processed; zero = nothing earned (a bonus can still be paid). */
  problemKind: 'month' | 'not_employed' | 'processed' | 'zero' | null;
}

interface AdvanceFacts {
  /** Outstanding today. */
  outstanding: number;
  /** Recoverable by a salary dated `date`. */
  recoverable: number;
  date: string;
}

function advanceFacts(ctx: Ctx, employeeId: number, date: string): AdvanceFacts {
  return { outstanding: outstandingAdvance(ctx, employeeId), recoverable: recoverableAdvance(ctx, employeeId, date), date };
}

function buildPreview(ctx: Ctx, emp: EmployeeRow, month: string, advance: AdvanceFacts, existing: SalaryPreview['existing']): SalaryPreview {
  const calc = calculateSalary(emp, month, marksFor(ctx, emp.id, month));
  const text = salaryRuleText(calc);
  let problem = monthProblem(ctx, month);
  let problemKind: SalaryPreview['problemKind'] = problem ? 'month' : null;
  if (!problem && !calc.daysEmployed) {
    problem = `${emp.name} did not work here in ${monthLabel(month, true)}.`;
    problemKind = 'not_employed';
  }
  if (!problem && existing) {
    problem = `Salary for ${monthLabel(month, true)} is already processed (${existing.salaryNo}).`;
    problemKind = 'processed';
  }
  if (!problem && calc.gross === 0) {
    problem = `No salary is earned for ${monthLabel(month, true)} (${days(calc.paidDays)} paid).`;
    problemKind = 'zero';
  }
  return {
    ...calc,
    employeeId: emp.id,
    employeeName: emp.name,
    designation: emp.designation,
    isActive: !!emp.is_active,
    month,
    monthLabel: monthLabel(month, true),
    outstandingAdvance: advance.outstanding,
    recoverableAdvance: advance.recoverable,
    suggestedRecovery: Math.max(Math.min(advance.recoverable, calc.gross), 0),
    noAttendance: calc.daysEmployed > 0 && calc.counts.unmarked === calc.daysEmployed,
    rule: text.rule,
    working: text.working,
    defaultDate: defaultSlipDate(ctx, month),
    date: advance.date,
    existing,
    problem,
    problemKind,
  };
}

function existingSlip(ctx: Ctx, employeeId: number, month: string): SalaryPreview['existing'] {
  const r = ctx.db.get<{ id: number; salary_no: string; status: SalaryStatus; net: number; paid: number }>(
    "SELECT id, salary_no, status, net, paid FROM salaries WHERE employee_id = ? AND month = ? AND status <> 'cancelled'",
    [employeeId, month],
  );
  return r ? { id: r.id, salaryNo: r.salary_no, status: r.status, net: r.net, paid: r.paid } : null;
}

/** Preview a month's salary. `date` = the salary date being considered (default: month end, or today). */
export function previewSalary(ctx: Ctx, employeeId: number, month: string, date?: string | null): SalaryPreview {
  monthRange(month);
  const emp = getEmployeeRow(ctx, employeeId);
  const on = date || defaultSlipDate(ctx, month);
  return buildPreview(ctx, emp, month, advanceFacts(ctx, emp.id, on), existingSlip(ctx, emp.id, month));
}

/* ------------------------------ Month sheet ------------------------------ */

export interface MonthSheetRow extends SalaryPreview {
  slip: {
    id: number;
    salaryNo: string;
    status: SalaryStatus;
    date: string;
    paidDays: number;
    gross: number;
    bonus: number;
    deductions: number;
    advanceRecovery: number;
    net: number;
    paid: number;
    balance: number;
  } | null;
}

export interface MonthSheet {
  month: string;
  monthLabel: string;
  defaultDate: string;
  /** Salary date the suggested advance recoveries are worked out for. */
  date: string;
  /** Why no salary can be processed for this month (null = it can). */
  problem: string | null;
  rows: MonthSheetRow[];
  totals: {
    employees: number;
    processed: number;
    /** Employees whose salary can still be processed. */
    pending: number;
    /** Of those, employees with no attendance marked for the month. */
    noAttendance: number;
    /** Gross of processed slips + estimated gross of the rest. */
    gross: number;
    net: number;
    paid: number;
    due: number;
  };
}

/** Salary sheet of a month. `date` = the salary date the suggested recoveries are for (default: month end, or today). */
export function salaryMonthSheet(ctx: Ctx, month: string, date?: string | null): MonthSheet {
  const { from, to } = monthRange(month);
  const on = date || defaultSlipDate(ctx, month);
  const slips = ctx.db.all<SalaryRow>("SELECT * FROM salaries WHERE month = ? AND status <> 'cancelled'", [month]);
  const byEmp = new Map(slips.map((s) => [s.employee_id, s]));
  const emps = employeesInPeriod(ctx, from, to, slips.map((s) => s.employee_id));
  const advances = partyBalances(ctx, 'employee', { account: 'EMP_ADV' });
  const recoverable = recoverableAdvances(ctx, on);
  const rows: MonthSheetRow[] = emps.map((emp) => {
    const s = byEmp.get(emp.id);
    const existing = s ? { id: s.id, salaryNo: s.salary_no, status: s.status, net: s.net, paid: s.paid } : null;
    const adv = { outstanding: advances.get(emp.id) ?? 0, recoverable: recoverable.get(emp.id) ?? 0, date: on };
    const preview = buildPreview(ctx, emp, month, adv, existing);
    return {
      ...preview,
      slip: s
        ? {
            id: s.id,
            salaryNo: s.salary_no,
            status: s.status,
            date: s.date,
            paidDays: s.paid_days,
            gross: s.gross,
            bonus: s.bonus,
            deductions: s.deductions,
            advanceRecovery: s.advance_recovery,
            net: s.net,
            paid: s.paid,
            balance: s.net - s.paid,
          }
        : null,
    };
  });
  const totals = { employees: rows.length, processed: 0, pending: 0, noAttendance: 0, gross: 0, net: 0, paid: 0, due: 0 };
  for (const r of rows) {
    if (r.slip) {
      totals.processed++;
      totals.gross += r.slip.gross + r.slip.bonus - r.slip.deductions;
      totals.net += r.slip.net;
      totals.paid += r.slip.paid;
      totals.due += r.slip.balance;
    } else {
      if (!r.problem) {
        totals.pending++;
        if (r.noAttendance) totals.noAttendance++;
      }
      totals.gross += r.gross;
      totals.net += r.gross - r.suggestedRecovery;
    }
  }
  return { month, monthLabel: monthLabel(month, true), defaultDate: defaultSlipDate(ctx, month), date: on, problem: monthProblem(ctx, month), rows, totals };
}

/* ------------------------------ Process ------------------------------ */

export interface PayNowInput {
  mode: SettlementMode;
  accountId?: number | null;
  amount: number;
}

export interface ProcessInput {
  employeeId: number;
  month: string;
  /** Posting date; defaults to the month end (or today while the month is running). */
  date?: string | null;
  bonus?: number;
  deductions?: number;
  advanceRecovery?: number;
  remarks?: string | null;
  payNow?: PayNowInput | null;
}

function statusFor(net: number, paid: number): SalaryStatus {
  if (paid >= net) return 'paid';
  return paid > 0 ? 'partly_paid' : 'unpaid';
}

function resolveSlipDate(ctx: Ctx, month: string, date: string | null | undefined): string {
  const t = today(ctx);
  const d = date || defaultSlipDate(ctx, month);
  const start = `${month}-01`;
  if (d > t) throw fail.validation(`The salary cannot be dated later than today (${formatDate(t)}).`, { date: 'Date cannot be in the future' });
  if (d < start) {
    throw fail.validation(`Salary for ${monthLabel(month, true)} cannot be dated before the month starts (${formatDate(start)}).`, { date: 'Before the month starts' });
  }
  return d;
}

/** A salary slip just saved or paid, with warnings to show (e.g. cash going below zero). */
export type SalaryResult = SalaryDetail & { warnings: string[] };

/** Money paid out by a new payment, with the warning when it takes the account below zero. */
interface PaidOut {
  accountId: number;
  warning: string | null;
}

export function processSalary(ctx: Ctx, input: ProcessInput): SalaryResult {
  const { id, payment } = saveSalary(ctx, input);
  return { ...getSalaryDetail(ctx, id), warnings: payment?.warning ? [payment.warning] : [] };
}

/** Why an advance recovery is too large for a salary dated `date` (null = it is fine). */
function recoveryProblem(name: string, recovery: number, adv: AdvanceFacts): { message: string; field: string } | null {
  if (recovery <= adv.recoverable) return null;
  const field = `At most ${formatINR(adv.recoverable)}`;
  if (adv.outstanding <= 0) return { message: `${name} has no advance outstanding, so nothing can be recovered.`, field };
  if (adv.recoverable >= adv.outstanding) {
    return { message: `Only ${formatINR(adv.outstanding)} advance is outstanding for ${name}, so you cannot recover more than that.`, field };
  }
  const on = formatDate(adv.date);
  if (adv.recoverable <= 0) {
    return {
      message: `${name}'s advance of ${formatINR(adv.outstanding)} was given after ${on}, so it cannot be recovered from a salary dated ${on}. Recover it from a later salary, or date this salary on or after the day the advance was given.`,
      field,
    };
  }
  return {
    message: `Only ${formatINR(adv.recoverable)} of ${name}'s advance was outstanding on ${on} (the rest was given after that day), so a salary dated ${on} can recover at most ${formatINR(adv.recoverable)}. Recover the rest from a later salary.`,
    field,
  };
}

function saveSalary(ctx: Ctx, input: ProcessInput): { id: number; payment: PaidOut | null } {
  const emp = getEmployeeRow(ctx, input.employeeId);
  const month = input.month;
  monthRange(month);
  const dup = activeSlipFor(ctx, emp.id, month);
  if (dup) {
    throw new AppError('CONFLICT', `Salary for ${monthLabel(month, true)} is already processed for ${emp.name} (${dup.salary_no}). Cancel that slip first to process it again.`);
  }
  const mp = monthProblem(ctx, month);
  if (mp) throw fail.validation(mp);
  const date = resolveSlipDate(ctx, month, input.date);
  // Only the advance outstanding on the salary date can be recovered: an advance given later must not be
  // taken back in an earlier-dated slip (Employee Advances would go negative in between).
  const p = buildPreview(ctx, emp, month, advanceFacts(ctx, emp.id, date), null);
  if (!p.daysEmployed) throw fail.validation(`${emp.name} did not work here in ${monthLabel(month, true)}.`);
  const bonus = input.bonus ?? 0;
  const deductions = input.deductions ?? 0;
  const recovery = input.advanceRecovery ?? 0;
  const tooMuch = recoveryProblem(emp.name, recovery, { outstanding: p.outstandingAdvance, recoverable: p.recoverableAdvance, date });
  if (tooMuch) throw fail.validation(tooMuch.message, { advanceRecovery: tooMuch.field });
  const earned = p.gross + bonus;
  const expense = earned - deductions;
  const net = expense - recovery;
  if (deductions > earned) {
    throw fail.validation(`Deductions (${formatINR(deductions)}) cannot be more than the salary earned (${formatINR(earned)}).`, { deductions: `At most ${formatINR(earned)}` });
  }
  if (net < 0) {
    throw fail.validation(
      `Deductions and advance recovery (${formatINR(deductions + recovery)}) cannot be more than the salary earned (${formatINR(earned)}).`,
      { advanceRecovery: `At most ${formatINR(Math.max(expense, 0))}` },
    );
  }
  if (expense === 0) {
    throw fail.validation(`The salary for ${monthLabel(month, true)} works out to ${formatINR(0)}, so there is nothing to record.`);
  }
  if (input.payNow) {
    if (net === 0) throw fail.validation('Nothing is left to pay: the whole salary goes towards the advance.', { 'payNow.amount': 'Nothing to pay' });
    if (input.payNow.amount > net) {
      throw fail.validation(`You cannot pay more than the net salary (${formatINR(net)}).`, { 'payNow.amount': `At most ${formatINR(net)}` });
    }
  }
  const num = nextDocNumber(ctx, 'salary', date);
  const details: SlipDetails = { daysEmployed: p.daysEmployed, employedFrom: p.employedFrom, employedTo: p.employedTo, counts: p.counts };
  const id = ctx.db.insert('salaries', {
    salary_no: num.number,
    seq: num.seq,
    fy_start: num.fyStart,
    employee_id: emp.id,
    month,
    date,
    salary_type: p.salaryType,
    rate: p.rate,
    days_in_month: p.daysInMonth,
    paid_days: p.paidDays,
    gross: p.gross,
    bonus,
    deductions,
    advance_recovery: recovery,
    net,
    paid: 0,
    status: statusFor(net, 0),
    remarks: input.remarks?.trim() || null,
    details: JSON.stringify(details),
    created_by: currentUserId(ctx),
    created_at: now(ctx),
  });
  const entryId = postEntry(ctx, {
    date,
    voucherType: 'salary',
    voucherNo: num.number,
    sourceType: 'salary',
    sourceId: id,
    narration: `Salary for ${monthLabel(month, true)} - ${emp.name} (${days(p.paidDays)} paid)${bonus ? `, bonus ${formatINR(bonus)}` : ''}${deductions ? `, deductions ${formatINR(deductions)}` : ''}`,
    lines: [
      { account: 'SALARY', debit: expense },
      { account: 'EMP_ADV', credit: recovery, partyType: 'employee', partyId: emp.id, memo: recovery ? 'Advance recovered' : null },
      { account: 'SALARY_PAYABLE', credit: net, partyType: 'employee', partyId: emp.id },
    ],
  });
  ctx.db.update('salaries', id, { journal_entry_id: entryId });
  let paidNote = '';
  let payment: PaidOut | null = null;
  if (input.payNow && input.payNow.amount > 0) {
    payment = insertPayment(ctx, getRow(ctx, id), { date, amount: input.payNow.amount, mode: input.payNow.mode, accountId: input.payNow.accountId, remarks: null });
    paidNote = `, paid ${formatINR(input.payNow.amount)} by ${PAYMENT_MODE_LABELS[input.payNow.mode]}`;
  }
  recordRevision(ctx, 'salary', id, 'created', snapshot(ctx, id));
  logActivity(
    ctx,
    'salary.process',
    `Processed salary ${num.number} for ${emp.name}, ${monthLabel(month, true)}: gross ${formatINR(p.gross)}${bonus ? `, bonus ${formatINR(bonus)}` : ''}${deductions ? `, deductions ${formatINR(deductions)}` : ''}${recovery ? `, advance recovered ${formatINR(recovery)}` : ''}, net ${formatINR(net)}${paidNote}`,
    { entityType: 'salary', entityId: id, details: { employeeId: emp.id, month, date, paidDays: p.paidDays, gross: p.gross, bonus, deductions, advanceRecovery: recovery, net, payNow: input.payNow ?? null } },
  );
  return { id, payment };
}

export interface ProcessAllInput {
  month: string;
  date?: string | null;
  /** Recover the suggested advance amount (outstanding on the salary date, up to the salary) from each salary. */
  recoverAdvances: boolean;
  /**
   * Also process employees with no attendance marked for the month. Monthly staff are then paid for every
   * day, so this must be confirmed; otherwise they are skipped with the reason.
   */
  includeUnmarked?: boolean;
  /** Pay every net salary in full right away. */
  payNow?: { mode: SettlementMode; accountId?: number | null } | null;
}

export interface ProcessAllResult {
  processed: Array<{ employeeId: number; name: string; salaryId: number; salaryNo: string; net: number }>;
  skipped: Array<{ employeeId: number; name: string; reason: string }>;
  totalNet: number;
  totalPaid: number;
  /** E.g. cash going below zero: one per account, for the whole amount paid from it. */
  warnings: string[];
}

/** Process every remaining salary of a month. Employees that cannot be processed are skipped with the reason. */
export function processAllSalaries(ctx: Ctx, input: ProcessAllInput): ProcessAllResult {
  const sheet = salaryMonthSheet(ctx, input.month, input.date);
  if (sheet.problem) throw fail.validation(sheet.problem);
  const res: ProcessAllResult = { processed: [], skipped: [], totalNet: 0, totalPaid: 0, warnings: [] };
  // Each payment's warning counts the payments before it, so the last one per account is the whole shortfall.
  const shortfalls = new Map<number, string>();
  for (const r of sheet.rows) {
    if (r.slip) continue;
    if (r.problem) {
      res.skipped.push({ employeeId: r.employeeId, name: r.employeeName, reason: r.problem });
      continue;
    }
    if (r.noAttendance && !input.includeUnmarked) {
      res.skipped.push({
        employeeId: r.employeeId,
        name: r.employeeName,
        reason: `No attendance is marked for ${sheet.monthLabel}, so the whole month would be paid. Mark attendance first, or process them for the full month.`,
      });
      continue;
    }
    try {
      const recovery = input.recoverAdvances ? r.suggestedRecovery : 0;
      const net = r.gross - recovery;
      const saved = ctx.db.tx(() =>
        saveSalary(ctx, {
          employeeId: r.employeeId,
          month: input.month,
          date: input.date,
          advanceRecovery: recovery,
          payNow: input.payNow && net > 0 ? { mode: input.payNow.mode, accountId: input.payNow.accountId, amount: net } : null,
        }),
      );
      if (saved.payment?.warning) shortfalls.set(saved.payment.accountId, saved.payment.warning);
      const slip = getSalary(ctx, saved.id);
      res.processed.push({ employeeId: r.employeeId, name: r.employeeName, salaryId: slip.id, salaryNo: slip.salaryNo, net: slip.net });
      res.totalNet += slip.net;
      res.totalPaid += slip.paid;
    } catch (e) {
      if (!(e instanceof AppError) || e.code === 'PERIOD_CLOSED') throw e;
      res.skipped.push({ employeeId: r.employeeId, name: r.employeeName, reason: e.message });
    }
  }
  res.warnings = [...shortfalls.values()];
  if (res.processed.length) {
    logActivity(
      ctx,
      'salary.processAll',
      `Processed ${res.processed.length} salar${res.processed.length === 1 ? 'y' : 'ies'} for ${monthLabel(input.month, true)}: net ${formatINR(res.totalNet)}${res.totalPaid ? `, paid ${formatINR(res.totalPaid)}` : ''}${res.skipped.length ? ` (${res.skipped.length} skipped)` : ''}`,
      { entityType: 'salary', details: res },
    );
  }
  return res;
}

/* ------------------------------ Payments ------------------------------ */

interface PaymentValues {
  date: string;
  amount: number;
  mode: SettlementMode;
  accountId?: number | null;
  remarks: string | null;
}

function insertPayment(ctx: Ctx, slip: JoinedSalaryRow, v: PaymentValues): PaidOut {
  const accountId = paymentAccountId(ctx, v.mode, v.accountId);
  // Worked out before posting; the salary is still paid (a receipt may not have been entered yet).
  const warning = negativeBalanceWarning(ctx, accountId, v.amount, v.date);
  const pid = ctx.db.insert('salary_payments', {
    salary_id: slip.id,
    date: v.date,
    amount: v.amount,
    mode: v.mode,
    account_id: accountId,
    remarks: v.remarks,
    created_by: currentUserId(ctx),
    created_at: now(ctx),
  });
  const entryId = postEntry(ctx, {
    date: v.date,
    voucherType: 'salary_payment',
    voucherNo: slip.salary_no,
    sourceType: 'salary_payment',
    sourceId: pid,
    narration: `Salary paid to ${slip.employee_name} for ${monthLabel(slip.month, true)} (${PAYMENT_MODE_LABELS[v.mode]})${v.remarks ? ` - ${v.remarks}` : ''}`,
    lines: [
      { account: 'SALARY_PAYABLE', debit: v.amount, partyType: 'employee', partyId: slip.employee_id },
      { account: accountId, credit: v.amount },
    ],
  });
  ctx.db.update('salary_payments', pid, { journal_entry_id: entryId });
  const paid = slip.paid + v.amount;
  ctx.db.update('salaries', slip.id, { paid, status: statusFor(slip.net, paid), updated_by: currentUserId(ctx), updated_at: now(ctx) });
  return { accountId, warning };
}

export interface PayInput {
  salaryId: number;
  date?: string | null;
  amount: number;
  mode: SettlementMode;
  accountId?: number | null;
  remarks?: string | null;
}

export function paySalary(ctx: Ctx, input: PayInput): SalaryResult {
  const slip = getRow(ctx, input.salaryId);
  if (slip.status === 'cancelled') throw fail.validation(`Salary slip ${slip.salary_no} is cancelled.`);
  const remaining = slip.net - slip.paid;
  if (remaining <= 0) throw fail.validation(`Salary slip ${slip.salary_no} is already fully paid.`);
  if (input.amount > remaining) {
    throw fail.validation(`Only ${formatINR(remaining)} is left to pay on ${slip.salary_no}.`, { amount: `At most ${formatINR(remaining)}` });
  }
  const t = today(ctx);
  const date = input.date || t;
  if (date > t) throw fail.validation(`A payment cannot be dated later than today (${formatDate(t)}).`, { date: 'Date cannot be in the future' });
  if (date < slip.date) {
    throw fail.validation(`A payment cannot be dated before the salary slip (${formatDate(slip.date)}).`, { date: 'Before the salary slip date' });
  }
  const remarks = input.remarks?.trim() || null;
  const { warning } = insertPayment(ctx, slip, { date, amount: input.amount, mode: input.mode, accountId: input.accountId, remarks });
  const after = getRow(ctx, slip.id);
  const what = `Paid ${formatINR(input.amount)} by ${PAYMENT_MODE_LABELS[input.mode]} on ${formatDate(date)}`;
  recordRevision(ctx, 'salary', slip.id, 'edited', snapshot(ctx, slip.id), what);
  logActivity(
    ctx,
    'salary.pay',
    `Paid salary ${formatINR(input.amount)} to ${slip.employee_name} by ${PAYMENT_MODE_LABELS[input.mode]} against ${slip.salary_no} (${monthLabel(slip.month, true)})${after.net - after.paid > 0 ? `, ${formatINR(after.net - after.paid)} still due` : ', fully paid'}`,
    { entityType: 'salary', entityId: slip.id, details: { amount: input.amount, mode: input.mode, date, remarks } },
  );
  return { ...getSalaryDetail(ctx, slip.id), warnings: warning ? [warning] : [] };
}

export function cancelSalaryPayment(ctx: Ctx, paymentId: number, reason: string): SalaryDetail {
  const why = reason.trim();
  if (!why) throw fail.validation('Enter the reason for cancelling', { reason: 'Enter a reason' });
  const p = ctx.db.get<{ id: number; salary_id: number; amount: number; mode: SettlementMode; date: string; status: string; journal_entry_id: number | null }>(
    'SELECT id, salary_id, amount, mode, date, status, journal_entry_id FROM salary_payments WHERE id = ?',
    [paymentId],
  );
  if (!p) throw fail.notFound('Salary payment');
  if (p.status === 'cancelled') throw fail.validation('This payment is already cancelled.');
  const slip = getRow(ctx, p.salary_id);
  if (slip.status === 'cancelled') throw fail.validation(`Salary slip ${slip.salary_no} is cancelled.`);
  assertCancelKeepsClosedAccounts(ctx, p.journal_entry_id, 'this payment');
  if (p.journal_entry_id) voidEntry(ctx, p.journal_entry_id, `Salary payment cancelled: ${why}`);
  ctx.db.update('salary_payments', p.id, { status: 'cancelled', cancelled_by: currentUserId(ctx), cancelled_at: now(ctx), cancel_reason: why });
  const paid = slip.paid - p.amount;
  ctx.db.update('salaries', slip.id, { paid, status: statusFor(slip.net, paid), updated_by: currentUserId(ctx), updated_at: now(ctx) });
  recordRevision(ctx, 'salary', slip.id, 'edited', snapshot(ctx, slip.id), `Cancelled payment of ${formatINR(p.amount)} dated ${formatDate(p.date)}: ${why}`);
  logActivity(
    ctx,
    'salary.paymentCancel',
    `Cancelled salary payment of ${formatINR(p.amount)} (${PAYMENT_MODE_LABELS[p.mode]}, ${formatDate(p.date)}) to ${slip.employee_name} on ${slip.salary_no}: ${why}`,
    { entityType: 'salary', entityId: slip.id, details: { paymentId: p.id, amount: p.amount, reason: why } },
  );
  return getSalaryDetail(ctx, slip.id);
}

/** Cancel a salary slip and every payment made against it. */
export function cancelSalary(ctx: Ctx, salaryId: number, reason: string): SalaryDetail {
  const why = reason.trim();
  if (!why) throw fail.validation('Enter the reason for cancelling', { reason: 'Enter a reason' });
  const slip = getRow(ctx, salaryId);
  if (slip.status === 'cancelled') throw fail.validation(`Salary slip ${slip.salary_no} is already cancelled.`);
  const stamp = now(ctx);
  const user = currentUserId(ctx);
  const payments = ctx.db.all<{ id: number; amount: number; journal_entry_id: number | null }>(
    "SELECT id, amount, journal_entry_id FROM salary_payments WHERE salary_id = ? AND status = 'active'",
    [slip.id],
  );
  for (const p of payments) {
    assertCancelKeepsClosedAccounts(ctx, p.journal_entry_id, 'this salary slip');
    if (p.journal_entry_id) voidEntry(ctx, p.journal_entry_id, `Salary slip ${slip.salary_no} cancelled: ${why}`);
    ctx.db.update('salary_payments', p.id, { status: 'cancelled', cancelled_by: user, cancelled_at: stamp, cancel_reason: `Salary slip cancelled: ${why}` });
  }
  if (slip.journal_entry_id) voidEntry(ctx, slip.journal_entry_id, `Salary slip ${slip.salary_no} cancelled: ${why}`);
  ctx.db.update('salaries', slip.id, { status: 'cancelled', paid: 0, cancelled_by: user, cancelled_at: stamp, cancel_reason: why, updated_by: user, updated_at: stamp });
  recordRevision(ctx, 'salary', slip.id, 'cancelled', snapshot(ctx, slip.id), why);
  const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
  logActivity(
    ctx,
    'salary.cancel',
    `Cancelled salary slip ${slip.salary_no} of ${slip.employee_name} for ${monthLabel(slip.month, true)} (net ${formatINR(slip.net)}${paidTotal ? `, ${payments.length} payment${payments.length === 1 ? '' : 's'} of ${formatINR(paidTotal)} reversed` : ''}): ${why}`,
    { entityType: 'salary', entityId: slip.id, details: { reason: why, paymentsCancelled: payments.map((p) => p.id) } },
  );
  return getSalaryDetail(ctx, slip.id);
}

/* ------------------------------ Lists ------------------------------ */

export interface SalaryListQuery {
  month?: string | null;
  from?: string | null;
  to?: string | null;
  employeeId?: number | null;
  status?: SalaryStatus | 'due' | null;
}

export function listSalaries(ctx: Ctx, q: SalaryListQuery): { rows: Salary[]; totals: { count: number; gross: number; net: number; paid: number; due: number; cancelled: number } } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.month) {
    where.push('s.month = :month');
    params.month = q.month;
  }
  if (q.from) {
    where.push('s.date >= :from');
    params.from = q.from;
  }
  if (q.to) {
    where.push('s.date <= :to');
    params.to = q.to;
  }
  if (q.employeeId) {
    where.push('s.employee_id = :emp');
    params.emp = q.employeeId;
  }
  if (q.status === 'due') where.push("s.status IN ('unpaid', 'partly_paid')");
  else if (q.status) {
    where.push('s.status = :status');
    params.status = q.status;
  }
  const rows = ctx.db
    .all<JoinedSalaryRow>(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.month DESC, e.name COLLATE NOCASE, s.id DESC LIMIT 5000`, params)
    .map(toSalary);
  const totals = { count: 0, gross: 0, net: 0, paid: 0, due: 0, cancelled: 0 };
  for (const r of rows) {
    if (r.status === 'cancelled') {
      totals.cancelled++;
      continue;
    }
    totals.count++;
    totals.gross += r.gross + r.bonus - r.deductions;
    totals.net += r.net;
    totals.paid += r.paid;
    totals.due += r.balance;
  }
  return { rows, totals };
}

/* ------------------------------ Printing ------------------------------ */

function fmtDays(n: number): string {
  return formatIndianNumber(n, Number.isInteger(n) ? 0 : 1);
}

/**
 * Print settings for salary slips. They go to the receipt printer (same paper, font and printer), but a
 * salary slip is not a customer receipt: the receipt's extra header lines (timings, tagline) and footer
 * ("Thank you! Visit again.") are left out, and one copy is printed whatever the bill copies setting is.
 */
function slipPrintSettings(ctx: Ctx): ReceiptSettings {
  return { ...getSection(ctx, 'receipt'), header: '', footer: '', copies: 1 };
}

/** Salary slip as receipt HTML. `duplicate` marks a reprint. */
export function salarySlipHtml(ctx: Ctx, id: number, opts: { duplicate?: boolean } = {}): string {
  const s = getSalaryDetail(ctx, id);
  const business = getSection(ctx, 'business');
  const settings = slipPrintSettings(ctx);
  const meta: Array<[string, string]> = [
    ['Slip No', s.salaryNo],
    ['Month', s.monthLabel],
    ['Date', formatDate(s.date)],
    ['Salary', salaryText(s.salaryType, s.rate)],
  ];
  if (s.employedFrom && s.employedTo && s.daysEmployed !== null && s.daysEmployed < s.daysInMonth) {
    meta.push(['Worked', `${formatDate(s.employedFrom)} to ${formatDate(s.employedTo)}`]);
  }
  meta.push(['Days in month', String(s.daysInMonth)]);
  if (s.counts) {
    const c = s.counts;
    const rows: Array<[string, number]> = [
      ['Present', c.P],
      ['Absent', c.A],
      ['Half days', c.H],
      ['Paid leave', c.L],
      ['Weekly off', c.W],
      ['Not marked', c.unmarked],
    ];
    for (const [label, n] of rows) if (n || label === 'Present') meta.push([label, String(n)]);
  }
  meta.push(['Paid days', fmtDays(s.paidDays)]);
  const totals: Array<{ label: string; value: string; bold?: boolean; big?: boolean }> = [{ label: 'Gross salary', value: formatINR(s.gross) }];
  if (s.bonus) totals.push({ label: 'Add: Bonus', value: formatINR(s.bonus) });
  if (s.deductions) totals.push({ label: 'Less: Deductions', value: `-${formatINR(s.deductions)}` });
  if (s.advanceRecovery) totals.push({ label: 'Less: Advance recovered', value: `-${formatINR(s.advanceRecovery)}` });
  totals.push({ label: 'Net salary', value: formatINR(s.net), big: true });
  const activePayments = s.payments.filter((p) => p.status === 'active');
  if (s.status !== 'cancelled') {
    totals.push({ label: 'Paid', value: formatINR(s.paid) });
    totals.push({ label: 'Balance due', value: formatINR(s.balance), bold: true });
  }
  const lines: string[] = [amountInWords(s.net)];
  for (const p of activePayments) lines.push(`Paid ${formatINR(p.amount)} by ${PAYMENT_MODE_LABELS[p.mode]} on ${formatDate(p.date)}`);
  if (s.currentAdvance > 0) lines.push(`Advance still outstanding: ${formatINR(s.currentAdvance)}`);
  if (s.remarks) lines.push(s.remarks);
  if (s.status === 'cancelled' && s.cancelReason) lines.push(`Cancelled: ${s.cancelReason}`);
  return renderReceiptHtml(
    {
      title: 'SALARY SLIP',
      duplicate: !!opts.duplicate,
      cancelled: s.status === 'cancelled',
      meta,
      party: { label: 'Employee', name: s.employeeName, phone: s.employeePhone, extra: s.designation },
      totals,
      lines,
      signature: 'Employee signature',
    },
    business,
    settings,
  );
}

/**
 * Print a salary slip on the receipt printer (not a transaction: printing is async). One copy; every
 * print after the first is a reprint, marked DUPLICATE when the receipt setting says so (like bills).
 */
export async function printSalarySlip(ctx: Ctx, id: number): Promise<{ printed: boolean; duplicate: boolean; message?: string }> {
  const row = getRow(ctx, id);
  const settings = slipPrintSettings(ctx);
  const reprint = row.print_count > 0;
  const duplicate = reprint && settings.markDuplicate;
  const html = salarySlipHtml(ctx, id, { duplicate });
  const printerName = settings.printerName?.trim() || undefined;
  const result = await ctx.platform.printHtml(html, {
    printerName,
    silent: !!printerName,
    paperWidthMm: settings.paperWidth,
    copies: settings.copies,
  });
  if (!result.printed) return { printed: false, duplicate, message: result.message };
  ctx.db.tx(() => {
    ctx.db.run('UPDATE salaries SET print_count = print_count + 1 WHERE id = ?', [id]);
    logActivity(
      ctx,
      'salary.print',
      `${reprint ? 'Reprinted' : 'Printed'} salary slip ${row.salary_no} of ${row.employee_name} (${monthLabel(row.month, true)})${duplicate ? ' marked DUPLICATE' : ''}`,
      { entityType: 'salary', entityId: id, details: { printCount: row.print_count + 1 } },
    );
  });
  return { printed: true, duplicate, message: result.message };
}
