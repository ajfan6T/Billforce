import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Ban, Pencil, Plus, Wallet } from 'lucide-react';
import { Alert, Button, Card, ErrorBox, KeyValues, Loading, Page, PageHeader } from '../../components/ui';
import { useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { call } from '../../api';
import { formatINR, formatQty } from '../../../shared/money';
import { formatRate } from '../../../shared/gst';
import { formatDate, formatDateTime } from '../../../shared/dates';
import { CancelledBadge, fmtDate, fmtMode, fmtMoney, ModeBadge, PayableText, PostingTable, RevisionHistory, type DiffField } from '../customers/common';
import { SupplierPaymentModal } from './SupplierPaymentModal';
import './purchases.css';

const itemsText = (items: any) =>
  Array.isArray(items) ? items.map((i: any) => `${i.description} ${formatQty(i.qty)}${i.unit ? ' ' + i.unit : ''} × ${formatINR(i.rate)}`).join('; ') : '—';
const paymentsText = (p: any) => (Array.isArray(p) && p.length ? p.map((x: any) => `${fmtMode(x.mode)} ${formatINR(x.amount)}`).join(', ') : 'None (on credit)');

export const PURCHASE_DIFF: DiffField[] = [
  { key: 'date', label: 'Date', format: fmtDate },
  { key: 'supplierName', label: 'Supplier' },
  { key: 'supplierBillNo', label: "Supplier's bill no" },
  { key: 'supplierBillDate', label: "Supplier's bill date", format: fmtDate },
  { key: 'expenseAccountName', label: 'Account' },
  { key: 'items', label: 'Items', format: itemsText },
  { key: 'discount', label: 'Discount', format: fmtMoney },
  { key: 'otherCharges', label: 'Other charges', format: fmtMoney },
  { key: 'roundOff', label: 'Round off', format: fmtMoney },
  { key: 'total', label: 'Total', format: fmtMoney },
  { key: 'payments', label: 'Payments', format: paymentsText },
  { key: 'credit', label: 'On credit', format: fmtMoney },
  { key: 'remarks', label: 'Remarks' },
];

export function PurchaseDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const valid = Number.isInteger(id) && id > 0;
  const q = useQuery('purchases.get', valid ? { id } : null);
  const [paying, setPaying] = useState(false);
  const p = q.data;

  if (!valid) return <Page><ErrorBox error="This purchase link is not valid." /></Page>;
  if (q.error) return <Page><PageHeader title="Purchase" back="/purchases" /><ErrorBox error={q.error} onRetry={q.reload} /></Page>;
  if (!p) return <Loading />;

  const active = p.status === 'active';
  const cancel = async () => {
    const reason = await dialogs.prompt({
      title: `Cancel purchase ${p.purchaseNo}?`,
      message: (
        <>
          The purchase of {formatINR(p.total)} will be removed from your accounts
          {p.credit ? ` and ${formatINR(p.credit)} will be taken off what you owe ${p.supplierName}` : ''}. It keeps its number and stays in the history.
        </>
      ),
      label: 'Reason for cancelling',
      placeholder: 'e.g. entered twice, goods returned',
      required: true,
      confirmText: 'Cancel purchase',
      danger: true,
    });
    if (!reason) return;
    try {
      await call('purchases.cancel', { id: p.id, reason });
      toast.success(`Purchase ${p.purchaseNo} cancelled`);
      void q.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Page>
      <PageHeader
        back="/purchases"
        title={
          <span className="row">
            Purchase {p.purchaseNo}
            {!active && <CancelledBadge />}
          </span>
        }
        subtitle={
          <>
            {formatDate(p.date)} ·{' '}
            {p.supplierId ? <Link to={`/suppliers/${p.supplierId}`}>{p.supplierName}</Link> : (p.supplierName ?? 'Cash purchase')}
            {p.supplierBillNo ? ` · their bill ${p.supplierBillNo}` : ''}
          </>
        }
        actions={
          <>
            {p.supplierId && can('suppliers.pay') && active && (p.supplierPayable ?? 0) > 0 && (
              <Button icon={<Wallet size={16} />} onClick={() => setPaying(true)}>
                Pay supplier
              </Button>
            )}
            {can('purchases.manage') && active && (
              <>
                <Button icon={<Pencil size={16} />} onClick={() => navigate(`/purchases/${p.id}/edit`)}>
                  Edit
                </Button>
                <Button variant="ghost" icon={<Ban size={16} />} onClick={cancel}>
                  Cancel purchase
                </Button>
              </>
            )}
            {can('purchases.manage') && (
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/purchases/new')}>
                New purchase
              </Button>
            )}
          </>
        }
      />
      {!active && (
        <div className="cancel-banner">
          <Alert tone="red" title={`Cancelled by ${p.cancelledBy ?? 'unknown'} on ${formatDateTime(p.cancelledAt)}`}>
            Reason: {p.cancelReason}. This purchase no longer counts in your accounts or the supplier's balance.
          </Alert>
        </div>
      )}
      <div className="detail-grid">
        <div className="stack">
          <Card title={`Items (${p.items.length})`} padded={false}>
            <div className="table-wrap">
              <table className="table items-table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>#</th>
                    <th>Description</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>Rate</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {p.items.map((i) => (
                    <tr key={i.lineNo}>
                      <td className="faint">{i.lineNo}</td>
                      <td className="desc">
                        {i.description}
                        {p.gst.mode === 'regular' && <span className="faint small"> · GST {formatRate(i.gstRate ?? 0)}</span>}
                      </td>
                      <td className="money" style={{ textAlign: 'right' }}>
                        {formatQty(i.qty)} {i.unit ?? ''}
                      </td>
                      <td className="money" style={{ textAlign: 'right' }}>
                        {formatINR(i.rate)}
                      </td>
                      <td className="money" style={{ textAlign: 'right' }}>
                        {formatINR(i.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="doc-totals">
              <div className="dt-row">
                <span>Items total</span>
                <span>{formatINR(p.subtotal)}</span>
              </div>
              {p.discount > 0 && (
                <div className="dt-row">
                  <span>Less discount</span>
                  <span>-{formatINR(p.discount)}</span>
                </div>
              )}
              {p.otherCharges > 0 && (
                <div className="dt-row">
                  <span>Other charges</span>
                  <span>{formatINR(p.otherCharges)}</span>
                </div>
              )}
              {p.gst.mode === 'regular' && (
                <>
                  <div className="dt-row">
                    <span>Taxable value</span>
                    <span>{formatINR(p.gst.taxable ?? 0)}</span>
                  </div>
                  {p.gst.cgst > 0 && (
                    <div className="dt-row">
                      <span>CGST{p.gst.inclusive ? ' (included)' : ''}</span>
                      <span>{formatINR(p.gst.cgst)}</span>
                    </div>
                  )}
                  {p.gst.sgst > 0 && (
                    <div className="dt-row">
                      <span>SGST{p.gst.inclusive ? ' (included)' : ''}</span>
                      <span>{formatINR(p.gst.sgst)}</span>
                    </div>
                  )}
                  {p.gst.igst > 0 && (
                    <div className="dt-row">
                      <span>IGST{p.gst.inclusive ? ' (included)' : ''}</span>
                      <span>{formatINR(p.gst.igst)}</span>
                    </div>
                  )}
                  <div className="dt-row">
                    <span>GST credit</span>
                    <span>{p.gst.itc ? 'Claimed' : 'Not claimed (part of the cost)'}</span>
                  </div>
                </>
              )}
              {p.roundOff !== 0 && (
                <div className="dt-row">
                  <span>Round off</span>
                  <span>{formatINR(p.roundOff, { plus: true })}</span>
                </div>
              )}
              <div className="dt-row dt-total">
                <span>Total</span>
                <span>{formatINR(p.total)}</span>
              </div>
            </div>
          </Card>
          <Card title="Payment">
            <KeyValues
              columns={3}
              items={[
                ['Paid by', <ModeBadge mode={p.paymentMode} credit={p.credit} />],
                ['Paid now', formatINR(p.paid)],
                ['On credit', p.credit ? <span className="bal-due money">{formatINR(p.credit)}</span> : formatINR(0)],
              ]}
            />
            {p.payments.length > 0 && (
              <table className="posting-table mt-2">
                <thead>
                  <tr>
                    <th>Mode</th>
                    <th>Account</th>
                    <th>Reference</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {p.payments.map((x, i) => (
                    <tr key={i}>
                      <td>{fmtMode(x.mode)}</td>
                      <td>{x.accountName}</td>
                      <td>{x.reference ?? <span className="faint">—</span>}</td>
                      <td className="num money">{formatINR(x.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {p.remarks && (
              <p className="mt-2 mb-0">
                <b>Remarks:</b> {p.remarks}
              </p>
            )}
          </Card>
          <Card title="History">
            <RevisionHistory revisions={p.revisions} fields={PURCHASE_DIFF} />
          </Card>
        </div>
        <div className="stack">
          <Card title="Details">
            <KeyValues
              columns={1}
              items={[
                ['Supplier', p.supplierId ? <Link to={`/suppliers/${p.supplierId}`}>{p.supplierName}</Link> : (p.supplierName ?? 'Cash purchase (no supplier record)')],
                p.supplierId ? ['Supplier balance now', <PayableText value={p.supplierPayable ?? 0} />] : null,
                ["Supplier's bill no", p.supplierBillNo],
                ["Supplier's bill date", p.supplierBillDate ? formatDate(p.supplierBillDate) : null],
                ['Recorded in', p.expenseAccountName],
                ['Entered by', `${p.createdBy ?? '—'} · ${formatDateTime(p.createdAt)}`],
                p.updatedAt ? ['Last edited', `${p.updatedBy ?? '—'} · ${formatDateTime(p.updatedAt)}`] : null,
              ]}
            />
          </Card>
          <Card title="How this is recorded in your accounts">
            <PostingTable lines={p.posting} voided={!active} />
          </Card>
        </div>
      </div>
      <SupplierPaymentModal
        open={paying}
        supplier={p.supplierId ? { id: p.supplierId, name: p.supplierName ?? '', phone: p.supplierPhone, payable: p.supplierPayable ?? 0 } : null}
        onClose={() => setPaying(false)}
        onSaved={(pay) => navigate(`/purchases/payments/${pay.id}`)}
      />
    </Page>
  );
}
