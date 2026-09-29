import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ClipboardCheck, PackageOpen, Plus, SlidersHorizontal } from 'lucide-react';
import { Alert, Badge, EmptyState, ErrorBox, LinkButton, Page, PageHeader, Stat, StatGrid, Toolbar } from '../../components/ui';
import { SearchInput, SegmentedControl } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { ExportButtons } from '../../components/report';
import { useDebounced, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import type { ApiOutput } from '../../api';
import { formatINR, formatQty } from '../../../shared/money';
import './stock.css';

type Row = ApiOutput<'stock.summary'>['items'][number];
type Filter = 'all' | 'low' | 'out';

export function StockStatusBadge({ status }: { status: Row['status'] }) {
  if (status === 'ok') return <Badge tone="green">In stock</Badge>;
  if (status === 'low') return <Badge tone="amber">Low</Badge>;
  if (status === 'out') return <Badge tone="red">Out of stock</Badge>;
  return <Badge tone="red">Below zero</Badge>;
}

/** Stock levels of every tracked item, with low-stock and out-of-stock filters. */
export function StockLevelsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const filter = (['all', 'low', 'out'].includes(params.get('filter') ?? '') ? params.get('filter') : 'all') as Filter;
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const data = useQuery('stock.summary', { filter, q: dq.trim() || null });
  const manage = can('stock.manage');
  const t = data.data?.totals;
  const setFilter = (f: Filter) => {
    const next = new URLSearchParams(params);
    if (f === 'all') next.delete('filter');
    else next.set('filter', f);
    setParams(next, { replace: true });
  };

  const columns: Array<Column<Row>> = [
    {
      key: 'name',
      label: 'Item',
      render: (r) => (
        <span>
          <span className="sl-cell-main">{r.name}</span>
          {r.category && <span className="sl-cell-sub">{r.category}</span>}
        </span>
      ),
    },
    { key: 'qty', label: 'In stock', align: 'right', render: (r) => <b className={r.qty < 0 ? 'neg' : ''}>{`${formatQty(r.qty)} ${r.unit}`}</b> },
    { key: 'reorderLevel', label: 'Low at', align: 'right', render: (r) => (r.reorderLevel ? `${formatQty(r.reorderLevel)} ${r.unit}` : <span className="faint">—</span>) },
    { key: 'avgCost', label: 'Avg cost', align: 'right', value: (r) => r.avgCost, render: (r) => (r.costKnown ? formatINR(Math.round(r.avgCost)) : <span className="faint">no cost</span>) },
    { key: 'value', label: 'Value', type: 'money' },
    { key: 'status', label: 'Status', render: (r) => <StockStatusBadge status={r.status} /> },
  ];

  return (
    <Page>
      <PageHeader
        title="Stock levels"
        subtitle="What is in the shop now, valued at the average purchase cost"
        actions={
          <>
            <ExportButtons report={data.data?.report} disabled={!data.data} />
            {manage && (
              <>
                <LinkButton to="/stock/opening" icon={<PackageOpen size={16} />}>
                  Opening stock
                </LinkButton>
                <LinkButton to="/stock/adjustments/new?kind=count" icon={<ClipboardCheck size={16} />}>
                  Stock count
                </LinkButton>
                <LinkButton to="/stock/adjustments/new" variant="primary" icon={<SlidersHorizontal size={16} />}>
                  Adjust stock
                </LinkButton>
              </>
            )}
          </>
        }
      />
      {t && (
        <StatGrid>
          <Stat label="Items tracked" value={t.items.toLocaleString('en-IN')} />
          <Stat label="Stock value" value={formatINR(t.value)} hint="At average purchase cost" />
          <Stat label="Low stock" value={t.low.toLocaleString('en-IN')} tone={t.low ? 'amber' : undefined} onClick={() => setFilter('low')} />
          <Stat label="Out of stock" value={(t.out + t.negative).toLocaleString('en-IN')} tone={t.out + t.negative ? 'red' : undefined} onClick={() => setFilter('out')} />
        </StatGrid>
      )}
      {t && t.items === 0 && (
        <Alert tone="blue">
          No items are tracked yet. Turn on "Track stock" for your items in Sales &gt; Items &amp; rates (or use "Track all items" in Settings &gt; Stock), then enter
          your opening stock or do a stock count.
        </Alert>
      )}
      <Toolbar className="mt-1">
        <SegmentedControl<Filter>
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All items' },
            { value: 'low', label: 'Low stock' },
            { value: 'out', label: 'Out of stock' },
          ]}
        />
        <SearchInput value={q} onChange={setQ} placeholder="Search item or category…" />
      </Toolbar>
      {data.error && <ErrorBox error={data.error} onRetry={data.reload} />}
      <div className="card sl-list-card">
        <DataTable<Row>
          columns={columns}
          rows={data.data?.items}
          rowKey={(r) => r.itemId}
          loading={data.loading}
          onRowClick={(r) => navigate(`/stock/items/${r.itemId}`)}
          rowClassName={(r) => (r.status === 'ok' ? '' : r.status === 'low' ? 'st-low' : 'st-out')}
          initialSort={{ key: 'name', dir: 'asc' }}
          footer={data.data?.items.length ? { value: <span className="money">{formatINR(data.data.items.reduce((s, i) => s + i.value, 0))}</span> } : undefined}
          empty={
            <EmptyState
              icon={<PackageOpen size={32} />}
              title={filter === 'all' ? 'No items with stock' : filter === 'low' ? 'Nothing is running low' : 'Nothing is out of stock'}
              action={
                manage && filter === 'all' ? (
                  <LinkButton to="/stock/opening" icon={<Plus size={16} />}>
                    Enter opening stock
                  </LinkButton>
                ) : undefined
              }
            />
          }
        />
      </div>
    </Page>
  );
}
