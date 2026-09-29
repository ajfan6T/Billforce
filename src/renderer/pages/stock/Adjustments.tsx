import { useNavigate } from 'react-router';
import { ClipboardCheck, SlidersHorizontal } from 'lucide-react';
import { Badge, EmptyState, ErrorBox, LinkButton, Page, PageHeader, Toolbar } from '../../components/ui';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker } from '../../components/report';
import { useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import type { ApiOutput } from '../../api';
import { useRange } from '../accounts/common';
import { StatusBadge } from '../sales/common';
import './stock.css';

type Row = ApiOutput<'stock.adjustments'>[number];

export function AdjustmentsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [range, setRange] = useRange('stock.adjustments.range', 'this_month');
  const list = useQuery('stock.adjustments', { from: range.from, to: range.to });
  const columns: Array<Column<Row>> = [
    { key: 'adjNo', label: 'Number', render: (r) => <span className="sl-cell-main nowrap">{r.adjNo}</span> },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'kind', label: 'Type', render: (r) => (r.kind === 'count' ? <Badge tone="blue">Stock count</Badge> : <Badge tone="purple">Adjustment</Badge>) },
    { key: 'items', label: 'Items', render: (r) => <span className="sl-cell-items">{r.items}</span> },
    { key: 'reason', label: 'Reason', render: (r) => r.reason ?? <span className="faint">—</span> },
    { key: 'createdBy', label: 'By' },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];
  return (
    <Page>
      <PageHeader
        title="Stock counts & adjustments"
        subtitle="Corrections to stock: counts, damaged or expired goods, goods taken for own use"
        actions={
          can('stock.manage') && (
            <>
              <LinkButton to="/stock/adjustments/new?kind=count" icon={<ClipboardCheck size={16} />}>
                Stock count
              </LinkButton>
              <LinkButton to="/stock/adjustments/new" variant="primary" icon={<SlidersHorizontal size={16} />}>
                Adjust stock
              </LinkButton>
            </>
          )
        }
      />
      <Toolbar>
        <DateRangePicker value={range} onChange={setRange} />
      </Toolbar>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      <div className="card sl-list-card">
        <DataTable<Row>
          columns={columns}
          rows={list.data}
          rowKey={(r) => r.id}
          loading={list.loading}
          onRowClick={(r) => navigate(`/stock/adjustments/${r.id}`)}
          rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
          empty={<EmptyState icon={<SlidersHorizontal size={30} />} title="No stock counts or adjustments in this period" />}
        />
      </div>
    </Page>
  );
}
