import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, Undo2 } from 'lucide-react';
import type { ApiOutput } from '../../api';
import { useDebounced, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { Badge, Button, EmptyState, ErrorBox, LinkButton, Page, PageHeader, Toolbar } from '../../components/ui';
import { SearchInput, Select } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker, ExportButtons, rangeFromPreset, type RangeValue } from '../../components/report';
import { PAYMENT_MODE_LABELS } from '../../../shared/constants';
import { formatINR } from '../../../shared/money';
import { describeRange, formatDate, todayISO } from '../../../shared/dates';
import type { ReportData } from '../../../shared/report';
import { RefundBadge, StatusBadge } from './common';

type Row = ApiOutput<'returns.list'>['rows'][number];
const PAGE = 200;

export function ReturnsList() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [range, setRange] = useState<RangeValue>(() => rangeFromPreset('this_month', todayISO()));
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'' | 'return' | 'adjustment'>('');
  const [status, setStatus] = useState<'' | 'active' | 'cancelled'>('');
  const [limit, setLimit] = useState(PAGE);
  const dq = useDebounced(q, 250);
  useEffect(() => setLimit(PAGE), [range.from, range.to, dq, kind, status]);
  const list = useQuery('returns.list', { from: range.from, to: range.to, q: dq.trim() || null, kind: kind || null, status: status || null, limit });
  const data = list.data;

  const columns: Array<Column<Row>> = [
    { key: 'cnNo', label: 'Number', render: (r) => <span className="sl-cell-main">{r.cnNo}</span> },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'kind', label: 'Type', render: (r) => (r.kind === 'return' ? <Badge tone="blue">Goods returned</Badge> : <Badge tone="purple">Credit note</Badge>) },
    { key: 'billNo', label: 'Against bill', render: (r) => r.billNo ?? <span className="faint">—</span> },
    { key: 'customerName', label: 'Customer', render: (r) => r.customerName ?? <span className="faint">Walk-in</span> },
    { key: 'reason', label: 'Reason', render: (r) => <span className="sl-cell-items" title={r.reason ?? ''}>{r.reason ?? ''}</span> },
    { key: 'refundMode', label: 'Refund', render: (r) => <RefundBadge mode={r.refundMode} /> },
    { key: 'total', label: 'Amount', type: 'money' },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];

  const report = useMemo<ReportData | null>(() => {
    if (!data) return null;
    return {
      title: 'Sales returns & credit notes',
      subtitle: describeRange({ from: data.from, to: data.to }),
      columns: [
        { key: 'no', label: 'Number', width: 16, nowrap: true },
        { key: 'date', label: 'Date', type: 'date', width: 11 },
        { key: 'kind', label: 'Type', width: 14 },
        { key: 'bill', label: 'Against bill', width: 16, nowrap: true },
        { key: 'customer', label: 'Customer', width: 22 },
        { key: 'reason', label: 'Reason', width: 30 },
        { key: 'refund', label: 'Refund', width: 16 },
        { key: 'total', label: 'Amount', type: 'money', width: 13 },
        { key: 'status', label: 'Status', width: 10 },
      ],
      rows: [
        ...data.rows.map((r) => ({
          cells: {
            no: r.cnNo,
            date: r.date,
            kind: r.kind === 'return' ? 'Goods returned' : 'Credit note',
            bill: r.billNo ?? '',
            customer: r.customerName ?? 'Walk-in',
            reason: r.reason ?? '',
            refund: r.refundMode === 'credit' ? 'Adjusted in account' : PAYMENT_MODE_LABELS[r.refundMode],
            total: r.total,
            status: r.status === 'active' ? 'Active' : 'Cancelled',
          },
          style: r.status === 'cancelled' ? ('muted' as const) : undefined,
          link: { kind: 'credit_note', id: r.id },
        })),
        { cells: { no: 'Total (active)', total: data.totals.total }, style: 'total' as const },
      ],
      summary: [
        { label: 'Total', value: data.totals.total, type: 'money' },
        { label: 'Refunded', value: data.totals.refunded, type: 'money' },
        { label: 'Adjusted in accounts', value: data.totals.adjusted, type: 'money' },
      ],
      landscape: true,
    };
  }, [data]);

  return (
    <Page>
      <PageHeader
        title="Returns & credit notes"
        subtitle="Goods returned by customers, and amounts credited without goods."
        actions={
          <>
            <ExportButtons report={report} disabled={!data?.rows.length} />
            {(can('returns.create') || can('returns.adjust')) && (
              <LinkButton to={can('returns.create') ? '/sales/returns/new' : '/sales/returns/new?kind=adjustment'} variant="primary" icon={<Plus size={16} />}>
                {can('returns.create') ? 'New return' : 'New credit note'}
              </LinkButton>
            )}
          </>
        }
      />
      <Toolbar className="sl-bill-filters">
        <DateRangePicker value={range} onChange={setRange} />
        <Select<'' | 'return' | 'adjustment'>
          value={kind}
          onChange={setKind}
          aria-label="Type"
          options={[
            { value: '', label: 'All types' },
            { value: 'return', label: 'Goods returned' },
            { value: 'adjustment', label: 'Credit notes' },
          ]}
        />
        <Select<'' | 'active' | 'cancelled'>
          value={status}
          onChange={setStatus}
          aria-label="Status"
          options={[
            { value: '', label: 'Any status' },
            { value: 'active', label: 'Active only' },
            { value: 'cancelled', label: 'Cancelled only' },
          ]}
        />
        <SearchInput value={q} onChange={setQ} placeholder="Number, bill no, customer, reason…" />
      </Toolbar>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {data && (
        <div className="sl-list-summary">
          <div className="sl-ls-item">
            <div className="sl-ls-label">Returns & credit notes</div>
            <div className="sl-ls-value">{data.totals.count - data.totals.cancelledCount}</div>
          </div>
          <div className="sl-ls-item">
            <div className="sl-ls-label">Total</div>
            <div className="sl-ls-value">{formatINR(data.totals.total)}</div>
          </div>
          <div className="sl-ls-item">
            <div className="sl-ls-label">Money refunded</div>
            <div className="sl-ls-value">{formatINR(data.totals.refunded)}</div>
          </div>
          <div className="sl-ls-item">
            <div className="sl-ls-label">Adjusted in accounts</div>
            <div className="sl-ls-value">{formatINR(data.totals.adjusted)}</div>
          </div>
        </div>
      )}
      <div className="card sl-list-card">
        <DataTable<Row>
          columns={columns}
          rows={data?.rows}
          rowKey={(r) => r.id}
          loading={list.loading}
          onRowClick={(r) => navigate(`/sales/returns/${r.id}`)}
          rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
          footer={{ cnNo: `${data?.totals.count ?? 0} total`, total: <span className="money">{formatINR(data?.totals.total)}</span> }}
          empty={
            <EmptyState
              icon={<Undo2 size={32} />}
              title={dq || kind || status ? 'Nothing matches your search' : `No returns ${range.from === range.to ? `on ${formatDate(range.from)}` : 'in this period'}`}
              message="When a customer returns goods, open the bill and choose “Sales return”, or start here."
              action={
                can('returns.create') || can('returns.adjust') ? (
                  <LinkButton to={can('returns.create') ? '/sales/returns/new' : '/sales/returns/new?kind=adjustment'} icon={<Plus size={16} />}>
                    {can('returns.create') ? 'New return' : 'New credit note'}
                  </LinkButton>
                ) : undefined
              }
            />
          }
        />
        {data?.hasMore && (
          <div className="sl-load-more">
            <Button size="sm" onClick={() => setLimit((l) => l + PAGE)} loading={list.loading}>
              Show more
            </Button>
          </div>
        )}
      </div>
    </Page>
  );
}
