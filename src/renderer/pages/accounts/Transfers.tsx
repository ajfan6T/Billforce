import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeftRight, ArrowRight } from 'lucide-react';
import { Alert, Button, Card, EmptyState, ErrorBox, Page, PageHeader, Toolbar } from '../../components/ui';
import { DateInput, Field, MoneyInput, Select, TextInput } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker, ExportButtons } from '../../components/report';
import { useMutation, useQuery } from '../../hooks';
import { useToast } from '../../feedback';
import type { ApiOutput } from '../../api';
import { formatDrCr, formatINR } from '../../../shared/money';
import { describeRange, todayISO } from '../../../shared/dates';
import { CancelledBadge, listReport, useRange } from './common';

type Row = ApiOutput<'accounts.transfers'>['rows'][number];

export function TransfersPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const accounts = useQuery('accounts.list', { groups: ['cash', 'bank'], withBalances: true });
  const [range, setRange] = useRange('transfers.range', 'this_month');
  const list = useQuery('accounts.transfers', { from: range.from, to: range.to });
  const m = useMutation('accounts.transfer');
  const [date, setDate] = useState(todayISO());
  const [fromId, setFromId] = useState<number | null>(null);
  const [toId, setToId] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [narration, setNarration] = useState('');

  const all = accounts.data ?? [];
  const cash = all.filter((a) => a.groupCode === 'cash');
  const bank = all.filter((a) => a.groupCode === 'bank');
  const byKey = (k: string) => all.find((a) => a.systemKey === k)?.id ?? null;
  const options = (exclude: number | null) => [
    ...cash.filter((a) => a.id !== exclude).map((a) => ({ value: a.id, label: `${a.name} (cash)` })),
    ...bank.filter((a) => a.id !== exclude).map((a) => ({ value: a.id, label: a.name })),
  ];
  const balOf = (id: number | null) => all.find((a) => a.id === id)?.balance;
  const presets = [
    { label: 'Deposit cash in bank', from: byKey('CASH'), to: byKey('BANK') },
    { label: 'Withdraw cash from bank', from: byKey('BANK'), to: byKey('CASH') },
    { label: 'UPI money to bank', from: byKey('UPI'), to: byKey('BANK') },
  ];
  const problem = !fromId || !toId ? 'Choose both accounts' : fromId === toId ? 'Choose two different accounts' : !amount ? 'Enter the amount' : null;

  const save = async () => {
    if (problem) return;
    try {
      const r = await m.run({ date, fromAccountId: fromId!, toAccountId: toId!, amount: amount!, narration: narration.trim() || null });
      toast.success(`${r.entry.narration} · ${formatINR(amount)} (${r.entry.voucherNo})`);
      for (const w of r.warnings) toast.warning(w);
      setAmount(null);
      setNarration('');
      void list.reload();
      void accounts.reload();
    } catch {
      /* shown below */
    }
  };

  const columns: Array<Column<Row>> = [
    { key: 'date', label: 'Date', type: 'date', width: 104 },
    { key: 'voucherNo', label: 'No', width: 140, render: (r) => <span className="ac-strong nowrap">{r.voucherNo}</span> },
    {
      key: 'fromAccount',
      label: 'From → To',
      render: (r) => (
        <div>
          <span className="row" style={{ gap: 6 }}>
            {r.fromAccount} <ArrowRight size={14} className="faint" /> {r.toAccount}
            {r.isVoid && <CancelledBadge />}
          </span>
          {r.narration && <span className="ac-sub">{r.narration}</span>}
        </div>
      ),
    },
    { key: 'createdBy', label: 'Entered by', width: 150 },
    { key: 'amount', label: 'Amount', type: 'money', width: 140 },
  ];

  const report = useMemo(
    () =>
      list.data &&
      listReport(
        'Cash & bank transfers',
        describeRange(range),
        [
          { key: 'date', label: 'Date', type: 'date', width: 11, get: (r: Row) => r.date },
          { key: 'no', label: 'No', width: 16, nowrap: true, get: (r) => r.voucherNo },
          { key: 'from', label: 'From', width: 22, get: (r) => r.fromAccount },
          { key: 'to', label: 'To', width: 22, get: (r) => r.toAccount },
          { key: 'narration', label: 'Narration', width: 32, get: (r) => (r.isVoid ? `${r.narration ?? ''} (cancelled)` : r.narration) },
          { key: 'amount', label: 'Amount', type: 'money', width: 14, get: (r) => (r.isVoid ? null : r.amount) },
        ],
        list.data.rows,
        { totals: { date: null, no: 'Total', from: null, to: null, narration: null, amount: list.data.total }, link: (r) => ({ kind: 'journal', id: r.id }) },
      ),
    [list.data, range],
  );

  return (
    <Page>
      <PageHeader title="Cash & bank transfer" subtitle="Cash deposited in the bank, cash withdrawn, or money moved between your UPI and bank accounts" actions={<ExportButtons report={report} />} />
      <Card
        title={
          <span className="row">
            <ArrowLeftRight size={17} /> New transfer
          </span>
        }
        className="ac-quick"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="ac-presets">
            {presets
              .filter((p) => p.from && p.to)
              .map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="pill"
                  onClick={() => {
                    setFromId(p.from);
                    setToId(p.to);
                  }}
                >
                  {p.label}
                </button>
              ))}
          </div>
          <div className="ac-transfer-grid">
            <Field label="From" required hint={fromId !== null && balOf(fromId) !== undefined ? `Balance ${formatDrCr(balOf(fromId)!)}` : undefined}>
              <Select<number> value={fromId ?? undefined} onChange={setFromId} placeholder="Money goes out of…" options={options(null)} />
            </Field>
            <div className="ac-transfer-arrow">
              <ArrowRight size={18} />
            </div>
            <Field label="To" required hint={toId !== null && balOf(toId) !== undefined ? `Balance ${formatDrCr(balOf(toId)!)}` : undefined}>
              <Select<number> value={toId ?? undefined} onChange={setToId} placeholder="Money comes into…" options={options(fromId)} />
            </Field>
          </div>
          <div className="ac-quick-grid mt-1" style={{ gridTemplateColumns: '160px 200px minmax(0, 1fr)' }}>
            <Field label="Date" required>
              <DateInput value={date} max={todayISO()} onChange={setDate} />
            </Field>
            <Field label="Amount" required error={m.fields.amount}>
              <MoneyInput value={amount} onChange={setAmount} />
            </Field>
            <Field label="Narration">
              <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Written automatically if left blank" maxLength={500} />
            </Field>
          </div>
          {m.error && (
            <div className="mt-1">
              <Alert tone="red">{m.error}</Alert>
            </div>
          )}
          <div className="ac-quick-actions">
            {problem && (fromId || toId || amount) ? <span className="small muted">{problem}</span> : null}
            <Button type="submit" variant="primary" loading={m.loading} disabled={!!problem}>
              Save transfer
            </Button>
          </div>
        </form>
      </Card>
      <Card title="Transfers" padded={false} className="ac-list-card">
        <div className="ac-filters">
          <Toolbar>
            <DateRangePicker value={range} onChange={setRange} />
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
            onRowClick={(r) => navigate(`/accounts/journals/${r.id}`)}
            rowClassName={(r) => (r.isVoid ? 'cancelled' : '')}
            footer={list.data?.rows.length ? { amount: <span className="money">{formatINR(list.data.total)}</span> } : undefined}
            empty={<EmptyState icon={<ArrowLeftRight size={30} />} title="No transfers in this period" message="Deposits, withdrawals and UPI-to-bank transfers appear here." />}
          />
        )}
      </Card>
    </Page>
  );
}
