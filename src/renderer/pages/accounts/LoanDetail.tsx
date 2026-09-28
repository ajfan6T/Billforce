import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Lock, Pencil, Unlock } from 'lucide-react';
import { Alert, Badge, Button, Card, ErrorBox, Loading, Page, PageHeader, Stat, StatGrid } from '../../components/ui';
import { DateInput, Field, MoneyInput, NumberInput, SegmentedControl, TextArea, TextInput } from '../../components/forms';
import { SettlementPicker } from '../../components/pickers';
import { ExportButtons, ReportView } from '../../components/report';
import { Modal } from '../../components/modal';
import { useMutation, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { useOpenLink } from '../../links';
import { call, type ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, todayISO } from '../../../shared/dates';
import type { SettlementMode } from '../../../shared/constants';
import { FieldGroup } from './common';
import './accounts.css';

type LoanDetail = ApiOutput<'loans.get'>;
type Kind = 'receive' | 'repay' | 'give' | 'collect';

export function LoanDetailPage() {
  const id = Number(useParams().id);
  const valid = Number.isInteger(id) && id > 0;
  const { can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const openLink = useOpenLink();
  const q = useQuery('loans.get', valid ? { id } : null);
  const [editing, setEditing] = useState(false);
  const d = q.data;
  const canManage = can('accounts.manage');

  if (!valid) return <Page><ErrorBox error="This loan link is not valid." /></Page>;
  if (q.error) return <Page><PageHeader title="Loan" back="/accounts/loans" /><ErrorBox error={q.error} onRetry={q.reload} /></Page>;
  if (!d) return <Loading />;
  const taken = d.direction === 'taken';

  const toggle = async () => {
    const closing = d.isActive;
    const ok = await dialogs.confirm({
      title: closing ? `Close the loan "${d.name}"?` : `Re-open the loan "${d.name}"?`,
      message: closing ? 'The loan is fully settled. It will be moved to closed loans and its account hidden from pickers.' : 'The loan will be shown again and new transactions can be recorded.',
      confirmText: closing ? 'Close loan' : 'Re-open loan',
    });
    if (!ok) return;
    try {
      await call('loans.update', { id: d.id, name: d.name, isActive: !closing });
      toast.success(closing ? 'Loan closed' : 'Loan re-opened');
      void q.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Page>
      <PageHeader
        back="/accounts/loans"
        title={
          <span className="row">
            {d.name}
            <Badge tone={taken ? 'red' : 'green'}>{taken ? 'Loan taken' : 'Loan given'}</Badge>
            {!d.isActive && <Badge>Closed</Badge>}
          </span>
        }
        subtitle={
          <>
            <Link to={`/accounts/ledger?account=${d.accountId}`}>{d.accountName}</Link>
            {d.interestRate ? ` · ${d.interestRate}% a year` : ''}
            {d.startDate ? ` · since ${formatDate(d.startDate)}` : ''}
          </>
        }
        actions={
          <>
            <ExportButtons report={d.ledger} />
            {canManage && (
              <>
                <Button icon={<Pencil size={16} />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
                {(d.outstanding === 0 || !d.isActive) && (
                  <Button variant="ghost" icon={d.isActive ? <Lock size={16} /> : <Unlock size={16} />} onClick={toggle}>
                    {d.isActive ? 'Close loan' : 'Re-open loan'}
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      <StatGrid>
        <Stat label="Outstanding" value={formatINR(d.outstanding)} tone={d.outstanding ? (taken ? 'red' : 'green') : undefined} hint={taken ? 'You still owe' : 'Still to be received'} />
        <Stat label="Loan amount" value={formatINR(d.principal)} hint="Sanctioned / agreed" />
        <Stat label={taken ? 'Received so far' : 'Given so far'} value={formatINR(d.disbursed)} />
        <Stat label={taken ? 'Repaid' : 'Collected back'} value={formatINR(d.repaid)} />
        <Stat label={taken ? 'Interest paid' : 'Interest received'} value={formatINR(d.interestToDate)} />
      </StatGrid>
      <div className="stack">
        {canManage && d.isActive && <TransactionCard loan={d} onSaved={() => void q.reload()} />}
        {canManage && !d.isActive && <Alert tone="neutral">This loan is closed. Re-open it to record new transactions.</Alert>}
        <Card title="Loan statement" padded={false} className="ac-report-card ac-stmt">
          <ReportView report={{ ...d.ledger, summary: undefined }} onLink={openLink} hideTitle emptyMessage="No transactions yet." />
          <div className="ac-note">To correct or cancel a transaction, click it in the statement and use Edit or Cancel on the voucher.</div>
        </Card>
        {d.notes && (
          <Card title="Notes">
            <div style={{ whiteSpace: 'pre-wrap' }}>{d.notes}</div>
          </Card>
        )}
      </div>
      {editing && (
        <EditLoanModal
          loan={d}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void q.reload();
          }}
        />
      )}
    </Page>
  );
}

function TransactionCard({ loan, onSaved }: { loan: LoanDetail; onSaved: () => void }) {
  const toast = useToast();
  const m = useMutation('loans.transaction');
  const taken = loan.direction === 'taken';
  const repayKind: Kind = taken ? 'repay' : 'collect';
  const moreKind: Kind = taken ? 'receive' : 'give';
  const [kind, setKind] = useState<Kind>(loan.outstanding > 0 ? repayKind : moreKind);
  const [date, setDate] = useState(todayISO());
  const [principal, setPrincipal] = useState<number | null>(null);
  const [interest, setInterest] = useState<number | null>(null);
  const [pay, setPay] = useState<{ mode: SettlementMode; accountId: number | null }>({ mode: 'bank', accountId: null });
  const [narration, setNarration] = useState('');
  const isRepay = kind === repayKind;
  const total = (principal ?? 0) + (isRepay ? (interest ?? 0) : 0);
  const over = isRepay && (principal ?? 0) > loan.outstanding;
  const problem = !total ? 'Enter the amount' : over ? `Principal cannot be more than the outstanding ${formatINR(loan.outstanding)}` : null;

  const save = async () => {
    if (problem) return;
    try {
      const r = await m.run({ loanId: loan.id, date, kind, principal: principal ?? 0, interest: isRepay ? (interest ?? 0) : 0, mode: pay.mode, accountId: pay.accountId, narration: narration.trim() || null });
      toast.success(`Saved ${r.entry.voucherNo}: ${r.entry.narration}`);
      for (const w of r.warnings) toast.warning(w);
      setPrincipal(null);
      setInterest(null);
      setNarration('');
      onSaved();
    } catch {
      /* shown below */
    }
  };

  return (
    <Card
      title={isRepay ? (taken ? 'Record a repayment' : 'Record money received back') : taken ? 'Record more loan received' : 'Record more loan given'}
      actions={
        <SegmentedControl<Kind>
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { value: repayKind, label: taken ? 'Repayment / EMI' : 'Repayment received' },
            { value: moreKind, label: taken ? 'More loan received' : 'More loan given' },
          ]}
        />
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className={`ac-loan-form${isRepay ? '' : ' no-interest'}`}>
          <Field label="Date" required>
            <DateInput value={date} max={todayISO()} onChange={setDate} />
          </Field>
          <Field label={isRepay ? 'Principal' : 'Amount'} error={m.fields.principal} hint={isRepay ? `Outstanding ${formatINR(loan.outstanding)}` : undefined}>
            <MoneyInput value={principal} onChange={setPrincipal} autoFocus />
          </Field>
          {isRepay && (
            <Field label="Interest" error={m.fields.interest} hint={taken ? 'Goes to Interest Paid' : 'Goes to Interest Received'}>
              <MoneyInput value={interest} onChange={setInterest} />
            </Field>
          )}
          <FieldGroup label={(taken && isRepay) || (!taken && !isRepay) ? 'Paid from' : 'Received into'}>
            <SettlementPicker value={pay} onChange={setPay} />
          </FieldGroup>
        </div>
        <div className="ac-loan-foot">
          <Field label="Narration">
            <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Written automatically if left blank" maxLength={500} />
          </Field>
          {isRepay && (
            <div className="ac-loan-total">
              <span>{taken ? 'Total paid' : 'Total received'}</span>
              <span className="money">{formatINR(total)}</span>
            </div>
          )}
          <Button type="submit" variant="primary" loading={m.loading} disabled={!!problem}>
            Save
          </Button>
        </div>
        {(m.error || (problem && total > 0)) && (
          <div className="ac-form-error">
            <Alert tone="red">{m.error ?? problem}</Alert>
          </div>
        )}
      </form>
    </Card>
  );
}

function EditLoanModal({ loan, onClose, onSaved }: { loan: LoanDetail; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const m = useMutation('loans.update');
  const [name, setName] = useState(loan.name);
  const [principal, setPrincipal] = useState<number | null>(loan.principal);
  const [rate, setRate] = useState<number | null>(loan.interestRate);
  const [startDate, setStartDate] = useState(loan.startDate ?? '');
  const [notes, setNotes] = useState(loan.notes ?? '');
  const save = async () => {
    try {
      await m.run({ id: loan.id, name, principal: principal ?? 0, interestRate: rate, startDate: startDate || null, notes: notes.trim() || null });
      toast.success('Loan saved');
      onSaved();
    } catch {
      /* shown below */
    }
  };
  return (
    <Modal
      open
      title={`Edit loan "${loan.name}"`}
      onClose={onClose}
      width={520}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!name.trim()} onClick={save}>
            Save
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
        <Field label={loan.direction === 'taken' ? 'Taken from' : 'Given to'} required error={m.fields.name} hint="The loan's ledger account is renamed too.">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </Field>
        <div className="ac-quick-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 140px 160px' }}>
          <Field label="Loan amount">
            <MoneyInput value={principal} onChange={setPrincipal} />
          </Field>
          <Field label="Interest %" error={m.fields.interestRate}>
            <NumberInput value={rate} onChange={setRate} decimals={2} />
          </Field>
          <Field label="Start date">
            <DateInput value={startDate} max={todayISO()} onChange={setStartDate} />
          </Field>
        </div>
        <Field label="Notes">
          <TextArea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </Field>
        <p className="small muted mt-0">These details are for your reference. Amounts in the accounts change only through the loan's transactions.</p>
        {m.error && <Alert tone="red">{m.error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
