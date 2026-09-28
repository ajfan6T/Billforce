import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Receipt, Save } from 'lucide-react';
import { Alert, Button, Card, EmptyState, ErrorBox, Page, PageHeader, Stat, StatGrid, Tabs, Toolbar } from '../../components/ui';
import { SearchInput, Select } from '../../components/forms';
import { AccountSelect } from '../../components/pickers';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker, ExportButtons, ReportView } from '../../components/report';
import { useDebounced, useMutation, useQuery, useStoredState } from '../../hooks';
import { useToast } from '../../feedback';
import { useOpenLink } from '../../links';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { describeRange } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS, type PaymentMode } from '../../../shared/constants';
import { CancelledBadge, fmtMode, listReport, ModeBadge, useRange } from './common';
import { emptyExpense, expensePayload, expenseProblem, ExpenseFields, type ExpenseDraft } from './ExpenseFields';

type Row = ApiOutput<'expenses.list'>['rows'][number];

export function ExpensesPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [lastMode, setLastMode] = useStoredState<PaymentMode>('accounts.expense.mode', 'cash');
  const [draft, setDraft] = useState<ExpenseDraft>(() => emptyExpense(lastMode));
  const [formKey, setFormKey] = useState(0);
  const create = useMutation('expenses.create');
  const [tab, setTab] = useState<'list' | 'summary'>('list');
  const [range, setRange] = useRange('expenses.range', 'this_month');
  // Opening an expense head's ledger keeps this page's period.
  const openLink = useOpenLink(range);
  const [head, setHead] = useState<number | null>(null);
  const [mode, setMode] = useState<PaymentMode | ''>('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const list = useQuery('expenses.list', { from: range.from, to: range.to, accountId: head, mode: mode || null, q: dq || null });
  const summary = useQuery('expenses.summary', tab === 'summary' ? { from: range.from, to: range.to } : null);
  const problem = expenseProblem(draft);
  const t = list.data?.totals;

  const save = async () => {
    if (problem || create.loading) return;
    try {
      const x = await create.run(expensePayload(draft));
      toast.success(`Saved ${x.expenseNo}: ${x.accountName} ${formatINR(x.amount)}`, { label: 'Open', onClick: () => navigate(`/accounts/expenses/${x.id}`) });
      for (const w of x.warnings) toast.warning(w);
      setLastMode(draft.pay.mode);
      // Keep the date and payment mode for the next entry.
      setDraft({ ...emptyExpense(draft.pay.mode), date: draft.date, pay: draft.pay });
      setFormKey((k) => k + 1);
      // Ready for the next one: back to the expense head.
      setTimeout(() => document.querySelector<HTMLSelectElement>('.ac-quick .ac-head-field select')?.focus(), 50);
      void list.reload();
      if (tab === 'summary') void summary.reload();
    } catch {
      /* shown in the form */
    }
  };

  const columns: Array<Column<Row>> = [
    { key: 'date', label: 'Date', type: 'date', width: 104 },
    { key: 'expenseNo', label: 'No', width: 140, render: (r) => <span className="ac-strong nowrap">{r.expenseNo}</span> },
    {
      key: 'accountName',
      label: 'Expense head',
      render: (r) => (
        <div>
          {r.accountName}
          {r.remarks && <span className="ac-sub">{r.remarks}</span>}
        </div>
      ),
    },
    { key: 'payee', label: 'Paid to', value: (r) => r.supplierName ?? r.payee, render: (r) => r.supplierName ?? r.payee ?? <span className="faint">—</span> },
    {
      key: 'mode',
      label: 'Paid by',
      width: 210,
      render: (r) =>
        r.status === 'cancelled' ? (
          <CancelledBadge />
        ) : (
          <span className="row" style={{ gap: 6 }}>
            <ModeBadge mode={r.mode} />
            {r.payAccountName && r.mode !== 'cash' && <span className="small muted nowrap">{r.payAccountName}</span>}
          </span>
        ),
    },
    { key: 'amount', label: 'Amount', type: 'money', width: 140 },
  ];

  const listExport = useMemo(() => {
    if (!list.data) return undefined;
    return listReport(
      'Expenses',
      describeRange(range),
      [
        { key: 'date', label: 'Date', type: 'date', width: 11, get: (r: Row) => r.date },
        { key: 'no', label: 'No', width: 16, get: (r) => r.expenseNo },
        { key: 'head', label: 'Expense head', width: 24, get: (r) => r.accountName },
        { key: 'payee', label: 'Paid to', width: 22, get: (r) => r.supplierName ?? r.payee },
        { key: 'mode', label: 'Paid by', width: 12, get: (r) => (r.status === 'cancelled' ? 'Cancelled' : fmtMode(r.mode)) },
        { key: 'ref', label: 'Ref no', width: 12, get: (r) => r.reference },
        { key: 'remarks', label: 'Remarks', width: 28, get: (r) => r.remarks },
        { key: 'amount', label: 'Amount', type: 'money', width: 14, get: (r) => (r.status === 'cancelled' ? null : r.amount) },
      ],
      list.data.rows,
      {
        totals: { date: null, no: 'Total', head: `${list.data.totals.count} expenses`, payee: null, mode: null, ref: null, remarks: null, amount: list.data.totals.amount },
        summary: [
          { label: 'Total', value: list.data.totals.amount, type: 'money' },
          { label: 'Cash', value: list.data.totals.cash, type: 'money' },
          { label: 'UPI / Bank', value: list.data.totals.upi + list.data.totals.bank, type: 'money' },
          { label: 'On credit', value: list.data.totals.credit, type: 'money' },
        ],
        link: (r) => ({ kind: 'expense', id: r.id }),
        landscape: true,
      },
    );
  }, [list.data, range]);

  return (
    <Page>
      <PageHeader
        title="Expenses"
        subtitle="Rent, electricity, tea, transport and other running costs of the business"
        actions={<ExportButtons report={tab === 'list' ? listExport : summary.data} />}
      />
      <Card title="Record an expense" className="ac-quick">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <ExpenseFields
            key={formKey}
            value={draft}
            onChange={setDraft}
            fields={create.fields}
            actions={
              <Button type="submit" variant="primary" icon={<Save size={16} />} kbd="Enter" loading={create.loading} disabled={!!problem} title={problem ?? undefined}>
                Save expense
              </Button>
            }
          />
          {create.error && (
            <div className="ac-form-error">
              <Alert tone="red">{create.error}</Alert>
            </div>
          )}
        </form>
      </Card>

      <StatGrid>
        <Stat label="Total expenses" value={formatINR(t?.amount ?? 0)} hint={`${t?.count ?? 0} entries · ${describeRange(range)}`} />
        <Stat label="Paid in cash" value={formatINR(t?.cash ?? 0)} />
        <Stat label="Paid by UPI / bank" value={formatINR((t?.upi ?? 0) + (t?.bank ?? 0))} />
        <Stat label="On credit" value={formatINR(t?.credit ?? 0)} tone={t?.credit ? 'amber' : undefined} hint={t?.cancelled ? `${t.cancelled} cancelled not counted` : 'Owed to suppliers'} />
      </StatGrid>

      <Card padded={false} className="ac-list-card">
        <div style={{ padding: '4px 12px 0' }}>
          <Tabs
            value={tab}
            onChange={(k) => setTab(k as 'list' | 'summary')}
            tabs={[
              { key: 'list', label: 'All expenses', count: list.data?.rows.length },
              { key: 'summary', label: 'By expense head' },
            ]}
          />
        </div>
        <div className="ac-filters">
          <Toolbar>
            <DateRangePicker value={range} onChange={setRange} />
            {tab === 'list' && (
              <>
                <div className="ac-fixed" style={{ width: 220 }}>
                  <AccountSelect value={head} onChange={setHead} types={['expense']} placeholder="All expense heads" allowEmpty />
                </div>
                <Select<PaymentMode | ''>
                  value={mode}
                  onChange={setMode}
                  aria-label="Paid by"
                  options={[{ value: '', label: 'Any payment mode' }, ...(['cash', 'upi', 'bank', 'credit'] as PaymentMode[]).map((m) => ({ value: m, label: m === 'credit' ? 'On credit' : PAYMENT_MODE_LABELS[m] }))]}
                />
                <SearchInput value={q} onChange={setQ} placeholder="Number, head, paid to, remarks" />
              </>
            )}
          </Toolbar>
        </div>
        {tab === 'list' ? (
          list.error ? (
            <div className="card-body">
              <ErrorBox error={list.error} onRetry={list.reload} />
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={list.data?.rows}
              loading={list.loading}
              rowKey={(r) => r.id}
              onRowClick={(r) => navigate(`/accounts/expenses/${r.id}`)}
              rowClassName={(r) => (r.status === 'cancelled' ? 'cancelled' : '')}
              footer={t ? { accountName: `${t.count} expenses`, amount: <span className="money">{formatINR(t.amount)}</span> } : undefined}
              empty={
                dq || head || mode ? (
                  'No expenses match your filters'
                ) : (
                  <EmptyState icon={<Receipt size={32} />} title="No expenses in this period" message="Use the form above to record rent, electricity, tea and other costs." />
                )
              }
            />
          )
        ) : (
          <div className="ac-report-card">
            {summary.data && summary.data.rows.length === 0 ? (
              <EmptyState icon={<Receipt size={32} />} title="No expenses in this period" />
            ) : (
              <ReportView report={summary.data ? { ...summary.data, summary: undefined } : undefined} loading={summary.loading} error={summary.error} onRetry={summary.reload} onLink={openLink} hideTitle />
            )}
          </div>
        )}
      </Card>
      {tab === 'summary' && summary.data && summary.data.rows.length > 0 && (
        <div className="mt-1">
          <Alert tone="neutral">Click an expense head to see its ledger.</Alert>
        </div>
      )}
    </Page>
  );
}
