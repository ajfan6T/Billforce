import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Mail, MapPin, Pencil, Phone, Plus, Power, StickyNote, Trash2, User, Wallet } from 'lucide-react';
import { Alert, Button, Card, EmptyState, ErrorBox, Loading, Page, PageHeader, Stat, StatGrid, Tabs } from '../../components/ui';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker, ExportButtons, ReportView, rangeFromPreset, type RangeValue } from '../../components/report';
import { useQuery, useStoredState } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { useLinkedPeriod, useOpenLink } from '../../links';
import { call, type ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { describeRange, formatDate } from '../../../shared/dates';
import { CancelledBadge, InactiveBadge, InfoRow, ModeBadge } from '../customers/common';
import { SupplierFormModal } from './SupplierFormModal';
import { SupplierPaymentModal } from './SupplierPaymentModal';

type PurchaseRow = ApiOutput<'purchases.list'>['rows'][number];
type PaymentRow = ApiOutput<'supplierPayments.list'>['rows'][number];

export function SupplierDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const openLink = useOpenLink();
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const [tab, setTab] = useStoredState<'statement' | 'purchases' | 'payments'>('supplier.tab', 'statement');
  // A report row (payables ageing, trial balance) opens the supplier on the report's period.
  const linkedPeriod = useLinkedPeriod();
  const [range, setRange] = useState<RangeValue>(() => linkedPeriod ?? rangeFromPreset('this_fy'));
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const valid = Number.isInteger(id) && id > 0;

  const sup = useQuery('suppliers.get', valid ? { id } : null);
  const statement = useQuery('suppliers.statement', valid && tab === 'statement' ? { supplierId: id, from: range.from, to: range.to } : null);
  const purchases = useQuery('suppliers.purchases', valid && tab === 'purchases' ? { supplierId: id, from: range.from, to: range.to } : null);
  const payments = useQuery('supplierPayments.list', valid && tab === 'payments' ? { supplierId: id, from: range.from, to: range.to } : null);
  const s = sup.data;
  const pickerSupplier = useMemo(() => (s ? { id: s.id, name: s.name, phone: s.phone, payable: s.payable } : null), [s]);

  const reloadAll = () => {
    void sup.reload();
    if (tab === 'statement') void statement.reload();
    if (tab === 'purchases') void purchases.reload();
    if (tab === 'payments') void payments.reload();
  };

  if (!valid) return <Page><ErrorBox error="This supplier link is not valid." /></Page>;
  if (sup.error) return <Page><PageHeader title="Supplier" back="/suppliers" /><ErrorBox error={sup.error} onRetry={sup.reload} /></Page>;
  if (!s) return <Loading />;

  const purchaseColumns: Array<Column<PurchaseRow>> = [
    { key: 'date', label: 'Date', type: 'date', width: 110 },
    { key: 'purchaseNo', label: 'Purchase no', render: (r) => <span className="bold">{r.purchaseNo}</span> },
    { key: 'supplierBillNo', label: 'Their bill no', render: (r) => r.supplierBillNo ?? <span className="faint">—</span> },
    { key: 'items', label: 'Items', render: (r) => <span className="cell-sub" style={{ color: 'inherit' }}>{r.items}</span> },
    { key: 'paymentMode', label: 'Mode', render: (r) => (r.status === 'cancelled' ? <CancelledBadge /> : <ModeBadge mode={r.paymentMode} credit={r.credit} />) },
    { key: 'total', label: 'Total', type: 'money' },
    { key: 'credit', label: 'On credit', type: 'money' },
  ];
  const paymentColumns: Array<Column<PaymentRow>> = [
    { key: 'date', label: 'Date', type: 'date', width: 110 },
    { key: 'paymentNo', label: 'Payment no', render: (r) => <span className="bold">{r.paymentNo}</span> },
    { key: 'mode', label: 'Mode', render: (r) => (r.status === 'cancelled' ? <CancelledBadge /> : <ModeBadge mode={r.mode} />) },
    { key: 'reference', label: 'Reference', render: (r) => r.reference ?? <span className="faint">—</span> },
    { key: 'discount', label: 'Discount', type: 'money', render: (r) => (r.discount ? formatINR(r.discount) : '') },
    { key: 'amount', label: 'Amount', type: 'money' },
  ];

  const toggleActive = async () => {
    if (s.isActive) {
      const ok = await dialogs.confirm({
        title: `Deactivate ${s.name}?`,
        message: (
          <>
            {s.name} will no longer be offered when entering purchases. Their history stays in your books.
            {s.payable !== 0 && (
              <>
                {' '}
                <b>Note:</b> {s.payable > 0 ? `you still owe ${formatINR(s.payable)}` : `you have paid an advance of ${formatINR(-s.payable)}`}.
              </>
            )}
          </>
        ),
        confirmText: 'Deactivate',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await call('suppliers.setActive', { id: s.id, active: !s.isActive });
      toast.success(s.isActive ? `${s.name} deactivated` : `${s.name} is active again`);
      void sup.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async () => {
    const ok = await dialogs.confirm({
      title: `Delete ${s.name}?`,
      message: 'This supplier has no purchases or payments, so the record can be deleted completely. This cannot be undone.',
      confirmText: 'Delete supplier',
      danger: true,
    });
    if (!ok) return;
    try {
      await call('suppliers.remove', { id: s.id });
      toast.success(`Deleted ${s.name}`);
      navigate('/suppliers');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Page>
      <PageHeader
        back="/suppliers"
        title={
          <span className="row">
            {s.name}
            {!s.isActive && <InactiveBadge />}
          </span>
        }
        subtitle={[s.contactPerson, s.phone].filter(Boolean).join(' · ') || undefined}
        actions={
          <>
            {can('suppliers.pay') && (
              <Button variant="primary" icon={<Wallet size={16} />} onClick={() => setPaying(true)}>
                Pay supplier
              </Button>
            )}
            {can('purchases.manage') && s.isActive && (
              <Button icon={<Plus size={16} />} onClick={() => navigate(`/purchases/new?supplier=${s.id}`)}>
                New purchase
              </Button>
            )}
            {can('suppliers.manage') && (
              <>
                <Button icon={<Pencil size={16} />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button variant="ghost" icon={<Power size={16} />} onClick={toggleActive}>
                  {s.isActive ? 'Deactivate' : 'Re-activate'}
                </Button>
                {s.canRemove && (
                  <Button variant="ghost" icon={<Trash2 size={16} />} onClick={remove}>
                    Delete
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      {!s.isActive && (
        <div className="cancel-banner">
          <Alert tone="neutral">This supplier is deactivated. Re-activate to enter new purchases from them.</Alert>
        </div>
      )}
      <StatGrid>
        <Stat
          label={s.payable > 0 ? 'You owe' : s.payable < 0 ? 'Advance paid' : 'Balance'}
          value={s.payable === 0 ? 'Nothing payable' : formatINR(Math.abs(s.payable))}
          tone={s.payable > 0 ? 'red' : s.payable < 0 ? 'green' : undefined}
          icon={<Wallet size={18} />}
          hint={s.lastPaymentDate ? `Last payment ${formatDate(s.lastPaymentDate)}` : 'No separate payments yet'}
        />
        <Stat
          label="Total purchased"
          value={formatINR(s.totals.purchased)}
          hint={`${s.totals.purchases} bill${s.totals.purchases === 1 ? '' : 's'}${s.lastPurchaseDate ? ` · last ${formatDate(s.lastPurchaseDate)}` : ''}`}
        />
        <Stat
          label="Total paid"
          value={formatINR(s.totals.paid + s.totals.paidAtPurchase)}
          hint={`${formatINR(s.totals.paidAtPurchase)} with bills · ${formatINR(s.totals.paid)} later${s.totals.discount ? ` · ${formatINR(s.totals.discount)} discount` : ''}`}
        />
      </StatGrid>

      <Card className="mb-2">
        <div className="info-strip">
          {s.contactPerson && <InfoRow icon={<User size={16} />}>{s.contactPerson}</InfoRow>}
          <InfoRow icon={<Phone size={16} />}>{s.phone ?? <span className="faint">No phone</span>}</InfoRow>
          {s.email && <InfoRow icon={<Mail size={16} />}>{s.email}</InfoRow>}
          <InfoRow icon={<MapPin size={16} />}>{s.address ? <span className="muted">{s.address}</span> : <span className="faint">No address</span>}</InfoRow>
          <InfoRow icon={<Wallet size={16} />}>
            {s.openingBalance ? (
              <>
                Opening balance <b className="money">{formatINR(s.openingBalance.amount)}</b> {s.openingBalance.direction === 'payable' ? 'payable' : 'advance'}
              </>
            ) : (
              <span className="faint">No opening balance</span>
            )}
          </InfoRow>
          {s.notes && (
            <InfoRow icon={<StickyNote size={16} />}>
              <span className="muted">{s.notes}</span>
            </InfoRow>
          )}
        </div>
      </Card>

      <Card padded={false}>
        <Tabs
          value={tab}
          onChange={(k) => setTab(k as typeof tab)}
          tabs={[
            { key: 'statement', label: 'Statement' },
            { key: 'purchases', label: 'Purchases', count: s.totals.purchases },
            { key: 'payments', label: 'Payments', count: s.totals.payments },
          ]}
        />
        <div className="tab-toolbar">
          <DateRangePicker value={range} onChange={setRange} />
          {tab === 'statement' && <ExportButtons report={statement.data} />}
        </div>
        {tab === 'statement' && (
          <div className="statement-view">
          <ReportView
            report={statement.data}
            loading={statement.loading}
            error={statement.error}
            onRetry={statement.reload}
            onLink={openLink}
            hideTitle
            emptyMessage={`No entries between ${describeRange(range)}.`}
          />
          </div>
        )}
        {tab === 'purchases' &&
          (purchases.error ? (
            <div className="card-body">
              <ErrorBox error={purchases.error} onRetry={purchases.reload} />
            </div>
          ) : (
            <DataTable
              columns={purchaseColumns}
              rows={purchases.data?.rows}
              loading={purchases.loading}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/purchases/${r.id}`)}
              rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
              empty={<EmptyState title="No purchases" message={`No purchases from ${s.name} between ${describeRange(range)}.`} />}
              footer={
                purchases.data && purchases.data.rows.length
                  ? {
                      date: `${purchases.data.totals.count} bills`,
                      total: <span className="money">{formatINR(purchases.data.totals.total)}</span>,
                      credit: <span className="money">{formatINR(purchases.data.totals.credit)}</span>,
                    }
                  : undefined
              }
            />
          ))}
        {tab === 'payments' &&
          (payments.error ? (
            <div className="card-body">
              <ErrorBox error={payments.error} onRetry={payments.reload} />
            </div>
          ) : (
            <DataTable
              columns={paymentColumns}
              rows={payments.data?.rows}
              loading={payments.loading}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/purchases/payments/${r.id}`)}
              rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
              empty={<EmptyState title="No payments" message={`No payments to ${s.name} between ${describeRange(range)}.`} />}
              footer={
                payments.data && payments.data.rows.length
                  ? {
                      date: `${payments.data.totals.count} payments`,
                      discount: <span className="money">{formatINR(payments.data.totals.discount)}</span>,
                      amount: <span className="money">{formatINR(payments.data.totals.amount)}</span>,
                    }
                  : undefined
              }
            />
          ))}
      </Card>

      <SupplierFormModal
        open={editing}
        supplier={s}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          reloadAll();
        }}
      />
      <SupplierPaymentModal open={paying} supplier={pickerSupplier} onClose={() => setPaying(false)} onSaved={reloadAll} />
    </Page>
  );
}
