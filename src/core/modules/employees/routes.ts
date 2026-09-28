import { z } from 'zod';
import { route, zDate, zId, zOptText, zPaise, zPhone, zPositivePaise, zSettlementMode } from '../../api/router';
import { ATTENDANCE_STATUSES } from '../../../shared/constants';
import * as employees from './service';
import * as attendance from './attendance';
import * as salary from './salary';
import * as advances from './advances';
import { employeeLedger } from './ledger';

/** Salary amounts are capped so a mistyped figure cannot overflow totals (₹10 crore). */
const MAX_SALARY = 1_000_000_000;

const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month');

const zEmployeeInput = z.object({
  name: z.string().trim().min(1, "Enter the employee's name").max(100),
  phone: zPhone,
  address: zOptText(300),
  designation: zOptText(60),
  joinDate: zDate.nullish(),
  salaryType: z.enum(['monthly', 'daily'], { message: 'Choose monthly salary or daily wages' }),
  salaryAmount: zPaise.max(MAX_SALARY, 'That salary looks too large. Please check the amount.'),
  weeklyOff: z.number().int().min(0).max(6).nullish(),
  idProof: zOptText(120),
  bankDetails: zOptText(300),
  notes: zOptText(500),
  openingAdvance: zPaise.max(MAX_SALARY, 'That amount looks too large. Please check it.').nullish(),
});

const zById = z.object({ id: zId });
const zReason = z.string().trim().min(1, 'Enter the reason for cancelling').max(300);

const VIEW = ['employees.view'] as const;

export const employeesRoutes = {
  /** CONTRACT: employee picker. */
  'employees.search': route({
    access: ['employees.view', 'employees.attendance', 'employees.salary'],
    input: z.object({ q: z.string().optional(), includeInactive: z.boolean().optional() }),
    handler: (ctx, input) => employees.searchEmployees(ctx, input.q, input.includeInactive),
  }),

  /* ---------------- Employee records ---------------- */
  'employees.list': route({
    access: [...VIEW],
    input: z.object({ q: z.string().nullish(), includeInactive: z.boolean().optional() }),
    handler: (ctx, input) => employees.listEmployees(ctx, input),
  }),
  'employees.get': route({ access: [...VIEW], input: zById, handler: (ctx, input) => employees.getEmployee(ctx, input.id) }),
  'employees.create': route({
    access: 'employees.manage',
    mutation: true,
    input: zEmployeeInput,
    handler: (ctx, input) => employees.createEmployee(ctx, input),
  }),
  'employees.update': route({
    access: 'employees.manage',
    mutation: true,
    input: zEmployeeInput.extend({ id: zId }),
    handler: (ctx, { id, ...input }) => employees.updateEmployee(ctx, id, input),
  }),
  /** Facts the add-employee form needs (opening advances are dated the books start date). */
  'employees.formInfo': route({ access: 'employees.manage', handler: (ctx) => employees.employeeFormInfo(ctx) }),
  /** Mark as left (active: false, last working day) or re-activate. */
  'employees.setActive': route({
    access: 'employees.manage',
    mutation: true,
    input: z.object({ id: zId, active: z.boolean(), leaveDate: zDate.nullish() }),
    handler: (ctx, input) => employees.setEmployeeActive(ctx, input.id, input.active, input.leaveDate),
  }),
  /** Advances, recoveries, salary earned and paid with running balances. */
  'employees.ledger': route({
    access: 'employees.salary',
    input: z.object({ employeeId: zId, from: zDate, to: zDate }),
    handler: (ctx, input) => employeeLedger(ctx, input.employeeId, input.from, input.to),
  }),

  /* ---------------- Attendance ---------------- */
  'attendance.month': route({
    access: ['employees.attendance', 'employees.view'],
    input: z.object({ month: zMonth, employeeId: zId.nullish() }),
    handler: (ctx, input) => attendance.attendanceMonth(ctx, input.month, input.employeeId),
  }),
  'attendance.mark': route({
    access: 'employees.attendance',
    mutation: true,
    input: z.object({ employeeId: zId, date: zDate, status: z.enum(ATTENDANCE_STATUSES).nullable(), note: zOptText(200).optional() }),
    handler: (ctx, input) => attendance.markAttendance(ctx, { ...input, note: input.note }),
  }),
  'attendance.markAll': route({
    access: 'employees.attendance',
    mutation: true,
    input: z.object({ date: zDate, status: z.enum(ATTENDANCE_STATUSES).default('P'), onlyUnmarked: z.boolean().default(true) }),
    handler: (ctx, input) => attendance.markAll(ctx, input),
  }),
  'attendance.fillWeeklyOff': route({
    access: 'employees.attendance',
    mutation: true,
    input: z.object({ month: zMonth }),
    handler: (ctx, input) => attendance.fillWeeklyOff(ctx, input.month),
  }),

  /* ---------------- Salary ---------------- */
  /** `date` = the salary date being considered: only the advance outstanding on that day can be recovered. */
  'salary.preview': route({
    access: 'employees.salary',
    input: z.object({ employeeId: zId, month: zMonth, date: zDate.nullish() }),
    handler: (ctx, input) => salary.previewSalary(ctx, input.employeeId, input.month, input.date),
  }),
  'salary.monthSheet': route({
    access: 'employees.salary',
    input: z.object({ month: zMonth, date: zDate.nullish() }),
    handler: (ctx, input) => salary.salaryMonthSheet(ctx, input.month, input.date),
  }),
  'salary.process': route({
    access: 'employees.salary',
    mutation: true,
    input: z.object({
      employeeId: zId,
      month: zMonth,
      date: zDate.nullish(),
      bonus: zPaise.max(MAX_SALARY).optional(),
      deductions: zPaise.max(MAX_SALARY).optional(),
      advanceRecovery: zPaise.max(MAX_SALARY).optional(),
      remarks: zOptText(300),
      payNow: z.object({ mode: zSettlementMode, accountId: zId.nullish(), amount: zPositivePaise }).nullish(),
    }),
    handler: (ctx, input) => salary.processSalary(ctx, input),
  }),
  /** Process every remaining employee of the month in one go. */
  'salary.processAll': route({
    access: 'employees.salary',
    mutation: true,
    input: z.object({
      month: zMonth,
      date: zDate.nullish(),
      recoverAdvances: z.boolean().default(true),
      /** Also process employees with no attendance marked (paid for the full month). Off = they are skipped. */
      includeUnmarked: z.boolean().default(false),
      payNow: z.object({ mode: zSettlementMode, accountId: zId.nullish() }).nullish(),
    }),
    handler: (ctx, input) => salary.processAllSalaries(ctx, input),
  }),
  'salary.pay': route({
    access: 'employees.salary',
    mutation: true,
    input: z.object({ salaryId: zId, date: zDate.nullish(), amount: zPositivePaise, mode: zSettlementMode, accountId: zId.nullish(), remarks: zOptText(200) }),
    handler: (ctx, input) => salary.paySalary(ctx, input),
  }),
  'salary.cancelPayment': route({
    access: 'employees.salary',
    mutation: true,
    input: z.object({ paymentId: zId, reason: zReason }),
    handler: (ctx, input) => salary.cancelSalaryPayment(ctx, input.paymentId, input.reason),
  }),
  /** Cancels the slip and every payment made against it. */
  'salary.cancel': route({
    access: 'employees.salary',
    mutation: true,
    input: z.object({ salaryId: zId, reason: zReason }),
    handler: (ctx, input) => salary.cancelSalary(ctx, input.salaryId, input.reason),
  }),
  'salary.list': route({
    access: 'employees.salary',
    input: z.object({
      month: zMonth.nullish(),
      from: zDate.nullish(),
      to: zDate.nullish(),
      employeeId: zId.nullish(),
      status: z.enum(['unpaid', 'partly_paid', 'paid', 'cancelled', 'due']).nullish(),
    }),
    handler: (ctx, input) => salary.listSalaries(ctx, input),
  }),
  'salary.get': route({ access: 'employees.salary', input: zById, handler: (ctx, input) => salary.getSalaryDetail(ctx, input.id) }),
  'salary.slipHtml': route({
    access: 'employees.salary',
    input: zById,
    handler: (ctx, input) => ({ html: salary.salarySlipHtml(ctx, input.id) }),
  }),
  'salary.print': route({
    access: 'employees.salary',
    input: zById,
    handler: (ctx, input) => salary.printSalarySlip(ctx, input.id),
  }),

  /* ---------------- Advances ---------------- */
  'advances.create': route({
    access: 'employees.salary',
    mutation: true,
    input: z.object({ employeeId: zId, date: zDate.nullish(), amount: zPositivePaise.max(MAX_SALARY, 'That amount looks too large. Please check it.'), mode: zSettlementMode, accountId: zId.nullish(), remarks: zOptText(200) }),
    handler: (ctx, input) => advances.createAdvance(ctx, input),
  }),
  'advances.cancel': route({
    access: 'employees.salary',
    mutation: true,
    input: z.object({ id: zId, reason: zReason }),
    handler: (ctx, input) => advances.cancelAdvance(ctx, input.id, input.reason),
  }),
  'advances.outstanding': route({
    access: 'employees.salary',
    input: z.object({ employeeId: zId }),
    handler: (ctx, input) => advances.employeeBalances(ctx, input.employeeId),
  }),
  'advances.get': route({ access: 'employees.salary', input: zById, handler: (ctx, input) => advances.getAdvance(ctx, input.id) }),
  'advances.list': route({
    access: 'employees.salary',
    input: z.object({ from: zDate.nullish(), to: zDate.nullish(), employeeId: zId.nullish(), status: z.enum(['active', 'cancelled']).nullish() }),
    handler: (ctx, input) => advances.listAdvances(ctx, input),
  }),
};
