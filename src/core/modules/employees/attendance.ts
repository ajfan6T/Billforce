/**
 * Daily attendance: P = present, A = absent, H = half day, L = paid leave,
 * W = weekly off. Attendance feeds the salary calculation, so it cannot be
 * marked for future days, outside the employment period, or for a month whose
 * salary has already been processed.
 */
import type { Ctx } from '../../context';
import { currentUserId, now, today } from '../../context';
import { fail } from '../../errors';
import { logActivity } from '../../audit';
import { ATTENDANCE_LABELS, type AttendanceStatus } from '../../../shared/constants';
import { datesBetween, dayOfWeek, endOfMonth, formatDate, monthKey, monthLabel } from '../../../shared/dates';
import {
  activeSlipFor,
  assertEmployedOn,
  emptyCounts,
  employmentWindow,
  getEmployeeRow,
  type AttendanceCounts,
  type EmployeeRow,
} from './service';

export interface AttendanceDay {
  date: string;
  /** Day of the month, 1-31. */
  day: number;
  /** 0 = Sunday. */
  weekday: number;
  future: boolean;
  isToday: boolean;
}

export interface AttendanceMark {
  status: AttendanceStatus;
  note: string | null;
}

export interface AttendanceEmployee {
  id: number;
  name: string;
  designation: string | null;
  weeklyOff: number | null;
  joinDate: string | null;
  leaveDate: string | null;
  isActive: boolean;
  /** Part of the month the employee worked here (null = none). */
  employedFrom: string | null;
  employedTo: string | null;
  /** Salary for the month is processed: attendance can no longer change. */
  lockedBy: { salaryId: number; salaryNo: string } | null;
  marks: Record<string, AttendanceMark>;
  /** Counts up to today, within the employment period. */
  counts: AttendanceCounts;
}

export interface AttendanceMonth {
  month: string;
  label: string;
  today: string;
  days: AttendanceDay[];
  employees: AttendanceEmployee[];
}

/** Validate "YYYY-MM" and return the first / last day. */
export function monthRange(month: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw fail.validation('Choose a valid month', { month: 'Choose a month' });
  const from = `${month}-01`;
  return { from, to: endOfMonth(from) };
}

/** Employees who worked here at any time in [from, to], plus any listed ids. */
export function employeesInPeriod(ctx: Ctx, from: string, to: string, alsoIds: number[] = []): EmployeeRow[] {
  const rows = ctx.db.all<EmployeeRow>(
    `SELECT * FROM employees
      WHERE ((join_date IS NULL OR join_date <= :to) AND (leave_date IS NULL OR leave_date >= :from) AND (is_active = 1 OR leave_date IS NOT NULL))
      ORDER BY name COLLATE NOCASE`,
    { from, to },
  );
  const have = new Set(rows.map((r) => r.id));
  const extra = alsoIds.filter((id) => !have.has(id));
  for (const id of extra) {
    const r = ctx.db.get<EmployeeRow>('SELECT * FROM employees WHERE id = ?', [id]);
    if (r) rows.push(r);
  }
  return rows;
}

function countMarks(marks: Record<string, AttendanceMark>, win: { from: string; to: string } | null, upTo: string): AttendanceCounts {
  const c = emptyCounts();
  if (!win) return c;
  const end = win.to < upTo ? win.to : upTo;
  if (end < win.from) return c;
  for (const d of datesBetween(win.from, end)) {
    const m = marks[d];
    if (m) c[m.status]++;
    else c.unmarked++;
  }
  return c;
}

/** The attendance sheet for a month (optionally one employee only). */
export function attendanceMonth(ctx: Ctx, month: string, employeeId?: number | null): AttendanceMonth {
  const { from, to } = monthRange(month);
  const t = today(ctx);
  const days: AttendanceDay[] = datesBetween(from, to).map((date) => ({
    date,
    day: Number(date.slice(8, 10)),
    weekday: dayOfWeek(date),
    future: date > t,
    isToday: date === t,
  }));
  const rows = employeeId ? [getEmployeeRow(ctx, employeeId)] : employeesInPeriod(ctx, from, to);
  const ids = rows.map((r) => r.id);
  const marksByEmp = new Map<number, Record<string, AttendanceMark>>();
  if (ids.length) {
    const marks = ctx.db.all<{ employee_id: number; date: string; status: AttendanceStatus; note: string | null }>(
      `SELECT employee_id, date, status, note FROM attendance WHERE date >= ? AND date <= ? AND employee_id IN (${ids.map(() => '?').join(', ')})`,
      [from, to, ...ids],
    );
    for (const m of marks) {
      const rec = marksByEmp.get(m.employee_id) ?? {};
      rec[m.date] = { status: m.status, note: m.note };
      marksByEmp.set(m.employee_id, rec);
    }
  }
  const slips = new Map<number, { salaryId: number; salaryNo: string }>();
  for (const s of ctx.db.all<{ id: number; employee_id: number; salary_no: string }>(
    "SELECT id, employee_id, salary_no FROM salaries WHERE month = ? AND status <> 'cancelled'",
    [month],
  )) {
    slips.set(s.employee_id, { salaryId: s.id, salaryNo: s.salary_no });
  }
  const employees = rows.map((r): AttendanceEmployee => {
    const win = employmentWindow(r, from, to);
    const marks = marksByEmp.get(r.id) ?? {};
    return {
      id: r.id,
      name: r.name,
      designation: r.designation,
      weeklyOff: r.weekly_off,
      joinDate: r.join_date,
      leaveDate: r.leave_date,
      isActive: !!r.is_active,
      employedFrom: win?.from ?? null,
      employedTo: win?.to ?? null,
      lockedBy: slips.get(r.id) ?? null,
      marks,
      counts: countMarks(marks, win, t),
    };
  });
  return { month, label: monthLabel(month, true), today: t, days, employees };
}

function lockedMessage(emp: EmployeeRow, month: string, salaryNo: string): string {
  return `Salary for ${monthLabel(month, true)} is already processed for ${emp.name} (${salaryNo}). Cancel that salary slip to change the attendance.`;
}

export interface MarkInput {
  employeeId: number;
  date: string;
  /** null clears the day. */
  status: AttendanceStatus | null;
  note?: string | null;
}

export function markAttendance(ctx: Ctx, input: MarkInput): { employeeId: number; date: string; status: AttendanceStatus | null; note: string | null } {
  const emp = getEmployeeRow(ctx, input.employeeId);
  const t = today(ctx);
  const date = input.date;
  if (date > t) throw fail.validation(`Attendance cannot be marked for a future date (${formatDate(date)}).`, { date: 'Future date' });
  assertEmployedOn(emp, date, 'attendance');
  const month = monthKey(date);
  const slip = activeSlipFor(ctx, emp.id, month);
  if (slip) throw fail.validation(lockedMessage(emp, month, slip.salary_no));
  const before = ctx.db.get<{ status: AttendanceStatus; note: string | null }>('SELECT status, note FROM attendance WHERE employee_id = ? AND date = ?', [emp.id, date]);
  const note = input.note?.trim() || null;
  if (input.status === null) {
    if (!before) return { employeeId: emp.id, date, status: null, note: null };
    ctx.db.run('DELETE FROM attendance WHERE employee_id = ? AND date = ?', [emp.id, date]);
    logActivity(ctx, 'attendance.clear', `Cleared attendance of ${emp.name} on ${formatDate(date)} (was ${ATTENDANCE_LABELS[before.status]})`, {
      entityType: 'employee',
      entityId: emp.id,
      details: { date, from: before.status, to: null },
    });
    return { employeeId: emp.id, date, status: null, note: null };
  }
  const keepNote = input.note === undefined ? (before?.note ?? null) : note;
  if (before && before.status === input.status && before.note === keepNote) {
    return { employeeId: emp.id, date, status: input.status, note: keepNote };
  }
  ctx.db.run(
    `INSERT INTO attendance (employee_id, date, status, note, marked_by, marked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (employee_id, date) DO UPDATE SET status = excluded.status, note = excluded.note, marked_by = excluded.marked_by, marked_at = excluded.marked_at`,
    [emp.id, date, input.status, keepNote, currentUserId(ctx), now(ctx)],
  );
  logActivity(
    ctx,
    'attendance.mark',
    `Marked ${emp.name} ${ATTENDANCE_LABELS[input.status]} on ${formatDate(date)}${before && before.status !== input.status ? ` (was ${ATTENDANCE_LABELS[before.status]})` : ''}${keepNote ? `: ${keepNote}` : ''}`,
    { entityType: 'employee', entityId: emp.id, details: { date, from: before?.status ?? null, to: input.status, note: keepNote } },
  );
  return { employeeId: emp.id, date, status: input.status, note: keepNote };
}

export interface MarkAllResult {
  date: string;
  marked: number;
  /** Employees whose weekly off falls on the day (marked W instead of present). */
  weeklyOff: number;
  alreadyMarked: number;
  /** Salary already processed for the month. */
  locked: number;
}

/**
 * Mark every employee working on the date. With status P, employees whose
 * weekly off falls on that day are marked W instead.
 */
export function markAll(ctx: Ctx, input: { date: string; status: AttendanceStatus; onlyUnmarked: boolean }): MarkAllResult {
  const t = today(ctx);
  const date = input.date;
  if (date > t) throw fail.validation(`Attendance cannot be marked for a future date (${formatDate(date)}).`, { date: 'Future date' });
  const month = monthKey(date);
  const rows = employeesInPeriod(ctx, date, date);
  const res: MarkAllResult = { date, marked: 0, weeklyOff: 0, alreadyMarked: 0, locked: 0 };
  const stamp = now(ctx);
  const user = currentUserId(ctx);
  for (const emp of rows) {
    if (activeSlipFor(ctx, emp.id, month)) {
      res.locked++;
      continue;
    }
    const existing = ctx.db.value<string | null>('SELECT status FROM attendance WHERE employee_id = ? AND date = ?', [emp.id, date], null);
    if (existing && input.onlyUnmarked) {
      res.alreadyMarked++;
      continue;
    }
    const status: AttendanceStatus = input.status === 'P' && emp.weekly_off !== null && emp.weekly_off === dayOfWeek(date) ? 'W' : input.status;
    ctx.db.run(
      `INSERT INTO attendance (employee_id, date, status, note, marked_by, marked_at) VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT (employee_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by, marked_at = excluded.marked_at`,
      [emp.id, date, status, user, stamp],
    );
    if (status === 'W' && input.status !== 'W') res.weeklyOff++;
    else res.marked++;
  }
  if (res.marked || res.weeklyOff) {
    const parts = [`${res.marked} employee${res.marked === 1 ? '' : 's'} ${ATTENDANCE_LABELS[input.status].toLowerCase()}`];
    if (res.weeklyOff) parts.push(`${res.weeklyOff} on weekly off`);
    logActivity(ctx, 'attendance.markAll', `Marked attendance for ${formatDate(date)}: ${parts.join(', ')}`, {
      entityType: 'attendance',
      details: { ...res, status: input.status, onlyUnmarked: input.onlyUnmarked },
    });
  }
  return res;
}

export interface FillWeeklyOffResult {
  month: string;
  filled: number;
  employees: number;
  /** Employees skipped because the month's salary is processed. */
  locked: number;
}

/** Mark W on each employee's weekly-off day (up to today) where nothing is marked yet. */
export function fillWeeklyOff(ctx: Ctx, month: string): FillWeeklyOffResult {
  const { from, to } = monthRange(month);
  const t = today(ctx);
  const res: FillWeeklyOffResult = { month, filled: 0, employees: 0, locked: 0 };
  if (from > t) return res;
  const stamp = now(ctx);
  const user = currentUserId(ctx);
  for (const emp of employeesInPeriod(ctx, from, to)) {
    if (emp.weekly_off === null) continue;
    const win = employmentWindow(emp, from, to < t ? to : t);
    if (!win) continue;
    if (activeSlipFor(ctx, emp.id, month)) {
      res.locked++;
      continue;
    }
    let filled = 0;
    for (const d of datesBetween(win.from, win.to)) {
      if (dayOfWeek(d) !== emp.weekly_off) continue;
      filled += ctx.db.run(
        `INSERT INTO attendance (employee_id, date, status, note, marked_by, marked_at) VALUES (?, ?, 'W', NULL, ?, ?)
         ON CONFLICT (employee_id, date) DO NOTHING`,
        [emp.id, d, user, stamp],
      ).changes;
    }
    if (filled) {
      res.filled += filled;
      res.employees++;
    }
  }
  if (res.filled) {
    logActivity(
      ctx,
      'attendance.weeklyOff',
      `Filled weekly offs for ${monthLabel(month, true)}: ${res.filled} day${res.filled === 1 ? '' : 's'} for ${res.employees} employee${res.employees === 1 ? '' : 's'}`,
      { entityType: 'attendance', details: res },
    );
  }
  return res;
}
