import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, ReceiptText } from 'lucide-react';
import { type ApiOutput } from '../../api';
import { useDebounced, useQuery, useHotkeys } from '../../hooks';
import { useAuth } from '../../auth';
import { Badge, Button, EmptyState, ErrorBox, LinkButton, Page, PageHeader, Toolbar } from '../../components/ui';
import { SearchInput, Select } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker, ExportButtons, rangeFromPreset, type RangeValue } from '../../components/report';
import { BILL_PAYMENT_MODE_LABELS, billPaymentLabel, type BillPaymentMode } from '../../../shared/billing';
import { formatINR } from '../../../shared/money';
import { describeRange, formatDate, formatTime, todayISO } from '../../../shared/dates';
import type { ReportData } from '../../../shared/report';
import { ModeBadge, StatusBadge } from './common';

type Row = ApiOutput<'sales.list'>['rows'][number];

const PAGE = 200;
/** Searching by bill number, customer or item looks at every date (finding an old bill to reprint). */
const ALL_DATES_FROM = '2000-01-01';

export function BillsList() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const canViewAll = can('billing.view');
  const [range, setRange] = useState<RangeValue>(() => rangeFromPreset('today', todayISO()));
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | 'active' | 'cancelled'>('');
  const [mode, setMode] = useState<'' | BillPaymentMode>('');
  const [limit, setLimit] = useState(PAGE);
  const dq = useDebounced(q, 250);

  useEffect(() => setLimit(PAGE), [range.from, range.to, dq, status, mode]);

  const searchAll = canViewAll && !!dq.trim();
  const list = useQuery('sales.list', {
    from: searchAll ? ALL_DATES_FROM : range.from,
    to: searchAll ? (todayISO() > range.to ? todayISO() : range.to) : range.to,
    q: dq.trim() || null,
    status: status || null,
    paymentMode: mode || null,
    limit,
  });
  useHotkeys({ F3: () => (document.querySelector('.sl-bill-filters input[type=search]') as HTMLInputElement | null)?.focus() });

  const data = list.data;
  const columns: Array<Column<Row>> = [
    {
      key: 'billNo',
      label: 'Bill no',
      render: (r) => (
        <span>
          <span className="sl-cell-main nowrap">{r.billNo}</span>
          {r.edited && (
            <span className="sl-cell-sub">
              <Badge tone="blue">Edited</Badge>
            </span>
          )}
        </span>
      ),
    },
    { key: 'date', label: 'Date', value: (r) => `${r.date} ${r.createdAt.slice(11)}`, render: (r) => <span className="nowrap">{formatDate(r.date)} <span className="sl-cell-sub">{r.createdAt.slice(0, 10) === r.date ? formatTime(r.createdAt) : ''}</span></span> },
    {
      key: 'customerName',
      label: 'Customer',
      render: (r) =>
        r.customerName ? (
          <span>
            {r.customerName}
            {r.customerPhone && <span className="sl-cell-sub">{r.customerPhone}</span>}
          </span>
        ) : (
          <span className="faint">Walk-in</span>
        ),
    },
    { key: 'itemsSummary', label: 'Items', render: (r) => <span className="sl-cell-items" title={r.itemsSummary}>{r.itemsSummary}</span> },
    { key: 'total', label: 'Total', type: 'money' },
    { key: 'paid', label: 'Paid', type: 'money' },
    { key: 'credit', label: 'Credit', type: 'money', render: (r) => (r.credit ? <span className="money" style={{ color: 'var(--warning)' }}>{formatINR(r.credit)}</span> : <span className="faint">—</span>) },
    { key: 'paymentMode', label: 'Mode', render: (r) => <ModeBadge mode={r.paymentMode} credit={r.credit} /> },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];

  const report = useMemo<ReportData | null>(() => {
    if (!data) return null;
    return {
      title: 'Bills',
      subtitle: `${searchAll ? 'All dates' : describeRange({ from: data.from, to: data.to })}${status ? ` · ${status === 'active' ? 'Active' : 'Cancelled'}` : ''}${mode ? ` · ${BILL_PAYMENT_MODE_LABELS[mode]}` : ''}${dq ? ` · "${dq}"` : ''}`,
      columns: [
        { key: 'billNo', label: 'Bill no', width: 16 },
        { key: 'date', label: 'Date', type: 'date', width: 11 },
        { key: 'customer', label: 'Customer', width: 24 },
        { key: 'phone', label: 'Phone', width: 14 },
        { key: 'items', label: 'Items', width: 36 },
        { key: 'total', label: 'Total', type: 'money', width: 13 },
        { key: 'paid', label: 'Paid', type: 'money', width: 13 },
        { key: 'credit', label: 'Credit', type: 'money', width: 13 },
        { key: 'mode', label: 'Mode', width: 8 },
        { key: 'status', label: 'Status', width: 10 },
      ],
      rows: [
        ...data.rows.map((r) => ({
          cells: {
            billNo: r.billNo,
            date: r.date,
            customer: r.customerName ?? 'Walk-in',
            phone: r.customerPhone ?? '',
            items: r.itemsSummary,
            total: r.total,
            paid: r.paid,
            credit: r.credit,
            mode: billPaymentLabel(r.paymentMode, r.credit),
            status: r.status === 'active' ? 'Active' : 'Cancelled',
          },
          style: r.status === 'cancelled' ? ('muted' as const) : undefined,
          link: { kind: 'bill', id: r.id },
        })),
        { cells: { billNo: 'Total (active bills)', total: data.totals.total, paid: data.totals.paid, credit: data.totals.credit }, style: 'total' as const },
      ],
      summary: [
        { label: 'Bills', value: data.totals.count - data.totals.cancelledCount, type: 'number' },
        { label: 'Sales', value: data.totals.total, type: 'money' },
        { label: 'Received', value: data.totals.paid, type: 'money' },
        { label: 'On credit', value: data.totals.credit, type: 'money' },
        { label: 'Cancelled', value: data.totals.cancelledCount, type: 'number' },
      ],
      notes: data.hasMore ? [`Showing the first ${data.rows.length} bills. Narrow the period to export all.`] : undefined,
      landscape: true,
    };
  }, [data, status, mode, dq, searchAll]);

  return (
    <Page>
      <PageHeader
        title="Bills"
        subtitle={data?.todayOnly ? "Today's bills. You can see bills of other days only with permission." : 'Every bill, with who made it and how it was paid.'}
        actions={
          <>
            <ExportButtons report={report} disabled={!data?.rows.length} />
            {can('billing.create') && (
              <LinkButton to="/billing/new" variant="primary" icon={<Plus size={16} />}>
                New bill
              </LinkButton>
            )}
          </>
        }
      />
      <Toolbar className="sl-bill-filters">
        {canViewAll && <DateRangePicker value={range} onChange={setRange} />}
        <Select<'' | 'active' | 'cancelled'>
          value={status}
          onChange={setStatus}
          aria-label="Status"
          options={[
            { value: '', label: 'All bills' },
            { value: 'active', label: 'Active only' },
            { value: 'cancelled', label: 'Cancelled only' },
          ]}
        />
        <Select<'' | BillPaymentMode>
          value={mode}
          onChange={setMode}
          aria-label="Payment mode"
          options={[
            { value: '', label: 'All payment modes' },
            ...(['cash', 'upi', 'bank', 'credit'] as const).map((m) => ({ value: m, label: BILL_PAYMENT_MODE_LABELS[m] })),
            { value: 'split', label: 'Split / part paid' },
          ]}
        />
        <SearchInput value={q} onChange={setQ} placeholder="Bill no, customer, phone, item… (F3)" />
      </Toolbar>

      {searchAll && <p className="small muted sl-search-all">Searching bills of all dates for “{dq.trim()}”. Clear the search to see the chosen period again.</p>}
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {data && (
        <div className="sl-list-summary">
          <div className="sl-ls-item">
            <div className="sl-ls-label">Bills</div>
            <div className="sl-ls-value">{data.totals.count - data.totals.cancelledCount}</div>
          </div>
          <div className="sl-ls-item">
            <div className="sl-ls-label">Sales</div>
            <div className="sl-ls-value">{formatINR(data.totals.total)}</div>
          </div>
          <div className="sl-ls-item">
            <div className="sl-ls-label">Received now</div>
            <div className="sl-ls-value">{formatINR(data.totals.paid)}</div>
          </div>
          <div className="sl-ls-item">
            <div className="sl-ls-label">On credit</div>
            <div className={`sl-ls-value${data.totals.credit ? ' warn' : ''}`}>{formatINR(data.totals.credit)}</div>
          </div>
          {data.totals.discount > 0 && (
            <div className="sl-ls-item">
              <div className="sl-ls-label">Discounts given</div>
              <div className="sl-ls-value">{formatINR(data.totals.discount)}</div>
            </div>
          )}
          {data.totals.cancelledCount > 0 && (
            <div className="sl-ls-item">
              <div className="sl-ls-label">Cancelled</div>
              <div className="sl-ls-value">{data.totals.cancelledCount}</div>
            </div>
          )}
        </div>
      )}

      <div className="card sl-list-card">
        <DataTable<Row>
          columns={columns}
          rows={data?.rows}
          rowKey={(r) => r.id}
          loading={list.loading}
          onRowClick={(r) => navigate(`/sales/bills/${r.id}`)}
          rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
          footer={{
            billNo: `${data?.totals.count ?? 0} bill${data?.totals.count === 1 ? '' : 's'}`,
            total: <span className="money">{formatINR(data?.totals.total)}</span>,
            paid: <span className="money">{formatINR(data?.totals.paid)}</span>,
            credit: <span className="money">{formatINR(data?.totals.credit)}</span>,
          }}
          empty={
            <EmptyState
              icon={<ReceiptText size={32} />}
              title={dq || status || mode ? 'No bills match your search' : 'No bills in this period'}
              message={dq || status || mode ? 'Try a different search or clear the filters.' : range.preset === 'today' ? 'Bills you make today will show up here.' : 'Choose a different period.'}
              action={
                can('billing.create') && !dq ? (
                  <LinkButton to="/billing/new" variant="primary" icon={<Plus size={16} />}>
                    Make a bill
                  </LinkButton>
                ) : undefined
              }
            />
          }
        />
        {data?.hasMore && (
          <div className="sl-load-more">
            <Button size="sm" onClick={() => setLimit((l) => l + PAGE)} loading={list.loading}>
              Show more bills
            </Button>
          </div>
        )}
      </div>
      <p className="faint small mt-1">Totals leave out cancelled bills. Click a bill to see it, reprint, edit or cancel it.</p>
    </Page>
  );
}
