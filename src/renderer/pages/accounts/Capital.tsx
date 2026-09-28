import { useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import { Alert, Button, Card, Page, PageHeader, Stat, StatGrid, Toolbar } from '../../components/ui';
import { DateInput, Field, MoneyInput, SegmentedControl, Select, TextInput } from '../../components/forms';
import { SettlementPicker } from '../../components/pickers';
import { DateRangePicker, ExportButtons, ReportView } from '../../components/report';
import { useMutation, useQuery } from '../../hooks';
import { useToast } from '../../feedback';
import { useOpenLink } from '../../links';
import { formatINR } from '../../../shared/money';
import { todayISO } from '../../../shared/dates';
import type { SettlementMode } from '../../../shared/constants';
import { FieldGroup, useRange } from './common';

type Settle = { mode: SettlementMode; accountId: number | null };

export function CapitalPage() {
  const openLink = useOpenLink();
  const [range, setRange] = useRange('capital.range', 'this_fy');
  const summary = useQuery('accounts.capitalSummary', { from: range.from, to: range.to });
  const s = summary.data;
  const reload = () => void summary.reload();

  return (
    <Page>
      <PageHeader title="Capital & drawings" subtitle="Money the owner puts into the business, or takes out for personal use" actions={<ExportButtons report={s?.report} />} />
      <div className="ac-split-even">
        <AddCapitalCard onSaved={reload} />
        <DrawingsCard onSaved={reload} />
      </div>
      <Card title="Owner's capital account" padded={false} className="ac-list-card ac-stmt">
        <div className="ac-filters">
          <Toolbar>
            <DateRangePicker value={range} onChange={setRange} />
          </Toolbar>
        </div>
        <div className="card-body">
          <StatGrid>
            <Stat label="Opening balance" value={<span className="money">{formatINR(s?.opening ?? 0)}</span>} />
            <Stat
              label="Capital added"
              value={<span className="money">{formatINR((s?.capitalAdded ?? 0) + (s?.openingBalances ?? 0))}</span>}
              tone={(s?.capitalAdded ?? 0) + (s?.openingBalances ?? 0) > 0 ? 'green' : undefined}
              hint={s?.openingBalances ? `incl. opening balances ${formatINR(s.openingBalances)}` : undefined}
            />
            <Stat label="Profit transferred" value={<span className="money">{formatINR(s?.profitTransferred ?? 0)}</span>} hint="At year-end closing" />
            <Stat label="Drawings" value={<span className="money">{formatINR(s?.drawings ?? 0)}</span>} tone={s?.drawings ? 'amber' : undefined} />
            <Stat label="Closing balance" value={<span className="money">{formatINR(s?.closing ?? 0)}</span>} tone="blue" />
          </StatGrid>
        </div>
        <ReportView report={s ? { ...s.report, summary: undefined } : undefined} loading={summary.loading} error={summary.error} onRetry={summary.reload} onLink={openLink} hideTitle />
      </Card>
    </Page>
  );
}

function AddCapitalCard({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const m = useMutation('accounts.capital');
  const capitalAccounts = useQuery('accounts.list', { groups: ['capital'] });
  const choices = (capitalAccounts.data ?? []).filter((a) => a.systemKey !== 'OPENING_EQUITY');
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState<number | null>(null);
  const [pay, setPay] = useState<Settle>({ mode: 'cash', accountId: null });
  const [capitalAccountId, setCapitalAccountId] = useState<number | null>(null);
  const [narration, setNarration] = useState('');
  const save = async () => {
    if (!amount) return;
    try {
      const e = await m.run({ date, amount, mode: pay.mode, accountId: pay.accountId, capitalAccountId, narration: narration.trim() || null });
      toast.success(`Recorded capital of ${formatINR(amount)} (${e.voucherNo})`);
      setAmount(null);
      setNarration('');
      onSaved();
    } catch {
      /* shown below */
    }
  };
  return (
    <Card
      title={
        <span className="row">
          <ArrowDownCircle size={17} className="pos" /> Add capital
        </span>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="small muted mt-0">The owner brings money into the business (cash in the till or into the bank).</p>
        <div className="ac-quick-pair" style={{ gridTemplateColumns: '160px minmax(0, 1fr)' }}>
          <Field label="Date" required>
            <DateInput value={date} max={todayISO()} onChange={setDate} />
          </Field>
          <Field label="Amount" required error={m.fields.amount}>
            <MoneyInput value={amount} onChange={setAmount} />
          </Field>
        </div>
        <FieldGroup label="Received into">
          <SettlementPicker value={pay} onChange={setPay} />
        </FieldGroup>
        {choices.length > 1 && (
          <Field label="Capital account">
            <Select<number> value={capitalAccountId ?? choices.find((c) => c.systemKey === 'CAPITAL')?.id} onChange={setCapitalAccountId} options={choices.map((c) => ({ value: c.id, label: c.name }))} />
          </Field>
        )}
        <Field label="Narration">
          <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Capital introduced by owner" maxLength={500} />
        </Field>
        {m.error && <Alert tone="red">{m.error}</Alert>}
        <div className="row-between">
          <span className="small faint">Dr {pay.mode === 'cash' ? 'Cash' : 'Bank / UPI'} · Cr Owner's Capital</span>
          <Button type="submit" variant="primary" loading={m.loading} disabled={!amount}>
            Save capital
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DrawingsCard({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const m = useMutation('accounts.drawings');
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState<number | null>(null);
  const [kind, setKind] = useState<'money' | 'goods'>('money');
  const [pay, setPay] = useState<Settle>({ mode: 'cash', accountId: null });
  const [narration, setNarration] = useState('');
  const save = async () => {
    if (!amount) return;
    try {
      const e = await m.run({ date, amount, goods: kind === 'goods', mode: kind === 'money' ? pay.mode : null, accountId: kind === 'money' ? pay.accountId : null, narration: narration.trim() || null });
      toast.success(`Recorded drawings of ${formatINR(amount)} (${e.voucherNo})`);
      setAmount(null);
      setNarration('');
      onSaved();
    } catch {
      /* shown below */
    }
  };
  return (
    <Card
      title={
        <span className="row">
          <ArrowUpCircle size={17} className="neg" /> Record drawings
        </span>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="small muted mt-0">The owner takes money or goods from the business for personal or home use.</p>
        <div className="ac-quick-pair" style={{ gridTemplateColumns: '160px minmax(0, 1fr)' }}>
          <Field label="Date" required>
            <DateInput value={date} max={todayISO()} onChange={setDate} />
          </Field>
          <Field label="Amount" required error={m.fields.amount}>
            <MoneyInput value={amount} onChange={setAmount} />
          </Field>
        </div>
        <FieldGroup label="What was taken">
          <SegmentedControl<'money' | 'goods'>
            value={kind}
            onChange={setKind}
            options={[
              { value: 'money', label: 'Money' },
              { value: 'goods', label: 'Goods from the shop' },
            ]}
          />
        </FieldGroup>
        {kind === 'money' ? (
          <FieldGroup label="Taken from">
            <SettlementPicker value={pay} onChange={setPay} />
          </FieldGroup>
        ) : (
          <div className="small muted">Enter the cost price of the goods. It is taken out of Purchases so your profit is not overstated.</div>
        )}
        <Field label="Narration">
          <TextInput value={narration} onChange={(e) => setNarration(e.target.value)} placeholder={kind === 'goods' ? 'Goods taken by owner for personal use' : 'Money taken by owner for personal use'} maxLength={500} />
        </Field>
        {m.error && <Alert tone="red">{m.error}</Alert>}
        <div className="row-between">
          <span className="small faint">Dr Drawings · Cr {kind === 'goods' ? 'Purchases' : pay.mode === 'cash' ? 'Cash' : 'Bank / UPI'}</span>
          <Button type="submit" variant="primary" loading={m.loading} disabled={!amount}>
            Save drawings
          </Button>
        </div>
      </form>
    </Card>
  );
}
