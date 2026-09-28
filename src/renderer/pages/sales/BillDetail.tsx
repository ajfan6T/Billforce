import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Ban, Copy, Pencil, Printer, RotateCcw, Undo2 } from 'lucide-react';
import { call, type ApiOutput } from '../../api';
import { useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { Alert, Badge, Button, Card, EmptyState, ErrorBox, KeyValues, Loading, Money, Page, PageHeader, Tabs } from '../../components/ui';
import { DataTable } from '../../components/table';
import { ReceiptPreview } from '../../components/pickers';
import { PAYMENT_MODE_LABELS } from '../../../shared/constants';
import { formatINR, formatQty } from '../../../shared/money';
import { formatDate, formatDateTime } from '../../../shared/dates';
import { LoadError, ModeBadge, RefundBadge, StatusBadge, qtyUnit, usePrintDoc } from './common';

type Bill = ApiOutput<'sales.get'>;
type Revision = ApiOutput<'sales.revisions'>[number];

const ACTION_LABEL: Record<string, { label: string; tone: 'green' | 'blue' | 'red' | 'neutral' }> = {
  created: { label: 'Created', tone: 'green' },
  edited: { label: 'Edited', tone: 'blue' },
  cancelled: { label: 'Cancelled', tone: 'red' },
  restored: { label: 'Restored', tone: 'neutral' },
};

export function BillDetail() {
  const id = Number(useParams().id);
  const q = useQuery('sales.get', { id });
  const [tab, setTab] = useState('bill');
  if (q.error) {
    return (
      <Page>
        <PageHeader title="Bill" back="/sales/bills" />
        <LoadError title="This bill cannot be opened" error={q.error} back="/sales/bills" backLabel="Back to bills" onRetry={q.reload} />
      </Page>
    );
  }
  if (!q.data) return <Loading />;
  return <BillView bill={q.data} reload={q.reload} tab={tab} setTab={setTab} />;
}

function BillView({ bill, reload, tab, setTab }: { bill: Bill; reload: () => Promise<void>; tab: string; setTab: (t: string) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const navigate = useNavigate();
  const printDoc = usePrintDoc();
  const preview = useQuery('sales.receiptHtml', { id: bill.id });
  const [busy, setBusy] = useState<string | null>(null);
  const active = bill.status === 'active';
  const activeReturns = bill.creditNotes.filter((c) => c.status === 'active');
  const lockedByReturns = activeReturns.length > 0;
  const reprint = bill.printedCurrent;
  const canPrint = !reprint || can('billing.reprint');

  const print = async () => {
    setBusy('print');
    await printDoc('bill', bill.id);
    setBusy(null);
    void reload();
  };

  const cancel = async () => {
    const reason = await dialogs.prompt({
      title: `Cancel bill ${bill.billNo}?`,
      message: (
        <>
          The bill of <b>{formatINR(bill.total)}</b>
          {bill.customerName ? ` for ${bill.customerName}` : ''} will be cancelled and removed from sales, cash and customer balances. It stays in the list
          (marked cancelled) and its number is not reused.
        </>
      ),
      label: 'Reason for cancelling',
      placeholder: 'e.g. Customer did not take the goods',
      required: true,
      confirmText: 'Cancel bill',
      danger: true,
    });
    if (!reason) return;
    setBusy('cancel');
    try {
      await call('sales.cancel', { id: bill.id, reason });
      toast.success(`Bill ${bill.billNo} cancelled`);
      await reload();
      void preview.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const itemsWithDisc = bill.items.some((i) => i.discount > 0);

  return (
    <Page>
      <PageHeader
        back="/sales/bills"
        title={
          <>
            Bill {bill.billNo}
            <span className="sl-header-badges">
              <StatusBadge status={bill.status} />
              <ModeBadge mode={bill.paymentMode} credit={bill.credit} />
              {bill.revision > 1 && <Badge tone="blue">Edited {bill.revision - 1}×</Badge>}
            </span>
          </>
        }
        subtitle={`${formatDate(bill.date)} · made by ${bill.createdByName ?? 'unknown'} on ${formatDateTime(bill.createdAt)}${bill.printCount ? ` · printed ${bill.printCount}×` : ' · not printed yet'}`}
        actions={
          <>
            {canPrint && (
              <Button icon={<Printer size={16} />} loading={busy === 'print'} onClick={print} variant={bill.printCount ? 'secondary' : 'primary'}>
                {reprint ? 'Reprint' : 'Print'}
              </Button>
            )}
            {active && can('billing.edit') && (
              <Button
                icon={<Pencil size={16} />}
                disabled={lockedByReturns}
                title={lockedByReturns ? 'Cancel the sales returns of this bill first' : 'Change items, rates, customer or payment'}
                onClick={() => navigate(`/sales/bills/${bill.id}/edit`)}
              >
                Edit
              </Button>
            )}
            {active && can('returns.create') && (
              <Button icon={<Undo2 size={16} />} onClick={() => navigate(`/sales/returns/new?billId=${bill.id}`)}>
                Sales return
              </Button>
            )}
            {can('billing.create') && (
              <Button icon={<Copy size={16} />} onClick={() => navigate(`/billing/new?repeat=${bill.id}`)} title="Start a new bill with the same items">
                Repeat bill
              </Button>
            )}
            {active && can('billing.cancel') && (
              <Button
                variant="danger"
                icon={<Ban size={16} />}
                loading={busy === 'cancel'}
                disabled={lockedByReturns}
                title={lockedByReturns ? 'Cancel the sales returns of this bill first' : undefined}
                onClick={cancel}
              >
                Cancel bill
              </Button>
            )}
          </>
        }
      />

      {!active && (
        <Alert tone="red" title="This bill is cancelled">
          Cancelled by {bill.cancelledByName ?? 'unknown'} on {formatDateTime(bill.cancelledAt)}. Reason: {bill.cancelReason}
        </Alert>
      )}
      {active && lockedByReturns && (can('billing.edit') || can('billing.cancel')) && (
        <Alert tone="amber">
          Goods were returned against this bill ({activeReturns.map((c) => c.cnNo).join(', ')}). To edit or cancel the bill, cancel those returns first.
        </Alert>
      )}

      <div className="mt-1">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'bill', label: 'Bill' },
            { key: 'history', label: 'History', count: bill.revisions.length },
          ]}
        />
      </div>

      {tab === 'bill' ? (
        <div className="sl-detail-grid">
          <div className="stack">
            <Card title="Customer & payment">
              <KeyValues
                columns={3}
                items={[
                  [
                    'Customer',
                    bill.customerId ? (
                      can('customers.view') ? (
                        <Link to={`/customers/${bill.customerId}`}>{bill.customerName}</Link>
                      ) : (
                        bill.customerName
                      )
                    ) : (
                      bill.customerName || <span className="faint">Walk-in</span>
                    ),
                  ],
                  ['Phone', bill.customerPhone],
                  // No balance at all (not ₹0) for users who may not see customer balances.
                  bill.customer && !bill.customer.balanceHidden ? ['Balance now', <Money key="b" value={bill.customer.balance} colored={false} />] : ['Bill date', formatDate(bill.date)],
                  ['Payment', <ModeBadge key="m" mode={bill.paymentMode} credit={bill.credit} />],
                  ['Paid now', <Money key="p" value={bill.paid} />],
                  ['On credit', bill.credit ? <Money key="c" value={bill.credit} /> : '—'],
                  bill.remarks ? ['Remarks', bill.remarks] : null,
                  bill.updatedAt ? ['Last edited', `${formatDateTime(bill.updatedAt)} by ${bill.updatedByName ?? 'unknown'}`] : null,
                ]}
              />
            </Card>

            <Card title={`Items (${bill.items.length})`} padded={false}>
              <DataTable
                compact
                columns={[
                  { key: 'lineNo', label: '#', width: 36, sortable: false },
                  { key: 'itemName', label: 'Item', sortable: false, render: (i) => <span className="sl-cell-main">{i.itemName}</span> },
                  { key: 'qty', label: 'Qty', align: 'right', sortable: false, render: (i) => qtyUnit(i.qty, i.unit) },
                  { key: 'rate', label: 'Rate', type: 'money', sortable: false },
                  ...(itemsWithDisc
                    ? [
                        {
                          key: 'discount',
                          label: 'Discount',
                          align: 'right' as const,
                          sortable: false,
                          render: (i: Bill['items'][number]) => (i.discount ? `${i.discountPct ? formatQty(i.discountPct) + '% · ' : ''}−${formatINR(i.discount)}` : ''),
                        },
                      ]
                    : []),
                  { key: 'amount', label: 'Amount', type: 'money', sortable: false },
                ]}
                rows={bill.items}
                rowKey={(i) => i.id}
              />
              <div className="sl-totals-box">
                <div className="tr muted">
                  <span>Subtotal</span>
                  <Money value={bill.subtotal} />
                </div>
                {bill.itemDiscount > 0 && (
                  <div className="tr muted">
                    <span>Item discounts</span>
                    <span className="money">−{formatINR(bill.itemDiscount)}</span>
                  </div>
                )}
                {bill.billDiscount > 0 && (
                  <div className="tr muted">
                    <span>Bill discount{bill.billDiscountPct ? ` (${formatQty(bill.billDiscountPct)}%)` : ''}</span>
                    <span className="money">−{formatINR(bill.billDiscount)}</span>
                  </div>
                )}
                {bill.roundOff !== 0 && (
                  <div className="tr muted">
                    <span>Round off</span>
                    <span className="money">{formatINR(bill.roundOff, { plus: true })}</span>
                  </div>
                )}
                <div className="tr grand">
                  <span>Total</span>
                  <Money value={bill.total} />
                </div>
                {bill.returnedTotal > 0 && (
                  <div className="tr muted">
                    <span>Returned / credited</span>
                    <span className="money">−{formatINR(bill.returnedTotal)}</span>
                  </div>
                )}
              </div>
            </Card>

            <Card title="Payments received with the bill" padded={!bill.payments.length}>
              {bill.payments.length ? (
                <DataTable
                  compact
                  columns={[
                    { key: 'mode', label: 'Mode', sortable: false, render: (p) => PAYMENT_MODE_LABELS[p.mode] },
                    { key: 'accountName', label: 'Account', sortable: false },
                    { key: 'reference', label: 'Reference', sortable: false },
                    { key: 'amount', label: 'Amount', type: 'money', sortable: false },
                  ]}
                  rows={bill.payments}
                  rowKey={(p) => p.id}
                />
              ) : (
                <div className="sl-muted-block">Nothing was paid with this bill. The full amount of {formatINR(bill.total)} was added to the customer's balance.</div>
              )}
            </Card>

            {bill.creditNotes.length > 0 && (
              <Card title="Returns & credit notes" padded={false}>
                <DataTable
                  compact
                  onRowClick={(c) => navigate(`/sales/returns/${c.id}`)}
                  rowClassName={(c) => (c.status === 'cancelled' ? 'cancelled' : '')}
                  columns={[
                    { key: 'cnNo', label: 'Number', render: (c) => <span className="sl-cell-main">{c.cnNo}</span> },
                    { key: 'date', label: 'Date', type: 'date' },
                    { key: 'refundMode', label: 'Refund', render: (c) => <RefundBadge mode={c.refundMode} /> },
                    { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} /> },
                    { key: 'total', label: 'Amount', type: 'money' },
                  ]}
                  rows={bill.creditNotes}
                  rowKey={(c) => c.id}
                />
              </Card>
            )}
          </div>

          <div className="sl-detail-side">
            <Card title="Receipt" padded={false} actions={canPrint ? <Button size="sm" icon={<Printer size={14} />} onClick={print} loading={busy === 'print'}>{reprint ? 'Reprint' : 'Print'}</Button> : undefined}>
              <ReceiptPreview html={preview.data?.html} widthMm={preview.data?.paperWidth ?? 80} height={600} />
            </Card>
            {reprint && !can('billing.reprint') && <p className="faint small">This bill was already printed. Reprinting needs permission.</p>}
          </div>
        </div>
      ) : (
        // Keyed by the version count, so cancelling or editing the bill with this tab open loads the new version.
        <BillHistory key={bill.revisions.length} billId={bill.id} count={bill.revisions.length} />
      )}
    </Page>
  );
}

function BillHistory({ billId, count }: { billId: number; count: number }) {
  const q = useQuery('sales.revisions', { id: billId });
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading />;
  if (!q.data.length) return <EmptyState icon={<RotateCcw size={30} />} title="No history" message="This bill has no recorded versions." />;
  const revs = [...q.data].reverse();
  return (
    <div className="sl-rev-list" aria-label={`${count} versions`}>
      {revs.map((r) => (
        <RevisionCard key={r.revision} r={r} />
      ))}
    </div>
  );
}

function RevisionCard({ r }: { r: Revision }) {
  const a = ACTION_LABEL[r.action] ?? { label: r.action, tone: 'neutral' as const };
  const s = r.snapshot;
  return (
    <div className="sl-rev-card">
      <div className="sl-rev-head">
        <span className="sl-rev-num">Version {r.revision}</span>
        <Badge tone={a.tone}>{a.label}</Badge>
        <span className="sl-rev-meta">
          by <b>{r.username ?? 'unknown'}</b> on {formatDateTime(r.at)}
        </span>
        <span className="grow" />
        <span className="money bold">{formatINR(s.total)}</span>
      </div>
      {r.reason && (
        <div className="sl-rev-reason">
          <span className="muted">Reason:</span> {r.reason}
        </div>
      )}
      <div className="sl-rev-body">
        {r.action === 'created' ? (
          <table className="sl-diff-table">
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {s.items.map((i, idx) => (
                <tr key={idx}>
                  <td>{i.itemName}</td>
                  <td style={{ textAlign: 'right' }}>{qtyUnit(i.qty, i.unit)}</td>
                  <td style={{ textAlign: 'right' }} className="money">
                    {formatINR(i.rate)}
                  </td>
                  <td style={{ textAlign: 'right' }} className="money">
                    {formatINR(i.amount)}
                    {i.discount ? <span className="sl-cell-sub">after −{formatINR(i.discount)}</span> : null}
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={3} className="muted">
                  {s.customerName ? `Customer: ${s.customerName}` : 'Walk-in'} · Paid {formatINR(s.paid)}
                  {s.credit ? ` · Credit ${formatINR(s.credit)}` : ''}
                  {s.billDiscount ? ` · Bill discount ${formatINR(s.billDiscount)}` : ''}
                </td>
                <td style={{ textAlign: 'right' }} className="money bold">
                  {formatINR(s.total)}
                </td>
              </tr>
            </tbody>
          </table>
        ) : r.changes.length ? (
          <table className="sl-diff-table">
            <thead>
              <tr>
                <th>What changed</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {r.changes.map((c, i) => (
                <tr key={i}>
                  <td className="sl-d-what">{c.label}</td>
                  <td className={c.before ? 'sl-d-before' : ''}>{c.before ?? '—'}</td>
                  <td className={c.after ? 'sl-d-after' : ''}>{c.after ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="sl-muted-block">Saved again without changes.</div>
        )}
      </div>
    </div>
  );
}
