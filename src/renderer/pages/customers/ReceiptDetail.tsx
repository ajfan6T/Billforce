import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Ban, Pencil, Printer } from 'lucide-react';
import { Alert, Button, Card, ErrorBox, KeyValues, Loading, Money, Page, PageHeader } from '../../components/ui';
import { ReceiptPreview } from '../../components/pickers';
import { useHotkeys, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { call } from '../../api';
import { formatDrCr, formatINR } from '../../../shared/money';
import { formatDate, formatDateTime } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS } from '../../../shared/constants';
import { CancelledBadge, fmtDate, fmtMode, fmtMoney, ModeBadge, PostingTable, RevisionHistory, type DiffField } from './common';
import { ReceiptModal } from './ReceiptModal';

export const RECEIPT_DIFF: DiffField[] = [
  { key: 'date', label: 'Date', format: fmtDate },
  { key: 'customerName', label: 'Customer' },
  { key: 'amount', label: 'Amount', format: fmtMoney },
  { key: 'discount', label: 'Discount', format: fmtMoney },
  { key: 'mode', label: 'Mode', format: fmtMode },
  { key: 'accountName', label: 'Account' },
  { key: 'reference', label: 'Reference' },
  { key: 'remarks', label: 'Remarks' },
];

export function ReceiptDetailPage() {
  const id = Number(useParams().id);
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const valid = Number.isInteger(id) && id > 0;
  const r = useQuery('receipts.get', valid ? { id } : null);
  const preview = useQuery('receipts.receiptHtml', valid ? { id } : null);
  const [editing, setEditing] = useState(false);
  const [printing, setPrinting] = useState(false);
  // Warnings from the last cancel / edit of this payment (e.g. money paid back on a return relied on it); kept on screen.
  const [notices, setNotices] = useState<{ id: number; list: string[] }>({ id, list: [] });
  const d = r.data;

  const reload = () => {
    void r.reload();
    void preview.reload();
  };

  // Same rule as bills: the first print is free, printing again needs "Reprint bills" and is marked DUPLICATE.
  const reprint = !!d && d.printCount > 0;
  const canPrint = !reprint || can('billing.reprint');

  const print = async () => {
    if (!d || !canPrint) return;
    setPrinting(true);
    try {
      const res = await call('receipts.print', { id: d.id });
      if (res.printed) toast.success(res.duplicate ? `Printed a duplicate of ${d.receiptNo}` : `Printed ${d.receiptNo}`);
      else if (res.message) toast.warning(res.message);
      reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setPrinting(false);
    }
  };

  const cancel = async () => {
    if (!d) return;
    const reason = await dialogs.prompt({
      title: `Cancel payment ${d.receiptNo}?`,
      message: `The ${formatINR(d.amount)} received from ${d.customerName} will be removed from the accounts and added back to what they owe. The payment keeps its number and stays in the history.`,
      label: 'Reason for cancelling',
      placeholder: 'e.g. cheque bounced, entered twice',
      required: true,
      confirmText: 'Cancel payment',
      danger: true,
    });
    if (!reason) return;
    try {
      const res = await call('receipts.cancel', { id: d.id, reason });
      toast.success(`Payment ${d.receiptNo} cancelled`);
      setNotices({ id: d.id, list: res.warnings });
      reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const active = d?.status === 'active';
  const canEdit = active && can('customers.receive') && can('billing.edit');
  const canCancel = active && can('customers.receive') && can('billing.cancel');
  useHotkeys({ 'ctrl+p': () => void print() }, [d?.id, d?.printCount]);

  if (!valid) return <Page><ErrorBox error="This payment link is not valid." /></Page>;
  if (r.error) return <Page><PageHeader title="Payment" back="/customers/receipts" /><ErrorBox error={r.error} onRetry={r.reload} /></Page>;
  if (!d) return <Loading />;

  return (
    <Page>
      <PageHeader
        back="/customers/receipts"
        title={
          <span className="row">
            Payment {d.receiptNo}
            {d.status === 'cancelled' && <CancelledBadge />}
          </span>
        }
        subtitle={
          <>
            {formatDate(d.date)} · from <Link to={`/customers/${d.customerId}`}>{d.customerName}</Link>
          </>
        }
        actions={
          <>
            {canPrint && (
              <Button icon={<Printer size={16} />} kbd="Ctrl+P" loading={printing} onClick={print}>
                {reprint ? 'Reprint' : 'Print'}
              </Button>
            )}
            {canEdit && (
              <Button icon={<Pencil size={16} />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {canCancel && (
              <Button variant="ghost" icon={<Ban size={16} />} onClick={cancel}>
                Cancel payment
              </Button>
            )}
          </>
        }
      />
      {d.status === 'cancelled' && (
        <div className="cancel-banner">
          <Alert tone="red" title={`Cancelled by ${d.cancelledBy ?? 'unknown'} on ${formatDateTime(d.cancelledAt)}`}>
            Reason: {d.cancelReason}. This payment no longer counts in the customer's balance or your accounts.
          </Alert>
        </div>
      )}
      {notices.id === d.id && notices.list.length > 0 && (
        <div className="cancel-banner">
          <Alert tone="amber" title="Check this">
            {notices.list.map((n) => (
              <div key={n}>{n}</div>
            ))}
          </Alert>
        </div>
      )}
      <div className="detail-grid">
        <div className="stack">
          <Card title="Payment details">
            <KeyValues
              columns={3}
              items={[
                ['Customer', <Link to={`/customers/${d.customerId}`}>{d.customerName}</Link>],
                ['Phone', d.customerPhone],
                ['Date', formatDate(d.date)],
                ['Amount received', <Money value={d.amount} className="bold" />],
                ['Discount allowed', d.discount ? <Money value={d.discount} /> : null],
                ['Total adjusted', <Money value={d.amount + d.discount} />],
                ['Mode', <ModeBadge mode={d.mode} />],
                ['Account', d.accountName],
                [d.mode === 'upi' ? 'UPI transaction ID' : d.mode === 'bank' ? 'Cheque / UTR no' : 'Reference', d.reference],
                ['Balance before', d.balanceBefore === null ? null : formatDrCr(d.balanceBefore)],
                ['Balance after', d.balanceAfter === null ? null : formatDrCr(d.balanceAfter)],
                ["Customer's balance today", formatDrCr(d.currentBalance)],
                ['Remarks', d.remarks],
                ['Entered by', `${d.createdBy ?? '—'} · ${formatDateTime(d.createdAt)}`],
                d.updatedAt ? ['Last edited', `${d.updatedBy ?? '—'} · ${formatDateTime(d.updatedAt)}`] : null,
              ]}
            />
          </Card>
          <Card title="How this is recorded in your accounts">
            <PostingTable lines={d.posting} voided={d.status === 'cancelled'} />
          </Card>
          <Card title="History">
            <RevisionHistory revisions={d.revisions} fields={RECEIPT_DIFF} />
          </Card>
        </div>
        <Card title="Receipt" actions={<span className="small muted">{PAYMENT_MODE_LABELS[d.mode]} · printed {d.printCount}×</span>}>
          <ReceiptPreview html={preview.data?.html} height={520} />
          {!canPrint && <p className="faint small mt-1">This receipt was already printed. Reprinting needs permission.</p>}
        </Card>
      </div>
      <ReceiptModal
        open={editing}
        receipt={d}
        onClose={() => setEditing(false)}
        onSaved={(saved) => {
          setNotices({ id: saved.id, list: saved.warnings });
          reload();
        }}
      />
    </Page>
  );
}
