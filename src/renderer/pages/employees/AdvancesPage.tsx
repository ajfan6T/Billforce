import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { HandCoins, Plus } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBox, Page, PageHeader, Stat, StatGrid, Badge } from '../../components/ui';
import { Select } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker, ExportButtons, rangeFromPreset, type RangeValue } from '../../components/report';
import { useHotkeys, useQuery } from '../../hooks';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { describeRange } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS } from '../../../shared/constants';
import { ModeBadge, listReport } from './common';
import { AdvanceModal } from './AdvanceModal';
import { AdvanceDetailModal } from './AdvanceDetailModal';

type Row = ApiOutput<'advances.list'>['rows'][number];

export function AdvancesPage() {
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useState<RangeValue>(() => rangeFromPreset('this_fy'));
  const [employeeId, setEmployeeId] = useState<number>(0);
  const [giving, setGiving] = useState(false);
  const employees = useQuery('employees.search', { includeInactive: true });
  const q = useQuery('advances.list', { from: range.from, to: range.to, employeeId: employeeId || null });
  const openId = Number(params.get('id')) || null;
  const setOpenId = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('id', String(id));
    else next.delete('id');
    setParams(next, { replace: true });
  };

  useHotkeys({ 'alt+n': () => setGiving(true) });

  const rows = q.data?.rows;
  const t = q.data?.totals;
  const empName = employees.data?.find((e) => e.id === employeeId)?.name;

  const columns: Array<Column<Row>> = [
    { key: 'date', label: 'Date', type: 'date', width: 110 },
    { key: 'advanceNo', label: 'Advance no', render: (r) => <span className="bold">{r.advanceNo}</span> },
    {
      key: 'employeeName',
      label: 'Employee',
      render: (r) => (
        <div onClick={(e) => e.stopPropagation()}>
          <Link to={`/employees/${r.employeeId}`}>{r.employeeName}</Link>
          {r.designation && <span className="emp-sub">{r.designation}</span>}
        </div>
      ),
    },
    { key: 'mode', label: 'Paid by', render: (r) => (r.status === 'cancelled' ? <Badge tone="red">Cancelled</Badge> : <ModeBadge mode={r.mode} />) },
    { key: 'remarks', label: 'Remarks', render: (r) => (r.status === 'cancelled' ? <span className="small">Cancelled: {r.cancelReason}</span> : (r.remarks ?? <span className="faint">—</span>)) },
    { key: 'amount', label: 'Amount', type: 'money' },
  ];

  const report = useMemo(
    () =>
      rows &&
      t &&
      listReport(
        'Employee advances',
        `${describeRange(range)}${empName ? ` · ${empName}` : ''}`,
        [
          { key: 'date', label: 'Date', type: 'date', width: 11, get: (r: Row) => r.date },
          { key: 'no', label: 'Advance no', width: 15, get: (r) => r.advanceNo },
          { key: 'employee', label: 'Employee', width: 22, get: (r) => r.employeeName },
          { key: 'mode', label: 'Paid by', width: 9, get: (r) => PAYMENT_MODE_LABELS[r.mode] },
          { key: 'remarks', label: 'Remarks', width: 28, get: (r) => (r.status === 'cancelled' ? `CANCELLED: ${r.cancelReason ?? ''}` : r.remarks) },
          { key: 'amount', label: 'Amount', type: 'money', width: 13, get: (r) => (r.status === 'cancelled' ? null : r.amount) },
        ],
        rows,
        {
          totals: { date: null, no: '', employee: `${t.count} advance${t.count === 1 ? '' : 's'}`, mode: '', remarks: '', amount: t.amount },
          summary: [
            { label: 'Advances given', value: t.amount, type: 'money' },
            { label: 'Outstanding today', value: t.outstanding, type: 'money' },
          ],
          link: (r) => ({ kind: 'advance', id: r.id }),
        },
      ),
    [rows, t, range, empName],
  );

  return (
    <Page>
      <PageHeader
        title="Advances"
        subtitle="Money given to employees ahead of their salary"
        actions={
          <Button variant="primary" icon={<Plus size={16} />} kbd="Alt+N" onClick={() => setGiving(true)}>
            Give advance
          </Button>
        }
      />
      {t && (
        <StatGrid>
          <Stat label={empName ? `Outstanding · ${empName}` : 'Outstanding today'} value={formatINR(t.outstanding)} tone={t.outstanding ? 'amber' : undefined} hint="Given and not yet recovered from salary" />
          <Stat label="Given in this period" value={formatINR(t.amount)} hint={`${t.count} advance${t.count === 1 ? '' : 's'}`} />
          <Stat label="By cash" value={formatINR(t.byMode.cash)} hint={`UPI ${formatINR(t.byMode.upi)} · Bank ${formatINR(t.byMode.bank)}`} />
        </StatGrid>
      )}
      <Card padded={false}>
        <div className="emp-card-toolbar">
          <div className="row-wrap">
            <DateRangePicker value={range} onChange={setRange} />
            <Select<number>
              value={employeeId}
              onChange={setEmployeeId}
              aria-label="Employee"
              style={{ width: 220 }}
              options={[{ value: 0, label: 'All employees' }, ...(employees.data ?? []).map((e) => ({ value: e.id, label: e.isActive ? e.name : `${e.name} (left)` }))]}
            />
          </div>
          <ExportButtons report={report} />
        </div>
        {q.error ? (
          <div className="card-body">
            <ErrorBox error={q.error} onRetry={q.reload} />
          </div>
        ) : !q.loading && rows?.length === 0 && !employeeId ? (
          <EmptyState
            icon={<HandCoins size={36} />}
            title="No advances in this period"
            message="When you give an employee money ahead of their salary, record it here. It is recovered when you process their salary."
            action={
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setGiving(true)}>
                Give advance
              </Button>
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            loading={q.loading}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpenId(r.id)}
            rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
            empty={empName ? `No advances to ${empName} in this period` : 'No advances'}
            footer={t && rows && rows.length > 1 ? { advanceNo: `${t.count} advances`, amount: <span className="money">{formatINR(t.amount)}</span> } : undefined}
          />
        )}
      </Card>
      <AdvanceModal
        open={giving}
        employeeId={employeeId || null}
        onClose={() => setGiving(false)}
        onSaved={() => {
          setGiving(false);
          void q.reload();
        }}
      />
      <AdvanceDetailModal id={openId} onClose={() => setOpenId(null)} onChanged={() => void q.reload()} />
    </Page>
  );
}
