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
import { returnLineAmount, returnNoteTotal } from '../../../shared/billing';
import { formatINR, formatQty } from '../../../shared/money';
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

export function ReturnNew() {
  const [params] = useSearchParams();
  const { can } = useAuth();
  const initialBill = Number(params.get('billId')) || null;
  // Goods returns need "returns.create"; credit notes without goods need "returns.adjust".
  const canGoods = can('returns.create');
  const canNote = can('returns.adjust');
  const [tab, setTab] = useState(!canGoods || (canNote && params.get('kind') === 'adjustment' && !initialBill) ? 'note' : 'goods');
  const cfg = useQuery('sales.posConfig', undefined);
  if (cfg.error) return <Page><ErrorBox error={cfg.error} onRetry={cfg.reload} /></Page>;
  if (!cfg.data) return <Loading />;
  const tabs = [
    ...(canGoods ? [{ key: 'goods', label: 'Goods returned' }] : []),
    ...(canNote ? [{ key: 'note', label: 'Credit note (no goods)' }] : []),
  ];
  const show = tab === 'note' && canNote ? 'note' : canGoods ? 'goods' : 'note';
  return (
    <Page>
      <PageHeader
        title={canNote && canGoods ? 'New return / credit note' : canNote ? 'New credit note' : 'New sales return'}
        back="/sales/returns"
        subtitle={canNote && canGoods ? 'Take back goods against a bill, or give a customer credit without goods.' : canNote ? 'Give a customer credit without goods.' : 'Take back goods against a bill.'}
      />
      {tabs.length > 1 && <Tabs value={show} onChange={setTab} tabs={tabs} />}
      {show === 'goods' ? <GoodsReturn cfg={cfg.data} initialBillId={initialBill} /> : <CreditNoteForm cfg={cfg.data} />}
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
  // Dated today when saved unless the user picks a date.
  const [date, setDate] = useState<string | null>(null);
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
  // Exactly what the server will save: capped at what was paid, rounded on the bill's running total.
  const subtotal = chosen.reduce((s, { l, p }) => s + (p.qty && p.rate !== null ? returnLineAmount(l, p.qty, p.rate) : 0), 0);
  const total =
    data && subtotal > 0
      ? returnNoteTotal({ billTotal: data.bill.total, returnedTotal: data.returnedTotal, returnedValue: data.returnedValue, value: subtotal, roundOff: data.roundOff })
      : 0;
  const roundOff = subtotal > 0 ? total - subtotal : 0;
  const moneyMode = refund.mode !== 'credit';
  const overMoney = !!data && moneyMode && total > data.moneyRefundable;
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
      if (p.rate > l.netRate) return `Refund rate of "${l.itemName}" cannot be more than ${formatINR(l.netRate)}, what the customer paid for it.`;
    }
    if (data.refundable <= 0) return 'Everything paid on this bill has already been refunded.';
    if (subtotal <= 0) return 'Nothing was paid for the chosen items, so there is nothing to refund.';
    if (total <= 0) return 'This return comes to ₹0.00 after rounding. Return it together with other items of the bill.';
    if (overMoney) {
      return data.bill.customerId
        ? `Only ${formatINR(data.moneyRefundable)} can be paid back in money on this bill. Choose “Adjust” to take ${formatINR(total)} off ${data.bill.customerName}'s balance, or return fewer items now.`
        : `Only ${formatINR(data.moneyRefundable)} can be refunded on this bill.`;
    }
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
        date,
        items: chosen.map(({ l, p }) => ({ billItemId: l.billItemId, qty: p.qty!, rate: p.rate! })),
        refundMode: refund.mode,
        refundAccountId: refund.accountId,
        reason: reason.trim() || null,
      });
      res.warnings.forEach((w) => toast.warning(w));
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
            <ModeBadge mode={b.paymentMode} credit={b.credit} />
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
                <th style={{ textAlign: 'right' }}>Refund rate</th>
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
                      {l.netRate !== l.rate && <span className="sl-cell-sub">Customer paid {formatINR(l.netRate)} each</span>}
                      {l.returnedAmount > 0 && l.returnable > 0 && <span className="sl-cell-sub">{formatINR(l.refundable)} of it left to refund</span>}
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
                          <MoneyInput
                            className="sl-rate-in"
                            value={on ? p.rate : l.netRate}
                            onChange={(rate) => setPick(l, { rate })}
                            aria-label={`Refund rate of ${l.itemName}`}
                            title={`At most ${formatINR(l.netRate)}, what the customer paid`}
                          />
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }} className="money bold">
                      {on && p.qty && p.rate !== null ? formatINR(returnLineAmount(l, p.qty, p.rate)) : ''}
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
            <div className="sl-refund-limits small" aria-label="Refund limits">
              <div className="tr">
                <span className="muted">Received on this bill</span>
                <span className="money">{formatINR(b.paid)}</span>
              </div>
              {data.returnedTotal > 0 && (
                <div className="tr">
                  <span className="muted">Already returned</span>
                  <span className="money">{formatINR(data.returnedTotal)}</span>
                </div>
              )}
              <div className="tr">
                <span className="muted">Can still be refunded</span>
                <span className="money bold">{formatINR(data.refundable)}</span>
              </div>
              <div className="tr">
                <span className="muted">In cash / UPI / bank, at most</span>
                <span className={`money bold${overMoney ? ' bad' : ''}`}>{formatINR(Math.min(data.moneyRefundable, data.refundable))}</span>
              </div>
            </div>
            <Field label="How is the money going back?" className="sl-refund-picker">
              <PaymentModePicker
                value={refund}
                onChange={setRefund}
                modes={b.customerId ? (data.moneyRefundable > 0 ? ['cash', 'upi', 'bank', 'credit'] : ['credit']) : ['cash', 'upi', 'bank']}
                creditLabel="Adjust"
              />
            </Field>
            {refund.mode === 'credit' && <div className="small muted">The amount will be taken off {b.customerName}'s balance.</div>}
            {b.customerId && data.moneyRefundable <= 0 && (
              <div className="small muted">{b.paid > 0 ? 'What was paid on this bill has already been paid back' : 'Nothing was paid on this bill'}, so the return is adjusted in the account.</div>
            )}
            {!b.customerId && <div className="small faint">Walk-in bill: the refund is paid back in money, up to what was paid.</div>}
            {overMoney && b.customerId && (
              <div className="sl-over-money">
                <div className="sl-pay-hint bad">
                  Only {formatINR(data.moneyRefundable)} can go back in money on this bill. Adjust this return in {b.customerName}'s account, or return fewer items now.
                </div>
                <Button size="sm" onClick={() => setRefund({ mode: 'credit', accountId: null })}>
                  Adjust in account instead
                </Button>
              </div>
            )}
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
                <DateInput value={date ?? cfg.today} onChange={(d) => d && setDate(d === cfg.today ? null : d)} min={b.date} max={cfg.today} />
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
  const [date, setDate] = useState<string | null>(null);
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
        date,
      });
      res.warnings.forEach((w) => toast.warning(w));
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
              <DateInput value={date ?? cfg.today} onChange={(d) => d && setDate(d === cfg.today ? null : d)} min={cfg.booksStartDate} max={cfg.today} />
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
