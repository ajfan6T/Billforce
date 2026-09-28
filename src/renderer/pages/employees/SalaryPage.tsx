import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Calculator, Eye, IndianRupee, Info, Users, WalletCards } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, ErrorBox, IconButton, LinkButton, Loading, Page, PageHeader, Stat, StatGrid } from '../../components/ui';
import { DataTable, type Column } from '../../components/table';
import { ExportButtons } from '../../components/report';
import { useHotkeys, useQuery, useStoredState } from '../../hooks';
import { useAuth } from '../../auth';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, monthLabel } from '../../../shared/dates';
import { MonthPicker, SalaryStatusBadge, currentMonth, fmtDays, listReport, salaryLabel, shiftMonth, SALARY_STATUS_LABELS } from './common';
import { ProcessSalaryModal } from './ProcessSalaryModal';
import { ProcessAllModal } from './ProcessAllModal';
import { PaySalaryModal, type PayTarget } from './PaySalaryModal';

type Row = ApiOutput<'salary.monthSheet'>['rows'][number];

/** Default month: last month during the first week (salary time), otherwise this month. */
function defaultMonth(): string {
  const m = currentMonth();
  return new Date().getDate() <= 7 ? shiftMonth(m, -1) : m;
}

export function SalaryPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [month, setMonth] = useStoredState('salary.month', defaultMonth());
  const safeMonth = month > currentMonth() ? currentMonth() : month;
  const q = useQuery('salary.monthSheet', { month: safeMonth });
  const [processing, setProcessing] = useState<number | null>(null);
  const [processAll, setProcessAll] = useState(false);
  const [paying, setPaying] = useState<PayTarget | null>(null);
  const [showRule, setShowRule] = useStoredState('salary.showRule', true);
  const sheet = q.data;
  const rows = sheet?.rows;
  const pending = rows?.filter((r) => !r.slip && !r.problem).length ?? 0;

  useHotkeys({ 'alt+a': () => pending > 0 && setProcessAll(true) }, [pending]);

  const payTarget = (r: Row): PayTarget | null =>
    r.slip ? { id: r.slip.id, salaryNo: r.slip.salaryNo, employeeName: r.employeeName, monthLabel: r.monthLabel, date: r.slip.date, net: r.slip.net, balance: r.slip.balance } : null;

  const columns: Array<Column<Row>> = [
    {
      key: 'employeeName',
      label: 'Employee',
      render: (r) => (
        <div>
          <div className="emp-name">{r.employeeName}</div>
          <span className="emp-sub nowrap">{salaryLabel(r.salaryType, r.rate)}</span>
        </div>
      ),
    },
    {
      key: 'paidDays',
      label: 'Paid days',
      align: 'right',
      value: (r) => r.slip?.paidDays ?? r.paidDays,
      render: (r) => (
        <span title={r.daysEmployed < r.daysInMonth ? `Worked ${r.daysEmployed} ${r.daysEmployed === 1 ? 'day' : 'days'} of ${r.daysInMonth}` : undefined}>
          <b>{fmtDays(r.slip?.paidDays ?? r.paidDays)}</b>
          <span className="faint"> / {r.daysInMonth}</span>
          {!r.slip && r.noAttendance && (
            <span
              className="emp-sub emp-warn nowrap"
              title={r.salaryType === 'monthly' ? 'No attendance marked this month: days not marked are paid, so this is a full month' : 'No attendance marked this month'}
            >
              No attendance
            </span>
          )}
        </span>
      ),
    },
    { key: 'gross', label: 'Salary earned', type: 'money', value: (r) => (r.slip ? r.slip.gross + r.slip.bonus - r.slip.deductions : r.gross) },
    {
      key: 'outstandingAdvance',
      label: 'Advance',
      type: 'money',
      render: (r) => (r.outstandingAdvance ? <span className="money emp-adv">{formatINR(r.outstandingAdvance)}</span> : <span className="emp-nil">—</span>),
    },
    {
      key: 'recovery',
      label: 'Recovery',
      type: 'money',
      value: (r) => (r.slip ? r.slip.advanceRecovery : r.suggestedRecovery),
      render: (r) => {
        const v = r.slip ? r.slip.advanceRecovery : r.suggestedRecovery;
        if (!v) return <span className="emp-nil">—</span>;
        return (
          <span className="money" title={r.slip ? 'Recovered in this salary' : `Suggested: the advance outstanding on ${formatDate(sheet?.date)}, up to the salary`}>
            {formatINR(v)}
            {!r.slip && <span className="faint"> *</span>}
          </span>
        );
      },
    },
    {
      key: 'net',
      label: 'Net salary',
      type: 'money',
      value: (r) => (r.slip ? r.slip.net : r.gross - r.suggestedRecovery),
      render: (r) => <span className={`money${r.slip ? ' bold' : ''}`}>{formatINR(r.slip ? r.slip.net : r.gross - r.suggestedRecovery)}</span>,
    },
    {
      key: 'paid',
      label: 'Paid',
      type: 'money',
      value: (r) => r.slip?.paid ?? null,
      render: (r) =>
        r.slip ? (
          <div>
            <span className="money">{formatINR(r.slip.paid)}</span>
            {r.slip.balance > 0 && <span className="emp-sub money emp-due">due {formatINR(r.slip.balance)}</span>}
          </div>
        ) : (
          <span className="emp-nil">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      value: (r) => (r.slip ? r.slip.status : r.problem ? 'z' : 'a'),
      render: (r) =>
        r.slip ? (
          <SalaryStatusBadge status={r.slip.status} />
        ) : r.problem ? (
          <span className="small muted" title={r.problem}>
            {r.problemKind === 'zero' ? 'Nothing earned' : r.problemKind === 'not_employed' ? 'Not working' : 'Not processed'}
          </span>
        ) : (
          <Badge tone="neutral">Not processed</Badge>
        ),
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      align: 'right',
      render: (r) => (
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          {r.slip ? (
            <>
              {r.slip.balance > 0 && (
                <Button size="sm" variant="success" icon={<IndianRupee size={14} />} onClick={() => setPaying(payTarget(r))} title={`Pay ${formatINR(r.slip.balance)} due`}>
                  Pay
                </Button>
              )}
              <IconButton label={`Open salary slip ${r.slip.salaryNo}`} icon={<Eye size={16} />} onClick={() => navigate(`/employees/salary/${r.slip!.id}`)} />
            </>
          ) : (
            (!r.problem || r.problemKind === 'zero') &&
            !sheet?.problem && (
              <Button size="sm" variant={r.problem ? 'ghost' : 'primary'} icon={<Calculator size={14} />} onClick={() => setProcessing(r.employeeId)}>
                Process
              </Button>
            )
          )}
        </div>
      ),
    },
  ];

  const report = useMemo(
    () =>
      sheet &&
      listReport(
        `Salary sheet - ${sheet.monthLabel}`,
        `${sheet.totals.processed} of ${sheet.totals.employees} processed`,
        [
          { key: 'name', label: 'Employee', width: 22, get: (r: Row) => r.employeeName },
          { key: 'designation', label: 'Designation', width: 14, get: (r) => r.designation },
          { key: 'rate', label: 'Salary / wage', width: 16, get: (r) => salaryLabel(r.salaryType, r.rate) },
          { key: 'paidDays', label: 'Paid days', type: 'number', width: 9, get: (r) => r.slip?.paidDays ?? r.paidDays },
          { key: 'gross', label: 'Gross', type: 'money', width: 12, get: (r) => r.slip?.gross ?? r.gross },
          { key: 'bonus', label: 'Bonus', type: 'money', width: 10, get: (r) => r.slip?.bonus ?? null },
          { key: 'deductions', label: 'Deductions', type: 'money', width: 11, get: (r) => r.slip?.deductions ?? null },
          { key: 'recovery', label: 'Advance recovered', type: 'money', width: 12, get: (r) => (r.slip ? r.slip.advanceRecovery : null) },
          { key: 'net', label: 'Net', type: 'money', width: 12, get: (r) => (r.slip ? r.slip.net : r.gross - r.suggestedRecovery) },
          { key: 'paid', label: 'Paid', type: 'money', width: 12, get: (r) => r.slip?.paid ?? null },
          { key: 'due', label: 'Due', type: 'money', width: 12, get: (r) => r.slip?.balance ?? null },
          { key: 'status', label: 'Status', width: 13, get: (r) => (r.slip ? `${SALARY_STATUS_LABELS[r.slip.status]} (${r.slip.salaryNo})` : 'Not processed') },
        ],
        sheet.rows,
        {
          landscape: true,
          summary: [
            { label: 'Employees', value: sheet.totals.employees, type: 'number' },
            { label: 'Net salary', value: sheet.totals.net, type: 'money' },
            { label: 'Paid', value: sheet.totals.paid, type: 'money' },
            { label: 'Due', value: sheet.totals.due, type: 'money' },
          ],
          link: (r) => (r.slip ? { kind: 'salary', id: r.slip.id } : { kind: 'employee', id: r.employeeId }),
          notes: [`Rows not yet processed show estimated figures from attendance, with the advance outstanding on ${formatDate(sheet.date)} recovered.`],
        },
      ),
    [sheet],
  );

  const t = sheet?.totals;
  return (
    <Page>
      <PageHeader
        title="Salary"
        subtitle={sheet ? `${sheet.monthLabel} · ${t!.processed} of ${t!.employees} processed` : monthLabel(safeMonth, true)}
        actions={
          <>
            <LinkButton to="/employees/advances" icon={<WalletCards size={16} />}>
              Advances
            </LinkButton>
            <Button variant="primary" icon={<Calculator size={16} />} kbd="Alt+A" disabled={!pending || !!sheet?.problem} onClick={() => setProcessAll(true)}>
              Process all remaining{pending ? ` (${pending})` : ''}
            </Button>
          </>
        }
      />
      {sheet && t && sheet.rows.length > 0 && (
        <StatGrid>
          <Stat label="Net salary" value={formatINR(t.net)} icon={<Users size={18} />} hint={t.processed < t.employees ? 'Includes estimates for employees not yet processed' : `${t.employees} employee${t.employees === 1 ? '' : 's'}`} />
          <Stat label="Paid" value={formatINR(t.paid)} tone={t.paid ? 'green' : undefined} />
          <Stat label="Still to pay" value={formatINR(t.due)} tone={t.due ? 'red' : undefined} hint="Processed but not yet paid" />
          <Stat
            label="Not processed"
            value={String(pending)}
            tone={pending ? 'amber' : undefined}
            hint={!pending ? 'All done for this month' : t.noAttendance ? `${t.noAttendance} with no attendance marked` : 'Use Process or Process all'}
          />
        </StatGrid>
      )}
      {showRule ? (
        <div className="mb-2">
          <Alert tone="blue" icon={<Info size={16} className="emp-alert-icon" />} title="How salary is worked out">
            <div className="salary-rule">
              <b>Monthly salary:</b> paid for every day of the month the employee works here, except absent days (a half day counts as half). Weekly offs, paid
              leave and days not marked are paid. Salary × paid days ÷ days in the month.
              <br />
              <b>Daily wages:</b> paid for each day present and each paid-leave day (a half day counts as half). Weekly offs, absent days and days not marked are not
              paid. Wage × paid days.
              <br />* Suggested recovery is the advance outstanding on the salary date, up to the salary. You can change it when you process.{' '}
              <button type="button" className="link-btn" onClick={() => setShowRule(false)}>
                Hide
              </button>
            </div>
          </Alert>
        </div>
      ) : null}
      <Card padded={false}>
        <div className="emp-card-toolbar">
          <div className="row-wrap">
            <MonthPicker value={safeMonth} onChange={setMonth} />
            {!showRule && (
              <button type="button" className="link-btn small" onClick={() => setShowRule(true)}>
                How is salary worked out?
              </button>
            )}
          </div>
          <ExportButtons report={report} />
        </div>
        {sheet?.problem && (
          <div className="card-body">
            <Alert tone="amber">{sheet.problem}</Alert>
          </div>
        )}
        {q.error ? (
          <div className="card-body">
            <ErrorBox error={q.error} onRetry={q.reload} />
          </div>
        ) : !sheet ? (
          <Loading />
        ) : sheet.rows.length === 0 ? (
          <EmptyState
            icon={<Users size={36} />}
            title={`No employees in ${sheet.monthLabel}`}
            message="Employees appear here for the months they work for you."
            action={
              can('employees.view') && (
                <LinkButton to="/employees" variant="primary">
                  Go to employees
                </LinkButton>
              )
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            loading={q.loading}
            rowKey={(r) => r.employeeId}
            onRowClick={(r) => (r.slip ? navigate(`/employees/salary/${r.slip.id}`) : !r.problem && !sheet.problem ? setProcessing(r.employeeId) : undefined)}
            footer={
              t && rows && rows.length > 1
                ? {
                    employeeName: `${rows.length} employees`,
                    gross: <span className="money">{formatINR(t.gross)}</span>,
                    net: <span className="money">{formatINR(t.net)}</span>,
                    paid: <span className="money">{formatINR(t.paid)}</span>,
                  }
                : undefined
            }
          />
        )}
      </Card>
      <ProcessSalaryModal
        open={processing !== null}
        employeeId={processing}
        month={safeMonth}
        onClose={() => setProcessing(null)}
        onSaved={() => {
          setProcessing(null);
          void q.reload();
        }}
      />
      <ProcessAllModal open={processAll} sheet={sheet} onClose={() => setProcessAll(false)} onDone={() => void q.reload()} />
      <PaySalaryModal
        open={!!paying}
        slip={paying}
        onClose={() => setPaying(null)}
        onSaved={() => {
          setPaying(null);
          void q.reload();
        }}
      />
    </Page>
  );
}
