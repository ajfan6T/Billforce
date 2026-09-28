import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Ban, Pencil, Printer } from 'lucide-react';
import { Alert, Button, Card, ErrorBox, KeyValues, Loading, Money, Page, PageHeader } from '../../components/ui';
import { ReceiptPreview } from '../../components/pickers';
import { useHotkeys, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { call } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, formatDateTime } from '../../../shared/dates';
import { CancelledBadge, ModeBadge, PayableText, PostingTable, RevisionHistory, type DiffField } from '../customers/common';
import { RECEIPT_DIFF } from '../customers/ReceiptDetail';
import { SupplierPaymentModal } from './SupplierPaymentModal';

const PAYMENT_DIFF: DiffField[] = RECEIPT_DIFF.map((f) => (f.key === 'customerName' ? { ...f, key: 'supplierName', label: 'Supplier' } : f));

export function SupplierPaymentDetailPage() {
  const id = Number(useParams().id);
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const valid = Number.isInteger(id) && id > 0;
  const q = useQuery('supplierPayments.get', valid ? { id } : null);
  const preview = useQuery('supplierPayments.voucherHtml', valid ? { id } : null);
  const [editing, setEditing] = useState(false);
  const [printing, setPrinting] = useState(false);
  const d = q.data;

  const reload = () => {
    void q.reload();
    void preview.reload();
  };

  // Same rule as bills: the first print is free, printing again needs "Reprint bills" and is marked DUPLICATE.
  const reprint = !!d && d.printCount > 0;
  const canPrint = !reprint || can('billing.reprint');

  const print = async () => {
    if (!d || !canPrint) return;
    setPrinting(true);
    try {
      const res = await call('supplierPayments.print', { id: d.id });
      if (res.printed) toast.success(res.duplicate ? `Printed a duplicate of voucher ${d.paymentNo}` : `Printed voucher ${d.paymentNo}`);
      else if (res.message) toast.warning(res.message);
      reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setPrinting(false);
    }
  };
  useHotkeys({ 'ctrl+p': () => void print() }, [d?.id, d?.printCount]);

  if (!valid) return <Page><ErrorBox error="This payment link is not valid." /></Page>;
  if (q.error) return <Page><PageHeader title="Payment" back="/purchases/payments" /><ErrorBox error={q.error} onRetry={q.reload} /></Page>;
  if (!d) return <Loading />;

  const active = d.status === 'active';
  const cancel = async () => {
    const reason = await dialogs.prompt({
      title: `Cancel payment ${d.paymentNo}?`,
      message: `The ${formatINR(d.amount)} paid to ${d.supplierName} will be removed from the accounts and added back to what you owe them. The payment keeps its number and stays in the history.`,
      label: 'Reason for cancelling',
      placeholder: 'e.g. cheque not cleared, entered twice',
      required: true,
      confirmText: 'Cancel payment',
      danger: true,
    });
    if (!reason) return;
    try {
      await call('supplierPayments.cancel', { id: d.id, reason });
      toast.success(`Payment ${d.paymentNo} cancelled`);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Page>
      <PageHeader
        back="/purchases/payments"
        title={
          <span className="row">
            Payment {d.paymentNo}
            {!active && <CancelledBadge />}
          </span>
        }
        subtitle={
          <>
            {formatDate(d.date)} · to <Link to={`/suppliers/${d.supplierId}`}>{d.supplierName}</Link>
          </>
        }
        actions={
          <>
            {canPrint && (
              <Button icon={<Printer size={16} />} kbd="Ctrl+P" loading={printing} onClick={print}>
                {reprint ? 'Reprint voucher' : 'Print voucher'}
              </Button>
            )}
            {can('suppliers.pay') && active && (
              <>
                <Button icon={<Pencil size={16} />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button variant="ghost" icon={<Ban size={16} />} onClick={cancel}>
                  Cancel payment
                </Button>
              </>
            )}
          </>
        }
      />
      {!active && (
        <div className="cancel-banner">
          <Alert tone="red" title={`Cancelled by ${d.cancelledBy ?? 'unknown'} on ${formatDateTime(d.cancelledAt)}`}>
            Reason: {d.cancelReason}. This payment no longer counts in the supplier's balance or your accounts.
          </Alert>
        </div>
      )}
      <div className="detail-grid">
        <div className="stack">
          <Card title="Payment details">
            <KeyValues
              columns={3}
              items={[
                ['Supplier', <Link to={`/suppliers/${d.supplierId}`}>{d.supplierName}</Link>],
                ['Phone', d.supplierPhone],
                ['Date', formatDate(d.date)],
                ['Amount paid', <Money value={d.amount} className="bold" />],
                ['Discount received', d.discount ? <Money value={d.discount} /> : null],
                ['Total settled', <Money value={d.amount + d.discount} />],
                ['Mode', <ModeBadge mode={d.mode} />],
                ['Paid from', d.accountName],
                [d.mode === 'upi' ? 'UPI transaction ID' : d.mode === 'bank' ? 'Cheque / UTR no' : 'Reference', d.reference],
                ['Payable before', d.payableBefore === null ? null : <PayableText value={d.payableBefore} />],
                ['Payable after', d.payableAfter === null ? null : <PayableText value={d.payableAfter} />],
                ['Payable today', <PayableText value={d.currentPayable} />],
                ['Remarks', d.remarks],
                ['Entered by', `${d.createdBy ?? '—'} · ${formatDateTime(d.createdAt)}`],
                d.updatedAt ? ['Last edited', `${d.updatedBy ?? '—'} · ${formatDateTime(d.updatedAt)}`] : null,
              ]}
            />
          </Card>
          <Card title="How this is recorded in your accounts">
            <PostingTable lines={d.posting} voided={!active} />
          </Card>
          <Card title="History">
            <RevisionHistory revisions={d.revisions} fields={PAYMENT_DIFF} />
          </Card>
        </div>
        <Card title="Payment voucher" actions={<span className="small muted">printed {d.printCount}×</span>}>
          <ReceiptPreview html={preview.data?.html} height={520} />
          {!canPrint && <p className="faint small mt-1">This voucher was already printed. Reprinting needs permission.</p>}
        </Card>
      </div>
      <SupplierPaymentModal open={editing} payment={d} onClose={() => setEditing(false)} onSaved={reload} />
    </Page>
  );
}
