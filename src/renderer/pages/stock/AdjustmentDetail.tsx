import { useParams } from 'react-router';
import { Ban } from 'lucide-react';
import { Alert, Badge, Button, Card, ErrorBox, KeyValues, Loading, Page, PageHeader } from '../../components/ui';
import { DataTable } from '../../components/table';
import { useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { call } from '../../api';
import { formatINR, formatQty } from '../../../shared/money';
import { formatDate, formatDateTime } from '../../../shared/dates';
import { StatusBadge } from '../sales/common';
import './stock.css';

export function AdjustmentDetailPage() {
  const id = Number(useParams().id);
  const q = useQuery('stock.adjustment', Number.isInteger(id) && id > 0 ? { id } : null);
  const { can } = useAuth();
  const dialogs = useDialogs();
  const toast = useToast();
  if (q.error) return <Page><PageHeader title="Stock adjustment" back="/stock/adjustments" /><ErrorBox error={q.error} onRetry={q.reload} /></Page>;
  const d = q.data;
  if (!d) return <Loading />;
  const cancel = async () => {
    const reason = await dialogs.prompt({ title: `Cancel ${d.adjNo}?`, message: 'The stock goes back to what it was before. Enter the reason.', label: 'Reason', required: true, confirmText: 'Cancel it', danger: true });
    if (!reason) return;
    try {
      await call('stock.cancelAdjustment', { id: d.id, reason });
      toast.success(`${d.adjNo} cancelled`);
      void q.reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const count = d.kind === 'count';
  return (
    <Page>
      <PageHeader
        title={`${count ? 'Stock count' : 'Stock adjustment'} ${d.adjNo}`}
        subtitle={`${formatDate(d.date)} · by ${d.createdBy ?? 'unknown'} on ${formatDateTime(d.createdAt)}`}
        back="/stock/adjustments"
        actions={
          d.status === 'active' && can('stock.manage') ? (
            <Button variant="danger" icon={<Ban size={16} />} onClick={() => void cancel()}>
              Cancel
            </Button>
          ) : undefined
        }
      />
      <div className="stack">
        {d.status === 'cancelled' && (
          <Alert tone="red">
            Cancelled on {d.cancelledAt ? formatDateTime(d.cancelledAt) : '—'} by {d.cancelledBy ?? 'unknown'}: {d.cancelReason}
          </Alert>
        )}
        <Card>
          <KeyValues
            columns={3}
            items={[
              ['Type', count ? <Badge tone="blue">Stock count</Badge> : <Badge tone="purple">Adjustment</Badge>],
              ['Status', <StatusBadge key="s" status={d.status} />],
              ['Reason', d.reason ?? '—'],
            ]}
          />
        </Card>
        <Card title={`Items (${d.lines.length})`} padded={false}>
          <DataTable
            compact
            columns={[
              { key: 'itemName', label: 'Item', sortable: false, render: (l) => <span className="sl-cell-main">{l.itemName}</span> },
              ...(count
                ? [
                    { key: 'bookQty', label: 'In the books', align: 'right' as const, sortable: false, render: (l: (typeof d.lines)[number]) => `${formatQty(l.bookQty ?? 0)} ${l.unit}` },
                    { key: 'counted', label: 'Found', align: 'right' as const, sortable: false, render: (l: (typeof d.lines)[number]) => `${formatQty(l.counted ?? 0)} ${l.unit}` },
                  ]
                : []),
              {
                key: 'qty',
                label: 'Change',
                align: 'right',
                sortable: false,
                render: (l) => <span className={l.qty > 0 ? 'st-change-pos' : l.qty < 0 ? 'st-change-neg' : 'muted'}>{l.qty === 0 ? 'no change' : `${l.qty > 0 ? '+' : ''}${formatQty(l.qty)} ${l.unit}`}</span>,
              },
              { key: 'unitCost', label: 'Cost per unit', align: 'right', sortable: false, render: (l) => (l.unitCost ? formatINR(l.unitCost) : <span className="faint">average</span>) },
              { key: 'note', label: 'Note', sortable: false, render: (l) => l.note ?? '' },
            ]}
            rows={d.lines}
            rowKey={(l) => l.lineNo}
          />
        </Card>
      </div>
    </Page>
  );
}
