import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { IndianRupee, Mail, MapPin, Pencil, Phone, Power, ReceiptText, StickyNote, Trash2, Undo2, Wallet } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, ErrorBox, Loading, Page, PageHeader, Stat, StatGrid, Tabs } from '../../components/ui';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker, ExportButtons, ReportView, rangeFromPreset, type RangeValue } from '../../components/report';
import { useHotkeys, useQuery, useStoredState } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { useLinkedPeriod, useOpenLink } from '../../links';
import { call, type ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { describeRange, formatDate } from '../../../shared/dates';
import { CancelledBadge, InactiveBadge, InfoRow, ModeBadge } from './common';
import { CustomerFormModal } from './CustomerFormModal';
import { ReceiptModal } from './ReceiptModal';

type BillRow = ApiOutput<'customers.bills'>['rows'][number];
type ReceiptRow = ApiOutput<'receipts.list'>['rows'][number];

export function CustomerDetailPage() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const openLink = useOpenLink();
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const [tab, setTab] = useStoredState<'statement' | 'bills' | 'payments'>('customer.tab', 'statement');
  // A report row (e.g. Sales by customer, ageing, trial balance) opens the account on the report's period.
  const linkedPeriod = useLinkedPeriod();
  const [range, setRange] = useState<RangeValue>(() => linkedPeriod ?? rangeFromPreset('this_fy'));
  const [editing, setEditing] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const valid = Number.isInteger(id) && id > 0;

  const cust = useQuery('customers.get', valid ? { id } : null);
  const statement = useQuery('customers.statement', valid && tab === 'statement' ? { customerId: id, from: range.from, to: range.to } : null);
  const bills = useQuery('customers.bills', valid && tab === 'bills' ? { customerId: id, from: range.from, to: range.to } : null);
  const payments = useQuery('receipts.list', valid && tab === 'payments' ? { customerId: id, from: range.from, to: range.to } : null);
  const c = cust.data;

  const reloadAll = () => {
    void cust.reload();
    if (tab === 'statement') void statement.reload();
    if (tab === 'bills') void bills.reload();
    if (tab === 'payments') void payments.reload();
  };

  useHotkeys({ 'alt+r': () => c && can('customers.receive') && setReceiving(true) });

  const billColumns: Array<Column<BillRow>> = [
    { key: 'date', label: 'Date', type: 'date', width: 110 },
    { key: 'billNo', label: 'Bill no', render: (r) => <span className="bold">{r.billNo}</span> },
    { key: 'items', label: 'Items', render: (r) => <span className="cell-sub" style={{ color: 'inherit' }}>{r.items}</span> },
    { key: 'paymentMode', label: 'Mode', render: (r) => (r.status === 'cancelled' ? <CancelledBadge /> : <ModeBadge mode={r.paymentMode} />) },
    { key: 'total', label: 'Total', type: 'money' },
    { key: 'paid', label: 'Paid', type: 'money' },
    { key: 'credit', label: 'On credit', type: 'money' },
  ];
  const payColumns: Array<Column<ReceiptRow>> = [
    { key: 'date', label: 'Date', type: 'date', width: 110 },
    { key: 'receiptNo', label: 'Receipt no', render: (r) => <span className="bold">{r.receiptNo}</span> },
    { key: 'mode', label: 'Mode', render: (r) => (r.status === 'cancelled' ? <CancelledBadge /> : <ModeBadge mode={r.mode} />) },
    { key: 'reference', label: 'Reference', render: (r) => r.reference ?? <span className="faint">—</span> },
    { key: 'discount', label: 'Discount', type: 'money', render: (r) => (r.discount ? formatINR(r.discount) : '') },
    { key: 'amount', label: 'Amount', type: 'money' },
  ];

  const pickerCustomer = useMemo(
    () => (c ? { id: c.id, name: c.name, phone: c.phone, balance: c.balance, creditLimit: c.creditLimit } : null),
    [c],
  );

  if (!valid) return <Page><ErrorBox error="This customer link is not valid." /></Page>;
  if (cust.error) return <Page><PageHeader title="Customer" back="/customers" /><ErrorBox error={cust.error} onRetry={cust.reload} /></Page>;
  if (!c) return <Loading />;

  const toggleActive = async () => {
    if (c.isActive) {
      const ok = await dialogs.confirm({
        title: `Deactivate ${c.name}?`,
        message: (
          <>
            {c.name} will no longer appear when billing or receiving payments. Their history and balance stay in your books.
            {c.balance !== 0 && (
              <>
                {' '}
                <b>Note:</b> the customer still has a balance of {formatINR(Math.abs(c.balance))} {c.balance > 0 ? 'due' : 'advance'}.
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
      await call('customers.setActive', { id: c.id, active: !c.isActive });
      toast.success(c.isActive ? `${c.name} deactivated` : `${c.name} is active again`);
      void cust.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async () => {
    const ok = await dialogs.confirm({
      title: `Delete ${c.name}?`,
      message: 'This customer has no bills or payments, so the record can be deleted completely. This cannot be undone.',
      confirmText: 'Delete customer',
      danger: true,
    });
    if (!ok) return;
    try {
      await call('customers.remove', { id: c.id });
      toast.success(`Deleted ${c.name}`);
      navigate('/customers');
    } catch (e) {
      toast.error(e);
    }
  };

  const tone = c.balance > 0 ? 'red' : c.balance < 0 ? 'green' : undefined;
  return (
    <Page>
      <PageHeader
        back="/customers"
        title={
          <span className="row">
            {c.name}
            {!c.isActive && <InactiveBadge />}
            {c.overLimit && <Badge tone="red">Over credit limit</Badge>}
          </span>
        }
        subtitle={[c.phone, `Customer since ${formatDate(c.createdAt.slice(0, 10))}`].filter(Boolean).join(' · ')}
        actions={
          <>
            {can('customers.receive') && (
              <Button variant="primary" icon={<IndianRupee size={16} />} kbd="Alt+R" onClick={() => setReceiving(true)}>
                Receive payment
              </Button>
            )}
            {can('billing.create') && c.isActive && (
              <Button icon={<ReceiptText size={16} />} onClick={() => navigate(`/billing/new?customer=${c.id}`)}>
                New bill
              </Button>
            )}
            {can('customers.manage') && (
              <>
                <Button icon={<Pencil size={16} />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button variant="ghost" icon={<Power size={16} />} onClick={toggleActive}>
                  {c.isActive ? 'Deactivate' : 'Re-activate'}
                </Button>
                {c.canRemove && (
                  <Button variant="ghost" icon={<Trash2 size={16} />} onClick={remove}>
                    Delete
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      {!c.isActive && (
        <div className="cancel-banner">
          <Alert tone="neutral">This customer is deactivated and hidden from billing. Re-activate to bill them again.</Alert>
        </div>
      )}
      <StatGrid>
        <Stat
          label={c.balance > 0 ? 'Amount due' : c.balance < 0 ? 'Advance with you' : 'Balance'}
          value={c.balance === 0 ? 'Nothing due' : formatINR(Math.abs(c.balance))}
          tone={tone}
          icon={<Wallet size={18} />}
          hint={c.lastPaymentDate ? `Last payment ${formatDate(c.lastPaymentDate)}` : 'No separate payments yet'}
        />
        <Stat
          label="Credit limit"
          value={c.creditLimit === null ? 'No limit' : formatINR(c.creditLimit)}
          tone={c.overLimit ? 'red' : undefined}
          hint={c.creditLimit !== null ? (c.overLimit ? `Over by ${formatINR(c.balance - c.creditLimit)}` : `${formatINR(Math.max(c.creditLimit - Math.max(c.balance, 0), 0))} available`) : undefined}
        />
        <Stat label="Total billed" value={formatINR(c.totals.billed)} hint={`${c.totals.bills} bill${c.totals.bills === 1 ? '' : 's'}${c.lastBillDate ? ` · last ${formatDate(c.lastBillDate)}` : ''}`} />
        <Stat
          label="Payments received"
          value={formatINR(c.totals.received + c.totals.paidAtBilling)}
          hint={`${formatINR(c.totals.paidAtBilling)} at billing · ${formatINR(c.totals.received)} later${c.totals.discount ? ` · ${formatINR(c.totals.discount)} discount` : ''}`}
        />
        <Stat
          label="Returns & credit notes"
          value={formatINR(c.totals.returned)}
          icon={<Undo2 size={18} />}
          hint={c.totals.returned ? (c.totals.refunded ? `${formatINR(c.totals.refunded)} refunded · ${formatINR(c.totals.returned - c.totals.refunded)} adjusted in account` : 'Adjusted in account') : 'No returns'}
        />
      </StatGrid>
      <BalanceSum c={c} />

      <Card className="mb-2">
        <div className="info-strip">
          <InfoRow icon={<Phone size={16} />}>{c.phone ?? <span className="faint">No phone</span>}</InfoRow>
          {c.email && <InfoRow icon={<Mail size={16} />}>{c.email}</InfoRow>}
          <InfoRow icon={<MapPin size={16} />}>{c.address ? <span className="muted">{c.address}</span> : <span className="faint">No address</span>}</InfoRow>
          <InfoRow icon={<Wallet size={16} />}>
            {c.openingBalance ? (
              <>
                Opening balance <b className="money">{formatINR(c.openingBalance.amount)}</b> {c.openingBalance.direction === 'receivable' ? 'due' : 'advance'}
              </>
            ) : (
              <span className="faint">No opening balance</span>
            )}
          </InfoRow>
          {c.notes && (
            <InfoRow icon={<StickyNote size={16} />}>
              <span className="muted">{c.notes}</span>
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
            { key: 'bills', label: 'Bills', count: c.totals.bills },
            { key: 'payments', label: 'Payments', count: c.totals.receipts },
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
        {tab === 'bills' &&
          (bills.error ? (
            <div className="card-body">
              <ErrorBox error={bills.error} onRetry={bills.reload} />
            </div>
          ) : (
            <DataTable
              columns={billColumns}
              rows={bills.data?.rows}
              loading={bills.loading}
              rowKey={(r) => r.id}
              onRowClick={(r) => openLink({ kind: 'bill', id: r.id })}
              rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
              empty={<EmptyState title="No bills" message={`No bills for ${c.name} between ${describeRange(range)}.`} />}
              footer={
                bills.data && bills.data.rows.length
                  ? {
                      date: `${bills.data.totals.count} bills`,
                      total: <span className="money">{formatINR(bills.data.totals.total)}</span>,
                      paid: <span className="money">{formatINR(bills.data.totals.paid)}</span>,
                      credit: <span className="money">{formatINR(bills.data.totals.credit)}</span>,
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
              columns={payColumns}
              rows={payments.data?.rows}
              loading={payments.loading}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/customers/receipts/${r.id}`)}
              rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
              empty={<EmptyState title="No payments" message={`No payments from ${c.name} between ${describeRange(range)}.`} />}
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

      <CustomerFormModal
        open={editing}
        customer={c}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          reloadAll();
        }}
      />
      <ReceiptModal open={receiving} customer={pickerCustomer} onClose={() => setReceiving(false)} onSaved={() => reloadAll()} />
    </Page>
  );
}

type CustomerView = ApiOutput<'customers.get'>;

/**
 * "Opening ₹100 + Billed ₹930 − Payments ₹638 − Returns ₹78 = Due ₹314": how the cards above add up to the
 * amount due (every part comes from the same totals, so it always agrees with the balance).
 */
function BalanceSum({ c }: { c: CustomerView }) {
  const t = c.totals;
  const parts: Array<{ sign: '+' | '−'; label: string; value: number }> = [];
  if (t.opening) parts.push({ sign: t.opening > 0 ? '+' : '−', label: t.opening > 0 ? 'Opening balance' : 'Opening advance', value: Math.abs(t.opening) });
  parts.push({ sign: '+', label: 'Billed', value: t.billed });
  parts.push({ sign: '−', label: 'Payments', value: t.paidAtBilling + t.received });
  if (t.discount) parts.push({ sign: '−', label: 'Discounts', value: t.discount });
  if (t.returned) parts.push({ sign: '−', label: 'Returns', value: t.returned });
  if (t.refunded) parts.push({ sign: '+', label: 'Refunds paid', value: t.refunded });
  if (t.adjustments) parts.push({ sign: t.adjustments > 0 ? '+' : '−', label: 'Other entries', value: Math.abs(t.adjustments) });
  const result = c.balance > 0 ? 'Amount due' : c.balance < 0 ? 'Advance with you' : 'Balance';
  return (
    <p className="balance-sum small muted" aria-label="How the balance adds up">
      {parts.map((p, i) => (
        <span key={p.label}>
          {i === 0 ? (p.sign === '−' ? '− ' : '') : ` ${p.sign} `}
          {p.label} <b className="money">{formatINR(p.value)}</b>
        </span>
      ))}
      {' = '}
      {result} <b className="money">{c.balance === 0 ? formatINR(0) : formatINR(Math.abs(c.balance))}</b>
    </p>
  );
}
