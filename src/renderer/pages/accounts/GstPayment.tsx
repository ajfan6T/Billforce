import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Landmark } from 'lucide-react';
import { Alert, Button, Card, EmptyState, ErrorBox, KeyValues, Loading, Money, Page, PageHeader } from '../../components/ui';
import { DateInput, Field, FormGrid, TextInput } from '../../components/forms';
import { SettlementPicker } from '../../components/pickers';
import { DataTable } from '../../components/table';
import { useMutation, useQuery } from '../../hooks';
import { useFeatures } from '../../auth';
import { useToast } from '../../feedback';
import type { ApiOutput } from '../../api';
import type { SettlementMode } from '../../../shared/constants';
import { formatINR } from '../../../shared/money';
import { addMonths, endOfMonth, formatDate, presetRange, startOfMonth, todayISO } from '../../../shared/dates';
import { formatRate } from '../../../shared/gst';
import { CancelledBadge } from './common';
import { PaymentBalanceHint, useShortfallConfirm } from './PaymentBalance';
import './accounts.css';

type Due = ApiOutput<'gst.due'>;
type RegularDue = Extract<Due, { mode: 'regular' }>;
type CompositionDue = Extract<Due, { mode: 'composition' }>;

const HEAD_LABEL = { cgst: 'CGST (central)', sgst: 'SGST (state)', igst: 'IGST (inter-state)' } as const;
const SHORT = { cgst: 'CGST', sgst: 'SGST', igst: 'IGST' } as const;

/** Record paying GST: set off input tax credit, pay the rest (regular), or pay composition tax on turnover. */
export function GstPaymentPage() {
  const features = useFeatures();
  const navigate = useNavigate();
  const toast = useToast();
  const composition = features.gst === 'composition';
  const today = todayISO();
  const lastMonthEnd = endOfMonth(addMonths(startOfMonth(today), -1));
  const lastQuarter = presetRange('last_quarter', today);
  const [upTo, setUpTo] = useState(composition ? lastQuarter.to : lastMonthEnd);
  const [from, setFrom] = useState(lastQuarter.from);
  const [date, setDate] = useState(today);
  const [pay, setPay] = useState<{ mode: SettlementMode; accountId: number | null }>({ mode: 'bank', accountId: null });
  const [reference, setReference] = useState('');
  const due = useQuery('gst.due', features.gst === 'none' ? null : { upTo, from: composition ? from : null });
  const payments = useQuery('gst.payments', features.gst === 'none' ? null : undefined);
  const m = useMutation('gst.pay');
  const confirmShortfall = useShortfallConfirm();

  if (features.gst === 'none') {
    return (
      <Page>
        <PageHeader title="Pay GST" />
        <Alert tone="neutral">Your business is not registered for GST. Turn GST on in Settings &gt; Business settings &gt; GST.</Alert>
      </Page>
    );
  }

  const d = due.data;
  const cash = d ? (d.mode === 'regular' ? d.cashTotal : d.tax) : 0;
  const setOff = d && d.mode === 'regular' ? d.setOff.reduce((s, x) => s + x.amount, 0) : 0;
  const nothing = !!d && cash <= 0 && setOff <= 0;
  const already = d && d.mode === 'composition' && d.paidBefore.length > 0;
  const problem = date < upTo ? 'The payment date must be on or after the end of the tax period' : nothing ? 'Nothing to pay' : already ? 'Already paid for this period' : null;

  const save = async () => {
    if (!d || problem) return;
    const accepted = cash > 0 ? await confirmShortfall({ mode: pay.mode, accountId: pay.accountId, amount: cash, date }) : [];
    if (accepted === null) return;
    try {
      const saved = await m.run({ upTo, from: composition ? from : null, date, mode: pay.mode, accountId: pay.accountId, reference: reference.trim() || null });
      toast.success(`GST payment recorded (${saved.voucherNo})`);
      saved.warnings.filter((w) => !accepted.includes(w)).forEach((w) => toast.warning(w));
      setReference('');
      void due.reload();
      void payments.reload();
    } catch {
      /* shown below */
    }
  };

  return (
    <Page>
      <PageHeader
        title="Pay GST"
        subtitle={composition ? 'Composition tax on your turnover, paid every quarter (CMP-08)' : 'Use your input tax credit first, then record the GST paid from the bank'}
      />
      <div className="stack">
        <Card title={<span className="row"><Landmark size={17} /> {composition ? 'Tax for the quarter' : 'GST due'}</span>}>
          <div className="stack">
            <FormGrid cols={3}>
              {composition && (
                <Field label="Period from" required>
                  <DateInput value={from} max={upTo} onChange={(v) => v && setFrom(v)} />
                </Field>
              )}
              <Field label={composition ? 'Period to' : 'Tax up to'} required hint={composition ? undefined : 'Usually the last day of the month you are filing'}>
                <DateInput value={upTo} max={today} onChange={(v) => v && setUpTo(v)} />
              </Field>
              <Field label="Paid on" required error={date < upTo ? 'On or after the period end' : m.fields.date}>
                <DateInput value={date} min={upTo} max={today} onChange={(v) => v && setDate(v)} />
              </Field>
            </FormGrid>
            {due.error ? (
              <ErrorBox error={due.error} onRetry={due.reload} />
            ) : !d ? (
              <Loading />
            ) : d.mode === 'regular' ? (
              <RegularTable d={d} />
            ) : (
              <CompositionTable d={d} />
            )}
          </div>
        </Card>
        {d && !nothing && !already && (
          <Card title="Payment">
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              {cash > 0 ? (
                <>
                  <SettlementPicker value={pay} onChange={setPay} />
                  <PaymentBalanceHint payment={{ mode: pay.mode, accountId: pay.accountId, amount: cash, date }} />
                  <FormGrid>
                    <Field label="Challan / CPIN number" hint="From the GST portal, for your records">
                      <TextInput value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
                    </Field>
                  </FormGrid>
                </>
              ) : (
                <Alert tone="blue">The input tax credit covers all the GST due. Saving records the set-off; no money is paid.</Alert>
              )}
              {m.error && <Alert tone="red">{m.error}</Alert>}
              <div className="row">
                <Button type="submit" variant="primary" loading={m.loading} disabled={!!problem}>
                  {cash > 0 ? `Record payment of ${formatINR(cash)}` : 'Record set-off'}
                </Button>
                {problem && <span className="small muted">{problem}</span>}
              </div>
            </form>
          </Card>
        )}
        {d && nothing && <Alert tone="green">Nothing is due {composition ? `for ${formatDate(from)} to ${formatDate(upTo)}` : `up to ${formatDate(upTo)}`}.</Alert>}
        {already && d?.mode === 'composition' && (
          <Alert tone="green">
            Already paid for this period:{' '}
            {d.paidBefore.map((p) => (
              <Link key={p.entryId} to={`/accounts/journals/${p.entryId}`}>
                {p.voucherNo ?? `#${p.entryId}`} ({formatDate(p.date)}, {formatINR(p.amount)})
              </Link>
            ))}
          </Alert>
        )}
        <Card title="GST payments recorded" padded={false}>
          <DataTable
            compact
            columns={[
              { key: 'date', label: 'Date', type: 'date', width: 104 },
              { key: 'voucherNo', label: 'No', width: 130, render: (r) => <span className="nowrap">{r.voucherNo}</span> },
              { key: 'narration', label: 'Details', render: (r) => <span>{r.narration} {r.cancelled && <CancelledBadge />}</span> },
              { key: 'amount', label: 'Amount', type: 'money', width: 130 },
            ]}
            rows={payments.data}
            loading={payments.loading}
            rowKey={(r) => r.entryId}
            onRowClick={(r) => navigate(`/accounts/journals/${r.entryId}`)}
            rowClassName={(r) => (r.cancelled ? 'cancelled' : '')}
            empty={<EmptyState icon={<Landmark size={30} />} title="No GST payments yet" message="Payments recorded here also show in the bank book and day book." />}
          />
        </Card>
      </div>
    </Page>
  );
}

function RegularTable({ d }: { d: RegularDue }) {
  const heads = (['cgst', 'sgst', 'igst'] as const).filter((h) => d.liability[h] || d.credit[h] || d.cash[h]);
  if (!heads.length) return <p className="muted mb-0">No GST collected or paid up to {formatDate(d.upTo)} that is not already settled.</p>;
  const used = (h: 'cgst' | 'sgst' | 'igst') => d.setOff.filter((s) => s.to === h).reduce((a, s) => a + s.amount, 0);
  return (
    <div className="stack-sm">
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Tax</th>
              <th className="num">GST collected</th>
              <th className="num">Credit available</th>
              <th className="num">Paid from credit</th>
              <th className="num">To pay now</th>
            </tr>
          </thead>
          <tbody>
            {heads.map((h) => (
              <tr key={h}>
                <td>{HEAD_LABEL[h]}</td>
                <td className="num money">{formatINR(d.liability[h])}</td>
                <td className="num money">{formatINR(d.credit[h])}</td>
                <td className="num money">{formatINR(used(h))}</td>
                <td className="num money">
                  <b>{formatINR(d.cash[h])}</b>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="num money">{formatINR(d.liability.cgst + d.liability.sgst + d.liability.igst)}</td>
              <td className="num money">{formatINR(d.credit.cgst + d.credit.sgst + d.credit.igst)}</td>
              <td className="num money">{formatINR(d.setOff.reduce((a, s) => a + s.amount, 0))}</td>
              <td className="num money">
                <b>{formatINR(d.cashTotal)}</b>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {d.setOff.length > 0 && (
        <p className="small muted mb-0">
          Credit used: {d.setOff.map((s) => `${SHORT[s.from]} credit ${formatINR(s.amount)} for ${SHORT[s.to]}`).join(' · ')}. IGST credit is used first; CGST and SGST credit cannot pay for each other.
        </p>
      )}
      {d.creditLeft.cgst + d.creditLeft.sgst + d.creditLeft.igst > 0 && (
        <p className="small muted mb-0">
          Credit carried forward to next month: {(['cgst', 'sgst', 'igst'] as const).filter((h) => d.creditLeft[h]).map((h) => `${SHORT[h]} ${formatINR(d.creditLeft[h])}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

function CompositionTable({ d }: { d: CompositionDue }) {
  return (
    <KeyValues
      columns={3}
      items={[
        ['Sales (bills of supply)', <Money key="b" value={d.billed} />],
        ['Less returns', <Money key="r" value={d.returns} />],
        ['Turnover', <Money key="t" value={d.turnover} />],
        [`CGST @ ${formatRate(d.rate / 2)}`, <Money key="c" value={d.cgst} />],
        [`SGST @ ${formatRate(d.rate / 2)}`, <Money key="s" value={d.sgst} />],
        ['Tax to pay', <b key="x"><Money value={d.tax} /></b>],
      ]}
    />
  );
}
