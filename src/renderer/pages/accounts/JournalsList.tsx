import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { BookOpen, Plus } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBox, Page, PageHeader, Toolbar } from '../../components/ui';
import { SearchInput, Select } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker, ExportButtons } from '../../components/report';
import { useDebounced, useHotkeys, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { call, type ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { describeRange } from '../../../shared/dates';
import type { VoucherType } from '../../../shared/constants';
import { CancelledBadge, listReport, PageBar, usePage, useRange, useVoucherOptions, VoucherBadge } from './common';

type Row = ApiOutput<'journals.list'>['rows'][number];

export function JournalsListPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [range, setRange] = useRange('journals.range', 'this_month');
  const [type, setType] = useState<VoucherType | ''>('');
  const voucherOptions = useVoucherOptions();
  const [status, setStatus] = useState<'all' | 'active' | 'cancelled'>('all');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [page, setPage] = usePage(`${range.from}|${range.to}|${type}|${dq}|${status}`);
  const input = { from: range.from, to: range.to, voucherType: type || null, q: dq || null, status, page };
  const list = useQuery('journals.list', input);
  const canManage = can('accounts.manage');

  useHotkeys({ 'alt+n': () => canManage && navigate('/accounts/journals/new') });

  const columns: Array<Column<Row>> = [
    { key: 'date', label: 'Date', type: 'date', width: 104 },
    { key: 'voucherNo', label: 'No', width: 140, render: (r) => <span className="ac-strong nowrap">{r.voucherNo ?? `#${r.id}`}</span> },
    {
      key: 'voucherType',
      label: 'Type',
      width: 170,
      value: (r) => r.voucherLabel,
      render: (r) => (r.isVoid ? <CancelledBadge /> : <VoucherBadge type={r.voucherType} label={r.voucherLabel} />),
    },
    {
      key: 'narration',
      label: 'Particulars',
      render: (r) => (
        <div>
          {r.narration || <span className="faint">No narration</span>}
          <span className="ac-sub">
            Dr {r.debitNames || '—'} · Cr {r.creditNames || '—'}
          </span>
        </div>
      ),
    },
    {
      key: 'sourceLabel',
      label: 'Made from',
      width: 170,
      render: (r) => (r.link.kind === 'journal' ? <span className="faint">{r.sourceType === 'manual' || r.sourceType === 'loan' ? 'Accounts' : r.sourceLabel}</span> : r.sourceLabel),
    },
    { key: 'amount', label: 'Amount', type: 'money', width: 140 },
  ];

  const toReport = (data: ApiOutput<'journals.list'>) =>
    listReport(
      'Journal entries',
      describeRange(range),
      [
        { key: 'date', label: 'Date', type: 'date', width: 11, get: (r: Row) => r.date },
        { key: 'no', label: 'No', width: 16, nowrap: true, get: (r) => r.voucherNo ?? `#${r.id}` },
        { key: 'type', label: 'Type', width: 20, get: (r) => (r.isVoid ? `${r.voucherLabel} (cancelled)` : r.voucherLabel) },
        { key: 'narration', label: 'Narration', width: 36, get: (r) => r.narration },
        { key: 'dr', label: 'Debit', width: 24, get: (r) => r.debitNames },
        { key: 'cr', label: 'Credit', width: 24, get: (r) => r.creditNames },
        { key: 'amount', label: 'Amount', type: 'money', width: 14, get: (r) => (r.isVoid ? null : r.amount) },
      ],
      data.rows,
      { totals: { date: null, no: 'Total', type: null, narration: null, dr: null, cr: null, amount: data.totalAmount }, link: (r) => ({ kind: 'journal', id: r.id }), landscape: true },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const report = useMemo(() => (list.data ? toReport(list.data) : undefined), [list.data, range]);
  // The export has every matching entry, not just the page on screen (its total covers them all).
  const loadAll = list.data && list.data.pageCount > 1 ? async () => toReport(await call('journals.list', { ...input, page: null, all: true })) : undefined;

  return (
    <Page>
      <PageHeader
        title="Journal entries"
        subtitle="Every entry in your books, including those made automatically by bills, purchases and salaries"
        actions={
          <>
            <ExportButtons report={report} load={loadAll} />
            {canManage && (
              <Button variant="primary" icon={<Plus size={16} />} kbd="Alt+N" onClick={() => navigate('/accounts/journals/new')}>
                New journal
              </Button>
            )}
          </>
        }
      />
      <Card padded={false} className="ac-list-card">
        <div className="ac-filters">
          <Toolbar>
            <DateRangePicker value={range} onChange={setRange} />
            <Select<VoucherType | ''> value={type} onChange={setType} aria-label="Voucher type" options={[{ value: '', label: 'All types' }, ...voucherOptions]} />
            <Select<'all' | 'active' | 'cancelled'>
              value={status}
              onChange={setStatus}
              aria-label="Status"
              options={[
                { value: 'all', label: 'Active & cancelled' },
                { value: 'active', label: 'Active only' },
                { value: 'cancelled', label: 'Cancelled only' },
              ]}
            />
            <SearchInput value={q} onChange={setQ} placeholder="Number, narration, account, party or amount" />
          </Toolbar>
        </div>
        <PageBar info={list.data} total={list.data?.total ?? 0} what="entries (newest first)" onPage={setPage} figuresNote={false} />
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
            onRowClick={(r) => navigate(`/accounts/journals/${r.id}`)}
            rowClassName={(r) => (r.isVoid ? 'cancelled' : '')}
            footer={list.data?.rows.length ? { narration: `${list.data.total} ${list.data.total === 1 ? 'entry' : 'entries'}`, amount: <span className="money">{formatINR(list.data.totalAmount)}</span> } : undefined}
            empty={
              dq || type || status !== 'all' ? (
                'No entries match your filters'
              ) : (
                <EmptyState
                  icon={<BookOpen size={32} />}
                  title="No entries in this period"
                  message={`Nothing was recorded between ${describeRange(range)}.`}
                  action={
                    canManage && (
                      <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/accounts/journals/new')}>
                        New journal
                      </Button>
                    )
                  }
                />
              )
            }
          />
        )}
        <PageBar info={list.data} total={list.data?.total ?? 0} what="entries (newest first)" onPage={setPage} figuresNote={false} bottom />
      </Card>
    </Page>
  );
}
