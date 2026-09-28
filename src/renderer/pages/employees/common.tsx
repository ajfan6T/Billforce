/**
 * UI pieces shared by the employee, attendance, salary and advance pages.
 */
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge, IconButton } from '../../components/ui';
import { formatINR } from '../../../shared/money';
import { addMonths, formatDate, formatDateTime, monthLabel, todayISO } from '../../../shared/dates';
import { ATTENDANCE_LABELS, ATTENDANCE_STATUSES, type AttendanceStatus } from '../../../shared/constants';
import type { ReportColumn, ReportData, ReportRow } from '../../../shared/report';
import './employees.css';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const currentMonth = () => todayISO().slice(0, 7);
export const shiftMonth = (month: string, by: number) => addMonths(`${month}-01`, by).slice(0, 7);

/** "₹15,000.00 / month" or "₹500.00 / day". */
export function salaryLabel(type: 'monthly' | 'daily', amount: number | null): string {
  if (amount === null) return '—';
  return `${formatINR(amount)} / ${type === 'monthly' ? 'month' : 'day'}`;
}

export function fmtDays(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Like <Field> but not a <label>: for button groups (payment mode, salary type),
 * where a wrapping label would give its text to the first button only.
 */
export function GroupField({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/* ------------------------------ Month picker ------------------------------ */

/** Previous / next month buttons around a native month input (or just the month name when `compact`). */
export function MonthPicker({
  value,
  onChange,
  max = currentMonth(),
  min,
  compact,
}: {
  value: string;
  onChange: (m: string) => void;
  max?: string;
  min?: string;
  compact?: boolean;
}) {
  const prev = shiftMonth(value, -1);
  const next = shiftMonth(value, 1);
  return (
    <div className="month-picker">
      <IconButton label={`Previous month (${monthLabel(prev, true)})`} icon={<ChevronLeft size={18} />} disabled={!!min && prev < min} onClick={() => onChange(prev)} />
      {compact ? (
        <span className="month-label" aria-live="polite">
          {monthLabel(value, true)}
        </span>
      ) : (
        <input
          type="month"
          className="input"
          aria-label="Month"
          value={value}
          max={max}
          min={min}
          onChange={(e) => {
            const v = e.target.value;
            if (/^\d{4}-\d{2}$/.test(v) && (!max || v <= max)) onChange(v);
          }}
        />
      )}
      <IconButton label={`Next month (${monthLabel(next, true)})`} icon={<ChevronRight size={18} />} disabled={!!max && next > max} onClick={() => onChange(next)} />
    </div>
  );
}

/* ------------------------------ Attendance ------------------------------ */

export const STATUS_ORDER: AttendanceStatus[] = [...ATTENDANCE_STATUSES];

/** Next status when a cell is clicked: P → A → H → L → W → (blank) → P. */
export function nextStatus(s: AttendanceStatus | null): AttendanceStatus | null {
  if (!s) return 'P';
  const i = STATUS_ORDER.indexOf(s);
  return i === STATUS_ORDER.length - 1 ? null : STATUS_ORDER[i + 1];
}

export function AttendanceLegend({ extra = true }: { extra?: boolean }) {
  return (
    <div className="att-legend" aria-label="Legend">
      {STATUS_ORDER.map((s) => (
        <span key={s} className="att-legend-item">
          <span className={`att-swatch att-${s}`}>{s}</span>
          {ATTENDANCE_LABELS[s]}
        </span>
      ))}
      {extra && (
        <>
          <span className="att-legend-item">
            <span className="att-swatch att-off" />
            Weekly off day (not marked)
          </span>
          <span className="att-legend-item">
            <span className="att-swatch att-none" />
            Not marked
          </span>
          <span className="att-legend-item">
            <span className="att-swatch att-outside" />
            Not working here
          </span>
        </>
      )}
    </div>
  );
}

export interface Counts {
  P: number;
  A: number;
  H: number;
  L: number;
  W: number;
  unmarked: number;
}

/** Coloured P / A / H / L / W chips with counts. */
export function AttendanceChips({ counts, showZero = false, unmarkedLabel = 'Not marked' }: { counts: Counts; showZero?: boolean; unmarkedLabel?: string }) {
  return (
    <div className="att-chips">
      {STATUS_ORDER.filter((s) => showZero || counts[s] > 0).map((s) => (
        <span key={s} className={`att-chip att-${s}`} title={ATTENDANCE_LABELS[s]}>
          {ATTENDANCE_LABELS[s]} {counts[s]}
        </span>
      ))}
      {counts.unmarked > 0 && (
        <span className="att-chip att-none">
          {unmarkedLabel} {counts.unmarked}
        </span>
      )}
    </div>
  );
}

/** Compact "P 22 A 1 H 2" for table cells. */
export function AttendanceMini({ counts }: { counts: Counts }) {
  const shown = (['P', 'A', 'H', 'L'] as const).filter((s) => counts[s] > 0);
  if (!shown.length) return <span className="faint">{counts.unmarked ? 'Not marked' : '—'}</span>;
  return (
    <span className="att-mini">
      {shown.map((s) => (
        <span key={s} className={`att-${s}`} title={`${ATTENDANCE_LABELS[s]}: ${counts[s]}`}>
          {s} {counts[s]}
        </span>
      ))}
    </span>
  );
}

/* ------------------------------ Badges & amounts ------------------------------ */

export type SalaryStatus = 'unpaid' | 'partly_paid' | 'paid' | 'cancelled';

export const SALARY_STATUS_LABELS: Record<SalaryStatus, string> = {
  unpaid: 'Not paid',
  partly_paid: 'Part paid',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

export function SalaryStatusBadge({ status }: { status: SalaryStatus }) {
  const tone = status === 'paid' ? 'green' : status === 'partly_paid' ? 'amber' : status === 'cancelled' ? 'red' : 'blue';
  return <Badge tone={tone}>{SALARY_STATUS_LABELS[status]}</Badge>;
}

export function ModeBadge({ mode }: { mode: 'cash' | 'upi' | 'bank' }) {
  const tone = mode === 'cash' ? 'green' : mode === 'upi' ? 'purple' : 'blue';
  return <Badge tone={tone}>{mode === 'cash' ? 'Cash' : mode === 'upi' ? 'UPI' : 'Bank'}</Badge>;
}

export function EmployeeStatusBadge({ isActive, leaveDate }: { isActive: boolean; leaveDate: string | null }) {
  if (isActive) return <Badge tone="green">Working</Badge>;
  return <Badge tone="neutral">Left{leaveDate ? ` ${formatDate(leaveDate)}` : ''}</Badge>;
}

/** Amount in red when > 0 (money owed), faint dash when zero. */
export function DueAmount({ value, tone = 'due' }: { value: number | null; tone?: 'due' | 'adv' }) {
  if (value === null) return <span className="faint">—</span>;
  if (!value) return <span className="emp-nil">—</span>;
  return <span className={`money ${tone === 'due' ? 'emp-due' : 'emp-adv'}`}>{formatINR(value)}</span>;
}

/* ------------------------------ Posting & history ------------------------------ */

export interface PostingLineView {
  account: string;
  party: string | null;
  debit: number;
  credit: number;
  void?: boolean;
  group?: string;
}

/** "How this is recorded in your accounts" table. Lines can be grouped (slip, each payment). */
export function PostingTable({ lines }: { lines: PostingLineView[] }) {
  if (!lines.length) return <div className="muted small">No accounting entry.</div>;
  let lastGroup: string | undefined;
  const rows: ReactNode[] = [];
  lines.forEach((l, i) => {
    if (l.group && l.group !== lastGroup) {
      rows.push(
        <tr key={`g${i}`} className="group">
          <td colSpan={3}>{l.group}</td>
        </tr>,
      );
      lastGroup = l.group;
    }
    rows.push(
      <tr key={i} className={l.void ? 'void' : ''}>
        <td>
          {l.account}
          {l.party && <span className="emp-sub" style={{ display: 'inline' }}> · {l.party}</span>}
        </td>
        <td className="num money">{l.debit ? formatINR(l.debit) : ''}</td>
        <td className="num money">{l.credit ? formatINR(l.credit) : ''}</td>
      </tr>,
    );
  });
  return (
    <>
      <table className="emp-posting">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
      {lines.some((l) => l.void) && <div className="muted small mt-1">Struck-through lines were reversed when cancelled and no longer affect any balance.</div>}
    </>
  );
}

export interface RevisionView {
  id: number;
  revision: number;
  action: 'created' | 'edited' | 'cancelled' | 'restored';
  reason: string | null;
  username: string | null;
  at: string;
}

const REV_TITLES: Record<RevisionView['action'], string> = { created: 'Created', edited: 'Changed', cancelled: 'Cancelled', restored: 'Restored' };

export function RevisionList({ revisions }: { revisions: RevisionView[] }) {
  if (!revisions.length) return <div className="muted small">No history.</div>;
  return (
    <ul className="emp-history">
      {revisions.map((r) => (
        <li key={r.id}>
          <span className={`dot ${r.action}`} />
          <div className="h-title">
            {REV_TITLES[r.action]} <span className="muted small">(version {r.revision})</span>
          </div>
          <div className="h-meta">
            {r.username ?? 'Unknown user'} · {formatDateTime(r.at)}
          </div>
          {r.reason && <div className="h-reason">{r.reason}</div>}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------ Export helper ------------------------------ */

export interface ListColumn<T> extends ReportColumn {
  get: (row: T) => string | number | null;
}

/** Turn an on-screen list into ReportData so it can be exported / printed. */
export function listReport<T>(
  title: string,
  subtitle: string,
  columns: Array<ListColumn<T>>,
  rows: T[],
  opts: { totals?: Record<string, string | number | null>; summary?: ReportData['summary']; link?: (row: T) => ReportRow['link']; landscape?: boolean; notes?: string[] } = {},
): ReportData {
  const out: ReportRow[] = rows.map((r) => ({
    cells: Object.fromEntries(columns.map((c) => [c.key, c.get(r)])),
    link: opts.link?.(r),
  }));
  if (opts.totals) out.push({ cells: opts.totals, style: 'total' });
  return {
    title,
    subtitle,
    columns: columns.map(({ get: _g, ...c }) => c),
    rows: out,
    summary: opts.summary,
    landscape: opts.landscape,
    notes: opts.notes,
  };
}
