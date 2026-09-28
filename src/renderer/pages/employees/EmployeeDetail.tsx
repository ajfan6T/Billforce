import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Calculator, CalendarCheck, HandCoins, IndianRupee, Pencil, UserCheck, UserMinus, Wallet } from 'lucide-react';
import { Alert, Button, Card, ErrorBox, KeyValues, Loading, Page, PageHeader, Stat, StatGrid, Tabs } from '../../components/ui';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker, ExportButtons, ReportView, rangeFromPreset, type RangeValue } from '../../components/report';
import { useHotkeys, useQuery, useStoredState } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { useLinkedPeriod, useOpenLink } from '../../links';
import { call, type ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { describeRange, formatDate, monthLabel } from '../../../shared/dates';
import { EmployeeStatusBadge, ModeBadge, SalaryStatusBadge, WEEKDAYS, currentMonth, fmtDays, shiftMonth } from './common';
import { EmployeeFormModal } from './EmployeeFormModal';
import { LeaveModal } from './LeaveModal';
import { AdvanceModal } from './AdvanceModal';
import { AdvanceDetailModal } from './AdvanceDetailModal';
import { ProcessSalaryModal } from './ProcessSalaryModal';
import { PaySalaryModal, type PayTarget } from './PaySalaryModal';
import { MiniCalendar } from './MiniCalendar';

type SlipRow = ApiOutput<'salary.list'>['rows'][number];
type AdvanceRow = ApiOutput<'advances.list'>['rows'][number];
type Tab = 'slips' | 'advances' | 'ledger';

export function EmployeeDetailPage() {
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const navigate = useNavigate();
  const openLink = useOpenLink();
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const canSalary = can('employees.salary');
  const [tab, setTab] = useStoredState<Tab>('employee.tab', 'slips');
  // A trial balance row opens the employee on the report's period.
  const linkedPeriod = useLinkedPeriod();
  const [range, setRange] = useState<RangeValue>(() => linkedPeriod ?? rangeFromPreset('this_fy'));
  const [editing, setEditing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [giving, setGiving] = useState(false);
  const [processMonth, setProcessMonth] = useState<string | null>(null);
  const [paying, setPaying] = useState<PayTarget | null>(null);
  const [advanceId, setAdvanceId] = useState<number | null>(null);

  const q = useQuery('employees.get', valid ? { id } : null);
  const slips = useQuery('salary.list', valid && canSalary && tab === 'slips' ? { employeeId: id } : null);
  const advances = useQuery('advances.list', valid && canSalary && tab === 'advances' ? { employeeId: id } : null);
  const ledger = useQuery('employees.ledger', valid && canSalary && tab === 'ledger' ? { employeeId: id, from: range.from, to: range.to } : null);
  const e = q.data;

  const reloadAll = () => {
    void q.reload();
    if (tab === 'slips') void slips.reload();
    if (tab === 'advances') void advances.reload();
    if (tab === 'ledger') void ledger.reload();
  };

  const openProcess = async () => {
    // Last month if it is still pending, otherwise this month.
    const prev = shiftMonth(currentMonth(), -1);
    try {
      const p = await call('salary.preview', { employeeId: id, month: prev });
      setProcessMonth(!p.problemKind ? prev : currentMonth());
    } catch {
      setProcessMonth(currentMonth());
    }
  };

  useHotkeys(
    {
      'alt+a': () => e?.isActive && canSalary && setGiving(true),
      'alt+s': () => canSalary && void openProcess(),
    },
    [e?.id, e?.isActive, canSalary],
  );

  if (!valid) return <Page><ErrorBox error="This employee link is not valid." /></Page>;
  if (q.error) return <Page><PageHeader title="Employee" back="/employees" /><ErrorBox error={q.error} onRetry={q.reload} /></Page>;
  if (!e) return <Loading />;

  const reactivate = async () => {
    const ok = await dialogs.confirm({
      title: `Re-activate ${e.name}?`,
      message: `${e.name} will appear on the attendance sheet and in the employee pickers again. The leaving date${e.leaveDate ? ` (${formatDate(e.leaveDate)})` : ''} is removed.`,
      confirmText: 'Re-activate',
    });
    if (!ok) return;
    try {
      await call('employees.setActive', { id: e.id, active: true });
      toast.success(`${e.name} is active again`);
      reloadAll();
    } catch (err) {
      toast.error(err);
    }
  };

  const slipColumns: Array<Column<SlipRow>> = [
    {
      key: 'month',
      label: 'Month',
      render: (r) => (
        <div className="nowrap">
          <div className="bold">{monthLabel(r.month)}</div>
          <span className="emp-sub">{r.salaryNo}</span>
        </div>
      ),
    },
    { key: 'paidDays', label: 'Paid days', align: 'right', render: (r) => <span className="nowrap">{`${fmtDays(r.paidDays)} / ${r.daysInMonth}`}</span> },
    { key: 'net', label: 'Net salary', type: 'money' },
    { key: 'paid', label: 'Paid', type: 'money' },
    { key: 'balance', label: 'Due', type: 'money', render: (r) => (r.balance ? <span className="money emp-due">{formatINR(r.balance)}</span> : <span className="emp-nil">—</span>) },
    { key: 'status', label: 'Status', render: (r) => <SalaryStatusBadge status={r.status} /> },
    {
      key: 'x',
      label: '',
      sortable: false,
      align: 'right',
      render: (r) =>
        r.balance > 0 ? (
          <span onClick={(ev) => ev.stopPropagation()}>
            <Button
              size="sm"
              variant="success"
              icon={<IndianRupee size={14} />}
              onClick={() => setPaying({ id: r.id, salaryNo: r.salaryNo, employeeName: r.employeeName, monthLabel: r.monthLabel, date: r.date, net: r.net, balance: r.balance })}
            >
              Pay
            </Button>
          </span>
        ) : null,
    },
  ];
  const advColumns: Array<Column<AdvanceRow>> = [
    { key: 'date', label: 'Date', type: 'date', width: 110 },
    { key: 'advanceNo', label: 'Advance no', render: (r) => <span className="bold">{r.advanceNo}</span> },
    { key: 'mode', label: 'Paid by', render: (r) => <ModeBadge mode={r.mode} /> },
    { key: 'remarks', label: 'Remarks', render: (r) => (r.status === 'cancelled' ? `Cancelled: ${r.cancelReason ?? ''}` : (r.remarks ?? <span className="faint">—</span>)) },
    { key: 'amount', label: 'Amount', type: 'money' },
  ];

  const showPay = e.showPay;
  return (
    <Page>
      <PageHeader
        back="/employees"
        title={
          <span className="row">
            {e.name}
            <EmployeeStatusBadge isActive={e.isActive} leaveDate={e.leaveDate} />
          </span>
        }
        subtitle={[e.designation, e.phone, e.joinDate ? `Joined ${formatDate(e.joinDate)}` : null].filter(Boolean).join(' · ')}
        actions={
          <>
            {canSalary && e.isActive && (
              <Button icon={<HandCoins size={16} />} kbd="Alt+A" onClick={() => setGiving(true)}>
                Give advance
              </Button>
            )}
            {canSalary && (
              <Button variant="primary" icon={<Calculator size={16} />} kbd="Alt+S" onClick={() => void openProcess()}>
                Process salary
              </Button>
            )}
            {can('employees.manage') && (
              <>
                <Button icon={<Pencil size={16} />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
                {e.isActive ? (
                  <Button variant="ghost" icon={<UserMinus size={16} />} onClick={() => setLeaving(true)}>
                    Mark as left
                  </Button>
                ) : (
                  <Button variant="ghost" icon={<UserCheck size={16} />} onClick={reactivate}>
                    Re-activate
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      {!e.isActive && (
        <div className="emp-banner">
          <Alert tone="neutral">
            {e.name} left on {formatDate(e.leaveDate)}. They no longer appear on the attendance sheet after that day. Their history stays in your books.
          </Alert>
        </div>
      )}
      {showPay && (
        <StatGrid>
          <Stat
            label={e.salaryType === 'monthly' ? 'Monthly salary' : 'Daily wage'}
            value={formatINR(e.salaryAmount)}
            icon={<Wallet size={18} />}
            hint={e.salaryType === 'monthly' ? 'Per month · absent days are cut' : 'Per day present or on paid leave'}
          />
          <Stat
            label="Advance outstanding"
            value={formatINR(e.outstandingAdvance)}
            tone={e.outstandingAdvance ? 'amber' : undefined}
            hint="Given and not yet recovered from salary"
          />
          <Stat label="Salary due" value={formatINR(e.salaryDue)} tone={e.salaryDue ? 'red' : undefined} hint="Processed but not yet paid" />
          {e.totals && (
            <Stat
              label="Salary this year"
              value={formatINR(e.totals.salaryThisFy)}
              hint={
                e.totals.lastSalaryMonth ? (
                  <>
                    Net pay {formatINR(e.totals.netThisFy)}
                    {e.totals.recoveredThisFy ? ` · ${formatINR(e.totals.recoveredThisFy)} advance recovered` : ''}
                    <br />
                    Last processed: {monthLabel(e.totals.lastSalaryMonth, true)}
                  </>
                ) : (
                  'No salary processed yet'
                )
              }
            />
          )}
        </StatGrid>
      )}
      <div className="emp-detail-grid emp-top-grid mb-2">
        <Card title="Details" className="emp-details-card">
          <KeyValues
            columns={3}
            items={[
              ['Phone', e.phone],
              ['Designation', e.designation],
              ['Joined', formatDate(e.joinDate)],
              !e.isActive && ['Left', formatDate(e.leaveDate)],
              ['Weekly off', e.weeklyOff === null ? 'None fixed' : WEEKDAYS[e.weeklyOff]],
              showPay && [`Advance before ${formatDate(e.booksStartDate)}`, e.openingAdvance ? formatINR(e.openingAdvance) : 'None'],
              ['ID proof', e.idProof],
              showPay && ['Bank / UPI details', e.bankDetails],
              ['Address', e.address],
              ['Notes', e.notes],
            ]}
          />
        </Card>
        <Card
          title={
            <span className="row">
              <CalendarCheck size={16} /> Attendance
            </span>
          }
          actions={
            can('employees.attendance') && e.isActive ? (
              <Link to="/employees/attendance" className="small">
                Mark attendance
              </Link>
            ) : undefined
          }
        >
          <MiniCalendar key={e.leaveDate ?? 'active'} employeeId={e.id} minMonth={e.joinDate?.slice(0, 7)} initialMonth={e.leaveDate?.slice(0, 7)} />
        </Card>
      </div>
      {canSalary ? (
        <Card padded={false}>
          <Tabs
            value={tab}
            onChange={(k) => setTab(k as Tab)}
            tabs={[
              { key: 'slips', label: 'Salary slips', count: e.totals?.slips },
              { key: 'advances', label: 'Advances' },
              { key: 'ledger', label: 'Ledger' },
            ]}
          />
          {tab === 'slips' &&
            (slips.error ? (
              <div className="card-body">
                <ErrorBox error={slips.error} onRetry={slips.reload} />
              </div>
            ) : (
              <DataTable
                columns={slipColumns}
                rows={slips.data?.rows}
                loading={slips.loading}
                rowKey={(r) => r.id}
                onRowClick={(r) => navigate(`/employees/salary/${r.id}`)}
                rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
                empty="No salary processed yet. Use Process salary at the top."
              />
            ))}
          {tab === 'advances' &&
            (advances.error ? (
              <div className="card-body">
                <ErrorBox error={advances.error} onRetry={advances.reload} />
              </div>
            ) : (
              <DataTable
                columns={advColumns}
                rows={advances.data?.rows}
                loading={advances.loading}
                rowKey={(r) => r.id}
                onRowClick={(r) => setAdvanceId(r.id)}
                rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
                empty="No advances given"
              />
            ))}
          {tab === 'ledger' && (
            <div className="emp-ledger">
              <div className="emp-card-toolbar">
                <DateRangePicker value={range} onChange={setRange} />
                <ExportButtons report={ledger.data} />
              </div>
              <ReportView
                report={ledger.data}
                loading={ledger.loading}
                error={ledger.error}
                onRetry={ledger.reload}
                onLink={(l) => (l.kind === 'advance' ? setAdvanceId(Number(l.id)) : openLink(l))}
                hideTitle
                emptyMessage={`No entries between ${describeRange(range)}.`}
              />
            </div>
          )}
        </Card>
      ) : (
        <Card title="Salary & advances">
          <div className="muted">You do not have permission to see salary and advance details. Ask the owner if you need it.</div>
        </Card>
      )}
      <EmployeeFormModal
        open={editing}
        employee={e}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          reloadAll();
        }}
      />
      <LeaveModal
        open={leaving}
        employee={e}
        onClose={() => setLeaving(false)}
        onSaved={() => {
          setLeaving(false);
          reloadAll();
        }}
      />
      <AdvanceModal
        open={giving}
        employeeId={e.id}
        lockEmployee
        onClose={() => setGiving(false)}
        onSaved={() => {
          setGiving(false);
          if (tab !== 'advances') setTab('advances');
          reloadAll();
        }}
      />
      <ProcessSalaryModal
        open={processMonth !== null}
        employeeId={e.id}
        month={processMonth ?? currentMonth()}
        onClose={() => setProcessMonth(null)}
        onSaved={(slip) => {
          setProcessMonth(null);
          navigate(`/employees/salary/${slip.id}`);
        }}
      />
      <PaySalaryModal
        open={!!paying}
        slip={paying}
        onClose={() => setPaying(null)}
        onSaved={() => {
          setPaying(null);
          reloadAll();
        }}
      />
      <AdvanceDetailModal id={advanceId} onClose={() => setAdvanceId(null)} onChanged={reloadAll} />
    </Page>
  );
}
