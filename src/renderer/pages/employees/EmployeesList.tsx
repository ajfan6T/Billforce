import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Briefcase, CalendarCheck, UserPlus } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBox, LinkButton, Page, PageHeader, Stat, StatGrid, Toolbar } from '../../components/ui';
import { Checkbox, SearchInput } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { ExportButtons } from '../../components/report';
import { useDebounced, useHotkeys, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, monthLabel, todayISO } from '../../../shared/dates';
import { AttendanceMini, DueAmount, EmployeeStatusBadge, listReport, salaryLabel } from './common';
import { EmployeeFormModal } from './EmployeeFormModal';

type Row = ApiOutput<'employees.list'>[number];

export function EmployeesListPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const dq = useDebounced(q, 200);
  const list = useQuery('employees.list', { q: dq || null, includeInactive });
  const [adding, setAdding] = useState(false);
  const rows = list.data;
  // Same rule as the server: salaries and balances need the salary or manage permission.
  const showPay = can('employees.salary') || can('employees.manage');

  useHotkeys({ 'alt+n': () => can('employees.manage') && setAdding(true) });

  const totals = useMemo(() => {
    const t = { active: 0, advance: 0, due: 0, monthly: 0 };
    for (const r of rows ?? []) {
      if (r.isActive) t.active++;
      t.advance += r.outstandingAdvance ?? 0;
      t.due += r.salaryDue ?? 0;
      if (r.isActive && r.salaryType === 'monthly') t.monthly += r.salaryAmount ?? 0;
    }
    return t;
  }, [rows]);

  const month = monthLabel(todayISO().slice(0, 7), true);
  const columns: Array<Column<Row>> = [
    {
      key: 'name',
      label: 'Employee',
      render: (r) => (
        <div>
          <div className="emp-name">{r.name}</div>
          {r.designation && <span className="emp-sub">{r.designation}</span>}
        </div>
      ),
    },
    { key: 'phone', label: 'Phone', render: (r) => r.phone ?? <span className="faint">—</span> },
    ...(showPay
      ? ([
          { key: 'salaryAmount', label: 'Salary', align: 'right', value: (r) => r.salaryAmount, render: (r) => <span className="money">{salaryLabel(r.salaryType, r.salaryAmount)}</span> },
        ] as Array<Column<Row>>)
      : []),
    { key: 'attendance', label: `Attendance (${month.split(' ')[0]})`, sortable: false, render: (r) => <AttendanceMini counts={r.attendance} /> },
    ...(showPay
      ? ([
          { key: 'outstandingAdvance', label: 'Advance', type: 'money', render: (r) => <DueAmount value={r.outstandingAdvance} tone="adv" /> },
          { key: 'salaryDue', label: 'Salary due', type: 'money', render: (r) => <DueAmount value={r.salaryDue} /> },
        ] as Array<Column<Row>>)
      : []),
    { key: 'isActive', label: 'Status', value: (r) => (r.isActive ? 0 : 1), render: (r) => <EmployeeStatusBadge isActive={r.isActive} leaveDate={r.leaveDate} /> },
  ];

  const report = useMemo(
    () =>
      rows &&
      listReport(
        'Employees',
        `As on ${formatDate(todayISO())}${dq ? ` · matching "${dq}"` : ''}`,
        [
          { key: 'name', label: 'Employee', width: 24, get: (r: Row) => r.name },
          { key: 'designation', label: 'Designation', width: 16, get: (r) => r.designation },
          { key: 'phone', label: 'Phone', width: 14, get: (r) => r.phone },
          { key: 'joined', label: 'Joined', type: 'date', width: 11, get: (r) => r.joinDate },
          ...(showPay
            ? [
                { key: 'type', label: 'Paid by', width: 10, get: (r: Row) => (r.salaryType === 'monthly' ? 'Month' : 'Day') },
                { key: 'salary', label: 'Salary / wage', type: 'money' as const, width: 13, get: (r: Row) => r.salaryAmount },
                { key: 'advance', label: 'Advance outstanding', type: 'money' as const, width: 14, get: (r: Row) => r.outstandingAdvance },
                { key: 'due', label: 'Salary due', type: 'money' as const, width: 13, get: (r: Row) => r.salaryDue },
              ]
            : []),
          { key: 'status', label: 'Status', width: 14, get: (r) => (r.isActive ? 'Working' : `Left ${formatDate(r.leaveDate)}`) },
        ],
        rows,
        {
          summary: [
            { label: 'Working', value: totals.active, type: 'number' },
            ...(showPay
              ? [
                  { label: 'Advances outstanding', value: totals.advance, type: 'money' as const },
                  { label: 'Salary due', value: totals.due, type: 'money' as const },
                ]
              : []),
          ],
          link: (r) => ({ kind: 'employee', id: r.id }),
          landscape: true,
        },
      ),
    [rows, dq, totals, showPay],
  );

  const noneYet = !list.loading && !dq && !includeInactive && rows?.length === 0;

  return (
    <Page>
      <PageHeader
        title="Employees"
        subtitle={rows ? `${totals.active} working${includeInactive && rows.length > totals.active ? ` · ${rows.length - totals.active} left` : ''}` : undefined}
        actions={
          <>
            {can('employees.attendance') && (
              <LinkButton to="/employees/attendance" icon={<CalendarCheck size={16} />}>
                Attendance
              </LinkButton>
            )}
            {can('employees.manage') && (
              <Button variant="primary" icon={<UserPlus size={16} />} kbd="Alt+N" onClick={() => setAdding(true)}>
                Add employee
              </Button>
            )}
          </>
        }
      />
      {showPay && (
        <StatGrid>
          <Stat label="Employees working" value={String(totals.active)} icon={<Briefcase size={18} />} hint={totals.monthly ? `Monthly salaries ${formatINR(totals.monthly)}` : undefined} />
          <Stat label="Salary due" value={formatINR(totals.due)} tone={totals.due ? 'red' : undefined} hint="Processed but not yet paid" />
          <Stat label="Advances outstanding" value={formatINR(totals.advance)} tone={totals.advance ? 'amber' : undefined} hint="To be recovered from salary" />
        </StatGrid>
      )}
      <Card padded={false}>
        <div className="emp-card-toolbar">
          <Toolbar>
            <SearchInput value={q} onChange={setQ} placeholder="Search name, phone or designation…" autoFocus className="emp-search" />
            <Checkbox checked={includeInactive} onChange={setIncludeInactive} label="Show employees who left" />
          </Toolbar>
          <ExportButtons report={report} />
        </div>
        {list.error ? (
          <div className="card-body">
            <ErrorBox error={list.error} onRetry={list.reload} />
          </div>
        ) : noneYet ? (
          <EmptyState
            icon={<Briefcase size={36} />}
            title="No employees yet"
            message="Add the people who work for you to keep their attendance, salary and advances in one place."
            action={
              can('employees.manage') && (
                <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setAdding(true)}>
                  Add employee
                </Button>
              )
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            loading={list.loading}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/employees/${r.id}`)}
            rowClassName={(r) => (r.isActive ? '' : 'emp-inactive')}
            empty={dq ? `No employees match "${dq}"` : 'No employees'}
            footer={
              showPay && rows && rows.length > 1
                ? {
                    name: `${rows.length} employees`,
                    outstandingAdvance: <span className="money">{formatINR(totals.advance)}</span>,
                    salaryDue: <span className="money">{formatINR(totals.due)}</span>,
                  }
                : undefined
            }
          />
        )}
      </Card>
      <EmployeeFormModal
        open={adding}
        initialName={q}
        onClose={() => setAdding(false)}
        onSaved={(e) => {
          setAdding(false);
          navigate(`/employees/${e.id}`);
        }}
      />
    </Page>
  );
}
