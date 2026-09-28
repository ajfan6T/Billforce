import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance, type TestApp } from './helpers';
import { partyBalance } from '../src/core/accounting/ledger';
import { calculateSalary } from '../src/core/modules/employees/salary';
import type { AttendanceStatus } from '../src/shared/constants';

let t: TestApp;
afterEach(() => {
  if (t) {
    expect(ledgerProblems(t.app)).toEqual([]);
    t.close();
  }
});

const RS = (rupees: number) => Math.round(rupees * 100);

async function addEmployee(overrides: Record<string, unknown> = {}) {
  return t.call('employees.create', {
    name: 'Ramesh Kumar',
    phone: '98200 11111',
    designation: 'Helper',
    joinDate: '2026-04-01',
    salaryType: 'monthly',
    salaryAmount: RS(15000),
    weeklyOff: 0,
    ...overrides,
  } as any);
}

async function mark(employeeId: number, dates: string[], status: AttendanceStatus | null) {
  for (const date of dates) await t.call('attendance.mark', { employeeId, date, status });
}

function advBalance(id: number) {
  return partyBalance(t.app.ctx(), 'employee', id, { account: 'EMP_ADV' });
}
function payableBalance(id: number) {
  return partyBalance(t.app.ctx(), 'employee', id, { account: 'SALARY_PAYABLE' });
}
function activityCount(action: string) {
  return t.app.db.value<number>('SELECT COUNT(*) FROM activity_log WHERE action = ?', [action], 0);
}

const emp = (o: Partial<{ join_date: string | null; leave_date: string | null; salary_type: 'monthly' | 'daily'; salary_amount: number }> = {}) => ({
  join_date: null,
  leave_date: null,
  salary_type: 'monthly' as const,
  salary_amount: RS(30000),
  ...o,
});

/* ------------------------------ Pure maths ------------------------------ */

describe('salary maths', () => {
  it('monthly: absents and half days reduce pay, unmarked / W / L are paid', () => {
    const marks: Record<string, AttendanceStatus> = {
      '2026-09-01': 'A',
      '2026-09-02': 'A',
      '2026-09-03': 'H',
      '2026-09-06': 'W',
      '2026-09-07': 'L',
      '2026-09-08': 'P',
    };
    const c = calculateSalary(emp(), '2026-09', marks);
    expect(c.daysInMonth).toBe(30);
    expect(c.daysEmployed).toBe(30);
    expect(c.counts).toEqual({ P: 1, A: 2, H: 1, L: 1, W: 1, unmarked: 24 });
    expect(c.paidDays).toBe(27.5);
    expect(c.gross).toBe(RS(27500)); // 30,000 x 27.5 / 30
  });

  it('monthly: whole month unmarked is a full salary', () => {
    expect(calculateSalary(emp(), '2026-09', {}).gross).toBe(RS(30000));
  });

  it('monthly: February and 31-day months divide by the actual days', () => {
    const feb = calculateSalary(emp({ salary_amount: RS(28000) }), '2027-02', { '2027-02-10': 'A' });
    expect(feb.daysInMonth).toBe(28);
    expect(feb.paidDays).toBe(27);
    expect(feb.gross).toBe(RS(27000));
    const leapFeb = calculateSalary(emp({ salary_amount: RS(29000) }), '2028-02', { '2028-02-29': 'A' });
    expect(leapFeb.daysInMonth).toBe(29);
    expect(leapFeb.gross).toBe(RS(28000));
    const oct = calculateSalary(emp({ salary_amount: RS(31000) }), '2026-10', { '2026-10-02': 'A' });
    expect(oct.daysInMonth).toBe(31);
    expect(oct.gross).toBe(RS(30000));
  });

  it('monthly: rounds to the nearest paisa', () => {
    // 10,000 x 30 / 31 = 9,677.419...
    const c = calculateSalary(emp({ salary_amount: RS(10000) }), '2026-10', { '2026-10-05': 'A' });
    expect(c.gross).toBe(967742);
  });

  it('monthly: joining and leaving mid-month pays only the days employed', () => {
    const joined = calculateSalary(emp({ join_date: '2026-09-16' }), '2026-09', { '2026-09-10': 'P' });
    expect(joined.employedFrom).toBe('2026-09-16');
    expect(joined.daysEmployed).toBe(15);
    expect(joined.counts.P).toBe(0); // marks outside employment are ignored
    expect(joined.gross).toBe(RS(15000));
    const left = calculateSalary(emp({ join_date: '2025-01-01', leave_date: '2026-09-10' }), '2026-09', { '2026-09-05': 'H' });
    expect(left.employedTo).toBe('2026-09-10');
    expect(left.daysEmployed).toBe(10);
    expect(left.paidDays).toBe(9.5);
    expect(left.gross).toBe(RS(9500));
    const notEmployed = calculateSalary(emp({ join_date: '2026-10-05' }), '2026-09', {});
    expect(notEmployed.daysEmployed).toBe(0);
    expect(notEmployed.gross).toBe(0);
  });

  it('daily wages: P + half of H + L are paid; W, A and unmarked are not', () => {
    const marks: Record<string, AttendanceStatus> = {};
    for (let d = 1; d <= 20; d++) marks[`2026-09-${String(d).padStart(2, '0')}`] = 'P';
    marks['2026-09-21'] = 'H';
    marks['2026-09-22'] = 'H';
    marks['2026-09-23'] = 'L';
    marks['2026-09-24'] = 'W';
    marks['2026-09-25'] = 'A';
    const c = calculateSalary(emp({ salary_type: 'daily', salary_amount: RS(500) }), '2026-09', marks);
    expect(c.paidDays).toBe(22);
    expect(c.gross).toBe(RS(11000));
    // odd paise: 333.33 x 1.5 = 499.995 -> 500.00
    const odd = calculateSalary(emp({ salary_type: 'daily', salary_amount: 33333 }), '2026-09', { '2026-09-01': 'P', '2026-09-02': 'H' });
    expect(odd.paidDays).toBe(1.5);
    expect(odd.gross).toBe(50000);
  });

  it('daily wages respect the joining date', () => {
    const c = calculateSalary(emp({ salary_type: 'daily', salary_amount: RS(600), join_date: '2026-09-15' }), '2026-09', {
      '2026-09-14': 'P',
      '2026-09-15': 'P',
      '2026-09-16': 'P',
    });
    expect(c.paidDays).toBe(2);
    expect(c.gross).toBe(RS(1200));
  });
});

/* ------------------------------ Employees ------------------------------ */

describe('employee records', () => {
  it('creates, lists, updates and validates employees', async () => {
    t = await createTestApp();
    const e = await addEmployee();
    expect(e).toMatchObject({ name: 'Ramesh Kumar', salaryType: 'monthly', salaryAmount: RS(15000), weeklyOff: 0, isActive: true, outstandingAdvance: 0, salaryDue: 0 });
    const list = await t.call('employees.list', {});
    expect(list).toHaveLength(1);
    expect(list[0].attendance.unmarked).toBe(28); // 1-28 Sep, nothing marked
    expect((await t.call('employees.search', { q: 'rame' }))[0].name).toBe('Ramesh Kumar');

    const dup = await t.fails('employees.create', { name: 'ramesh  kumar', salaryType: 'monthly', salaryAmount: 100 });
    expect(dup.message).toMatch(/already exists/);
    expect((await t.fails('employees.create', { name: '', salaryType: 'monthly', salaryAmount: 100 })).code).toBe('VALIDATION');
    expect((await t.fails('employees.create', { name: 'X', salaryType: 'weekly', salaryAmount: 100 })).code).toBe('VALIDATION');
    expect((await t.fails('employees.create', { name: 'X', salaryType: 'monthly', salaryAmount: -5 })).code).toBe('VALIDATION');
    expect((await t.fails('employees.create', { name: 'X', salaryType: 'monthly', salaryAmount: 100, phone: 'abc' })).code).toBe('VALIDATION');

    const u = await t.call('employees.update', {
      id: e.id,
      name: 'Ramesh K',
      designation: 'Senior helper',
      joinDate: '2026-04-01',
      salaryType: 'daily',
      salaryAmount: RS(600),
      weeklyOff: 1,
    });
    expect(u).toMatchObject({ name: 'Ramesh K', salaryType: 'daily', salaryAmount: RS(600), weeklyOff: 1, designation: 'Senior helper' });
    const log = t.app.db.get<{ summary: string }>("SELECT summary FROM activity_log WHERE action = 'employee.update'")!;
    expect(log.summary).toMatch(/renamed from "Ramesh Kumar"/);
    expect(log.summary).toMatch(/₹15,000.00 per month → ₹600.00 per day/);
    expect(activityCount('employee.create')).toBe(1);
  });

  it('records an opening advance against Opening Balance Adjustment', async () => {
    t = await createTestApp();
    const e = await addEmployee({ openingAdvance: RS(2000) });
    expect(e.outstandingAdvance).toBe(RS(2000));
    expect(e.openingAdvance).toBe(RS(2000));
    expect(systemBalance(t.app, 'EMP_ADV')).toBe(RS(2000));
    expect(systemBalance(t.app, 'OPENING_EQUITY')).toBe(-RS(2000));
    const entry = t.app.db.get<{ date: string; voucher_type: string }>('SELECT date, voucher_type FROM journal_entries WHERE id = (SELECT opening_entry_id FROM employees WHERE id = ?)', [e.id])!;
    expect(entry).toEqual({ date: '2026-04-01', voucher_type: 'opening' });

    const base = { id: e.id, name: 'Ramesh Kumar', salaryType: 'monthly' as const, salaryAmount: RS(15000), joinDate: '2026-04-01' };
    // change it
    await t.call('employees.update', { ...base, openingAdvance: RS(3000) });
    expect(advBalance(e.id)).toBe(RS(3000));
    // leaving openingAdvance out keeps it
    await t.call('employees.update', { ...base });
    expect(advBalance(e.id)).toBe(RS(3000));

    // recover 2,500 in August's salary; the opening advance can then not go below 2,500
    await t.call('salary.process', { employeeId: e.id, month: '2026-08', advanceRecovery: RS(2500) });
    expect(advBalance(e.id)).toBe(RS(500));
    const err = await t.fails('employees.update', { ...base, openingAdvance: RS(1000) });
    expect(err.message).toMatch(/already been recovered/);
    await t.call('employees.update', { ...base, openingAdvance: RS(2500) });
    expect(advBalance(e.id)).toBe(0);
    // removing it entirely is blocked too (would leave a negative advance)
    expect((await t.fails('employees.update', { ...base, openingAdvance: 0 })).message).toMatch(/recovered/);
  });

  it('marks an employee as left and back, cleaning up attendance after the last day', async () => {
    t = await createTestApp();
    const e = await addEmployee();
    await mark(e.id, ['2026-09-20', '2026-09-21', '2026-09-22'], 'P');
    await t.call('advances.create', { employeeId: e.id, amount: RS(1000), mode: 'cash' });
    const res = await t.call('employees.setActive', { id: e.id, active: false, leaveDate: '2026-09-20' });
    expect(res.employee).toMatchObject({ isActive: false, leaveDate: '2026-09-20' });
    expect(res.warnings.join(' ')).toMatch(/₹1,000.00 advance outstanding/);
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM attendance WHERE employee_id = ?', [e.id])).toBe(1);
    expect(await t.call('employees.list', {})).toHaveLength(0);
    expect(await t.call('employees.list', { includeInactive: true })).toHaveLength(1);
    // still on September's sheet (left during the month) but not on October's
    expect((await t.call('attendance.month', { month: '2026-09' })).employees.map((x) => x.id)).toEqual([e.id]);
    t.setToday('2026-10-05');
    expect((await t.call('attendance.month', { month: '2026-10' })).employees).toHaveLength(0);
    expect((await t.fails('advances.create', { employeeId: e.id, amount: RS(100), mode: 'cash' })).message).toMatch(/marked as left/);

    const back = await t.call('employees.setActive', { id: e.id, active: true });
    expect(back.employee).toMatchObject({ isActive: true, leaveDate: null });
    expect(activityCount('employee.leave')).toBe(1);
    expect(activityCount('employee.activate')).toBe(1);
  });

  it('rejects a leaving date that would strand a later salary slip or is in the future', async () => {
    t = await createTestApp();
    const e = await addEmployee();
    await t.call('salary.process', { employeeId: e.id, month: '2026-08' });
    expect((await t.fails('employees.setActive', { id: e.id, active: false, leaveDate: '2026-07-31' })).message).toMatch(/Aug(ust)? 2026/);
    expect((await t.fails('employees.setActive', { id: e.id, active: false, leaveDate: '2026-10-01' })).message).toMatch(/later than today/);
    expect((await t.fails('employees.setActive', { id: e.id, active: false, leaveDate: '2026-03-01' })).message).toMatch(/before the joining date/);
    expect((await t.fails('employees.update', { id: e.id, name: 'Ramesh Kumar', salaryType: 'monthly', salaryAmount: RS(15000), joinDate: '2026-09-01' })).message).toMatch(
      /August 2026/,
    );
  });
});

/* ------------------------------ Attendance ------------------------------ */

describe('attendance', () => {
  it('marks, changes and clears a day with an activity log', async () => {
    t = await createTestApp();
    const e = await addEmployee();
    await t.call('attendance.mark', { employeeId: e.id, date: '2026-09-10', status: 'P' });
    await t.call('attendance.mark', { employeeId: e.id, date: '2026-09-10', status: 'H', note: 'Left early' });
    let m = await t.call('attendance.month', { month: '2026-09' });
    expect(m.days).toHaveLength(30);
    expect(m.days[27]).toMatchObject({ date: '2026-09-28', isToday: true, future: false });
    expect(m.days[28].future).toBe(true);
    expect(m.employees[0].marks['2026-09-10']).toEqual({ status: 'H', note: 'Left early' });
    expect(m.employees[0].counts).toMatchObject({ H: 1, unmarked: 27 });
    await t.call('attendance.mark', { employeeId: e.id, date: '2026-09-10', status: null });
    m = await t.call('attendance.month', { month: '2026-09' });
    expect(m.employees[0].marks['2026-09-10']).toBeUndefined();
    expect(activityCount('attendance.mark')).toBe(2);
    expect(activityCount('attendance.clear')).toBe(1);
    const last = t.app.db.get<{ summary: string }>("SELECT summary FROM activity_log WHERE action = 'attendance.mark' ORDER BY id DESC LIMIT 1")!;
    expect(last.summary).toBe('Marked Ramesh Kumar Half day on 10-09-2026 (was Present): Left early');
  });

  it('rejects future dates and dates outside the employment period', async () => {
    t = await createTestApp();
    const e = await addEmployee({ joinDate: '2026-09-15' });
    expect((await t.fails('attendance.mark', { employeeId: e.id, date: '2026-09-29', status: 'P' })).message).toMatch(/future/);
    expect((await t.fails('attendance.mark', { employeeId: e.id, date: '2026-09-14', status: 'P' })).message).toMatch(/joined on 15-09-2026/);
    expect((await t.fails('attendance.mark', { employeeId: e.id, date: '2026-09-15', status: 'X' })).code).toBe('VALIDATION');
    await t.call('attendance.mark', { employeeId: e.id, date: '2026-09-15', status: 'P' });
    await t.call('employees.setActive', { id: e.id, active: false, leaveDate: '2026-09-20' });
    expect((await t.fails('attendance.mark', { employeeId: e.id, date: '2026-09-21', status: 'P' })).message).toMatch(/left on 20-09-2026/);
    // an employee who joined later is not on an earlier month's sheet
    await addEmployee({ name: 'Suresh', joinDate: '2026-10-01' });
    expect((await t.call('attendance.month', { month: '2026-09' })).employees.map((x) => x.name)).toEqual(['Ramesh Kumar']);
    expect((await t.fails('attendance.month', { month: '2026-13' })).code).toBe('VALIDATION');
  });

  it('marks everyone present (weekly offs as W) and fills weekly offs', async () => {
    t = await createTestApp();
    const a = await addEmployee({ name: 'A', weeklyOff: 1 }); // Monday off: 28-09-2026 is a Monday
    const b = await addEmployee({ name: 'B', weeklyOff: 0 });
    const c = await addEmployee({ name: 'C', weeklyOff: null });
    await t.call('attendance.mark', { employeeId: c.id, date: '2026-09-28', status: 'A' });
    const res = await t.call('attendance.markAll', { date: '2026-09-28' });
    expect(res).toMatchObject({ marked: 1, weeklyOff: 1, alreadyMarked: 1, locked: 0 });
    const m = await t.call('attendance.month', { month: '2026-09' });
    const byName = Object.fromEntries(m.employees.map((x) => [x.name, x.marks['2026-09-28']?.status]));
    expect(byName).toEqual({ A: 'W', B: 'P', C: 'A' });
    expect((await t.fails('attendance.markAll', { date: '2026-09-29' })).message).toMatch(/future/);

    const fill = await t.call('attendance.fillWeeklyOff', { month: '2026-09' });
    // Sundays up to 28 Sep: 6, 13, 20, 27 for B; Mondays 7, 14, 21 (28 already W) for A
    expect(fill).toMatchObject({ filled: 7, employees: 2 });
    const again = await t.call('attendance.fillWeeklyOff', { month: '2026-09' });
    expect(again.filled).toBe(0);
    expect(activityCount('attendance.markAll')).toBe(1);
    expect(activityCount('attendance.weeklyOff')).toBe(1);
    void a;
    void b;
  });

  it('locks attendance once the month salary is processed', async () => {
    t = await createTestApp();
    const e = await addEmployee();
    const slip = await t.call('salary.process', { employeeId: e.id, month: '2026-08' });
    const err = await t.fails('attendance.mark', { employeeId: e.id, date: '2026-08-10', status: 'A' });
    expect(err.message).toMatch(new RegExp(`already processed.*${slip.salaryNo.replace(/\//g, '\\/')}`));
    const m = await t.call('attendance.month', { month: '2026-08' });
    expect(m.employees[0].lockedBy).toEqual({ salaryId: slip.id, salaryNo: slip.salaryNo });
    expect((await t.call('attendance.markAll', { date: '2026-08-10' })).locked).toBe(1);
    await t.call('salary.cancel', { salaryId: slip.id, reason: 'Recalculate' });
    await t.call('attendance.mark', { employeeId: e.id, date: '2026-08-10', status: 'A' });
  });
});

/* ------------------------------ Salary ------------------------------ */

describe('salary slips', () => {
  it('previews with the rule in plain words and the suggested recovery', async () => {
    t = await createTestApp();
    const e = await addEmployee();
    await mark(e.id, ['2026-09-01', '2026-09-02'], 'A');
    await mark(e.id, ['2026-09-03'], 'H');
    await t.call('advances.create', { employeeId: e.id, amount: RS(20000), mode: 'cash' });
    const p = await t.call('salary.preview', { employeeId: e.id, month: '2026-09' });
    expect(p).toMatchObject({ daysInMonth: 30, daysEmployed: 30, paidDays: 27.5, gross: RS(13750), outstandingAdvance: RS(20000), suggestedRecovery: RS(13750), problem: null });
    expect(p.defaultDate).toBe('2026-09-28'); // month still running
    expect(p.rule).toMatch(/except absent days/);
    expect(p.working).toBe('₹15,000.00 × 27.5 paid days ÷ 30 days in the month = ₹13,750.00');
    const aug = await t.call('salary.preview', { employeeId: e.id, month: '2026-08' });
    expect(aug.defaultDate).toBe('2026-08-31');
    expect((await t.call('salary.preview', { employeeId: e.id, month: '2026-10' })).problem).toMatch(/not started/);
    expect((await t.call('salary.preview', { employeeId: e.id, month: '2026-03' })).problem).toMatch(/before your books start/);
  });

  it('processes a slip without payment: Dr Salaries, Cr Salary Payable', async () => {
    t = await createTestApp({ openingCash: RS(100000) });
    const e = await addEmployee();
    await mark(e.id, ['2026-08-05'], 'A');
    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-08', bonus: RS(500), deductions: RS(200), remarks: 'Diwali advance bonus' });
    // August: 31 days, 1 absent -> 15,000 x 30 / 31 = 14,516.13
    expect(s).toMatchObject({ month: '2026-08', date: '2026-08-31', paidDays: 30, gross: 1451613, bonus: RS(500), deductions: RS(200), advanceRecovery: 0, status: 'unpaid', paid: 0 });
    expect(s.net).toBe(1451613 + RS(300));
    expect(s.salaryNo).toBe('SAL/26-27/0001');
    expect(s.counts).toMatchObject({ A: 1, unmarked: 30 });
    expect(systemBalance(t.app, 'SALARY')).toBe(s.net);
    expect(systemBalance(t.app, 'SALARY_PAYABLE')).toBe(-s.net);
    expect(systemBalance(t.app, 'CASH')).toBe(RS(100000));
    expect(payableBalance(e.id)).toBe(-s.net);
    const entry = t.app.db.get<any>("SELECT * FROM journal_entries WHERE source_type = 'salary' AND source_id = ?", [s.id]);
    expect(entry).toMatchObject({ voucher_type: 'salary', voucher_no: s.salaryNo, date: '2026-08-31', is_void: 0 });
    expect(s.posting.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['Salaries & Wages', s.net, 0],
      ['Salary Payable', 0, s.net],
    ]);
    const list = await t.call('employees.list', {});
    expect(list[0].salaryDue).toBe(s.net);
    const revs = t.app.db.all<any>("SELECT action FROM document_revisions WHERE doc_type = 'salary' AND doc_id = ?", [s.id]);
    expect(revs.map((r) => r.action)).toEqual(['created']);
    expect(activityCount('salary.process')).toBe(1);
  });

  it('processes with pay-now and records the payment as its own voucher', async () => {
    t = await createTestApp({ openingCash: RS(100000) });
    const e = await addEmployee();
    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-08', payNow: { mode: 'cash', amount: RS(15000) } });
    expect(s).toMatchObject({ net: RS(15000), paid: RS(15000), balance: 0, status: 'paid' });
    expect(s.payments).toHaveLength(1);
    const pay = t.app.db.get<any>('SELECT * FROM salary_payments WHERE salary_id = ?', [s.id]);
    const entry = t.app.db.get<any>("SELECT * FROM journal_entries WHERE source_type = 'salary_payment' AND source_id = ?", [pay.id]);
    expect(entry).toMatchObject({ voucher_type: 'salary_payment', date: '2026-08-31' });
    expect(systemBalance(t.app, 'CASH')).toBe(RS(85000));
    expect(systemBalance(t.app, 'SALARY_PAYABLE')).toBe(0);
    expect(systemBalance(t.app, 'SALARY')).toBe(RS(15000));

    const e2 = await addEmployee({ name: 'Suresh', salaryType: 'daily', salaryAmount: RS(500) });
    await mark(e2.id, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'], 'P');
    const s2 = await t.call('salary.process', { employeeId: e2.id, month: '2026-09', payNow: { mode: 'upi', amount: RS(1500) } });
    expect(s2).toMatchObject({ gross: RS(2000), net: RS(2000), paid: RS(1500), status: 'partly_paid', balance: RS(500) });
    expect(systemBalance(t.app, 'UPI')).toBe(-RS(1500));
    expect((await t.fails('salary.process', { employeeId: e2.id, month: '2026-08', payNow: { mode: 'cash', amount: RS(1) } })).message).toMatch(/nothing to record/);
  });

  it('takes partial payments up to the balance', async () => {
    t = await createTestApp({ openingCash: RS(100000) });
    const e = await addEmployee();
    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-08' });
    const p1 = await t.call('salary.pay', { salaryId: s.id, amount: RS(5000), mode: 'cash', date: '2026-09-01' });
    expect(p1).toMatchObject({ paid: RS(5000), balance: RS(10000), status: 'partly_paid' });
    expect((await t.fails('salary.pay', { salaryId: s.id, amount: RS(10001), mode: 'cash' })).message).toMatch(/Only ₹10,000.00 is left/);
    expect((await t.fails('salary.pay', { salaryId: s.id, amount: RS(100), mode: 'cash', date: '2026-08-30' })).message).toMatch(/before the salary slip/);
    expect((await t.fails('salary.pay', { salaryId: s.id, amount: RS(100), mode: 'cash', date: '2026-09-29' })).message).toMatch(/later than today/);
    expect((await t.fails('salary.pay', { salaryId: s.id, amount: 0, mode: 'cash' })).code).toBe('VALIDATION');
    const p2 = await t.call('salary.pay', { salaryId: s.id, amount: RS(10000), mode: 'bank', remarks: 'NEFT' });
    expect(p2).toMatchObject({ paid: RS(15000), balance: 0, status: 'paid' });
    expect((await t.fails('salary.pay', { salaryId: s.id, amount: RS(1), mode: 'cash' })).message).toMatch(/fully paid/);
    expect(systemBalance(t.app, 'CASH')).toBe(RS(95000));
    expect(systemBalance(t.app, 'BANK')).toBe(-RS(10000));
    expect(payableBalance(e.id)).toBe(0);

    // cancel one payment: it comes back as due
    const toCancel = p2.payments.find((p) => p.mode === 'bank')!;
    const after = await t.call('salary.cancelPayment', { paymentId: toCancel.id, reason: 'Entered twice' });
    expect(after).toMatchObject({ paid: RS(5000), balance: RS(10000), status: 'partly_paid' });
    expect(systemBalance(t.app, 'BANK')).toBe(0);
    expect(payableBalance(e.id)).toBe(-RS(10000));
    expect(after.revisions.map((r) => r.action)).toEqual(['created', 'edited', 'edited', 'edited']);
    expect(after.revisions[3].reason).toMatch(/Entered twice/);
    expect(activityCount('salary.pay')).toBe(2);
    expect(activityCount('salary.paymentCancel')).toBe(1);
  });

  it('recovers advances up to the outstanding amount', async () => {
    t = await createTestApp({ openingCash: RS(100000) });
    const e = await addEmployee();
    const adv = await t.call('advances.create', { employeeId: e.id, amount: RS(5000), mode: 'cash', date: '2026-08-10', remarks: 'Medical' });
    expect(adv).toMatchObject({ advanceNo: 'ADV/26-27/0001', amount: RS(5000), currentAdvance: RS(5000) });
    expect(systemBalance(t.app, 'EMP_ADV')).toBe(RS(5000));
    expect(systemBalance(t.app, 'CASH')).toBe(RS(95000));
    const tooMuch = await t.fails('salary.process', { employeeId: e.id, month: '2026-08', advanceRecovery: RS(5001) });
    expect(tooMuch.message).toMatch(/Only ₹5,000.00 advance is outstanding/);
    expect(tooMuch.fields?.advanceRecovery).toBeTruthy();
    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-08', advanceRecovery: RS(3000) });
    expect(s).toMatchObject({ gross: RS(15000), advanceRecovery: RS(3000), net: RS(12000) });
    expect(s.posting.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['Salaries & Wages', RS(15000), 0],
      ['Employee Advances', 0, RS(3000)],
      ['Salary Payable', 0, RS(12000)],
    ]);
    expect(systemBalance(t.app, 'SALARY')).toBe(RS(15000));
    expect(advBalance(e.id)).toBe(RS(2000));
    expect(payableBalance(e.id)).toBe(-RS(12000));

    // deductions + recovery cannot exceed what was earned
    const e2 = await addEmployee({ name: 'Suresh', salaryType: 'daily', salaryAmount: RS(500) });
    await t.call('advances.create', { employeeId: e2.id, amount: RS(5000), mode: 'cash' });
    await mark(e2.id, ['2026-09-01', '2026-09-02'], 'P');
    expect((await t.fails('salary.process', { employeeId: e2.id, month: '2026-09', deductions: RS(600), advanceRecovery: RS(500) })).message).toMatch(/cannot be more than the salary earned/);
    expect((await t.fails('salary.process', { employeeId: e2.id, month: '2026-09', deductions: RS(1001) })).message).toMatch(/Deductions/);
    // whole salary goes to the advance: net 0, nothing to pay
    const s2 = await t.call('salary.process', { employeeId: e2.id, month: '2026-09', advanceRecovery: RS(1000) });
    expect(s2).toMatchObject({ net: 0, status: 'paid' });
    expect(advBalance(e2.id)).toBe(RS(4000));
  });

  it('cancelling a slip voids the slip and all its payments; the month can then be processed again', async () => {
    t = await createTestApp({ openingCash: RS(100000) });
    const e = await addEmployee();
    await t.call('advances.create', { employeeId: e.id, amount: RS(4000), mode: 'cash', date: '2026-08-01' });
    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-08', advanceRecovery: RS(4000), payNow: { mode: 'cash', amount: RS(6000) } });
    await t.call('salary.pay', { salaryId: s.id, amount: RS(5000), mode: 'upi' });
    expect(advBalance(e.id)).toBe(0);
    expect(systemBalance(t.app, 'CASH')).toBe(RS(90000));

    const dup = await t.fails('salary.process', { employeeId: e.id, month: '2026-08' });
    expect(dup.code).toBe('CONFLICT');
    expect(dup.message).toMatch(/already processed/);
    // the advance cannot be cancelled while its recovery stands
    const advId = t.app.db.value<number>('SELECT id FROM employee_advances');
    expect((await t.fails('advances.cancel', { id: advId, reason: 'x' })).message).toMatch(/already been recovered/);

    expect((await t.fails('salary.cancel', { salaryId: s.id, reason: '  ' })).code).toBe('VALIDATION');
    const c = await t.call('salary.cancel', { salaryId: s.id, reason: 'Wrong bonus' });
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Wrong bonus', balance: 0, paid: 0 });
    expect(c.payments.every((p) => p.status === 'cancelled')).toBe(true);
    const entries = t.app.db.all<any>(
      "SELECT is_void FROM journal_entries WHERE (source_type = 'salary' AND source_id = ?) OR (source_type = 'salary_payment' AND source_id IN (SELECT id FROM salary_payments WHERE salary_id = ?))",
      [s.id, s.id],
    );
    expect(entries).toHaveLength(3);
    expect(entries.every((x) => x.is_void === 1)).toBe(true);
    expect(systemBalance(t.app, 'SALARY')).toBe(0);
    expect(systemBalance(t.app, 'SALARY_PAYABLE')).toBe(0);
    expect(systemBalance(t.app, 'CASH')).toBe(RS(96000));
    expect(systemBalance(t.app, 'UPI')).toBe(0);
    expect(advBalance(e.id)).toBe(RS(4000));
    expect(c.revisions.map((r) => r.action)).toEqual(['created', 'edited', 'cancelled']);
    expect(c.revisions[2].reason).toBe('Wrong bonus');
    expect(activityCount('salary.cancel')).toBe(1);
    expect((await t.fails('salary.cancel', { salaryId: s.id, reason: 'again' })).message).toMatch(/already cancelled/);
    expect((await t.fails('salary.pay', { salaryId: s.id, amount: RS(1), mode: 'cash' })).message).toMatch(/cancelled/);

    const again = await t.call('salary.process', { employeeId: e.id, month: '2026-08' });
    expect(again.salaryNo).toBe('SAL/26-27/0002');
    expect(again.status).toBe('unpaid');
    // now the advance can be cancelled
    await t.call('advances.cancel', { id: advId, reason: 'Given by mistake' });
    expect(advBalance(e.id)).toBe(0);
    expect(systemBalance(t.app, 'CASH')).toBe(RS(100000));
  });

  it('validates month, date and employment when processing', async () => {
    t = await createTestApp();
    const e = await addEmployee({ joinDate: '2026-09-10' });
    expect((await t.fails('salary.process', { employeeId: e.id, month: '2026-10' })).message).toMatch(/not started/);
    expect((await t.fails('salary.process', { employeeId: e.id, month: '2026-08' })).message).toMatch(/did not work here/);
    expect((await t.fails('salary.process', { employeeId: e.id, month: '2026-09', date: '2026-08-31' })).message).toMatch(/before the month starts/);
    expect((await t.fails('salary.process', { employeeId: e.id, month: '2026-09', date: '2026-09-29' })).message).toMatch(/later than today/);
    expect((await t.fails('salary.process', { employeeId: e.id, month: '2026-9' })).code).toBe('VALIDATION');
    expect((await t.fails('salary.process', { employeeId: 999, month: '2026-09' })).code).toBe('NOT_FOUND');
    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-09', date: '2026-09-28' });
    // joined 10 Sep: 21 of 30 days
    expect(s).toMatchObject({ daysEmployed: 21, paidDays: 21, gross: RS(10500) });
  });

  it('builds the month sheet and processes everyone remaining in one go', async () => {
    t = await createTestApp({ openingCash: RS(200000) });
    const a = await addEmployee({ name: 'Anil' });
    const b = await addEmployee({ name: 'Bala', salaryType: 'daily', salaryAmount: RS(600) });
    const c = await addEmployee({ name: 'Chetan', salaryAmount: RS(12000) });
    await addEmployee({ name: 'Dinesh', joinDate: '2026-09-01' });
    // given in August, so August's salary (dated 31-08) can recover it
    await t.call('advances.create', { employeeId: c.id, amount: RS(3000), mode: 'cash', date: '2026-08-05' });
    await mark(b.id, ['2026-08-03', '2026-08-04', '2026-08-05'], 'P');
    await t.call('salary.process', { employeeId: a.id, month: '2026-08' });
    const sheet = await t.call('salary.monthSheet', { month: '2026-08' });
    expect(sheet.rows.map((r) => r.employeeName)).toEqual(['Anil', 'Bala', 'Chetan']);
    expect(sheet.totals).toMatchObject({ employees: 3, processed: 1, pending: 2 });
    const chetan = sheet.rows.find((r) => r.employeeName === 'Chetan')!;
    expect(chetan).toMatchObject({ gross: RS(12000), outstandingAdvance: RS(3000), suggestedRecovery: RS(3000), slip: null, problem: null });
    expect(sheet.rows[0].slip).toMatchObject({ status: 'unpaid', net: RS(15000) });

    // Chetan has no attendance marked: confirmed to be paid for the full month
    const res = await t.call('salary.processAll', { month: '2026-08', recoverAdvances: true, includeUnmarked: true, payNow: { mode: 'cash' } });
    expect(res.processed.map((p) => p.name)).toEqual(['Bala', 'Chetan']);
    expect(res.skipped).toEqual([]);
    expect(res.totalNet).toBe(RS(1800) + RS(9000));
    expect(res.totalPaid).toBe(res.totalNet);
    expect(advBalance(c.id)).toBe(0);
    expect(systemBalance(t.app, 'CASH')).toBe(RS(200000) - RS(3000) - res.totalPaid);
    const after = await t.call('salary.monthSheet', { month: '2026-08' });
    expect(after.totals).toMatchObject({ processed: 3, pending: 0, due: RS(15000) });
    expect(activityCount('salary.processAll')).toBe(1);

    // a month where someone earned nothing: skipped with the reason
    await mark(b.id, [], 'P');
    const sep = await t.call('salary.processAll', { month: '2026-09', recoverAdvances: false, includeUnmarked: true });
    expect(sep.skipped.map((s) => s.name)).toEqual(['Bala']);
    expect(sep.skipped[0].reason).toMatch(/No salary is earned/);
    expect(sep.processed.map((p) => p.name)).toEqual(['Anil', 'Chetan', 'Dinesh']);

    const list = await t.call('salary.list', { month: '2026-08' });
    expect(list.rows).toHaveLength(3);
    expect(list.totals).toMatchObject({ count: 3, due: RS(15000) });
    expect((await t.call('salary.list', { status: 'due' })).rows.length).toBe(4);
    expect((await t.call('salary.list', { employeeId: a.id })).rows.map((r) => r.month)).toEqual(['2026-09', '2026-08']);
  });

  it('prints a thermal salary slip', async () => {
    t = await createTestApp();
    const e = await addEmployee();
    await mark(e.id, ['2026-08-05'], 'A');
    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-08', bonus: RS(1000), payNow: { mode: 'cash', amount: RS(5000) } });
    const { html } = await t.call('salary.slipHtml', { id: s.id });
    expect(html).toContain('SALARY SLIP');
    expect(html).toContain('Ramesh Kumar');
    expect(html).toContain('Helper');
    expect(html).toContain('August 2026');
    expect(html).toContain('Paid days');
    expect(html).toContain(s.salaryNo);
    expect(html).toContain('Employee signature');
    expect(html).toContain('Balance due');
    const res = await t.call('salary.print', { id: s.id });
    expect(res.printed).toBe(true);
    expect(t.platform.printed).toHaveLength(1);
    expect(t.platform.printed[0].opts.paperWidthMm).toBe(80);
    expect(activityCount('salary.print')).toBe(1);
    await t.call('salary.cancel', { salaryId: s.id, reason: 'Test' });
    expect((await t.call('salary.slipHtml', { id: s.id })).html).toContain('CANCELLED');
  });
});

describe('salary edge cases', () => {
  it('pays the final salary of an employee who left mid-month', async () => {
    t = await createTestApp({ openingCash: RS(50000) });
    const e = await addEmployee();
    await mark(e.id, ['2026-09-02'], 'A');
    await t.call('employees.setActive', { id: e.id, active: false, leaveDate: '2026-09-10' });
    const sheet = await t.call('salary.monthSheet', { month: '2026-09' });
    expect(sheet.rows.map((r) => r.employeeName)).toEqual(['Ramesh Kumar']);
    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-09', payNow: { mode: 'cash', amount: RS(4500) } });
    // 10 days employed, 1 absent -> 9 / 30 of 15,000
    expect(s).toMatchObject({ daysEmployed: 10, paidDays: 9, gross: RS(4500), status: 'paid', employedTo: '2026-09-10' });
    // not on October's sheet
    t.setToday('2026-10-05');
    expect((await t.call('salary.monthSheet', { month: '2026-10' })).rows).toHaveLength(0);
  });

  it('records a bonus even when no salary was earned', async () => {
    t = await createTestApp();
    const e = await addEmployee({ salaryType: 'daily', salaryAmount: RS(500) });
    const p = await t.call('salary.preview', { employeeId: e.id, month: '2026-08' });
    expect(p).toMatchObject({ gross: 0, problemKind: 'zero' });
    expect((await t.fails('salary.process', { employeeId: e.id, month: '2026-08' })).message).toMatch(/nothing to record/);
    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-08', bonus: RS(1000), remarks: 'Festival bonus' });
    expect(s).toMatchObject({ gross: 0, bonus: RS(1000), net: RS(1000), remarks: 'Festival bonus' });
    expect(systemBalance(t.app, 'SALARY')).toBe(RS(1000));
  });

  it('keeps a full snapshot (with payments) in every revision', async () => {
    t = await createTestApp({ openingCash: RS(50000) });
    const e = await addEmployee();
    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-08', payNow: { mode: 'cash', amount: RS(5000) } });
    await t.call('salary.pay', { salaryId: s.id, amount: RS(2000), mode: 'upi' });
    const revs = t.app.db.all<{ action: string; snapshot: string; reason: string | null; username: string }>(
      "SELECT action, snapshot, reason, username FROM document_revisions WHERE doc_type = 'salary' AND doc_id = ? ORDER BY revision",
      [s.id],
    );
    expect(revs.map((r) => r.action)).toEqual(['created', 'edited']);
    const first = JSON.parse(revs[0].snapshot);
    expect(first).toMatchObject({ salaryNo: s.salaryNo, net: RS(15000), paid: RS(5000), status: 'partly_paid' });
    expect(first.payments).toHaveLength(1);
    const second = JSON.parse(revs[1].snapshot);
    expect(second).toMatchObject({ paid: RS(7000) });
    expect(second.payments).toHaveLength(2);
    expect(revs[1].reason).toMatch(/Paid ₹2,000.00 by UPI/);
    expect(revs[1].username).toBe('owner');
    const log = t.app.db.all<{ entity_type: string; entity_id: number }>("SELECT entity_type, entity_id FROM activity_log WHERE action LIKE 'salary.%'");
    expect(log.every((l) => l.entity_type === 'salary' && l.entity_id === s.id)).toBe(true);
  });

  it('refuses to post into a closed financial year', async () => {
    t = await createTestApp({ booksStart: '2025-04-01', today: '2026-05-10', openingCash: RS(50000) });
    const e = await addEmployee({ joinDate: '2025-04-01' });
    const march = await t.call('salary.process', { employeeId: e.id, month: '2026-03' });
    const adv = await t.call('advances.create', { employeeId: e.id, amount: RS(1000), mode: 'cash', date: '2026-03-15' });
    t.app.db.run("UPDATE financial_years SET is_closed = 1 WHERE start_date = '2025-04-01'");
    expect((await t.fails('salary.cancel', { salaryId: march.id, reason: 'x' })).code).toBe('PERIOD_CLOSED');
    expect((await t.fails('salary.pay', { salaryId: march.id, amount: RS(100), mode: 'cash', date: '2026-03-31' })).code).toBe('PERIOD_CLOSED');
    expect((await t.fails('advances.cancel', { id: adv.id, reason: 'x' })).code).toBe('PERIOD_CLOSED');
    expect((await t.fails('salary.process', { employeeId: e.id, month: '2026-02' })).code).toBe('PERIOD_CLOSED');
    // paying last year's salary this year is fine
    const paid = await t.call('salary.pay', { salaryId: march.id, amount: RS(15000), mode: 'cash', date: '2026-04-05' });
    expect(paid.status).toBe('paid');
    // and nothing was half-written by the failed calls
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM salaries WHERE month = '2026-02'")).toBe(0);
  });

  it('cleans up attendance before a changed joining date', async () => {
    t = await createTestApp();
    const e = await addEmployee({ joinDate: '2026-09-01' });
    await mark(e.id, ['2026-09-01', '2026-09-02', '2026-09-10'], 'P');
    await t.call('employees.update', { id: e.id, name: 'Ramesh Kumar', salaryType: 'monthly', salaryAmount: RS(15000), joinDate: '2026-09-05' });
    const m = await t.call('attendance.month', { month: '2026-09' });
    expect(Object.keys(m.employees[0].marks)).toEqual(['2026-09-10']);
    const log = t.app.db.get<{ summary: string }>("SELECT summary FROM activity_log WHERE action = 'employee.update'")!;
    expect(log.summary).toMatch(/removed 2 attendance marks before the joining date/);
    expect((await t.fails('employees.update', { id: e.id, name: 'Ramesh Kumar', salaryType: 'monthly', salaryAmount: 1, joinDate: '2026-02-30' })).code).toBe('VALIDATION');
  });
});

/* ------------------------------ Advances & ledger ------------------------------ */

describe('advances and employee ledger', () => {
  it('lists and cancels advances', async () => {
    t = await createTestApp({ openingCash: RS(50000) });
    const e = await addEmployee();
    const a1 = await t.call('advances.create', { employeeId: e.id, amount: RS(1000), mode: 'cash', date: '2026-09-01' });
    await t.call('advances.create', { employeeId: e.id, amount: RS(2000), mode: 'upi', date: '2026-09-15' });
    expect((await t.fails('advances.create', { employeeId: e.id, amount: RS(100), mode: 'cash', date: '2026-09-30' })).message).toMatch(/later than today/);
    expect((await t.fails('advances.create', { employeeId: e.id, amount: 0, mode: 'cash' })).code).toBe('VALIDATION');
    expect((await t.fails('advances.create', { employeeId: e.id, amount: RS(100), mode: 'credit' })).code).toBe('VALIDATION');
    let list = await t.call('advances.list', { from: '2026-09-01', to: '2026-09-30' });
    expect(list.rows.map((r) => r.advanceNo)).toEqual(['ADV/26-27/0002', 'ADV/26-27/0001']);
    expect(list.totals).toMatchObject({ count: 2, amount: RS(3000), byMode: { cash: RS(1000), upi: RS(2000), bank: 0 } });
    const c = await t.call('advances.cancel', { id: a1.id, reason: 'Returned' });
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Returned', currentAdvance: RS(2000) });
    expect(c.revisions.map((r) => r.action)).toEqual(['created', 'cancelled']);
    expect(systemBalance(t.app, 'CASH')).toBe(RS(50000));
    list = await t.call('advances.list', { employeeId: e.id });
    expect(list.totals).toMatchObject({ count: 1, amount: RS(2000), cancelled: 1 });
    expect((await t.fails('advances.cancel', { id: a1.id, reason: 'again' })).message).toMatch(/already cancelled/);
    expect(activityCount('advance.create')).toBe(2);
    expect(activityCount('advance.cancel')).toBe(1);
  });

  it('shows advances, recoveries, salary earned and paid with running balances', async () => {
    t = await createTestApp({ openingCash: RS(100000) });
    const e = await addEmployee({ openingAdvance: RS(1000) });
    await t.call('advances.create', { employeeId: e.id, amount: RS(4000), mode: 'cash', date: '2026-07-10' });
    const jul = await t.call('salary.process', { employeeId: e.id, month: '2026-07', advanceRecovery: RS(2000) });
    await t.call('salary.pay', { salaryId: jul.id, amount: RS(10000), mode: 'cash', date: '2026-08-02' });
    await t.call('salary.process', { employeeId: e.id, month: '2026-08', advanceRecovery: RS(1000), payNow: { mode: 'upi', amount: RS(14000) } });

    const full = await t.call('employees.ledger', { employeeId: e.id, from: '2026-04-01', to: '2026-09-28' });
    const cells = full.rows.map((r) => r.cells);
    expect(cells[0]).toMatchObject({ particulars: 'Balance brought forward', advBalance: 0, due: 0 });
    const body = cells.slice(1, -1);
    expect(body.map((c) => String(c.particulars).split(':')[0])).toEqual(['Opening balance', 'Advance', 'Salary slip', 'Salary paid', 'Salary slip', 'Salary paid']);
    expect(body[2].particulars).toBe('Salary slip: July 2026 · 31 paid days · gross ₹15,000.00');
    expect(body[2].number).toBe(jul.salaryNo);
    expect(body.map((c) => c.advBalance)).toEqual([RS(1000), RS(5000), RS(3000), RS(3000), RS(2000), RS(2000)]);
    expect(body.map((c) => c.due)).toEqual([0, 0, RS(13000), RS(3000), RS(17000), RS(3000)]);
    expect(cells[cells.length - 1]).toMatchObject({ given: RS(5000), recovered: RS(3000), advBalance: RS(2000), earned: RS(27000), paid: RS(24000), due: RS(3000) });
    expect(full.rows[2].link).toMatchObject({ kind: 'advance' });
    expect(full.rows[3].link).toEqual({ kind: 'salary', id: jul.id });
    expect(full.rows[4].link).toEqual({ kind: 'salary', id: jul.id });

    // a later window starts from the brought-forward balances
    const aug = await t.call('employees.ledger', { employeeId: e.id, from: '2026-08-01', to: '2026-08-31' });
    expect(aug.rows[0].cells).toMatchObject({ advBalance: RS(3000), due: RS(13000) });
    expect(aug.rows[aug.rows.length - 1].cells).toMatchObject({ advBalance: RS(2000), due: RS(3000) });
    expect(aug.summary?.find((s) => s.label === 'Advance outstanding')?.value).toBe(RS(2000));
    // agrees with the ledger
    expect(advBalance(e.id)).toBe(RS(2000));
    expect(payableBalance(e.id)).toBe(-RS(3000));
    const detail = await t.call('employees.get', { id: e.id });
    expect(detail).toMatchObject({ outstandingAdvance: RS(2000), salaryDue: RS(3000), openingAdvance: RS(1000) });
    // salary earned (gross) this year; the net after advance recovery separately
    expect(detail.totals).toMatchObject({ slips: 2, salaryThisFy: RS(30000), netThisFy: RS(27000), recoveredThisFy: RS(3000), advancesThisFy: RS(4000), lastSalaryMonth: '2026-08' });
  });
});

/* ------------------------------ Advance recovery by date ------------------------------ */

/** Lowest Employee Advances balance of an employee on any day (the account must never go negative). */
function lowestAdvanceBalance(id: number): number {
  const rows = t.app.db.all<{ date: string; amt: number }>(
    `SELECT e.date, SUM(l.debit - l.credit) AS amt FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.is_void = 0 AND l.party_type = 'employee' AND l.party_id = ? AND l.account_id = (SELECT id FROM accounts WHERE system_key = 'EMP_ADV')
      GROUP BY e.date ORDER BY e.date`,
    [id],
  );
  let bal = 0;
  let low = 0;
  for (const r of rows) {
    bal += r.amt;
    low = Math.min(low, bal);
  }
  return low;
}

describe('advance recovery is limited to the advance outstanding on the slip date', () => {
  it('does not recover, in a month-end slip, an advance given after that month', async () => {
    t = await createTestApp({ openingCash: RS(100000) });
    const e = await addEmployee({ name: 'Pooja Shinde' });
    await t.call('advances.create', { employeeId: e.id, amount: RS(3000), mode: 'cash', date: '2026-09-08' });

    // August salary processed in September: dated 31-08, before the advance existed
    const p = await t.call('salary.preview', { employeeId: e.id, month: '2026-08' });
    expect(p).toMatchObject({ date: '2026-08-31', outstandingAdvance: RS(3000), recoverableAdvance: 0, suggestedRecovery: 0 });
    // dated after the advance, it can be recovered
    const later = await t.call('salary.preview', { employeeId: e.id, month: '2026-08', date: '2026-09-10' });
    expect(later).toMatchObject({ date: '2026-09-10', recoverableAdvance: RS(3000), suggestedRecovery: RS(3000) });

    const sheet = await t.call('salary.monthSheet', { month: '2026-08' });
    expect(sheet.rows[0]).toMatchObject({ outstandingAdvance: RS(3000), recoverableAdvance: 0, suggestedRecovery: 0 });
    expect((await t.call('salary.monthSheet', { month: '2026-08', date: '2026-09-10' })).rows[0].suggestedRecovery).toBe(RS(3000));

    const err = await t.fails('salary.process', { employeeId: e.id, month: '2026-08', advanceRecovery: RS(3000) });
    expect(err.message).toMatch(/given after 31-08-2026/);
    expect(err.fields?.advanceRecovery).toBe('At most ₹0.00');

    const res = await t.call('salary.processAll', { month: '2026-08', recoverAdvances: true, includeUnmarked: true });
    expect(res.processed).toHaveLength(1);
    const slip = await t.call('salary.get', { id: res.processed[0].salaryId });
    expect(slip).toMatchObject({ date: '2026-08-31', advanceRecovery: 0, net: RS(15000) });
    expect(partyBalance(t.app.ctx(), 'employee', e.id, { account: 'EMP_ADV', to: '2026-08-31' })).toBe(0);
    expect(lowestAdvanceBalance(e.id)).toBe(0);
    const bs = await t.call('reports.balanceSheet', { asOf: '2026-08-31' });
    expect(JSON.stringify(bs)).not.toMatch(/-300000/);
  });

  it('recovers up to the advance outstanding on the date, and a later-dated slip can take the rest', async () => {
    t = await createTestApp({ openingCash: RS(100000) });
    const e = await addEmployee();
    await t.call('advances.create', { employeeId: e.id, amount: RS(2000), mode: 'cash', date: '2026-08-20' });
    await t.call('advances.create', { employeeId: e.id, amount: RS(3000), mode: 'cash', date: '2026-09-08' });
    const err = await t.fails('salary.process', { employeeId: e.id, month: '2026-08', advanceRecovery: RS(2500) });
    expect(err.message).toMatch(/Only ₹2,000.00 .* outstanding on 31-08-2026/);
    const aug = await t.call('salary.process', { employeeId: e.id, month: '2026-08', advanceRecovery: RS(2000) });
    expect(aug.advanceRecovery).toBe(RS(2000));
    // the same salary dated after the second advance could have recovered both
    const sep = await t.call('salary.preview', { employeeId: e.id, month: '2026-09' });
    expect(sep).toMatchObject({ outstandingAdvance: RS(3000), recoverableAdvance: RS(3000), suggestedRecovery: RS(3000) });
    expect(lowestAdvanceBalance(e.id)).toBe(0);
  });

  it('does not recover again what a later slip has already recovered', async () => {
    t = await createTestApp({ openingCash: RS(100000) });
    const e = await addEmployee();
    await t.call('advances.create', { employeeId: e.id, amount: RS(5000), mode: 'cash', date: '2026-08-05' });
    // September processed first (dated 15-09) and recovers the whole advance
    await t.call('salary.process', { employeeId: e.id, month: '2026-09', date: '2026-09-15', advanceRecovery: RS(5000) });
    // a new advance after that
    await t.call('advances.create', { employeeId: e.id, amount: RS(2000), mode: 'cash', date: '2026-09-20' });
    // August dated 31-08: 5,000 was outstanding then and 2,000 is outstanding today, but recovering
    // anything would take the advance below zero between 15-09 and 20-09
    const p = await t.call('salary.preview', { employeeId: e.id, month: '2026-08' });
    expect(p).toMatchObject({ outstandingAdvance: RS(2000), recoverableAdvance: 0, suggestedRecovery: 0 });
    expect((await t.fails('salary.process', { employeeId: e.id, month: '2026-08', advanceRecovery: RS(1) })).fields?.advanceRecovery).toBe('At most ₹0.00');
    await t.call('salary.process', { employeeId: e.id, month: '2026-08' });
    expect(lowestAdvanceBalance(e.id)).toBe(0);
  });

  it('cannot cancel an advance whose amount a salary has recovered, even when a later advance hides it today', async () => {
    t = await createTestApp({ openingCash: RS(100000) });
    const e = await addEmployee();
    const a1 = await t.call('advances.create', { employeeId: e.id, amount: RS(5000), mode: 'cash', date: '2026-08-01' });
    await t.call('salary.process', { employeeId: e.id, month: '2026-08', advanceRecovery: RS(5000) });
    const a2 = await t.call('advances.create', { employeeId: e.id, amount: RS(5000), mode: 'cash', date: '2026-09-08' });
    // today's balance is 5,000, but cancelling the first advance would leave -5,000 from 31-08 to 07-09
    expect((await t.fails('advances.cancel', { id: a1.id, reason: 'Wrong' })).message).toMatch(/₹5,000.00 of this advance has already been recovered/);
    await t.call('advances.cancel', { id: a2.id, reason: 'Not given' });
    expect(lowestAdvanceBalance(e.id)).toBe(0);
  });

  it('cannot lower the opening advance below what a salary recovered before a later advance', async () => {
    t = await createTestApp({ openingCash: RS(100000) });
    const e = await addEmployee({ openingAdvance: RS(3000) });
    await t.call('salary.process', { employeeId: e.id, month: '2026-08', advanceRecovery: RS(3000) });
    await t.call('advances.create', { employeeId: e.id, amount: RS(4000), mode: 'cash', date: '2026-09-08' });
    const base = { id: e.id, name: 'Ramesh Kumar', salaryType: 'monthly' as const, salaryAmount: RS(15000), joinDate: '2026-04-01' };
    const err = await t.fails('employees.update', { ...base, openingAdvance: RS(1000) });
    expect(err.message).toMatch(/₹3,000.00 of the opening advance has already been recovered/);
    expect(lowestAdvanceBalance(e.id)).toBe(0);
  });
});

/* ------------------------------ Money going out: balance warnings ------------------------------ */

describe('cash / bank balance warnings', () => {
  it('warns (without blocking) when an advance or salary payment takes cash or bank below zero', async () => {
    t = await createTestApp({ openingCash: RS(10000) });
    const e = await addEmployee();
    const ok = await t.call('advances.create', { employeeId: e.id, amount: RS(4000), mode: 'cash' });
    expect(ok.warnings).toEqual([]);
    const short = await t.call('advances.create', { employeeId: e.id, amount: RS(7000), mode: 'cash' });
    expect(short.warnings).toEqual(['Cash in Hand will be short by ₹1,000.00 after this payment. Check that all money received has been entered.']);
    expect(systemBalance(t.app, 'CASH')).toBe(-RS(1000));

    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-08', payNow: { mode: 'upi', amount: RS(5000) } });
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/short by ₹5,000.00/);
    const paid = await t.call('salary.pay', { salaryId: s.id, amount: RS(2000), mode: 'upi' });
    expect(paid.warnings[0]).toMatch(/short by ₹7,000.00/);
    const none = await t.call('salary.process', { employeeId: e.id, month: '2026-07' });
    expect(none.warnings).toEqual([]);
  });

  it('process all gives one warning per account, for the whole shortfall', async () => {
    t = await createTestApp({ openingCash: RS(20000) });
    await addEmployee({ name: 'Anil' });
    await addEmployee({ name: 'Bala' });
    const res = await t.call('salary.processAll', { month: '2026-08', recoverAdvances: true, includeUnmarked: true, payNow: { mode: 'cash' } });
    expect(res.totalPaid).toBe(RS(30000));
    expect(res.warnings).toEqual(['Cash in Hand will be short by ₹10,000.00 after this payment. Check that all money received has been entered.']);
    const t2 = await t.call('salary.processAll', { month: '2026-07', recoverAdvances: true, includeUnmarked: true });
    expect(t2.warnings).toEqual([]);
  });
});

/* ------------------------------ Process all: no attendance ------------------------------ */

describe('process all with no attendance marked', () => {
  it('flags employees with no attendance and skips them unless the full-month pay is confirmed', async () => {
    t = await createTestApp({ openingCash: RS(200000) });
    const a = await addEmployee({ name: 'Anil' });
    const b = await addEmployee({ name: 'Bala' });
    const c = await addEmployee({ name: 'Chetan', salaryType: 'daily', salaryAmount: RS(500) });
    await mark(a.id, ['2026-08-03'], 'A');
    const sheet = await t.call('salary.monthSheet', { month: '2026-08' });
    const by = (n: string) => sheet.rows.find((r) => r.employeeName === n)!;
    expect(by('Anil').noAttendance).toBe(false);
    expect(by('Bala')).toMatchObject({ noAttendance: true, gross: RS(15000), problem: null });
    // daily wages with nothing marked earn nothing (already skipped as "No salary is earned")
    expect(by('Chetan')).toMatchObject({ noAttendance: true, problemKind: 'zero' });
    expect(sheet.totals).toMatchObject({ pending: 2, noAttendance: 1 });
    const pv = await t.call('salary.preview', { employeeId: b.id, month: '2026-08' });
    expect(pv.noAttendance).toBe(true);

    const first = await t.call('salary.processAll', { month: '2026-08', recoverAdvances: true });
    expect(first.processed.map((p) => p.name)).toEqual(['Anil']);
    expect(first.skipped.map((s) => s.name)).toEqual(['Bala', 'Chetan']);
    expect(first.skipped[0].reason).toMatch(/No attendance is marked for August 2026/);
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM salaries WHERE employee_id = ?', [b.id])).toBe(0);

    const second = await t.call('salary.processAll', { month: '2026-08', recoverAdvances: true, includeUnmarked: true });
    expect(second.processed.map((p) => p.name)).toEqual(['Bala']);
    expect(second.processed[0].net).toBe(RS(15000));
    void c;
  });
});

/* ------------------------------ Salary slip printing ------------------------------ */

describe('salary slip printing', () => {
  it('leaves out the customer header / footer, prints one copy and marks reprints DUPLICATE', async () => {
    t = await createTestApp();
    await t.call('settings.update', { section: 'receipt', values: { copies: 3, header: 'Open 9 am to 9 pm', footer: 'Thank you! Visit again.' } });
    const e = await addEmployee();
    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-08' });
    const { html } = await t.call('salary.slipHtml', { id: s.id });
    expect(html).toContain('SALARY SLIP');
    expect(html).toContain('Employee signature');
    expect(html).not.toContain('Thank you! Visit again.');
    expect(html).not.toContain('Open 9 am to 9 pm');
    expect(html).not.toContain('DUPLICATE');

    const first = await t.call('salary.print', { id: s.id });
    expect(first).toMatchObject({ printed: true, duplicate: false });
    expect(t.platform.printed[0].opts.copies).toBe(1);
    expect(t.platform.printed[0].html).not.toContain('DUPLICATE');
    expect(t.platform.printed[0].html).not.toContain('Thank you! Visit again.');
    const again = await t.call('salary.print', { id: s.id });
    expect(again).toMatchObject({ printed: true, duplicate: true });
    expect(t.platform.printed[1].opts.copies).toBe(1);
    expect(t.platform.printed[1].html).toContain('DUPLICATE');
    const log = t.app.db.all<{ summary: string }>("SELECT summary FROM activity_log WHERE action = 'salary.print' ORDER BY id");
    expect(log.map((l) => l.summary)).toEqual([expect.stringMatching(/^Printed salary slip/), expect.stringMatching(/^Reprinted salary slip .*DUPLICATE/)]);

    // without the DUPLICATE setting, reprints look like the original
    await t.call('settings.update', { section: 'receipt', values: { markDuplicate: false } });
    expect(await t.call('salary.print', { id: s.id })).toMatchObject({ printed: true, duplicate: false });
    expect(t.platform.printed[2].html).not.toContain('DUPLICATE');
  });
});

/* ------------------------------ Employee page totals ------------------------------ */

describe('employee page totals', () => {
  it('shows the salary earned this year (before advance recovery) with the net pay separately', async () => {
    t = await createTestApp({ openingCash: RS(100000) });
    const e = await addEmployee();
    await t.call('advances.create', { employeeId: e.id, amount: RS(5000), mode: 'cash', date: '2026-08-02' });
    await t.call('salary.process', { employeeId: e.id, month: '2026-08', bonus: RS(1000), deductions: RS(400), advanceRecovery: RS(5000), payNow: { mode: 'cash', amount: RS(2000) } });
    const d = await t.call('employees.get', { id: e.id });
    expect(d.totals).toMatchObject({ salaryThisFy: RS(15600), netThisFy: RS(10600), recoveredThisFy: RS(5000), paidThisFy: RS(2000) });
  });
});

/* ------------------------------ Permissions ------------------------------ */

describe('permissions', () => {
  it('cashiers cannot see or change employees by default', async () => {
    t = await createTestApp();
    const e = await addEmployee();
    await t.loginAs('cashier');
    for (const [route, input] of [
      ['employees.list', {}],
      ['employees.get', { id: e.id }],
      ['employees.create', { name: 'X', salaryType: 'monthly', salaryAmount: 100 }],
      ['attendance.mark', { employeeId: e.id, date: '2026-09-10', status: 'P' }],
      ['attendance.month', { month: '2026-09' }],
      ['salary.process', { employeeId: e.id, month: '2026-08' }],
      ['salary.monthSheet', { month: '2026-08' }],
      ['advances.create', { employeeId: e.id, amount: 100, mode: 'cash' }],
      ['employees.ledger', { employeeId: e.id, from: '2026-04-01', to: '2026-09-28' }],
    ] as const) {
      expect((await t.fails(route, input)).code).toBe('FORBIDDEN');
    }
  });

  it('managers can do everything in the module', async () => {
    t = await createTestApp({ openingCash: RS(10000) });
    await t.loginAs('manager');
    const e = await addEmployee();
    await t.call('attendance.mark', { employeeId: e.id, date: '2026-09-10', status: 'P' });
    await t.call('advances.create', { employeeId: e.id, amount: RS(500), mode: 'cash' });
    const s = await t.call('salary.process', { employeeId: e.id, month: '2026-08', payNow: { mode: 'cash', amount: RS(1000) } });
    expect(s.createdBy).toBe('Test manager');
    const log = t.app.db.get<{ username: string }>("SELECT username FROM activity_log WHERE action = 'salary.process'")!;
    expect(log.username).toBe('manager1');
  });

  it('a user who can only view employees does not see pay details; attendance-only users cannot touch salary', async () => {
    t = await createTestApp();
    const e = await addEmployee({ openingAdvance: RS(700) });
    t.app.db.run("INSERT INTO role_permissions (role, permission) VALUES ('cashier', 'employees.view'), ('cashier', 'employees.attendance')");
    await t.loginAs('cashier');
    const list = await t.call('employees.list', {});
    expect(list[0]).toMatchObject({ name: 'Ramesh Kumar', salaryAmount: null, outstandingAdvance: null, salaryDue: null, bankDetails: null });
    const d = await t.call('employees.get', { id: e.id });
    expect(d).toMatchObject({ showPay: false, openingAdvance: null, totals: null });
    await t.call('attendance.mark', { employeeId: e.id, date: '2026-09-10', status: 'A' });
    expect((await t.fails('salary.preview', { employeeId: e.id, month: '2026-09' })).code).toBe('FORBIDDEN');
    expect((await t.fails('employees.update', { id: e.id, name: 'X', salaryType: 'monthly', salaryAmount: 1 })).code).toBe('FORBIDDEN');
    expect((await t.fails('advances.list', {})).code).toBe('FORBIDDEN');
  });
});
