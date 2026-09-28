import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Wallet } from 'lucide-react';
import { Button, Card, ErrorBox, Page, PageHeader, Stat, StatGrid, Toolbar } from '../../components/ui';
import { Checkbox, SearchInput, Select } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker, ExportButtons } from '../../components/report';
import { useDebounced, useHotkeys, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { describeRange } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS, type SettlementMode } from '../../../shared/constants';
import { CancelledBadge, countText, listReport, ModeBadge, useRange } from '../customers/common';
import { SupplierPaymentModal } from './SupplierPaymentModal';

type Row = ApiOutput<'supplierPayments.list'>['rows'][number];

export function SupplierPaymentsListPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [range, setRange] = useRange('supplierPayments.range', 'this_month');
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<SettlementMode | ''>('');
  const [showCancelled, setShowCancelled] = useState(true);
  const [paying, setPaying] = useState(false);
  const dq = useDebounced(q, 200);
  const list = useQuery('supplierPayments.list', { from: range.from, to: range.to, q: dq || null, mode: mode || null, status: showCancelled ? null : 'active' });
  const t = list.data?.totals;

  useHotkeys({ 'alt+n': () => can('suppliers.pay') && setPaying(true) });

  const columns: Array<Column<Row>> = [
    { key: 'date', label: 'Date', type: 'date', width: 110 },
    { key: 'paymentNo', label: 'Payment no', render: (r) => <span className="bold">{r.paymentNo}</span> },
    { key: 'supplierName', label: 'Supplier' },
    { key: 'mode', label: 'Mode', render: (r) => (r.status === 'cancelled' ? <CancelledBadge /> : <ModeBadge mode={r.mode} />) },
    { key: 'reference', label: 'Reference', render: (r) => r.reference ?? <span className="faint">—</span> },
    { key: 'discount', label: 'Discount', type: 'money', render: (r) => (r.discount ? formatINR(r.discount) : '') },
    { key: 'amount', label: 'Amount', type: 'money' },
    { key: 'createdBy', label: 'Entered by', render: (r) => <span className="small muted">{r.createdBy}</span> },
  ];

  const report = useMemo(
    () =>
      list.data &&
      listReport(
        'Payments made to suppliers',
        describeRange(range),
        [
          { key: 'date', label: 'Date', type: 'date', width: 11, get: (r: Row) => r.date },
          { key: 'no', label: 'Payment no', width: 16, nowrap: true, get: (r) => r.paymentNo },
          { key: 'supplier', label: 'Supplier', width: 24, get: (r) => r.supplierName },
          { key: 'mode', label: 'Mode', width: 8, get: (r) => (r.status === 'cancelled' ? 'Cancelled' : PAYMENT_MODE_LABELS[r.mode]) },
          { key: 'reference', label: 'Reference', width: 16, get: (r) => r.reference },
          { key: 'discount', label: 'Discount', type: 'money', width: 12, get: (r) => (r.status === 'cancelled' ? null : r.discount || null) },
          { key: 'amount', label: 'Amount', type: 'money', width: 14, get: (r) => (r.status === 'cancelled' ? null : r.amount) },
        ],
        list.data.rows,
        {
          totals: { date: null, no: 'Total', supplier: countText(list.data.totals.count, 'payment'), mode: null, reference: null, discount: list.data.totals.discount, amount: list.data.totals.amount },
          summary: [
            { label: 'Total paid', value: list.data.totals.amount, type: 'money' },
            { label: 'Cash', value: list.data.totals.byMode.cash, type: 'money' },
            { label: 'UPI', value: list.data.totals.byMode.upi, type: 'money' },
            { label: 'Bank', value: list.data.totals.byMode.bank, type: 'money' },
          ],
          link: (r) => ({ kind: 'supplier_payment', id: r.id }),
        },
      ),
    [list.data, range],
  );

  return (
    <Page>
      <PageHeader
        title="Payments made"
        subtitle="Money paid to suppliers against what you owe them"
        actions={
          <>
            <ExportButtons report={report} />
            {can('suppliers.pay') && (
              <Button variant="primary" icon={<Wallet size={16} />} kbd="Alt+N" onClick={() => setPaying(true)}>
                Pay supplier
              </Button>
            )}
          </>
        }
      />
      <StatGrid>
        <Stat label="Total paid" value={formatINR(t?.amount ?? 0)} hint={`${countText(t?.count ?? 0, 'payment')} · ${describeRange(range)}`} />
        <Stat label="Cash" value={formatINR(t?.byMode.cash ?? 0)} />
        <Stat label="UPI" value={formatINR(t?.byMode.upi ?? 0)} />
        <Stat label="Bank / cheque" value={formatINR(t?.byMode.bank ?? 0)} />
        <Stat label="Discount received" value={formatINR(t?.discount ?? 0)} tone={t?.discount ? 'green' : undefined} hint={t?.cancelled ? `${t.cancelled} cancelled not counted` : undefined} />
      </StatGrid>
      <Card padded={false} className="list-card">
        <div className="tab-toolbar">
          <Toolbar>
            <DateRangePicker value={range} onChange={setRange} />
            <SearchInput value={q} onChange={setQ} placeholder="Payment no, supplier, reference…" />
            <Select<SettlementMode | ''>
              value={mode}
              onChange={setMode}
              aria-label="Mode"
              style={{ width: 130 }}
              options={[
                { value: '', label: 'All modes' },
                { value: 'cash', label: 'Cash' },
                { value: 'upi', label: 'UPI' },
                { value: 'bank', label: 'Bank' },
              ]}
            />
            <Checkbox checked={showCancelled} onChange={setShowCancelled} label="Show cancelled" />
          </Toolbar>
        </div>
        {list.error ? (
          <div className="card-body">
            <ErrorBox error={list.error} onRetry={list.reload} />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={list.data?.rows}
            loading={list.loading}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/purchases/payments/${r.id}`)}
            rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
            empty={dq || mode ? 'No payments match your filters' : `No payments made between ${describeRange(range)}`}
            footer={
              t && list.data!.rows.length
                ? {
                    date: countText(t.count, 'payment'),
                    discount: <span className="money">{formatINR(t.discount)}</span>,
                    amount: <span className="money">{formatINR(t.amount)}</span>,
                  }
                : undefined
            }
          />
        )}
      </Card>
      <SupplierPaymentModal open={paying} onClose={() => setPaying(false)} onSaved={() => void list.reload()} />
    </Page>
  );
}
