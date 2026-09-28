import { useState } from 'react';
import { ErrorBox, Loading } from '../../components/ui';
import { useQuery } from '../../hooks';
import { formatDate } from '../../../shared/dates';
import { ATTENDANCE_LABELS } from '../../../shared/constants';
import { AttendanceChips, MonthPicker, WEEKDAY_SHORT, currentMonth } from './common';

/** One employee's attendance for a month as a small calendar. */
export function MiniCalendar({ employeeId, minMonth, initialMonth }: { employeeId: number; minMonth?: string; initialMonth?: string }) {
  const [month, setMonth] = useState(initialMonth && initialMonth < currentMonth() ? initialMonth : currentMonth());
  const q = useQuery('attendance.month', { month, employeeId });
  const sheet = q.data;
  const emp = sheet?.employees[0];

  return (
    <div className="stack-sm mini-cal-wrap">
      <MonthPicker value={month} onChange={setMonth} min={minMonth} />
      {q.error ? (
        <ErrorBox error={q.error} onRetry={q.reload} />
      ) : !sheet || !emp ? (
        <Loading />
      ) : (
        <>
          <div className="mini-cal" aria-label={`Attendance ${sheet.label}`}>
            {WEEKDAY_SHORT.map((d) => (
              <div key={d} className="mc-head">
                {d.slice(0, 2)}
              </div>
            ))}
            {Array.from({ length: sheet.days[0].weekday }, (_, i) => (
              <div key={`b${i}`} />
            ))}
            {sheet.days.map((d) => {
              const m = emp.marks[d.date];
              const outside = !emp.employedFrom || d.date < emp.employedFrom || d.date > (emp.employedTo ?? '');
              const off = !m && !outside && !d.future && emp.weeklyOff === d.weekday;
              const cls = m ? `att-${m.status}` : d.future ? 'future' : outside ? 'outside' : off ? 'off' : '';
              const title = `${formatDate(d.date)}: ${m ? ATTENDANCE_LABELS[m.status] : outside ? 'not working here' : d.future ? '' : off ? 'weekly off (not marked)' : 'not marked'}${m?.note ? ` · ${m.note}` : ''}`;
              return (
                <div key={d.date} className={`mc-day ${cls}${d.isToday ? ' today' : ''}`} title={title}>
                  <span>{d.day}</span>
                  {m && <b>{m.status}</b>}
                </div>
              );
            })}
          </div>
          <div className="mini-cal-counts">
            <AttendanceChips counts={emp.counts} />
          </div>
        </>
      )}
    </div>
  );
}
