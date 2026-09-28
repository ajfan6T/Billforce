import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, ShoppingBag } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBox, Page, PageHeader, Stat, StatGrid, Toolbar } from '../../components/ui';
import { SearchInput, Select } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker, ExportButtons } from '../../components/report';
import { useDebounced, useHotkeys, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { describeRange } from '../../../shared/dates';
import { CancelledBadge, fmtMode, listReport, ModeBadge, useRange } from '../customers/common';

type Row = ApiOutput<'purchases.list'>['rows'][number];

export function PurchasesListPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [range, setRange] = useRange('purchases.range', 'this_month');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | 'active' | 'cancelled'>('');
  const dq = useDebounced(q, 200);
  const list = useQuery('purchases.list', { from: range.from, to: range.to, q: dq || null, status: status || null });
  const t = list.data?.totals;

  useHotkeys({ 'alt+n': () => can('purchases.manage') && navigate('/purchases/new') });

  const columns: Array<Column<Row>> = [
    { key: 'date', label: 'Date', type: 'date', width: 110 },
    { key: 'purchaseNo', label: 'Purchase no', render: (r) => <span className="bold">{r.purchaseNo}</span> },
    {
      key: 'supplierName',
      label: 'Supplier',
      render: (r) => (
        <div>
          {r.supplierName ?? <span className="faint">Cash purchase</span>}
          {r.supplierBillNo && <span className="cell-sub">Bill {r.supplierBillNo}</span>}
        </div>
      ),
    },
    {
      key: 'items',
      label: 'Items',
      render: (r) => (
        <div>
          <span className="cell-sub" style={{ color: 'inherit' }}>
            {r.items}
          </span>
          {r.accountName !== 'Purchases' && <span className="cell-sub">{r.accountName}</span>}
        </div>
      ),
    },
    { key: 'paymentMode', label: 'Paid by', render: (r) => (r.status === 'cancelled' ? <CancelledBadge /> : <ModeBadge mode={r.paymentMode} credit={r.credit} />) },
    { key: 'total', label: 'Total', type: 'money' },
    { key: 'credit', label: 'On credit', type: 'money', render: (r) => (r.credit ? <span className="money">{formatINR(r.credit)}</span> : '') },
  ];

  const report = useMemo(() => {
    if (!list.data) return undefined;
    const r = listReport(
        'Purchase bills',
        describeRange(range),
        [
          { key: 'date', label: 'Date', type: 'date', width: 11, get: (r: Row) => r.date },
          { key: 'no', label: 'Purchase no', width: 16, get: (r) => r.purchaseNo },
          { key: 'supplier', label: 'Supplier', width: 22, get: (r) => r.supplierName ?? 'Cash purchase' },
          { key: 'billNo', label: 'Their bill no', width: 14, get: (r) => r.supplierBillNo },
          { key: 'items', label: 'Items', width: 30, get: (r) => r.items },
          { key: 'account', label: 'Account', width: 16, get: (r) => r.accountName },
          { key: 'mode', label: 'Paid by', width: 9, get: (r) => (r.status === 'cancelled' ? 'Cancelled' : fmtMode(r.paymentMode, r.credit)) },
          { key: 'total', label: 'Total', type: 'money', width: 13, get: (r) => (r.status === 'cancelled' ? null : r.total) },
          { key: 'paid', label: 'Paid', type: 'money', width: 13, get: (r) => (r.status === 'cancelled' ? null : r.paid) },
          { key: 'credit', label: 'On credit', type: 'money', width: 13, get: (r) => (r.status === 'cancelled' ? null : r.credit) },
        ],
        list.data.rows,
        {
          totals: { date: null, no: 'Total', supplier: `${list.data.totals.count} bills`, billNo: null, items: null, account: null, mode: null, total: list.data.totals.total, paid: list.data.totals.paid, credit: list.data.totals.credit },
          summary: [
            { label: 'Total purchases', value: list.data.totals.total, type: 'money' },
            { label: 'Paid', value: list.data.totals.paid, type: 'money' },
            { label: 'On credit', value: list.data.totals.credit, type: 'money' },
          ],
          link: (r) => ({ kind: 'purchase', id: r.id }),
        },
      );
    return { ...r, landscape: true };
  }, [list.data, range]);

  return (
    <Page>
      <PageHeader
        title="Purchase bills"
        subtitle="Goods and services bought from suppliers"
        actions={
          <>
            <ExportButtons report={report} />
            {can('purchases.manage') && (
              <Button variant="primary" icon={<Plus size={16} />} kbd="Alt+N" onClick={() => navigate('/purchases/new')}>
                New purchase
              </Button>
            )}
          </>
        }
      />
      <StatGrid>
        <Stat label="Total purchases" value={formatINR(t?.total ?? 0)} hint={`${t?.count ?? 0} bills · ${describeRange(range)}`} />
        <Stat label="Paid" value={formatINR(t?.paid ?? 0)} tone="green" />
        <Stat label="On credit" value={formatINR(t?.credit ?? 0)} tone={t?.credit ? 'red' : undefined} hint={t?.cancelled ? `${t.cancelled} cancelled not counted` : 'Added to supplier balances'} />
      </StatGrid>
      <Card padded={false} className="list-card">
        <div className="tab-toolbar">
          <Toolbar>
            <DateRangePicker value={range} onChange={setRange} />
            <SearchInput value={q} onChange={setQ} placeholder="Purchase no, supplier, bill no, item…" />
            <Select<'' | 'active' | 'cancelled'>
              value={status}
              onChange={setStatus}
              aria-label="Status"
              style={{ width: 150 }}
              options={[
                { value: '', label: 'All bills' },
                { value: 'active', label: 'Active only' },
                { value: 'cancelled', label: 'Cancelled only' },
              ]}
            />
          </Toolbar>
        </div>
        {list.error ? (
          <div className="card-body">
            <ErrorBox error={list.error} onRetry={list.reload} />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={list.data?.rows}
            loading={list.loading}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/purchases/${r.id}`)}
            rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
            empty={
              dq || status ? (
                'No purchase bills match your filters'
              ) : (
                <EmptyState
                  icon={<ShoppingBag size={32} />}
                  title="No purchases in this period"
                  message={`Nothing was bought between ${describeRange(range)}.`}
                  action={
                    can('purchases.manage') && (
                      <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/purchases/new')}>
                        New purchase
                      </Button>
                    )
                  }
                />
              )
            }
            footer={
              t && list.data!.rows.length
                ? {
                    date: `${t.count} bills`,
                    total: <span className="money">{formatINR(t.total)}</span>,
                    credit: <span className="money">{formatINR(t.credit)}</span>,
                  }
                : undefined
            }
          />
        )}
      </Card>
    </Page>
  );
}
