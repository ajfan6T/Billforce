import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { IndianRupee } from 'lucide-react';
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
import { CancelledBadge, countText, listReport, ModeBadge, useRange } from './common';
import { ReceiptModal } from './ReceiptModal';

type Row = ApiOutput<'receipts.list'>['rows'][number];

export function ReceiptsListPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [range, setRange] = useRange('receipts.range', 'this_month');
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<SettlementMode | ''>('');
  const [showCancelled, setShowCancelled] = useState(true);
  const [receiving, setReceiving] = useState(false);
  const dq = useDebounced(q, 200);
  const list = useQuery('receipts.list', { from: range.from, to: range.to, q: dq || null, mode: mode || null, status: showCancelled ? null : 'active' });
  const t = list.data?.totals;

  useHotkeys({ 'alt+n': () => can('customers.receive') && setReceiving(true) });

  const columns: Array<Column<Row>> = [
    { key: 'date', label: 'Date', type: 'date', width: 110 },
    { key: 'receiptNo', label: 'Receipt no', render: (r) => <span className="bold">{r.receiptNo}</span> },
    {
      key: 'customerName',
      label: 'Customer',
      render: (r) => (
        <div>
          {r.customerName}
          {r.customerPhone && <span className="cell-sub">{r.customerPhone}</span>}
        </div>
      ),
    },
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
        'Payments received',
        describeRange(range),
        [
          { key: 'date', label: 'Date', type: 'date', width: 11, get: (r: Row) => r.date },
          { key: 'no', label: 'Receipt no', width: 16, get: (r) => r.receiptNo },
          { key: 'customer', label: 'Customer', width: 24, get: (r) => r.customerName },
          { key: 'mode', label: 'Mode', width: 8, get: (r) => (r.status === 'cancelled' ? 'Cancelled' : PAYMENT_MODE_LABELS[r.mode]) },
          { key: 'reference', label: 'Reference', width: 16, get: (r) => r.reference },
          { key: 'discount', label: 'Discount', type: 'money', width: 12, get: (r) => (r.status === 'cancelled' ? null : r.discount || null) },
          { key: 'amount', label: 'Amount', type: 'money', width: 14, get: (r) => (r.status === 'cancelled' ? null : r.amount) },
        ],
        list.data.rows,
        {
          totals: { date: null, no: 'Total', customer: countText(list.data.totals.count, 'payment'), mode: null, reference: null, discount: list.data.totals.discount, amount: list.data.totals.amount },
          summary: [
            { label: 'Total received', value: list.data.totals.amount, type: 'money' },
            { label: 'Cash', value: list.data.totals.byMode.cash, type: 'money' },
            { label: 'UPI', value: list.data.totals.byMode.upi, type: 'money' },
            { label: 'Bank', value: list.data.totals.byMode.bank, type: 'money' },
          ],
          link: (r) => ({ kind: 'receipt', id: r.id }),
        },
      ),
    [list.data, range],
  );

  return (
    <Page>
      <PageHeader
        title="Payments received"
        subtitle="Money received from customers against their dues"
        actions={
          <>
            <ExportButtons report={report} />
            {can('customers.receive') && (
              <Button variant="primary" icon={<IndianRupee size={16} />} kbd="Alt+N" onClick={() => setReceiving(true)}>
                Receive payment
              </Button>
            )}
          </>
        }
      />
      <StatGrid>
        <Stat label="Total received" value={formatINR(t?.amount ?? 0)} tone="green" hint={`${countText(t?.count ?? 0, 'payment')} · ${describeRange(range)}`} />
        <Stat label="Cash" value={formatINR(t?.byMode.cash ?? 0)} />
        <Stat label="UPI" value={formatINR(t?.byMode.upi ?? 0)} />
        <Stat label="Bank / cheque" value={formatINR(t?.byMode.bank ?? 0)} />
        <Stat label="Discount allowed" value={formatINR(t?.discount ?? 0)} hint={t?.cancelled ? `${t.cancelled} cancelled not counted` : undefined} />
      </StatGrid>
      <Card padded={false} className="list-card">
        <div className="tab-toolbar">
          <Toolbar>
            <DateRangePicker value={range} onChange={setRange} />
            <SearchInput value={q} onChange={setQ} placeholder="Receipt no, customer, reference…" />
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
            onRowClick={(r) => navigate(`/customers/receipts/${r.id}`)}
            rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
            empty={dq || mode ? 'No payments match your filters' : `No payments received between ${describeRange(range)}`}
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
      <ReceiptModal open={receiving} onClose={() => setReceiving(false)} onSaved={() => void list.reload()} />
    </Page>
  );
}
