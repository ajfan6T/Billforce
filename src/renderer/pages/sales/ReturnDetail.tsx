import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Ban, Printer } from 'lucide-react';
import { call } from '../../api';
import { useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { Alert, Badge, Button, Card, KeyValues, Loading, Money, Page, PageHeader } from '../../components/ui';
import { DataTable } from '../../components/table';
import { ReceiptPreview } from '../../components/pickers';
import { PAYMENT_MODE_LABELS } from '../../../shared/constants';
import { formatINR } from '../../../shared/money';
import { formatDate, formatDateTime } from '../../../shared/dates';
import { LoadError, RefundBadge, StatusBadge, qtyUnit, usePrintDoc } from './common';

export function ReturnDetail() {
  const id = Number(useParams().id);
  const q = useQuery('returns.get', { id });
  const preview = useQuery('returns.receiptHtml', { id });
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const printDoc = usePrintDoc();
  const [busy, setBusy] = useState<string | null>(null);

  if (q.error) {
    return (
      <Page>
        <PageHeader title="Return" back="/sales/returns" />
        <LoadError title="This return cannot be opened" error={q.error} back="/sales/returns" backLabel="Back to returns" onRetry={q.reload} />
      </Page>
    );
  }
  const d = q.data;
  if (!d) return <Loading />;
  const isReturn = d.kind === 'return';
  const active = d.status === 'active';
  const reprint = d.printCount > 0;
  const canPrint = !reprint || can('billing.reprint');

  const print = async () => {
    setBusy('print');
    await printDoc('return', d.id);
    setBusy(null);
    void q.reload();
  };
  const cancel = async () => {
    const reason = await dialogs.prompt({
      title: `Cancel ${d.cnNo}?`,
      message: (
        <>
          The {isReturn ? 'return' : 'credit note'} of <b>{formatINR(d.total)}</b> will be removed from the books
          {d.refundMode === 'credit' ? ` and ${d.customerName}'s balance goes back up` : ' (as if the money was not refunded)'}.
          {isReturn ? ' The items can be returned again later.' : ''}
        </>
      ),
      label: 'Reason for cancelling',
      required: true,
      confirmText: `Cancel ${isReturn ? 'return' : 'credit note'}`,
      danger: true,
    });
    if (!reason) return;
    setBusy('cancel');
    try {
      const res = await call('returns.cancel', { id: d.id, reason });
      toast.success(`${d.cnNo} cancelled`);
      res.warnings.forEach((w) => toast.warning(w));
      await q.reload();
      void preview.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      <PageHeader
        back="/sales/returns"
        title={
          <>
            {isReturn ? 'Sales return' : 'Credit note'} {d.cnNo}
            <span className="sl-header-badges">
              <StatusBadge status={d.status} />
              <RefundBadge mode={d.refundMode} />
            </span>
          </>
        }
        subtitle={`${formatDate(d.date)} · by ${d.createdByName ?? 'unknown'} on ${formatDateTime(d.createdAt)}`}
        actions={
          <>
            {canPrint && (
              <Button icon={<Printer size={16} />} loading={busy === 'print'} onClick={print}>
                {reprint ? 'Reprint' : 'Print'}
              </Button>
            )}
            {active && can('returns.cancel') && (
              <Button variant="danger" icon={<Ban size={16} />} loading={busy === 'cancel'} onClick={cancel}>
                Cancel {isReturn ? 'return' : 'credit note'}
              </Button>
            )}
          </>
        }
      />
      {!active && (
        <Alert tone="red" title="Cancelled">
          Cancelled by {d.cancelledByName ?? 'unknown'} on {formatDateTime(d.cancelledAt)}. Reason: {d.cancelReason}
        </Alert>
      )}
      <div className="sl-detail-grid mt-1">
        <div className="stack">
          <Card title="Details">
            <KeyValues
              columns={3}
              items={[
                ['Type', isReturn ? <Badge tone="blue">Goods returned</Badge> : <Badge tone="purple">Credit note (no goods)</Badge>],
                d.billId ? ['Against bill', <Link key="bill" to={`/sales/bills/${d.billId}`}>{d.billNo}</Link>] : null,
                d.billDate ? ['Bill date', formatDate(d.billDate)] : null,
                ['Customer', d.customerId && can('customers.view') ? <Link to={`/customers/${d.customerId}`}>{d.customerName}</Link> : (d.customerName ?? 'Walk-in')],
                ['Refund', d.refundMode === 'credit' ? "Adjusted in customer's account" : `${PAYMENT_MODE_LABELS[d.refundMode]}${d.refundAccountName ? ` · ${d.refundAccountName}` : ''}`],
                d.customer && !d.customer.balanceHidden ? ['Customer balance now', <Money key="b" value={d.customer.balance} />] : null,
                ['Reason', d.reason],
              ]}
            />
          </Card>
          {isReturn && (
            <Card title={`Items returned (${d.items.length})`} padded={false}>
              <DataTable
                compact
                columns={[
                  { key: 'itemName', label: 'Item', sortable: false, render: (i) => <span className="sl-cell-main">{i.itemName}</span> },
                  { key: 'qty', label: 'Qty', align: 'right', sortable: false, render: (i) => qtyUnit(i.qty, i.unit) },
                  { key: 'rate', label: 'Refund rate', type: 'money', sortable: false },
                  { key: 'amount', label: 'Amount', type: 'money', sortable: false },
                ]}
                rows={d.items}
                rowKey={(i) => i.id}
              />
            </Card>
          )}
          <Card>
            <div className="sl-totals-box" style={{ padding: 0 }}>
              {d.roundOff !== 0 && (
                <>
                  <div className="tr muted">
                    <span>Items</span>
                    <Money value={d.subtotal} />
                  </div>
                  <div className="tr muted">
                    <span>Round off</span>
                    <span className="money">{formatINR(d.roundOff, { plus: true })}</span>
                  </div>
                </>
              )}
              <div className="tr grand">
                <span>{d.refundMode === 'credit' ? 'Total credit' : 'Total refund'}</span>
                <Money value={d.total} />
              </div>
            </div>
          </Card>
          <Card title="History">
            <div className="stack-sm">
              {d.revisions.map((r) => (
                <div key={r.revision} className="row small">
                  <Badge tone={r.action === 'cancelled' ? 'red' : 'green'}>{r.action === 'cancelled' ? 'Cancelled' : 'Created'}</Badge>
                  <span>
                    by <b>{r.username ?? 'unknown'}</b> on {formatDateTime(r.at)}
                    {r.reason ? ` — ${r.reason}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
        <div className="sl-detail-side">
          <Card title="Receipt" padded={false}>
            <ReceiptPreview html={preview.data?.html} widthMm={preview.data?.paperWidth ?? 80} height={520} />
          </Card>
        </div>
      </div>
    </Page>
  );
}
