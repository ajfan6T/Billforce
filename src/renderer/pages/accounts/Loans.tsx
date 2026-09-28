import { useState } from 'react';
import { useNavigate } from 'react-router';
import { HandCoins, Landmark, Plus } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, ErrorBox, Page, PageHeader, Stat, StatGrid } from '../../components/ui';
import { Checkbox, DateInput, Field, MoneyInput, NumberInput, SegmentedControl, Switch, TextArea, TextInput } from '../../components/forms';
import { SettlementPicker } from '../../components/pickers';
import { DataTable, type Column } from '../../components/table';
import { Modal } from '../../components/modal';
import { useHotkeys, useMutation, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useToast } from '../../feedback';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, todayISO } from '../../../shared/dates';
import type { SettlementMode } from '../../../shared/constants';
import { FieldGroup } from './common';
import './accounts.css';

type Loan = ApiOutput<'loans.list'>['rows'][number];

export function LoansPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [showClosed, setShowClosed] = useState(false);
  const q = useQuery('loans.list', { includeClosed: showClosed });
  const [adding, setAdding] = useState(false);
  const canManage = can('accounts.manage');
  const rows = q.data?.rows ?? [];
  useHotkeys({ 'alt+n': () => canManage && setAdding(true) });

  const columns = (taken: boolean): Array<Column<Loan>> => [
    {
      key: 'name',
      label: taken ? 'Taken from' : 'Given to',
      render: (l) => (
        <div>
          <span className="ac-strong">{l.name}</span> {!l.isActive && <Badge>Closed</Badge>}
          <span className="ac-sub">{l.accountName}</span>
        </div>
      ),
    },
    { key: 'interestRate', label: 'Interest', width: 90, render: (l) => (l.interestRate ? `${l.interestRate}%` : <span className="faint">—</span>) },
    { key: 'startDate', label: 'Since', type: 'date', width: 104 },
    { key: 'principal', label: 'Loan amount', type: 'money', width: 130 },
    { key: 'repaid', label: taken ? 'Repaid' : 'Collected', type: 'money', width: 130 },
    { key: 'interestToDate', label: taken ? 'Interest paid' : 'Interest received', type: 'money', width: 130 },
    { key: 'outstanding', label: 'Outstanding', type: 'money', width: 140, render: (l) => <span className={`money ac-strong${l.outstanding ? '' : ' faint'}`}>{formatINR(l.outstanding)}</span> },
  ];

  const table = (taken: boolean) => {
    const list = rows.filter((l) => l.direction === (taken ? 'taken' : 'given'));
    return (
      <Card
        title={
          <span className="row">
            {taken ? <Landmark size={17} /> : <HandCoins size={17} />} {taken ? 'Loans taken' : 'Loans given'}
          </span>
        }
        padded={false}
        className="ac-list-card"
        actions={<span className="ac-type-total">{formatINR(taken ? (q.data?.totals.taken ?? 0) : (q.data?.totals.given ?? 0))}</span>}
      >
        <DataTable
          columns={columns(taken)}
          rows={q.data ? list : undefined}
          loading={q.loading}
          rowKey={(l) => l.id}
          onRowClick={(l) => navigate(`/accounts/loans/${l.id}`)}
          rowClassName={(l) => (l.isActive ? '' : 'inactive')}
          empty={taken ? 'No loans taken. Add bank loans or money borrowed from relatives here.' : 'No loans given. Add money you have lent to others here.'}
        />
      </Card>
    );
  };

  return (
    <Page>
      <PageHeader
        title="Loans"
        subtitle="Loans you have taken (bank, relatives) and loans you have given"
        actions={
          <>
            <Switch checked={showClosed} onChange={setShowClosed} label="Show closed loans" />
            {canManage && (
              <Button variant="primary" icon={<Plus size={16} />} kbd="Alt+N" onClick={() => setAdding(true)}>
                New loan
              </Button>
            )}
          </>
        }
      />
      {q.error ? (
        <ErrorBox error={q.error} onRetry={q.reload} />
      ) : (
        <>
          <StatGrid>
            <Stat label="You owe" value={formatINR(q.data?.totals.taken ?? 0)} tone={q.data?.totals.taken ? 'red' : undefined} hint="Outstanding on loans taken" />
            <Stat label="Owed to you" value={formatINR(q.data?.totals.given ?? 0)} tone={q.data?.totals.given ? 'green' : undefined} hint="Outstanding on loans given" />
            <Stat label="Interest paid" value={formatINR(q.data?.totals.interestPaid ?? 0)} hint="On loans taken" />
            <Stat label="Interest received" value={formatINR(q.data?.totals.interestReceived ?? 0)} hint="On loans given" />
          </StatGrid>
          {q.data && rows.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Landmark size={34} />}
                title="No loans yet"
                message="Record a bank loan, money borrowed from family, or money you have lent to someone. Repayments and interest are then posted to the accounts for you."
                action={
                  canManage && (
                    <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
                      New loan
                    </Button>
                  )
                }
              />
            </Card>
          ) : (
            <div className="stack">
              {table(true)}
              {table(false)}
            </div>
          )}
        </>
      )}
      {adding && q.data && (
        <NewLoanModal
          booksStartDate={q.data.booksStartDate}
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false);
            navigate(`/accounts/loans/${id}`);
          }}
        />
      )}
    </Page>
  );
}

function NewLoanModal({ booksStartDate, onClose, onSaved }: { booksStartDate: string; onClose: () => void; onSaved: (id: number) => void }) {
  const toast = useToast();
  const m = useMutation('loans.create');
  const [direction, setDirection] = useState<'taken' | 'given'>('taken');
  const [name, setName] = useState('');
  const [principal, setPrincipal] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [startDate, setStartDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const [record, setRecord] = useState(true);
  const [pay, setPay] = useState<{ mode: SettlementMode; accountId: number | null }>({ mode: 'bank', accountId: null });
  const [disburseAmount, setDisburseAmount] = useState<number | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const older = !!startDate && startDate < booksStartDate;
  const taken = direction === 'taken';
  const problem = !name.trim() ? 'Enter a name' : !principal ? 'Enter the loan amount' : !startDate ? 'Enter the start date' : null;

  const save = async () => {
    if (problem) return;
    try {
      const l = await m.run({
        name,
        direction,
        principal: principal!,
        interestRate: rate,
        startDate,
        notes: notes.trim() || null,
        openingOutstanding: older ? opening : null,
        disburse: !older && record ? { date: startDate, mode: pay.mode, accountId: pay.accountId, amount: disburseAmount ?? principal! } : null,
      });
      toast.success(`Added ${l.accountName}`);
      onSaved(l.id);
    } catch {
      /* shown below */
    }
  };

  return (
    <Modal
      open
      title="New loan"
      onClose={onClose}
      width={600}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!!problem} onClick={save}>
            Save loan
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <SegmentedControl<'taken' | 'given'>
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'taken', label: 'Loan taken (I borrowed)', icon: <Landmark size={15} /> },
            { value: 'given', label: 'Loan given (I lent)', icon: <HandCoins size={15} /> },
          ]}
        />
        <Field label={taken ? 'Taken from' : 'Given to'} required error={m.fields.name} hint={`A ledger account "${taken ? 'Loan' : 'Loan given'} - ${name.trim() || '…'}" is created for it.`}>
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={taken ? 'e.g. HDFC Bank, Mama ji' : 'e.g. Ramesh Kumar'} maxLength={60} />
        </Field>
        <div className="ac-quick-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 150px 170px' }}>
          <Field label="Loan amount" required error={m.fields.principal} hint="Amount sanctioned / agreed">
            <MoneyInput value={principal} onChange={setPrincipal} />
          </Field>
          <Field label="Interest (% a year)" error={m.fields.interestRate}>
            <NumberInput value={rate} onChange={setRate} decimals={2} placeholder="Optional" />
          </Field>
          <Field label="Start date" required>
            <DateInput value={startDate} max={todayISO()} onChange={setStartDate} />
          </Field>
        </div>
        {older ? (
          <Field
            label={`Amount still ${taken ? 'owed' : 'to be received'} on ${formatDate(booksStartDate)}`}
            hint="This loan started before you began using Billforce. Enter what was outstanding on your books start date."
            error={m.fields.openingOutstanding}
          >
            <MoneyInput value={opening} onChange={setOpening} style={{ maxWidth: 220 }} />
          </Field>
        ) : (
          <div className="stack-sm">
            <Checkbox checked={record} onChange={setRecord} label={taken ? 'Record the loan money received now' : 'Record the loan money paid out now'} />
            {record && (
              <div className="ac-quick-grid" style={{ gridTemplateColumns: 'auto 200px' }}>
                <FieldGroup label={taken ? 'Received into' : 'Paid from'}>
                  <SettlementPicker value={pay} onChange={setPay} />
                </FieldGroup>
                <Field label="Amount" hint="If only part was released">
                  <MoneyInput value={disburseAmount ?? principal} onChange={setDisburseAmount} />
                </Field>
              </div>
            )}
          </div>
        )}
        <Field label="Notes">
          <TextArea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Loan account number, EMI date, security given…" maxLength={1000} />
        </Field>
        {m.error && <Alert tone="red">{m.error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
