/**
 * Advances given to employees (recovered later from their salary).
 * Posting: Dr Employee Advances (employee), Cr cash / bank.
 */
import type { Ctx } from '../../context';
import { currentUserId, now, today } from '../../context';
import { fail } from '../../errors';
import { listRevisions, logActivity, recordRevision, type RevisionRow } from '../../audit';
import { nextDocNumber } from '../../numbering';
import { getEntryLines, partyBalances, paymentAccountId, postEntry, voidEntry } from '../../accounting/ledger';
import { formatINR } from '../../../shared/money';
import { formatDate } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS, type SettlementMode } from '../../../shared/constants';
import { getEmployeeRow, outstandingAdvance, salaryDue } from './service';

interface AdvanceRow {
  id: number;
  advance_no: string;
  employee_id: number;
  date: string;
  amount: number;
  mode: SettlementMode;
  account_id: number;
  remarks: string | null;
  status: 'active' | 'cancelled';
  journal_entry_id: number | null;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  employee_name: string;
  designation: string | null;
  account_name: string;
  created_by_name: string | null;
  cancelled_by_name: string | null;
}

export interface Advance {
  id: number;
  advanceNo: string;
  employeeId: number;
  employeeName: string;
  designation: string | null;
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

export interface AdvanceDetail extends Advance {
  posting: Array<{ account: string; party: string | null; debit: number; credit: number }>;
  revisions: RevisionRow[];
  /** Employee's advance outstanding today. */
  currentAdvance: number;
}

const SELECT = `SELECT v.*, e.name AS employee_name, e.designation, a.name AS account_name,
    uc.full_name AS created_by_name, ux.full_name AS cancelled_by_name
  FROM employee_advances v
  JOIN employees e ON e.id = v.employee_id
  JOIN accounts a ON a.id = v.account_id
  LEFT JOIN users uc ON uc.id = v.created_by
  LEFT JOIN users ux ON ux.id = v.cancelled_by`;

function toAdvance(r: AdvanceRow): Advance {
  return {
    id: r.id,
    advanceNo: r.advance_no,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    designation: r.designation,
    date: r.date,
    amount: r.amount,
    mode: r.mode,
    accountId: r.account_id,
    accountName: r.account_name,
    remarks: r.remarks,
    status: r.status,
    journalEntryId: r.journal_entry_id,
    createdBy: r.created_by_name,
    createdAt: r.created_at,
    cancelledBy: r.cancelled_by_name,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
  };
}

function getRow(ctx: Ctx, id: number): AdvanceRow {
  const r = ctx.db.get<AdvanceRow>(`${SELECT} WHERE v.id = ?`, [id]);
  if (!r) throw fail.notFound('Advance');
  return r;
}

export function getAdvance(ctx: Ctx, id: number): AdvanceDetail {
  const r = getRow(ctx, id);
  return {
    ...toAdvance(r),
    posting: r.journal_entry_id
      ? getEntryLines(ctx, r.journal_entry_id).map((l) => ({ account: l.account_name, party: l.party_name, debit: l.debit, credit: l.credit }))
      : [],
    revisions: listRevisions(ctx, 'advance', id),
    currentAdvance: outstandingAdvance(ctx, r.employee_id),
  };
}

export interface AdvanceInput {
  employeeId: number;
  date?: string | null;
  amount: number;
  mode: SettlementMode;
  accountId?: number | null;
  remarks?: string | null;
}

export function createAdvance(ctx: Ctx, input: AdvanceInput): AdvanceDetail {
  const emp = getEmployeeRow(ctx, input.employeeId);
  if (!emp.is_active) {
    throw fail.validation(`${emp.name} is marked as left${emp.leave_date ? ` (${formatDate(emp.leave_date)})` : ''}. Re-activate the employee to give an advance.`, {
      employeeId: 'Employee has left',
    });
  }
  const t = today(ctx);
  const date = input.date || t;
  if (date > t) throw fail.validation(`An advance cannot be dated later than today (${formatDate(t)}).`, { date: 'Date cannot be in the future' });
  if (!(input.amount > 0)) throw fail.validation('Enter the advance amount', { amount: 'Enter the amount' });
  const accountId = paymentAccountId(ctx, input.mode, input.accountId);
  const remarks = input.remarks?.trim() || null;
  const num = nextDocNumber(ctx, 'advance', date);
  const id = ctx.db.insert('employee_advances', {
    advance_no: num.number,
    seq: num.seq,
    fy_start: num.fyStart,
    employee_id: emp.id,
    date,
    amount: input.amount,
    mode: input.mode,
    account_id: accountId,
    remarks,
    created_by: currentUserId(ctx),
    created_at: now(ctx),
  });
  const entryId = postEntry(ctx, {
    date,
    voucherType: 'advance',
    voucherNo: num.number,
    sourceType: 'advance',
    sourceId: id,
    narration: `Advance to ${emp.name} (${PAYMENT_MODE_LABELS[input.mode]})${remarks ? ` - ${remarks}` : ''}`,
    lines: [
      { account: 'EMP_ADV', debit: input.amount, partyType: 'employee', partyId: emp.id },
      { account: accountId, credit: input.amount },
    ],
  });
  ctx.db.update('employee_advances', id, { journal_entry_id: entryId });
  recordRevision(ctx, 'advance', id, 'created', toAdvance(getRow(ctx, id)));
  const outstanding = outstandingAdvance(ctx, emp.id);
  logActivity(
    ctx,
    'advance.create',
    `Gave advance ${num.number} of ${formatINR(input.amount)} to ${emp.name} by ${PAYMENT_MODE_LABELS[input.mode]}; outstanding now ${formatINR(outstanding)}`,
    { entityType: 'advance', entityId: id, details: { employeeId: emp.id, amount: input.amount, mode: input.mode, date, remarks } },
  );
  return getAdvance(ctx, id);
}

export function cancelAdvance(ctx: Ctx, id: number, reason: string): AdvanceDetail {
  const why = reason.trim();
  if (!why) throw fail.validation('Enter the reason for cancelling', { reason: 'Enter a reason' });
  const r = getRow(ctx, id);
  if (r.status === 'cancelled') throw fail.validation(`Advance ${r.advance_no} is already cancelled.`);
  const outstanding = outstandingAdvance(ctx, r.employee_id);
  if (outstanding - r.amount < 0) {
    const recovered = r.amount - Math.max(outstanding, 0);
    throw fail.validation(
      `${formatINR(recovered)} of this advance has already been recovered from ${r.employee_name}'s salary. Cancel that salary slip first, then cancel the advance.`,
    );
  }
  if (r.journal_entry_id) voidEntry(ctx, r.journal_entry_id, `Advance ${r.advance_no} cancelled: ${why}`);
  ctx.db.update('employee_advances', id, { status: 'cancelled', cancelled_by: currentUserId(ctx), cancelled_at: now(ctx), cancel_reason: why });
  recordRevision(ctx, 'advance', id, 'cancelled', toAdvance(getRow(ctx, id)), why);
  logActivity(ctx, 'advance.cancel', `Cancelled advance ${r.advance_no} of ${formatINR(r.amount)} to ${r.employee_name}: ${why}`, {
    entityType: 'advance',
    entityId: id,
    details: { reason: why },
  });
  return getAdvance(ctx, id);
}

export interface AdvanceListQuery {
  from?: string | null;
  to?: string | null;
  employeeId?: number | null;
  status?: 'active' | 'cancelled' | null;
}

/** An employee's advance outstanding and salary due today (for the "Give advance" form). */
export function employeeBalances(ctx: Ctx, employeeId: number): { employeeId: number; name: string; outstanding: number; salaryDue: number } {
  const emp = getEmployeeRow(ctx, employeeId);
  return { employeeId: emp.id, name: emp.name, outstanding: outstandingAdvance(ctx, emp.id), salaryDue: salaryDue(ctx, emp.id) };
}

export interface AdvanceListTotals {
  count: number;
  amount: number;
  cancelled: number;
  byMode: Record<SettlementMode, number>;
  /** Advance outstanding today (all employees, or the chosen employee). */
  outstanding: number;
}

export function listAdvances(ctx: Ctx, q: AdvanceListQuery): { rows: Advance[]; totals: AdvanceListTotals } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.from) {
    where.push('v.date >= :from');
    params.from = q.from;
  }
  if (q.to) {
    where.push('v.date <= :to');
    params.to = q.to;
  }
  if (q.employeeId) {
    where.push('v.employee_id = :emp');
    params.emp = q.employeeId;
  }
  if (q.status) {
    where.push('v.status = :status');
    params.status = q.status;
  }
  const rows = ctx.db
    .all<AdvanceRow>(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY v.date DESC, v.id DESC LIMIT 5000`, params)
    .map(toAdvance);
  let outstanding = 0;
  if (q.employeeId) outstanding = outstandingAdvance(ctx, q.employeeId);
  else for (const bal of partyBalances(ctx, 'employee', { account: 'EMP_ADV' }).values()) outstanding += bal;
  const totals: AdvanceListTotals = { count: 0, amount: 0, cancelled: 0, byMode: { cash: 0, upi: 0, bank: 0 }, outstanding };
  for (const r of rows) {
    if (r.status === 'cancelled') {
      totals.cancelled++;
      continue;
    }
    totals.count++;
    totals.amount += r.amount;
    totals.byMode[r.mode] += r.amount;
  }
  return { rows, totals };
}
