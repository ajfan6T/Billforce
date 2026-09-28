/**
 * Employee records: add / edit / mark as left, list with advance and salary
 * balances, and the helpers the attendance, salary and advance services share.
 *
 * Balances come straight from the ledger:
 *   outstanding advance = Employee Advances (employee) debit balance
 *   salary due          = Salary Payable (employee) credit balance
 */
import type { Ctx } from '../../context';
import { assertCan, can, now, today } from '../../context';
import { fail } from '../../errors';
import { logActivity } from '../../audit';
import { getSection } from '../../settings';
import { partyBalance, partyBalances, systemAccountId } from '../../accounting/ledger';
import { setPartyOpeningBalance } from '../../accounting/opening';
import { isDateInClosedYear } from '../../accounting/periods';
import { formatINR } from '../../../shared/money';
import { endOfMonth, formatDate, fyOf, isValidISODate, monthKey, monthLabel, startOfMonth } from '../../../shared/dates';
import type { AttendanceStatus } from '../../../shared/constants';

/*
 * CONTRACT functions used by other modules. The employees module owner extends
 * this file but must keep these signatures.
 */

export interface EmployeeSummary {
  id: number;
  name: string;
  phone: string | null;
  designation: string | null;
  isActive: boolean;
}

export function searchEmployees(ctx: Ctx, q = '', includeInactive = false): EmployeeSummary[] {
  const text = q.trim();
  return ctx.db
    .all<any>(
      `SELECT id, name, phone, designation, is_active FROM employees
        WHERE (:all = 1 OR is_active = 1) AND (:q = '' OR name LIKE :like OR phone LIKE :like)
        ORDER BY name COLLATE NOCASE`,
      { all: includeInactive ? 1 : 0, q: text, like: `%${text}%` },
    )
    .map((r) => ({ id: r.id, name: r.name, phone: r.phone, designation: r.designation, isActive: !!r.is_active }));
}

/* ------------------------------ Types ------------------------------ */

export type SalaryType = 'monthly' | 'daily';

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface EmployeeRow {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  designation: string | null;
  join_date: string | null;
  leave_date: string | null;
  salary_type: SalaryType;
  salary_amount: number;
  weekly_off: number | null;
  id_proof: string | null;
  bank_details: string | null;
  notes: string | null;
  opening_entry_id: number | null;
  is_active: number;
  created_at: string;
  updated_at: string | null;
}

export interface AttendanceCounts {
  P: number;
  A: number;
  H: number;
  L: number;
  W: number;
  /** Working days (up to today) with nothing marked. */
  unmarked: number;
}

export interface Employee {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  designation: string | null;
  joinDate: string | null;
  leaveDate: string | null;
  salaryType: SalaryType;
  /** Paise per month (monthly) or per day (daily). Null when the user may not see pay details. */
  salaryAmount: number | null;
  /** 0 = Sunday ... 6 = Saturday; null = no fixed weekly off. */
  weeklyOff: number | null;
  idProof: string | null;
  bankDetails: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
}

export interface EmployeeListItem extends Employee {
  /** Advance given and not yet recovered (paise). Null when pay details are hidden. */
  outstandingAdvance: number | null;
  /** Salary processed but not yet paid (paise). Null when pay details are hidden. */
  salaryDue: number | null;
  /** Attendance for the current month (days up to today). */
  attendance: AttendanceCounts;
}

export interface EmployeeDetail extends EmployeeListItem {
  /** Advance given before the books start (paise). Null when pay details are hidden. */
  openingAdvance: number | null;
  booksStartDate: string;
  /** The opening advance cannot be changed because the first financial year is closed. */
  openingLocked: boolean;
  /** Whether the logged-in user may see salary and balances. */
  showPay: boolean;
  totals: {
    slips: number;
    /** Salary earned in the current financial year: gross + bonus - deductions (what the employee cost). */
    salaryThisFy: number;
    /** Net salary of those slips (after advance recovery). */
    netThisFy: number;
    /** Recovered from advances in those slips. */
    recoveredThisFy: number;
    /** Paid against those slips so far. */
    paidThisFy: number;
    advancesThisFy: number;
    lastSalaryMonth: string | null;
  } | null;
}

export interface EmployeeInput {
  name: string;
  phone?: string | null;
  address?: string | null;
  designation?: string | null;
  joinDate?: string | null;
  salaryType: SalaryType;
  salaryAmount: number;
  weeklyOff?: number | null;
  idProof?: string | null;
  bankDetails?: string | null;
  notes?: string | null;
  /** Advance already given before the books start. undefined = leave unchanged (on update). */
  openingAdvance?: number | null;
}

/* ------------------------------ Helpers ------------------------------ */

/** Can the logged-in user see salaries and employee balances? */
export function canSeePay(ctx: Ctx): boolean {
  return can(ctx, 'employees.salary') || can(ctx, 'employees.manage');
}

export function getEmployeeRow(ctx: Ctx, id: number): EmployeeRow {
  const r = ctx.db.get<EmployeeRow>('SELECT * FROM employees WHERE id = ?', [id]);
  if (!r) throw fail.notFound('Employee');
  return r;
}

/** The part of [from, to] during which the employee worked here (null if none). */
export function employmentWindow(emp: Pick<EmployeeRow, 'join_date' | 'leave_date'>, from: string, to: string): { from: string; to: string } | null {
  const start = emp.join_date && emp.join_date > from ? emp.join_date : from;
  const end = emp.leave_date && emp.leave_date < to ? emp.leave_date : to;
  return start <= end ? { from: start, to: end } : null;
}

/** Throw unless the employee was working here on the date. */
export function assertEmployedOn(emp: EmployeeRow, date: string, what: string): void {
  if (emp.join_date && date < emp.join_date) {
    throw fail.validation(`${emp.name} joined on ${formatDate(emp.join_date)}, so ${what} cannot be dated ${formatDate(date)}.`, { date: 'Before the joining date' });
  }
  if (emp.leave_date && date > emp.leave_date) {
    throw fail.validation(`${emp.name} left on ${formatDate(emp.leave_date)}, so ${what} cannot be dated ${formatDate(date)}.`, { date: 'After the leaving date' });
  }
}

export function salaryText(type: SalaryType, amount: number): string {
  return `${formatINR(amount)} ${type === 'monthly' ? 'per month' : 'per day'}`;
}

export function emptyCounts(): AttendanceCounts {
  return { P: 0, A: 0, H: 0, L: 0, W: 0, unmarked: 0 };
}

/** Outstanding advance of an employee (Employee Advances debit balance). */
export function outstandingAdvance(ctx: Ctx, employeeId: number): number {
  return partyBalance(ctx, 'employee', employeeId, { account: 'EMP_ADV' });
}

/**
 * Advance that an entry dated `date` may recover (credit to Employee Advances) for each employee:
 * the lowest balance the employee's advance account has on that day or any later day, never below 0.
 * Advances given after the date are not counted, nor is anything a later-dated salary already recovered,
 * so recovering up to this amount can never make Employee Advances negative on any day.
 * Employees without an advance are left out of the map.
 */
export function recoverableAdvances(ctx: Ctx, date: string, employeeId?: number): Map<number, number> {
  const params: unknown[] = [date, 'employee', systemAccountId(ctx, 'EMP_ADV')];
  let one = '';
  if (employeeId !== undefined) {
    one = ' AND l.party_id = ?';
    params.push(employeeId);
  }
  // One row per employee for everything up to the date (day ''), then one per later day.
  const rows = ctx.db.all<{ party_id: number; day: string; amt: number }>(
    `SELECT l.party_id, CASE WHEN e.date <= ? THEN '' ELSE e.date END AS day, SUM(l.debit - l.credit) AS amt
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.party_type = ? AND l.account_id = ? AND e.is_void = 0${one}
      GROUP BY l.party_id, day ORDER BY l.party_id, day`,
    params,
  );
  const state = new Map<number, { bal: number; low: number }>();
  for (const r of rows) {
    let s = state.get(r.party_id);
    if (!s) {
      s = { bal: 0, low: 0 };
      state.set(r.party_id, s);
      if (r.day === '') {
        s.bal = s.low = r.amt;
        continue;
      }
    }
    s.bal += r.amt;
    s.low = Math.min(s.low, s.bal);
  }
  const out = new Map<number, number>();
  for (const [id, s] of state) if (s.low > 0) out.set(id, s.low);
  return out;
}

/** Advance of one employee that an entry dated `date` may recover (see recoverableAdvances). */
export function recoverableAdvance(ctx: Ctx, employeeId: number, date: string): number {
  return recoverableAdvances(ctx, date, employeeId).get(employeeId) ?? 0;
}

/** Salary processed but unpaid (Salary Payable credit balance, as a positive number). */
export function salaryDue(ctx: Ctx, employeeId: number): number {
  return 0 - partyBalance(ctx, 'employee', employeeId, { account: 'SALARY_PAYABLE' });
}

/** Opening advance held in the employee's opening entry (0 if none / void). */
export function openingAdvanceOf(ctx: Ctx, emp: Pick<EmployeeRow, 'id' | 'opening_entry_id'>): number {
  if (!emp.opening_entry_id) return 0;
  return ctx.db.value<number>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.id = ? AND e.is_void = 0 AND l.party_type = 'employee' AND l.party_id = ?`,
    [emp.opening_entry_id, emp.id],
    0,
  );
}

/** Active salary slip of an employee for a month, if any. */
export function activeSlipFor(ctx: Ctx, employeeId: number, month: string): { id: number; salary_no: string } | undefined {
  return ctx.db.get<{ id: number; salary_no: string }>(
    "SELECT id, salary_no FROM salaries WHERE employee_id = ? AND month = ? AND status <> 'cancelled'",
    [employeeId, month],
  );
}

function toEmployee(r: EmployeeRow, showPay: boolean): Employee {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    address: r.address,
    designation: r.designation,
    joinDate: r.join_date,
    leaveDate: r.leave_date,
    salaryType: r.salary_type,
    salaryAmount: showPay ? r.salary_amount : null,
    weeklyOff: r.weekly_off,
    idProof: r.id_proof,
    bankDetails: showPay ? r.bank_details : null,
    notes: r.notes,
    isActive: !!r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Attendance counts for the given employees between from and to (inclusive),
 * limited to each employee's employment window and to days up to today.
 */
export function attendanceCounts(ctx: Ctx, rows: EmployeeRow[], from: string, to: string): Map<number, AttendanceCounts> {
  const out = new Map<number, AttendanceCounts>();
  const t = today(ctx);
  const upTo = to < t ? to : t;
  if (!rows.length || upTo < from) {
    for (const r of rows) out.set(r.id, emptyCounts());
    return out;
  }
  const marks = ctx.db.all<{ employee_id: number; date: string; status: AttendanceStatus }>(
    'SELECT employee_id, date, status FROM attendance WHERE date >= ? AND date <= ?',
    [from, upTo],
  );
  const byEmp = new Map<number, Array<{ date: string; status: AttendanceStatus }>>();
  for (const m of marks) {
    const list = byEmp.get(m.employee_id) ?? [];
    list.push(m);
    byEmp.set(m.employee_id, list);
  }
  for (const r of rows) {
    const c = emptyCounts();
    const win = employmentWindow(r, from, upTo);
    if (win) {
      let marked = 0;
      for (const m of byEmp.get(r.id) ?? []) {
        if (m.date < win.from || m.date > win.to) continue;
        c[m.status]++;
        marked++;
      }
      const days = Math.round((Date.parse(`${win.to}T00:00:00Z`) - Date.parse(`${win.from}T00:00:00Z`)) / 86_400_000) + 1;
      c.unmarked = Math.max(days - marked, 0);
    }
    out.set(r.id, c);
  }
  return out;
}

/* ------------------------------ Queries ------------------------------ */

export function listEmployees(ctx: Ctx, opts: { q?: string | null; includeInactive?: boolean } = {}): EmployeeListItem[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (!opts.includeInactive) where.push('is_active = 1');
  const text = opts.q?.trim();
  if (text) {
    where.push("(name LIKE :like OR REPLACE(COALESCE(phone, ''), ' ', '') LIKE :phone OR designation LIKE :like)");
    params.like = `%${text}%`;
    params.phone = `%${text.replace(/\s/g, '')}%`;
  }
  const rows = ctx.db.all<EmployeeRow>(
    `SELECT * FROM employees ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY is_active DESC, name COLLATE NOCASE`,
    params,
  );
  const showPay = canSeePay(ctx);
  const adv = showPay ? partyBalances(ctx, 'employee', { account: 'EMP_ADV' }) : new Map<number, number>();
  const pay = showPay ? partyBalances(ctx, 'employee', { account: 'SALARY_PAYABLE' }) : new Map<number, number>();
  const t = today(ctx);
  const counts = attendanceCounts(ctx, rows, startOfMonth(t), endOfMonth(t));
  return rows.map((r) => ({
    ...toEmployee(r, showPay),
    outstandingAdvance: showPay ? (adv.get(r.id) ?? 0) : null,
    salaryDue: showPay ? 0 - (pay.get(r.id) ?? 0) : null,
    attendance: counts.get(r.id) ?? emptyCounts(),
  }));
}

export function getEmployee(ctx: Ctx, id: number): EmployeeDetail {
  const r = getEmployeeRow(ctx, id);
  const showPay = canSeePay(ctx);
  const t = today(ctx);
  const counts = attendanceCounts(ctx, [r], startOfMonth(t), endOfMonth(t)).get(r.id) ?? emptyCounts();
  const booksStartDate = getSection(ctx, 'accounts').booksStartDate;
  let totals: EmployeeDetail['totals'] = null;
  if (showPay) {
    const fy = fyOf(t);
    const s = ctx.db.get<{ slips: number; earned: number; net: number; recovered: number; paid: number; last_month: string | null }>(
      `SELECT COUNT(*) AS slips,
              COALESCE(SUM(CASE WHEN date >= :from AND date <= :to THEN gross + bonus - deductions ELSE 0 END), 0) AS earned,
              COALESCE(SUM(CASE WHEN date >= :from AND date <= :to THEN net ELSE 0 END), 0) AS net,
              COALESCE(SUM(CASE WHEN date >= :from AND date <= :to THEN advance_recovery ELSE 0 END), 0) AS recovered,
              COALESCE(SUM(CASE WHEN date >= :from AND date <= :to THEN paid ELSE 0 END), 0) AS paid,
              MAX(month) AS last_month
         FROM salaries WHERE employee_id = :id AND status <> 'cancelled'`,
      { from: fy.start, to: fy.end, id },
    )!;
    const advances = ctx.db.value<number>(
      "SELECT COALESCE(SUM(amount), 0) FROM employee_advances WHERE employee_id = ? AND status = 'active' AND date >= ? AND date <= ?",
      [id, fy.start, fy.end],
      0,
    );
    totals = {
      slips: s.slips,
      salaryThisFy: s.earned,
      netThisFy: s.net,
      recoveredThisFy: s.recovered,
      paidThisFy: s.paid,
      advancesThisFy: advances,
      lastSalaryMonth: s.last_month,
    };
  }
  return {
    ...toEmployee(r, showPay),
    outstandingAdvance: showPay ? outstandingAdvance(ctx, id) : null,
    salaryDue: showPay ? salaryDue(ctx, id) : null,
    attendance: counts,
    openingAdvance: showPay ? openingAdvanceOf(ctx, r) : null,
    booksStartDate,
    openingLocked: isDateInClosedYear(ctx, booksStartDate),
    showPay,
    totals,
  };
}

export function employeeFormInfo(ctx: Ctx): { booksStartDate: string; openingLocked: boolean } {
  const booksStartDate = getSection(ctx, 'accounts').booksStartDate;
  return { booksStartDate, openingLocked: isDateInClosedYear(ctx, booksStartDate) };
}

/* ------------------------------ Changes ------------------------------ */

interface NormalizedEmployee {
  name: string;
  phone: string | null;
  address: string | null;
  designation: string | null;
  join_date: string | null;
  salary_type: SalaryType;
  salary_amount: number;
  weekly_off: number | null;
  id_proof: string | null;
  bank_details: string | null;
  notes: string | null;
}

const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

function normalize(ctx: Ctx, input: EmployeeInput, exceptId?: number): NormalizedEmployee {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw fail.validation("Enter the employee's name", { name: 'Enter the name' });
  const clash = ctx.db.get<{ id: number }>('SELECT id FROM employees WHERE name = ? COLLATE NOCASE AND is_active = 1 AND id <> ?', [name, exceptId ?? 0]);
  if (clash) {
    throw fail.validation(`An employee named "${name}" already exists. Add a surname or nickname so you can tell them apart.`, { name: 'Name already used' });
  }
  const joinDate = clean(input.joinDate);
  if (joinDate && !isValidISODate(joinDate)) throw fail.validation('Enter a valid joining date', { joinDate: 'Enter a valid date' });
  if (input.salaryType !== 'monthly' && input.salaryType !== 'daily') throw fail.validation('Choose monthly salary or daily wages', { salaryType: 'Choose one' });
  if (!Number.isInteger(input.salaryAmount) || input.salaryAmount < 0) throw fail.validation('Enter the salary amount', { salaryAmount: 'Enter the amount' });
  const weeklyOff = input.weeklyOff ?? null;
  if (weeklyOff !== null && (!Number.isInteger(weeklyOff) || weeklyOff < 0 || weeklyOff > 6)) {
    throw fail.validation('Choose the weekly off day', { weeklyOff: 'Choose a day' });
  }
  return {
    name,
    phone: clean(input.phone),
    address: clean(input.address),
    designation: clean(input.designation),
    join_date: joinDate,
    salary_type: input.salaryType,
    salary_amount: input.salaryAmount,
    weekly_off: weeklyOff,
    id_proof: clean(input.idProof),
    bank_details: clean(input.bankDetails),
    notes: clean(input.notes),
  };
}

/** Remove attendance marked outside the employment period (after a joining / leaving date change). */
function removeAttendanceOutside(ctx: Ctx, emp: Pick<EmployeeRow, 'id' | 'join_date' | 'leave_date'>): number {
  let removed = 0;
  if (emp.join_date) removed += ctx.db.run('DELETE FROM attendance WHERE employee_id = ? AND date < ?', [emp.id, emp.join_date]).changes;
  if (emp.leave_date) removed += ctx.db.run('DELETE FROM attendance WHERE employee_id = ? AND date > ?', [emp.id, emp.leave_date]).changes;
  return removed;
}

/** Salary slips must stay inside the employment period. */
function assertSlipsInside(ctx: Ctx, emp: Pick<EmployeeRow, 'id' | 'name'>, joinDate: string | null, leaveDate: string | null): void {
  if (joinDate) {
    const s = ctx.db.get<{ salary_no: string; month: string }>(
      "SELECT salary_no, month FROM salaries WHERE employee_id = ? AND status <> 'cancelled' AND month < ? ORDER BY month LIMIT 1",
      [emp.id, monthKey(joinDate)],
    );
    if (s) {
      throw fail.validation(
        `Salary for ${monthLabel(s.month, true)} (${s.salary_no}) is recorded for ${emp.name}, which is before ${formatDate(joinDate)}. Cancel that salary slip first or choose an earlier date.`,
        { joinDate: 'Salary is recorded before this date' },
      );
    }
  }
  if (leaveDate) {
    const s = ctx.db.get<{ salary_no: string; month: string }>(
      "SELECT salary_no, month FROM salaries WHERE employee_id = ? AND status <> 'cancelled' AND month > ? ORDER BY month LIMIT 1",
      [emp.id, monthKey(leaveDate)],
    );
    if (s) {
      throw fail.validation(
        `Salary for ${monthLabel(s.month, true)} (${s.salary_no}) is recorded for ${emp.name}, which is after ${formatDate(leaveDate)}. Cancel that salary slip first or choose a later date.`,
        { leaveDate: 'Salary is recorded after this date' },
      );
    }
  }
}

function setOpeningAdvance(ctx: Ctx, emp: EmployeeRow, name: string, amount: number): void {
  const current = openingAdvanceOf(ctx, emp);
  if (current === amount) return;
  if (amount < current) {
    // Lowering the opening advance lowers the advance balance on every day from the books start, so it
    // must not take any day below zero (a salary may have recovered it before a later advance was given).
    const openedOn =
      ctx.db.value<string | null>('SELECT date FROM journal_entries WHERE id = ?', [emp.opening_entry_id], null) ?? getSection(ctx, 'accounts').booksStartDate;
    const spare = recoverableAdvance(ctx, emp.id, openedOn);
    if (current - amount > spare) {
      const recovered = current - spare;
      throw fail.validation(
        `${formatINR(recovered)} of the opening advance has already been recovered from salary, so it cannot be less than ${formatINR(recovered)}.`,
        { openingAdvance: `At least ${formatINR(recovered)}` },
      );
    }
  }
  const entryId = setPartyOpeningBalance(ctx, 'employee', emp.id, name, amount, emp.opening_entry_id);
  if (entryId !== emp.opening_entry_id) ctx.db.update('employees', emp.id, { opening_entry_id: entryId });
}

/** The opening advance is an accounting entry (Employee Advances against the opening balance adjustment). */
const OPENING_ADVANCE_DENIED = 'You are not allowed to set or change the advance given before your books started. Ask the owner or manager.';

export function createEmployee(ctx: Ctx, input: EmployeeInput): EmployeeDetail {
  const v = normalize(ctx, input);
  const opening = input.openingAdvance ?? 0;
  if (opening < 0) throw fail.validation('The opening advance cannot be negative', { openingAdvance: 'Cannot be negative' });
  if (opening > 0) assertCan(ctx, 'employees.salary', OPENING_ADVANCE_DENIED);
  const id = ctx.db.insert('employees', { ...v, is_active: 1, created_at: now(ctx) });
  if (opening > 0) setOpeningAdvance(ctx, getEmployeeRow(ctx, id), v.name, opening);
  logActivity(
    ctx,
    'employee.create',
    `Added employee ${v.name}${v.designation ? ` (${v.designation})` : ''}, ${salaryText(v.salary_type, v.salary_amount)}${opening ? `, opening advance ${formatINR(opening)}` : ''}`,
    { entityType: 'employee', entityId: id, details: { ...v, openingAdvance: opening } },
  );
  return getEmployee(ctx, id);
}

export function updateEmployee(ctx: Ctx, id: number, input: EmployeeInput): EmployeeDetail {
  const before = getEmployeeRow(ctx, id);
  const v = normalize(ctx, input, id);
  if (v.join_date && before.leave_date && v.join_date > before.leave_date) {
    throw fail.validation(`The joining date cannot be after the leaving date (${formatDate(before.leave_date)}).`, { joinDate: 'After the leaving date' });
  }
  if (v.join_date !== before.join_date) assertSlipsInside(ctx, before, v.join_date, null);
  const openingBefore = openingAdvanceOf(ctx, before);
  // Sending the saved opening advance back unchanged is fine; changing it needs "Salary & advances".
  if (input.openingAdvance !== undefined && input.openingAdvance !== null && input.openingAdvance !== openingBefore) {
    assertCan(ctx, 'employees.salary', OPENING_ADVANCE_DENIED);
  }
  ctx.db.update('employees', id, { ...v, updated_at: now(ctx) });
  const removed = v.join_date !== before.join_date ? removeAttendanceOutside(ctx, { id, join_date: v.join_date, leave_date: before.leave_date }) : 0;
  if (input.openingAdvance !== undefined && input.openingAdvance !== null && input.openingAdvance !== openingBefore) {
    if (input.openingAdvance < 0) throw fail.validation('The opening advance cannot be negative', { openingAdvance: 'Cannot be negative' });
    setOpeningAdvance(ctx, getEmployeeRow(ctx, id), v.name, input.openingAdvance);
  } else if (before.opening_entry_id && openingBefore && before.name !== v.name) {
    // Keep the opening entry's narration in step with the new name. If that year is
    // already closed the entry cannot change; the old narration is harmless.
    try {
      setPartyOpeningBalance(ctx, 'employee', id, v.name, openingBefore, before.opening_entry_id);
    } catch {
      /* narration only */
    }
  }
  const changes: string[] = [];
  if (before.name !== v.name) changes.push(`renamed from "${before.name}"`);
  if (before.salary_type !== v.salary_type || before.salary_amount !== v.salary_amount) {
    changes.push(`salary ${salaryText(before.salary_type, before.salary_amount)} → ${salaryText(v.salary_type, v.salary_amount)}`);
  }
  if (before.designation !== v.designation) changes.push(`designation ${before.designation ?? '—'} → ${v.designation ?? '—'}`);
  if (before.join_date !== v.join_date) changes.push(`joining date ${formatDate(before.join_date) || '—'} → ${formatDate(v.join_date) || '—'}`);
  if (before.weekly_off !== v.weekly_off) {
    changes.push(`weekly off ${before.weekly_off === null ? 'none' : WEEKDAY_NAMES[before.weekly_off]} → ${v.weekly_off === null ? 'none' : WEEKDAY_NAMES[v.weekly_off]}`);
  }
  if (input.openingAdvance !== undefined && input.openingAdvance !== null && input.openingAdvance !== openingBefore) {
    changes.push(`opening advance ${formatINR(openingBefore)} → ${formatINR(input.openingAdvance)}`);
  }
  if (removed) changes.push(`removed ${removed} attendance mark${removed === 1 ? '' : 's'} before the joining date`);
  const { opening_entry_id: _o, ...beforeDetails } = before;
  logActivity(ctx, 'employee.update', `Updated employee ${v.name}${changes.length ? ': ' + changes.join(', ') : ''}`, {
    entityType: 'employee',
    entityId: id,
    details: { before: beforeDetails, after: v, openingAdvance: input.openingAdvance ?? openingBefore },
  });
  return getEmployee(ctx, id);
}

export interface SetActiveResult {
  employee: EmployeeDetail;
  warnings: string[];
}

/** Mark an employee as left (with the last working day) or bring them back. */
export function setEmployeeActive(ctx: Ctx, id: number, active: boolean, leaveDate?: string | null): SetActiveResult {
  const emp = getEmployeeRow(ctx, id);
  const warnings: string[] = [];
  if (active) {
    if (emp.is_active) return { employee: getEmployee(ctx, id), warnings };
    ctx.db.update('employees', id, { is_active: 1, leave_date: null, updated_at: now(ctx) });
    logActivity(ctx, 'employee.activate', `Re-activated employee ${emp.name}${emp.leave_date ? ` (had left on ${formatDate(emp.leave_date)})` : ''}`, {
      entityType: 'employee',
      entityId: id,
    });
    return { employee: getEmployee(ctx, id), warnings };
  }
  if (!emp.is_active) throw fail.validation(`${emp.name} is already marked as left.`);
  const t = today(ctx);
  const last = leaveDate || t;
  if (!isValidISODate(last)) throw fail.validation('Enter a valid leaving date', { leaveDate: 'Enter a valid date' });
  if (last > t) throw fail.validation(`The last working day cannot be later than today (${formatDate(t)}). Mark ${emp.name} as left on or after their last day.`, { leaveDate: 'Cannot be in the future' });
  if (emp.join_date && last < emp.join_date) {
    throw fail.validation(`The last working day cannot be before the joining date (${formatDate(emp.join_date)}).`, { leaveDate: 'Before the joining date' });
  }
  assertSlipsInside(ctx, emp, null, last);
  ctx.db.update('employees', id, { is_active: 0, leave_date: last, updated_at: now(ctx) });
  const removed = removeAttendanceOutside(ctx, { id, join_date: emp.join_date, leave_date: last });
  const adv = outstandingAdvance(ctx, id);
  const due = salaryDue(ctx, id);
  if (adv > 0) warnings.push(`${emp.name} still has ${formatINR(adv)} advance outstanding. Recover it from the final salary or record it as an expense.`);
  if (due > 0) warnings.push(`${formatINR(due)} salary is still due to ${emp.name}.`);
  if (!activeSlipFor(ctx, id, monthKey(last)) && (!emp.join_date || monthKey(emp.join_date) <= monthKey(last))) {
    warnings.push(`Remember to process the salary for ${monthLabel(monthKey(last), true)}.`);
  }
  logActivity(
    ctx,
    'employee.leave',
    `Marked employee ${emp.name} as left on ${formatDate(last)}${removed ? ` (removed ${removed} attendance mark${removed === 1 ? '' : 's'} after that day)` : ''}`,
    { entityType: 'employee', entityId: id, details: { leaveDate: last, removedAttendance: removed, outstandingAdvance: adv, salaryDue: due } },
  );
  return { employee: getEmployee(ctx, id), warnings };
}
