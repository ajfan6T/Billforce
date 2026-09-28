import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { FileMinus2, Printer, Save, Search, X } from 'lucide-react';
import { call, errorMessage, type ApiOutput } from '../../api';
import { useHotkeys, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useToast, useUnsavedWarning } from '../../feedback';
import { Alert, Button, Card, ErrorBox, Loading, Page, PageHeader, Tabs } from '../../components/ui';
import { Combobox, DateInput, Field, MoneyInput, NumberInput, TextInput } from '../../components/forms';
import { CustomerPicker, PaymentModePicker, type CustomerOption, type PaymentChoice } from '../../components/pickers';
import { roundQty } from '../../../shared/billing';
import { formatINR, formatQty, lineAmount, roundOffAdjustment } from '../../../shared/money';
import { formatDate } from '../../../shared/dates';
import { ModeBadge, qtyUnit, usePrintDoc } from './common';

type FoundBill = ApiOutput<'returns.findBills'>[number];
type Returnable = ApiOutput<'returns.billReturnable'>;
type RLine = Returnable['lines'][number];

const RETURN_REASONS = ['Damaged', 'Wrong item', 'Not needed', 'Expired', 'Size / colour change'];
const NOTE_REASONS = ['Price correction', 'Rate difference', 'Goodwill', 'Damaged in delivery', 'Short supply'];

interface Pick {
  on: boolean;
  qty: number | null;
  rate: number | null;
}

/** Refund amount of one line, exactly as the server computes it. */
function lineRefund(l: RLine, qty: number, rate: number): number {
  let amount = lineAmount(qty, rate);
  if (roundQty(qty) === l.returnable && rate === l.netRate) {
    const left = l.netAmount - l.returnedAmount;
    if (left > 0 && Math.abs(left - amount) <= Math.ceil(l.qtyBilled) + 1) amount = left;
  }
  return amount;
}

export function ReturnNew() {
  const [params] = useSearchParams();
  const initialBill = Number(params.get('billId')) || null;
  const [tab, setTab] = useState(params.get('kind') === 'adjustment' ? 'note' : 'goods');
  const cfg = useQuery('sales.posConfig', undefined);
  if (cfg.error) return <Page><ErrorBox error={cfg.error} onRetry={cfg.reload} /></Page>;
  if (!cfg.data) return <Loading />;
  return (
    <Page>
      <PageHeader title="New return / credit note" back="/sales/returns" subtitle="Take back goods against a bill, or give a customer credit without goods." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'goods', label: 'Goods returned' },
          { key: 'note', label: 'Credit note (no goods)' },
        ]}
      />
      {tab === 'goods' ? <GoodsReturn cfg={cfg.data} initialBillId={initialBill} /> : <CreditNoteForm cfg={cfg.data} />}
    </Page>
  );
}

function useSaveKeys(save: (print: boolean) => void) {
  useHotkeys({ F9: () => save(true), F10: () => save(false), 'ctrl+s': () => save(false) });
}

function GoodsReturn({ cfg, initialBillId }: { cfg: ApiOutput<'sales.posConfig'>; initialBillId: number | null }) {
  const navigate = useNavigate();
  const toast = useToast();
  const printDoc = usePrintDoc();
  const { can } = useAuth();
  const [billId, setBillId] = useState<number | null>(initialBillId);
  const [search, setSearch] = useState('');
  const r = useQuery('returns.billReturnable', billId ? { billId } : null);
  const [picks, setPicks] = useState<Record<number, Pick>>({});
  const [refund, setRefund] = useState<PaymentChoice>({ mode: 'cash', accountId: null });
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(cfg.today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!r.data) return;
    setPicks({});
    setRefund({ mode: r.data.suggestedRefundMode, accountId: null });
    setError(null);
  }, [r.data?.bill.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = r.data;
  const chosen = useMemo(
    () => (data ? data.lines.filter((l) => picks[l.billItemId]?.on).map((l) => ({ l, p: picks[l.billItemId] })) : []),
    [data, picks],
  );
  const subtotal = chosen.reduce((s, { l, p }) => s + (p.qty && p.rate !== null ? lineRefund(l, p.qty, p.rate) : 0), 0);
  const roundOff = cfg.roundOff && subtotal > 0 ? roundOffAdjustment(subtotal) : 0;
  const total = subtotal + roundOff;
  useUnsavedWarning(chosen.length > 0);

  const toggle = (l: RLine, on: boolean) =>
    setPicks((p) => ({ ...p, [l.billItemId]: { on, qty: p[l.billItemId]?.qty ?? l.returnable, rate: p[l.billItemId]?.rate ?? l.netRate } }));
  const setPick = (l: RLine, patch: Partial<Pick>) => setPicks((p) => ({ ...p, [l.billItemId]: { ...(p[l.billItemId] ?? { on: true, qty: l.returnable, rate: l.netRate }), on: true, ...patch } }));

  const problem = (() => {
    if (!data) return 'Choose the bill first.';
    if (data.bill.status !== 'active') return 'This bill is cancelled.';
    if (!chosen.length) return 'Tick the items being returned.';
    for (const { l, p } of chosen) {
      if (!p.qty || p.qty <= 0) return `Enter the quantity of "${l.itemName}".`;
      if (p.qty > l.returnable + 1e-9) return `Only ${qtyUnit(l.returnable, l.unit)} of "${l.itemName}" can be returned.`;
      if (p.rate === null) return `Enter the refund rate of "${l.itemName}".`;
      if (p.rate > l.rate) return `Refund rate of "${l.itemName}" cannot be more than ${formatINR(l.rate)}.`;
    }
    if (total <= 0) return 'The refund must be more than zero.';
    return null;
  })();

  const save = async (print: boolean) => {
    if (saving || !data) return;
    if (problem) return setError(problem);
    setSaving(true);
    setError(null);
    try {
      const res = await call('returns.create', {
        kind: 'return',
        billId: data.bill.id,
        date: date !== cfg.today ? date : null,
        items: chosen.map(({ l, p }) => ({ billItemId: l.billItemId, qty: p.qty!, rate: p.rate! })),
        refundMode: refund.mode,
        refundAccountId: refund.accountId,
        reason: reason.trim() || null,
      });
      toast.success(`Sales return ${res.cnNo} saved · ${formatINR(res.total)} ${res.refundMode === 'credit' ? 'adjusted' : 'to refund'}`);
      if (print) await printDoc('return', res.id);
      navigate(`/sales/returns/${res.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  useSaveKeys((p) => void save(p));

  if (!billId) {
    return (
      <Card title="Which bill is being returned?">
        <div className="stack">
          <div className="pos-search">
            <Search size={18} className="search-icon" />
            <Combobox<FoundBill>
              value={search}
              onInputChange={setSearch}
              autoFocus
              openOnFocus
              aria-label="Find bill"
              placeholder="Type the bill number, customer name or phone…"
              loadOptions={(q) => call('returns.findBills', { q, limit: 12 })}
              getKey={(b) => b.id}
              onSelect={(b) => setBillId(b.id)}
              renderOption={(b) => (
                <div className="sl-item-option">
                  <div>
                    <div className="sl-io-name">{b.billNo}</div>
                    <div className="sl-io-sub">
                      {formatDate(b.date)} · {b.customerName ?? 'Walk-in'}
                      {b.customerPhone ? ` · ${b.customerPhone}` : ''} · {b.itemCount} item{b.itemCount === 1 ? '' : 's'}
                    </div>
                  </div>
                  <span className="sl-io-rate">{formatINR(b.total)}</span>
                </div>
              )}
            />
          </div>
          <p className="muted small">
            Tip: open the bill from <Link to="/sales/bills">Bills</Link> and click “Sales return”. For a price correction without goods, use the “Credit note” tab.
          </p>
        </div>
      </Card>
    );
  }
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  if (!data) return <Loading />;
  const b = data.bill;
  const fullyReturned = data.lines.every((l) => l.returnable <= 0);

  return (
    <div className="sl-return-form">
      <div className="stack">
        <Card>
          <div className="sl-bill-pick-card">
            <span className="sl-bp-no">{can('billing.view') || b.date === cfg.today ? <Link to={`/sales/bills/${b.id}`}>{b.billNo}</Link> : b.billNo}</span>
            <span className="muted">{formatDate(b.date)}</span>
            <span>{b.customerName ?? <span className="faint">Walk-in</span>}</span>
            <ModeBadge mode={b.paymentMode} />
            <span className="grow" />
            <span>
              Bill total <b className="money">{formatINR(b.total)}</b>
            </span>
            {data.returnedTotal > 0 && <span className="muted">Returned so far {formatINR(data.returnedTotal)}</span>}
            <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => (setBillId(null), setSearch(''))}>
              Change bill
            </Button>
          </div>
        </Card>
        {b.status !== 'active' && <Alert tone="red">This bill is cancelled, so nothing can be returned against it.</Alert>}
        {b.status === 'active' && fullyReturned && <Alert tone="amber">Everything on this bill has already been returned.</Alert>}
        <Card title="Tick the items being returned" padded={false}>
          <div className="table-wrap">
          <table className="table compact sl-return-lines">
            <thead>
              <tr>
                <th style={{ width: 36 }} />
                <th>Item</th>
                <th style={{ textAlign: 'right' }}>Billed</th>
                <th style={{ textAlign: 'right' }}>Returning</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th style={{ textAlign: 'right' }}>Refund</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => {
                const p = picks[l.billItemId];
                const on = !!p?.on;
                const disabled = l.returnable <= 0 || b.status !== 'active';
                return (
                  <tr key={l.billItemId} className={disabled ? 'off' : ''}>
                    <td>
                      <input type="checkbox" aria-label={`Return ${l.itemName}`} checked={on} disabled={disabled} onChange={(e) => toggle(l, e.target.checked)} />
                    </td>
                    <td>
                      <span className="sl-cell-main">{l.itemName}</span>
                      <span className="sl-cell-sub">Billed at {formatINR(l.rate)}</span>
                      {l.netRate !== l.rate && <span className="sl-cell-sub">Paid {formatINR(l.netRate)} each after discount</span>}
                    </td>
                    <td style={{ textAlign: 'right' }} className="nowrap">
                      {qtyUnit(l.qtyBilled, l.unit)}
                      {l.qtyReturned > 0 && <span className="sl-cell-sub">{formatQty(l.qtyReturned)} returned</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {disabled ? (
                        <span className="faint">{l.returnable <= 0 ? 'All returned' : '—'}</span>
                      ) : (
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                          <NumberInput className="sl-qty-in" value={on ? p.qty : null} placeholder={formatQty(l.returnable)} onChange={(qty) => setPick(l, { qty })} aria-label={`Quantity of ${l.itemName} returned`} />
                          <span className="faint small nowrap">of {formatQty(l.returnable)}</span>
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {!disabled && (
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <MoneyInput className="sl-rate-in" value={on ? p.rate : l.netRate} onChange={(rate) => setPick(l, { rate })} aria-label={`Refund rate of ${l.itemName}`} />
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }} className="money bold">
                      {on && p.qty && p.rate !== null ? formatINR(lineRefund(l, p.qty, p.rate)) : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </Card>
      </div>

      <div className="sl-return-summary">
        <Card title="Refund">
          <div className="stack">
            <Field label="How is the money going back?" className="sl-refund-picker">
              <PaymentModePicker value={refund} onChange={setRefund} modes={b.customerId ? ['cash', 'upi', 'bank', 'credit'] : ['cash', 'upi', 'bank']} creditLabel="Adjust" />
            </Field>
            {refund.mode === 'credit' && <div className="small muted">The amount will be taken off {b.customerName}'s balance.</div>}
            {!b.customerId && <div className="small faint">Walk-in bill: the refund is paid back in money.</div>}
            <Field label="Reason (optional)">
              <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is it being returned?" maxLength={300} onKeyDown={(e) => e.key === 'Enter' && void save(true)} />
              <div className="sl-reason-chips">
                {RETURN_REASONS.map((x) => (
                  <button key={x} type="button" className="pill" onClick={() => setReason(x)}>
                    {x}
                  </button>
                ))}
              </div>
            </Field>
            {can('billing.backdate') && (
              <Field label="Return date">
                <DateInput value={date} onChange={(d) => d && setDate(d)} min={b.date} max={cfg.today} />
              </Field>
            )}
            <div className="pos-totals">
              {roundOff !== 0 && (
                <>
                  <div className="tr muted">
                    <span>Items</span>
                    <span className="money">{formatINR(subtotal)}</span>
                  </div>
                  <div className="tr muted">
                    <span>Round off</span>
                    <span className="money">{formatINR(roundOff, { plus: true })}</span>
                  </div>
                </>
              )}
            </div>
            <div className="pos-grand">
              <span className="pg-label">{refund.mode === 'credit' ? 'Credit' : 'Refund'}</span>
              <span className="pg-value">{formatINR(total)}</span>
            </div>
            {error && (
              <div className="pos-error" role="alert">
                {error}
              </div>
            )}
            <div className="pos-actions">
              <Button variant="primary" icon={<Printer size={18} />} kbd="F9" loading={saving} disabled={b.status !== 'active' || fullyReturned} onClick={() => void save(true)}>
                Save & print
              </Button>
              <Button icon={<Save size={16} />} kbd="F10" disabled={saving || b.status !== 'active' || fullyReturned} onClick={() => void save(false)}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => navigate(-1)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function CreditNoteForm({ cfg }: { cfg: ApiOutput<'sales.posConfig'> }) {
  const navigate = useNavigate();
  const toast = useToast();
  const printDoc = usePrintDoc();
  const { can } = useAuth();
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<PaymentChoice>({ mode: 'credit', accountId: null });
  const [date, setDate] = useState(cfg.today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useUnsavedWarning(!!amount);

  const problem = !customer ? 'Choose the customer.' : !amount || amount <= 0 ? 'Enter the amount.' : !reason.trim() ? 'Enter the reason for the credit note.' : null;
  const save = async (print: boolean) => {
    if (saving) return;
    if (problem) return setError(problem);
    setSaving(true);
    setError(null);
    try {
      const res = await call('returns.create', {
        kind: 'adjustment',
        customerId: customer!.id,
        amount: amount!,
        reason: reason.trim(),
        refundMode: refund.mode,
        refundAccountId: refund.accountId,
        date: date !== cfg.today ? date : null,
      });
      toast.success(`Credit note ${res.cnNo} saved · ${formatINR(res.total)}`);
      if (print) await printDoc('return', res.id);
      navigate(`/sales/returns/${res.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  useSaveKeys((p) => void save(p));

  return (
    <div className="sl-return-form">
      <Card title="Credit note without goods">
        <div className="stack">
          <Alert tone="blue" icon={<FileMinus2 size={18} />}>
            Use this when a customer was overcharged, or you give credit as goodwill. No items come back. The amount is taken off their balance, or paid back in
            money.
          </Alert>
          <Field label="Customer" required>
            <CustomerPicker value={customer} onChange={setCustomer} autoFocus />
          </Field>
          <Field label="Amount" required>
            <MoneyInput value={amount} onChange={setAmount} placeholder="0.00" aria-label="Credit note amount" />
          </Field>
          <Field label="Reason" required>
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Charged ₹5 extra per kg on bill INV/26-27/0042" maxLength={300} onKeyDown={(e) => e.key === 'Enter' && void save(true)} />
            <div className="sl-reason-chips">
              {NOTE_REASONS.map((x) => (
                <button key={x} type="button" className="pill" onClick={() => setReason(x)}>
                  {x}
                </button>
              ))}
            </div>
          </Field>
          {can('billing.backdate') && (
            <Field label="Date">
              <DateInput value={date} onChange={(d) => d && setDate(d)} min={cfg.booksStartDate} max={cfg.today} />
            </Field>
          )}
        </div>
      </Card>
      <div className="sl-return-summary">
        <Card title="Settle">
          <div className="stack">
            <Field label="Give the credit as" className="sl-refund-picker">
              <PaymentModePicker value={refund} onChange={setRefund} modes={['credit', 'cash', 'upi', 'bank']} creditLabel="Adjust" />
            </Field>
            <div className="small muted">
              {refund.mode === 'credit' ? (customer ? `Reduces what ${customer.name} owes you.` : "Reduces the customer's balance.") : 'Money is paid back to the customer now.'}
            </div>
            {customer && refund.mode === 'credit' && amount ? (
              <div className="small">
                Balance after: <b className="money">{formatINR(customer.balance - amount)}</b>
                {customer.balance - amount < 0 ? ' (advance)' : ''}
              </div>
            ) : null}
            <div className="pos-grand">
              <span className="pg-label">Credit note</span>
              <span className="pg-value">{formatINR(amount ?? 0)}</span>
            </div>
            {error && (
              <div className="pos-error" role="alert">
                {error}
              </div>
            )}
            <div className="pos-actions">
              <Button variant="primary" icon={<Printer size={18} />} kbd="F9" loading={saving} onClick={() => void save(true)}>
                Save & print
              </Button>
              <Button icon={<Save size={16} />} kbd="F10" disabled={saving} onClick={() => void save(false)}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => navigate(-1)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
