import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { CalendarCheck, CalendarDays, Lock, Users } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBox, LinkButton, Loading, Page, PageHeader } from '../../components/ui';
import { SegmentedControl } from '../../components/forms';
import { useHotkeys, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { call, type ApiOutput } from '../../api';
import { formatDate, formatDateLong, todayISO } from '../../../shared/dates';
import { ATTENDANCE_LABELS, type AttendanceStatus } from '../../../shared/constants';
import { AttendanceLegend, MonthPicker, STATUS_ORDER, currentMonth, nextStatus, type Counts } from './common';

type Sheet = ApiOutput<'attendance.month'>;
type SheetEmployee = Sheet['employees'][number];
type Mark = { status: AttendanceStatus; note: string | null };
type Brush = 'cycle' | AttendanceStatus | 'clear';

const DAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function countsFor(emp: SheetEmployee, marks: Record<string, Mark>, days: Sheet['days']): Counts {
  const c: Counts = { P: 0, A: 0, H: 0, L: 0, W: 0, unmarked: 0 };
  if (!emp.employedFrom || !emp.employedTo) return c;
  for (const d of days) {
    if (d.future || d.date < emp.employedFrom || d.date > emp.employedTo) continue;
    const m = marks[d.date];
    if (m) c[m.status]++;
    else c.unmarked++;
  }
  return c;
}

/** Month attendance sheet: employees × days. Click (or type P / A / H / L / W) to mark. */
export function AttendancePage() {
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const [month, setMonth] = useState(currentMonth());
  const q = useQuery('attendance.month', { month });
  const [marks, setMarks] = useState<Record<number, Record<string, Mark>>>({});
  const [brush, setBrush] = useState<Brush>('cycle');
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState<'all' | 'weekly' | null>(null);
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const sheet = q.data;
  const today = todayISO();

  useEffect(() => {
    if (sheet) setMarks(Object.fromEntries(sheet.employees.map((e) => [e.id, e.marks])));
  }, [sheet]);
  useEffect(() => setActive(null), [month]);

  const canMark = useCallback(
    (emp: SheetEmployee, date: string, future: boolean) => !future && !emp.lockedBy && !!emp.employedFrom && date >= emp.employedFrom && date <= (emp.employedTo ?? ''),
    [],
  );

  const setCell = useCallback(
    (emp: SheetEmployee, date: string, status: AttendanceStatus | null) => {
      setMarks((all) => {
        const cur = { ...(all[emp.id] ?? {}) };
        if (status) cur[date] = { status, note: cur[date]?.note ?? null };
        else delete cur[date];
        return { ...all, [emp.id]: cur };
      });
      setPending((n) => n + 1);
      queue.current = queue.current.then(async () => {
        try {
          await call('attendance.mark', { employeeId: emp.id, date, status });
        } catch (e) {
          toast.error(e);
          void q.reload();
        } finally {
          setPending((n) => n - 1);
        }
      });
    },
    [toast, q],
  );

  const apply = (emp: SheetEmployee, date: string, how: Brush) => {
    const cur = marks[emp.id]?.[date]?.status ?? null;
    const next = how === 'cycle' ? nextStatus(cur) : how === 'clear' ? null : how;
    if (next !== cur) setCell(emp, date, next);
  };

  const focusCell = (r: number, c: number) => {
    setActive({ r, c });
    // Focus right away so fast typing (P P A P …) lands on the right day.
    cellRefs.current.get(`${r}:${c}`)?.focus();
  };

  const onCellKey = (e: KeyboardEvent<HTMLButtonElement>, r: number, c: number, emp: SheetEmployee, date: string, enabled: boolean) => {
    if (!sheet) return;
    const rows = sheet.employees.length;
    const cols = sheet.days.length;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowLeft' || k === 'ArrowUp' || k === 'ArrowDown' || k === 'Home' || k === 'End') {
      e.preventDefault();
      if (k === 'ArrowRight') focusCell(r, Math.min(c + 1, cols - 1));
      if (k === 'ArrowLeft') focusCell(r, Math.max(c - 1, 0));
      if (k === 'ArrowDown') focusCell(Math.min(r + 1, rows - 1), c);
      if (k === 'ArrowUp') focusCell(Math.max(r - 1, 0), c);
      if (k === 'Home') focusCell(r, 0);
      if (k === 'End') focusCell(r, cols - 1);
      return;
    }
    if (!enabled) return;
    const letter = k.toUpperCase();
    if ((STATUS_ORDER as string[]).includes(letter) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      apply(emp, date, letter as AttendanceStatus);
      // Move on to the next day so a row can be typed quickly: P P P A P ...
      focusCell(r, Math.min(c + 1, cols - 1));
    } else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      apply(emp, date, 'clear');
    }
  };

  const markAll = async (date: string) => {
    setBusy('all');
    try {
      const res = await call('attendance.markAll', { date, status: 'P', onlyUnmarked: true });
      const parts = [`${res.marked} marked present`];
      if (res.weeklyOff) parts.push(`${res.weeklyOff} on weekly off`);
      if (res.alreadyMarked) parts.push(`${res.alreadyMarked} already marked`);
      if (res.locked) parts.push(`${res.locked} skipped (salary processed)`);
      if (res.marked || res.weeklyOff) toast.success(`${formatDate(date)}: ${parts.join(', ')}`);
      else toast.info(`Nothing to mark on ${formatDate(date)}: ${parts.slice(1).join(', ') || 'no employees working that day'}`);
      if (date.slice(0, 7) !== month) setMonth(date.slice(0, 7));
      else await q.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const markDay = async (date: string) => {
    const ok = await dialogs.confirm({
      title: `Mark everyone present on ${formatDateLong(date)}?`,
      message: 'Only employees with nothing marked for that day are changed. Anyone whose weekly off falls on that day is marked as weekly off (W).',
      confirmText: 'Mark present',
    });
    if (ok) await markAll(date);
  };

  const fillWeekly = async () => {
    setBusy('weekly');
    try {
      const res = await call('attendance.fillWeeklyOff', { month });
      if (res.filled) toast.success(`Filled ${res.filled} weekly-off day${res.filled === 1 ? '' : 's'} for ${res.employees} employee${res.employees === 1 ? '' : 's'}`);
      else toast.info(res.locked ? 'Nothing to fill (salary already processed for some employees).' : 'No weekly offs to fill. Days already marked are left as they are; set each employee\'s weekly off in their details.');
      await q.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  useHotkeys({ 'alt+p': () => !busy && void markAll(today) }, [busy, today, month]);

  const dayTotals = useMemo(() => {
    const out: Record<string, number> = {};
    if (!sheet) return out;
    for (const d of sheet.days) {
      let n = 0;
      for (const e of sheet.employees) {
        const s = marks[e.id]?.[d.date]?.status;
        if (s === 'P') n++;
      }
      out[d.date] = n;
    }
    return out;
  }, [sheet, marks]);

  const brushOptions: Array<{ value: Brush; label: string; title: string }> = [
    { value: 'cycle', label: 'Cycle', title: 'Each click moves P → A → H → L → W → blank' },
    ...STATUS_ORDER.map((s) => ({ value: s as Brush, label: s, title: ATTENDANCE_LABELS[s] })),
    { value: 'clear', label: 'Clear', title: 'Remove the mark' },
  ];

  const isCurrent = month === currentMonth();
  // Keyboard focus starts on today's column (or the first day).
  const defaultCol = Math.max(sheet?.days.findIndex((d) => d.isToday) ?? 0, 0);

  return (
    <Page wide>
      <PageHeader
        title="Attendance"
        subtitle={sheet ? `${sheet.label} · ${sheet.employees.length} employee${sheet.employees.length === 1 ? '' : 's'}` : undefined}
        actions={
          <>
            <Button icon={<CalendarDays size={16} />} loading={busy === 'weekly'} disabled={!!busy || !sheet?.employees.length} onClick={fillWeekly} title="Mark W on each employee's weekly-off day where nothing is marked (up to today)">
              Fill weekly offs
            </Button>
            <Button variant="primary" icon={<CalendarCheck size={16} />} kbd="Alt+P" loading={busy === 'all'} disabled={!!busy} onClick={() => void markAll(today)}>
              Mark all present today
            </Button>
          </>
        }
      />
      <Card padded={false}>
        <div className="att-toolbar">
          <div className="row-wrap">
            <MonthPicker value={month} onChange={setMonth} />
            {!isCurrent && (
              <Button size="sm" variant="ghost" onClick={() => setMonth(currentMonth())}>
                This month
              </Button>
            )}
            <div className="att-brush">
              <span>Click sets</span>
              <SegmentedControl<Brush> size="sm" value={brush} onChange={setBrush} options={brushOptions} />
            </div>
          </div>
          <span className="small muted" aria-live="polite">
            {pending > 0 ? 'Saving…' : q.loading && sheet ? 'Loading…' : 'All changes saved'}
          </span>
        </div>
        {q.error ? (
          <div className="card-body">
            <ErrorBox error={q.error} onRetry={q.reload} />
          </div>
        ) : !sheet ? (
          <Loading />
        ) : sheet.employees.length === 0 ? (
          <EmptyState
            icon={<Users size={36} />}
            title={`No employees in ${sheet.label}`}
            message="Employees appear here from their joining date until they leave."
            action={
              can('employees.view') && (
                <LinkButton to="/employees" variant="primary">
                  Go to employees
                </LinkButton>
              )
            }
          />
        ) : (
          <div className="att-grid-wrap">
            <table className="att-grid" role="grid" aria-label={`Attendance for ${sheet.label}`}>
              <colgroup>
                <col className="att-col-name" />
                {sheet.days.map((d) => (
                  <col key={d.date} className="att-col-day" />
                ))}
                {STATUS_ORDER.map((s) => (
                  <col key={s} className="att-col-total" />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th className="att-name">Employee</th>
                  {sheet.days.map((d) => (
                    <th key={d.date} className={`att-dayhead${d.weekday === 0 ? ' sun' : ''}${d.isToday ? ' today' : ''}${d.future ? ' future' : ''}`} title={formatDateLong(d.date)}>
                      {d.future ? (
                        <>
                          <div className="dn">{d.day}</div>
                          <div className="wd">{DAY_LETTER[d.weekday]}</div>
                        </>
                      ) : (
                        <button type="button" tabIndex={-1} onClick={() => void markDay(d.date)} title={`${formatDateLong(d.date)}: mark everyone not yet marked as present`}>
                          <span className="dn">{d.day}</span>
                          <span className="wd">{DAY_LETTER[d.weekday]}</span>
                        </button>
                      )}
                    </th>
                  ))}
                  {STATUS_ORDER.map((s, i) => (
                    <th key={s} className={`att-total-head${i === 0 ? ' first' : ''}`} title={`Days ${ATTENDANCE_LABELS[s].toLowerCase()}`}>
                      <span className={`att-swatch att-${s}`}>{s}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.employees.map((emp, r) => {
                  const em = marks[emp.id] ?? {};
                  const counts = countsFor(emp, em, sheet.days);
                  const sub = emp.lockedBy
                    ? 'Salary processed'
                    : emp.employedFrom && emp.employedFrom > `${month}-01`
                      ? `Joined ${formatDate(emp.employedFrom)}`
                      : emp.leaveDate && emp.leaveDate.slice(0, 7) === month
                        ? `Left ${formatDate(emp.leaveDate)}`
                        : emp.designation;
                  return (
                    <tr key={emp.id}>
                      <td className="att-name" title={emp.lockedBy ? `${emp.name}: salary processed (${emp.lockedBy.salaryNo}). Cancel the salary slip to change attendance.` : emp.name}>
                        <div className="att-name-main">
                          {emp.lockedBy && <Lock size={12} aria-label="Locked" />}
                          {can('employees.view') ? <Link to={`/employees/${emp.id}`}>{emp.name}</Link> : emp.name}
                        </div>
                        {sub && <div className="att-name-sub">{sub}</div>}
                      </td>
                      {sheet.days.map((d, c) => {
                        const m = em[d.date];
                        const enabled = canMark(emp, d.date, d.future);
                        const outside = !emp.employedFrom || d.date < emp.employedFrom || d.date > (emp.employedTo ?? '');
                        const off = !m && emp.weeklyOff === d.weekday && !outside && !d.future;
                        const cls = m ? `att-${m.status}` : d.future ? 'att-future' : outside ? 'att-outside' : off ? 'att-none att-off' : 'att-none';
                        const label = `${emp.name}, ${formatDate(d.date)}: ${m ? ATTENDANCE_LABELS[m.status] : outside ? 'not working here' : d.future ? 'future day' : off ? 'weekly off day, not marked' : 'not marked'}${m?.note ? ` (${m.note})` : ''}${emp.lockedBy && !outside ? ' · salary processed' : ''}`;
                        const isActive = active ? active.r === r && active.c === c : r === 0 && c === defaultCol;
                        return (
                          <td key={d.date} className={`att-cell${d.isToday ? ' today' : ''}`}>
                            <button
                              ref={(el) => {
                                if (el) cellRefs.current.set(`${r}:${c}`, el);
                                else cellRefs.current.delete(`${r}:${c}`);
                              }}
                              type="button"
                              className={`att-btn ${cls}${emp.lockedBy ? ' att-locked' : ''}`}
                              aria-disabled={!enabled}
                              aria-label={label}
                              title={label}
                              tabIndex={isActive ? 0 : -1}
                              onFocus={() => setActive({ r, c })}
                              onClick={() => enabled && apply(emp, d.date, brush)}
                              onKeyDown={(e) => onCellKey(e, r, c, emp, d.date, enabled)}
                            >
                              {m?.status ?? ''}
                            </button>
                          </td>
                        );
                      })}
                      {STATUS_ORDER.map((s, i) => (
                        <td key={s} className={`att-total${i === 0 ? ' first' : ''}${counts[s] ? '' : ' zero'}`}>
                          {counts[s]}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className="att-name">Present</td>
                  {sheet.days.map((d) => (
                    <td key={d.date}>{d.future ? '' : dayTotals[d.date] || ''}</td>
                  ))}
                  <td colSpan={STATUS_ORDER.length} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {sheet && sheet.employees.length > 0 && (
          <div className="att-footer-note">
            <AttendanceLegend />
            <span>
              Keyboard: arrow keys move · type <b>P A H L W</b> to mark · <b>Delete</b> clears · click a date to mark everyone present
            </span>
          </div>
        )}
      </Card>
    </Page>
  );
}
