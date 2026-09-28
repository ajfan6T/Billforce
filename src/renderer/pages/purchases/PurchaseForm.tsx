import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Plus, Save, Trash2 } from 'lucide-react';
import { Alert, Button, Card, ErrorBox, IconButton, Loading, Page, PageHeader } from '../../components/ui';
import { Checkbox, DateInput, Field, FormGrid, MoneyInput, NumberInput, Select, TextArea, TextInput } from '../../components/forms';
import { PaymentModePicker, SupplierPicker, type PaymentChoice, type SupplierOption } from '../../components/pickers';
import { useDebounced, useHotkeys, useMutation, useQuery } from '../../hooks';
import { useDialogs, useToast, useUnsavedWarning } from '../../feedback';
import { call, type ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, todayISO } from '../../../shared/dates';
import type { SettlementMode } from '../../../shared/constants';
import { purchaseTotals } from '../../../shared/purchase';
import { BoxField } from '../customers/common';
import { DescriptionInput } from './DescriptionInput';
import '../customers/parties.css';
import './purchases.css';

type PurchaseDetail = ApiOutput<'purchases.get'>;
type FormOptions = ApiOutput<'purchases.formOptions'>;

interface Line {
  key: number;
  description: string;
  qty: number | null;
  unit: string;
  rate: number | null;
}

interface PayRow {
  key: number;
  mode: SettlementMode;
  accountId: number | null;
  amount: number | null;
  reference: string;
}

let nextKey = 1;
const blankLine = (): Line => ({ key: nextKey++, description: '', qty: null, unit: '', rate: null });
const blankPay = (mode: SettlementMode = 'cash'): PayRow => ({ key: nextKey++, mode, accountId: null, amount: null, reference: '' });
const COLS = ['desc', 'qty', 'unit', 'rate'] as const;

interface State {
  date: string;
  cashPurchase: boolean;
  supplier: SupplierOption | null;
  supplierName: string;
  supplierBillNo: string;
  supplierBillDate: string;
  accountId: number | null;
  lines: Line[];
  discount: number | null;
  otherCharges: number | null;
  roundOff: boolean;
  pay: PaymentChoice;
  payReference: string;
  split: boolean;
  splitRows: PayRow[];
  remarks: string;
  reason: string;
}

function fromPurchase(p: PurchaseDetail, supplier: SupplierOption | null, defaultRoundOff: boolean): State {
  const single = p.payments.length === 1 && p.credit === 0 ? p.payments[0] : null;
  return {
    date: p.date,
    cashPurchase: !p.supplierId,
    supplier,
    supplierName: p.supplierId ? '' : (p.supplierName ?? ''),
    supplierBillNo: p.supplierBillNo ?? '',
    supplierBillDate: p.supplierBillDate ?? '',
    accountId: p.expenseAccountId,
    lines: [...p.items.map((i) => ({ key: nextKey++, description: i.description, qty: i.qty, unit: i.unit ?? '', rate: i.rate })), blankLine()],
    discount: p.discount || null,
    otherCharges: p.otherCharges || null,
    // Not stored: rounding was on if it changed the total, or (by default) when the total is a whole rupee.
    roundOff: p.roundOff !== 0 || (defaultRoundOff && p.total % 100 === 0),
    pay: p.payments.length === 0 ? { mode: 'credit', accountId: null } : single ? { mode: single.mode, accountId: single.accountId } : { mode: 'cash', accountId: null },
    payReference: single?.reference ?? '',
    split: p.payments.length > 0 && !single,
    splitRows: !single && p.payments.length ? p.payments.map((x) => ({ key: nextKey++, mode: x.mode, accountId: x.accountId, amount: x.amount, reference: x.reference ?? '' })) : [blankPay()],
    remarks: p.remarks ?? '',
    reason: '',
  };
}

function fresh(opts: FormOptions, supplier: SupplierOption | null, keep?: Partial<State>): State {
  return {
    date: keep?.date ?? todayISO(),
    cashPurchase: false,
    supplier,
    supplierName: '',
    supplierBillNo: '',
    supplierBillDate: '',
    accountId: keep?.accountId ?? opts.defaultAccountId,
    lines: [blankLine()],
    discount: null,
    otherCharges: null,
    roundOff: opts.roundOff,
    pay: { mode: supplier ? 'credit' : 'cash', accountId: null },
    payReference: '',
    split: false,
    splitRows: [blankPay()],
    remarks: '',
    reason: '',
  };
}

/** New purchase (/purchases/new) and edit (/purchases/:id/edit). */
export function PurchaseFormPage() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : null;
  const [search] = useSearchParams();
  const presetSupplierId = Number(search.get('supplier')) || null;
  const opts = useQuery('purchases.formOptions', undefined);
  const existing = useQuery('purchases.get', editId ? { id: editId } : null);
  const [initial, setInitial] = useState<State | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!opts.data || initial) return;
    if (editId) {
      const p = existing.data;
      if (!p) return;
      if (p.supplierId) {
        call('suppliers.get', { id: p.supplierId })
          .then((s) => setInitial(fromPurchase(p, { id: s.id, name: s.name, phone: s.phone, payable: s.payable }, opts.data!.roundOff)))
          .catch((e) => setLoadError(String(e?.message ?? e)));
      } else setInitial(fromPurchase(p, null, opts.data.roundOff));
    } else if (presetSupplierId) {
      call('suppliers.get', { id: presetSupplierId })
        .then((s) => setInitial(fresh(opts.data!, s.isActive ? { id: s.id, name: s.name, phone: s.phone, payable: s.payable } : null)))
        .catch(() => setInitial(fresh(opts.data!, null)));
    } else setInitial(fresh(opts.data, null));
  }, [opts.data, existing.data, editId, presetSupplierId, initial]);

  const error = opts.error ?? existing.error ?? loadError;
  if (error) {
    return (
      <Page>
        <PageHeader title={editId ? 'Edit purchase' : 'New purchase bill'} back="/purchases" />
        <ErrorBox error={error} />
      </Page>
    );
  }
  if (!opts.data || !initial) return <Loading />;
  if (existing.data && existing.data.status === 'cancelled') {
    return (
      <Page>
        <PageHeader title={`Edit purchase ${existing.data.purchaseNo}`} back={`/purchases/${existing.data.id}`} />
        <Alert tone="red">This purchase was cancelled and cannot be edited.</Alert>
      </Page>
    );
  }
  return <PurchaseEditor key={editId ?? 'new'} options={opts.data} initial={initial} existing={existing.data ?? null} />;
}

function PurchaseEditor({ options, initial, existing }: { options: FormOptions; initial: State; existing: PurchaseDetail | null }) {
  const navigate = useNavigate();
  const toast = useToast();
  const dialogs = useDialogs();
  const [s, setS] = useState<State>(initial);
  const sRef = useRef(s);
  sRef.current = s;
  const [dirty, setDirty] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const create = useMutation('purchases.create');
  const update = useMutation('purchases.update');
  const m = existing ? update : create;
  const cells = useRef(new Map<string, HTMLInputElement | null>());
  const payTouched = useRef(!!existing);
  useUnsavedWarning(dirty);
  const today = todayISO();

  const patch = (p: Partial<State>) => {
    setS((x) => ({ ...x, ...p }));
    setDirty(true);
  };

  /* ---------- Lines ---------- */
  const setLine = (key: number, p: Partial<Line>) => {
    setS((x) => {
      let lines = x.lines.map((l) => (l.key === key ? { ...l, ...p } : l));
      const last = lines[lines.length - 1];
      if (last.description.trim()) lines = [...lines, blankLine()];
      return { ...x, lines };
    });
    setDirty(true);
  };
  const removeLine = (key: number) => {
    setS((x) => {
      const lines = x.lines.filter((l) => l.key !== key);
      return { ...x, lines: lines.length ? lines : [blankLine()] };
    });
    setDirty(true);
  };
  const focusCell = (row: number, col: number) => {
    const tryFocus = () => {
      const line = sRef.current.lines[row];
      const el = line ? cells.current.get(`${line.key}:${COLS[col]}`) : null;
      if (el) {
        el.focus();
        el.select?.();
      }
      return !!el;
    };
    // The next line may only appear after this render; try once more on the next frame.
    if (!tryFocus()) requestAnimationFrame(() => void tryFocus());
  };
  /** Typed a description bought before: fill in the last unit and rate if they are still empty. */
  const fillFromHistory = (key: number, o: { unit: string | null; rate: number }) => {
    setS((x) => ({ ...x, lines: x.lines.map((l) => (l.key === key ? { ...l, unit: l.unit || o.unit || '', rate: l.rate ?? o.rate } : l)) }));
  };

  /** Enter moves along the line: description -> qty -> unit -> rate -> next line. */
  const advance = (row: number, col: number) => {
    if (col === 0 && !s.lines[row]?.description.trim()) {
      // Enter on an empty description: done with items, move to the discount.
      document.getElementById('purchase-discount')?.focus();
      return;
    }
    if (col < COLS.length - 1) focusCell(row, col + 1);
    else focusCell(row + 1, 0);
  };
  const onCellKey = (e: React.KeyboardEvent<HTMLInputElement>, row: number, col: number) => {
    if (e.key !== 'Enter' || e.ctrlKey) return;
    e.preventDefault();
    advance(row, col);
  };

  /* ---------- Totals & payments ---------- */
  const filled = s.lines.filter((l) => l.description.trim() || l.qty || l.rate);
  const lineProblem = filled
    .map((l, i) => (!l.description.trim() ? `Line ${i + 1}: enter what was bought` : !l.qty ? `Line ${i + 1}: enter the quantity` : l.rate === null ? `Line ${i + 1}: enter the rate` : null))
    .find(Boolean);
  const totals = purchaseTotals({
    items: filled.map((l) => ({ qty: l.qty ?? 0, rate: l.rate ?? 0 })),
    discount: s.discount ?? 0,
    otherCharges: s.otherCharges ?? 0,
    roundOff: s.roundOff,
  });
  const payments = s.split
    ? s.splitRows.filter((p) => (p.amount ?? 0) > 0).map((p) => ({ mode: p.mode, accountId: p.accountId, amount: p.amount!, reference: p.reference.trim() || null }))
    : s.pay.mode === 'credit'
      ? []
      : totals.total > 0
        ? [{ mode: s.pay.mode as SettlementMode, accountId: s.pay.accountId, amount: totals.total, reference: s.payReference.trim() || null }]
        : [];
  const paid = payments.reduce((sum, p) => sum + p.amount, 0);
  const credit = totals.total - paid;
  const hasSupplier = !s.cashPurchase && !!s.supplier;

  const problem =
    lineProblem ??
    (!filled.length
      ? 'Add at least one item'
      : totals.discount > totals.subtotal
        ? 'The discount is more than the items total'
        : totals.total <= 0
          ? 'The total must be more than zero'
          : paid > totals.total
            ? `The amount paid (${formatINR(paid)}) is more than the total (${formatINR(totals.total)})`
            : credit > 0 && !hasSupplier
              ? `${formatINR(credit)} is unpaid: choose a supplier to buy on credit, or pay in full`
              : !s.accountId
                ? 'Choose the account to record this purchase in'
                : null);

  /* ---------- Duplicate bill check ---------- */
  const dBillNo = useDebounced(s.supplierBillNo.trim(), 400);
  const dup = useQuery(
    'purchases.checkBillNo',
    hasSupplier && dBillNo ? { supplierId: s.supplier!.id, supplierBillNo: dBillNo, excludeId: existing?.id ?? null } : null,
  );
  const duplicate = hasSupplier && dBillNo ? dup.data?.duplicate : null;

  /* ---------- Save ---------- */
  const save = async (andNew: boolean) => {
    setShowErrors(true);
    if (problem || m.loading) {
      if (problem) toast.warning(problem);
      return;
    }
    const input = {
      date: s.date,
      supplierId: hasSupplier ? s.supplier!.id : null,
      supplierName: s.cashPurchase ? s.supplierName.trim() || null : null,
      supplierBillNo: s.supplierBillNo.trim() || null,
      supplierBillDate: s.supplierBillDate || null,
      expenseAccountId: s.accountId,
      items: filled.map((l) => ({ description: l.description.trim(), qty: l.qty!, unit: l.unit.trim() || null, rate: l.rate ?? 0 })),
      discount: s.discount ?? 0,
      otherCharges: s.otherCharges ?? 0,
      roundOff: s.roundOff,
      payments,
      remarks: s.remarks.trim() || null,
    };
    try {
      const saved = existing ? await update.run({ id: existing.id, ...input, reason: s.reason.trim() || null }) : await create.run(input);
      setDirty(false);
      toast.success(`${existing ? 'Updated' : 'Saved'} purchase ${saved.purchaseNo} · ${formatINR(saved.total)}`);
      saved.warnings.forEach((w) => toast.warning(w));
      if (andNew && !existing) {
        setS(fresh(options, null, { date: s.date, accountId: s.accountId }));
        payTouched.current = false;
        setShowErrors(false);
        setTimeout(() => document.querySelector<HTMLInputElement>('.purchase-form [aria-label="Supplier"]')?.focus(), 50);
      } else navigate(`/purchases/${saved.id}`);
    } catch {
      /* error shown below */
    }
  };

  const leave = async () => {
    if (dirty && !(await dialogs.confirm({ title: 'Discard this purchase?', message: 'The changes you made will be lost.', confirmText: 'Discard', danger: true }))) return;
    setDirty(false);
    navigate(existing ? `/purchases/${existing.id}` : '/purchases');
  };

  useHotkeys({ 'ctrl+s': () => void save(false), F9: () => void save(false), 'ctrl+Enter': () => void save(!existing) });

  const accountsByGroup = useMemo(() => {
    const m = new Map<string, FormOptions['accounts']>();
    for (const a of options.accounts) m.set(a.groupName, [...(m.get(a.groupName) ?? []), a]);
    return [...m.entries()];
  }, [options.accounts]);

  const refLabel = s.pay.mode === 'upi' ? 'UPI transaction ID' : s.pay.mode === 'bank' ? 'Cheque / UTR number' : 'Reference';

  return (
    <Page wide>
      <PageHeader
        back={existing ? `/purchases/${existing.id}` : '/purchases'}
        title={existing ? `Edit purchase ${existing.purchaseNo}` : 'New purchase bill'}
        subtitle={existing ? `Entered on ${formatDate(existing.date)}. Changes are kept in the history.` : 'Enter a bill from a supplier, or a cash purchase'}
      />
      <div className="purchase-form">
        <div className="stack">
          <Card title="Supplier & bill">
            <div className="stack">
              <FormGrid cols={3}>
                <BoxField
                  className="span-2"
                  label={
                    <span className="label-row">
                      {s.cashPurchase ? 'Bought from (optional)' : 'Supplier'}
                      <button
                        type="button"
                        className="link-btn small-link"
                        onClick={() => patch({ cashPurchase: !s.cashPurchase, ...(!s.cashPurchase && s.pay.mode === 'credit' ? { pay: { mode: 'cash', accountId: null } } : {}) })}
                      >
                        {s.cashPurchase ? 'Choose a supplier record instead' : 'Cash purchase without a supplier record'}
                      </button>
                    </span>
                  }
                  error={showErrors && credit > 0 && !hasSupplier ? 'Needed to buy on credit' : m.fields.supplierId}
                >
                  {s.cashPurchase ? (
                    <TextInput value={s.supplierName} maxLength={120} placeholder="e.g. local market" aria-label="Bought from" onChange={(e) => patch({ supplierName: e.target.value })} autoFocus />
                  ) : (
                    <SupplierPicker
                      value={s.supplier}
                      onChange={(sup) => patch({ supplier: sup, ...(sup && !payTouched.current ? { pay: { mode: 'credit', accountId: null } } : {}) })}
                      autoFocus={!existing && !s.supplier}
                    />
                  )}
                </BoxField>
                <Field label="Record in account" hint="Furniture, computers etc.: pick a fixed asset" error={m.fields.expenseAccountId}>
                  <select className="input select" value={s.accountId ?? ''} onChange={(e) => patch({ accountId: Number(e.target.value) || null })} aria-label="Record in account">
                    {accountsByGroup.map(([group, list]) => (
                      <optgroup key={group} label={group}>
                        {list.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </Field>
              </FormGrid>
              <FormGrid cols={3}>
                <Field
                  label="Supplier's bill no"
                  error={m.fields.supplierBillNo}
                  hint={
                    duplicate ? (
                      <span className="dup-hint">
                        Already entered: <Link to={`/purchases/${duplicate.id}`}>{duplicate.purchaseNo}</Link>, {formatDate(duplicate.date)}, {formatINR(duplicate.total)}
                      </span>
                    ) : undefined
                  }
                >
                  <TextInput value={s.supplierBillNo} maxLength={60} onChange={(e) => patch({ supplierBillNo: e.target.value })} placeholder="As printed on their bill" />
                </Field>
                <Field label="Supplier's bill date" error={m.fields.supplierBillDate}>
                  <DateInput value={s.supplierBillDate} max={s.date} onChange={(v) => patch({ supplierBillDate: v })} />
                </Field>
                <Field label="Purchase date" required error={m.fields.date}>
                  <DateInput value={s.date} max={today} onChange={(v) => v && patch({ date: v })} />
                </Field>
              </FormGrid>
            </div>
          </Card>

          <Card title="Items" padded={false} actions={<span className="small muted">Enter moves to the next box · Ctrl+S saves</span>}>
            <div className="line-grid" role="table">
              <div className="lg-row lg-head" role="row">
                <span>#</span>
                <span>Description</span>
                <span className="r">Qty</span>
                <span>Unit</span>
                <span className="r">Rate (₹)</span>
                <span className="r">Amount</span>
                <span />
              </div>
              {s.lines.map((l, i) => {
                const amount = l.qty && l.rate !== null ? totals.amounts[filled.indexOf(l)] ?? 0 : null;
                const isBlank = i === s.lines.length - 1 && !l.description && !l.qty && l.rate === null;
                return (
                  <div className={`lg-row${isBlank ? ' lg-blank' : ''}`} role="row" key={l.key}>
                    <span className="lg-no">{i + 1}</span>
                    <DescriptionInput
                      inputRef={(el) => void cells.current.set(`${l.key}:desc`, el)}
                      value={l.description}
                      supplierId={hasSupplier ? s.supplier!.id : null}
                      placeholder={isBlank ? (i === 0 ? 'What did you buy?' : 'Add another item…') : ''}
                      ariaLabel={`Line ${i + 1} description`}
                      onChange={(v) => setLine(l.key, { description: v })}
                      onPick={(o) => setLine(l.key, { description: o.description, unit: o.unit ?? l.unit, rate: o.rate })}
                      onExactMatch={(o) => fillFromHistory(l.key, o)}
                      onEnter={() => advance(i, 0)}
                    />
                    <NumberInput
                      ref={(el) => void cells.current.set(`${l.key}:qty`, el)}
                      value={l.qty}
                      aria-label={`Line ${i + 1} quantity`}
                      onChange={(v) => setLine(l.key, { qty: v })}
                      onKeyDown={(e) => onCellKey(e, i, 1)}
                    />
                    <input
                      ref={(el) => void cells.current.set(`${l.key}:unit`, el)}
                      className="input"
                      value={l.unit}
                      placeholder={isBlank ? '' : 'pcs'}
                      maxLength={20}
                      aria-label={`Line ${i + 1} unit`}
                      onChange={(e) => setLine(l.key, { unit: e.target.value })}
                      onKeyDown={(e) => onCellKey(e, i, 2)}
                    />
                    <MoneyInput
                      ref={(el) => void cells.current.set(`${l.key}:rate`, el)}
                      symbol={false}
                      value={l.rate}
                      aria-label={`Line ${i + 1} rate`}
                      onChange={(v) => setLine(l.key, { rate: v })}
                      onKeyDown={(e) => onCellKey(e, i, 3)}
                    />
                    <span className="lg-amount money">{amount === null ? '' : formatINR(amount, { symbol: false })}</span>
                    {isBlank ? <span /> : <IconButton label="Remove line" icon={<Trash2 size={15} />} className="danger" tabIndex={-1} onClick={() => removeLine(l.key)} />}
                  </div>
                );
              })}
            </div>
            <div className="lg-foot">
              <Button size="sm" variant="ghost" icon={<Plus size={15} />} onClick={() => focusCell(s.lines.length - 1, 0)}>
                Add item
              </Button>
              <span className="muted small">
                {filled.length} item{filled.length === 1 ? '' : 's'} · Items total <b className="money">{formatINR(totals.subtotal)}</b>
              </span>
            </div>
          </Card>

          <Card title="Payment">
            <div className="stack">
              <div className="row-wrap">
                {!s.split && (
                  <PaymentModePicker
                    value={s.pay}
                    onChange={(v) => {
                      payTouched.current = true;
                      patch({ pay: v });
                    }}
                  />
                )}
                <Checkbox
                  checked={s.split}
                  onChange={(v) => patch({ split: v, splitRows: v && !s.splitRows.some((r) => r.amount) ? [blankPay(s.pay.mode === 'credit' ? 'cash' : (s.pay.mode as SettlementMode))] : s.splitRows })}
                  label="Split or part payment"
                />
              </div>
              {!s.split && s.pay.mode !== 'credit' && (
                <FormGrid cols={2}>
                  <Field label={refLabel}>
                    <TextInput value={s.payReference} maxLength={80} onChange={(e) => patch({ payReference: e.target.value })} placeholder="Optional" />
                  </Field>
                  <div className="paid-note">
                    Paid in full now: <b className="money">{formatINR(totals.total)}</b>
                  </div>
                </FormGrid>
              )}
              {!s.split && s.pay.mode === 'credit' && (
                hasSupplier ? (
                  <Alert tone="blue">
                    Nothing paid now. <b>{formatINR(totals.total)}</b> will be added to what you owe {s.supplier!.name}.
                  </Alert>
                ) : (
                  <Alert tone="amber">Choose a supplier above to buy on credit.</Alert>
                )
              )}
              {s.split && (
                <div className="split-rows">
                  {s.splitRows.map((p, i) => (
                    <div className="split-row" key={p.key}>
                      <Select<SettlementMode>
                        value={p.mode}
                        aria-label={`Payment ${i + 1} mode`}
                        onChange={(mode) => patch({ splitRows: s.splitRows.map((x) => (x.key === p.key ? { ...x, mode, accountId: null } : x)) })}
                        options={[
                          { value: 'cash', label: 'Cash' },
                          { value: 'upi', label: 'UPI' },
                          { value: 'bank', label: 'Bank' },
                        ]}
                      />
                      <MoneyInput
                        value={p.amount}
                        aria-label={`Payment ${i + 1} amount`}
                        placeholder="Amount"
                        onChange={(amount) => patch({ splitRows: s.splitRows.map((x) => (x.key === p.key ? { ...x, amount } : x)) })}
                      />
                      <TextInput
                        value={p.reference}
                        maxLength={80}
                        placeholder={p.mode === 'cash' ? 'Reference (optional)' : p.mode === 'upi' ? 'UPI transaction ID' : 'Cheque / UTR no'}
                        onChange={(e) => patch({ splitRows: s.splitRows.map((x) => (x.key === p.key ? { ...x, reference: e.target.value } : x)) })}
                      />
                      <IconButton
                        label="Remove payment"
                        icon={<Trash2 size={15} />}
                        className="danger"
                        onClick={() => patch({ splitRows: s.splitRows.length > 1 ? s.splitRows.filter((x) => x.key !== p.key) : [blankPay()] })}
                      />
                    </div>
                  ))}
                  <div className="row-between">
                    <Button size="sm" variant="ghost" icon={<Plus size={15} />} onClick={() => patch({ splitRows: [...s.splitRows, blankPay('upi')] })} disabled={s.splitRows.length >= 5}>
                      Add payment
                    </Button>
                    <span className="small">
                      Paid now <b className="money">{formatINR(paid)}</b> · On credit{' '}
                      <b className={`money ${credit > 0 ? 'bal-due' : ''}`}>{formatINR(Math.max(credit, 0))}</b>
                    </span>
                  </div>
                  {credit > 0 && !hasSupplier && <Alert tone="amber">{formatINR(credit)} is unpaid. Choose a supplier above to keep it on credit.</Alert>}
                </div>
              )}
              <Field label="Remarks">
                <TextArea rows={2} value={s.remarks} maxLength={500} onChange={(e) => patch({ remarks: e.target.value })} placeholder="Optional note" />
              </Field>
              {existing && (
                <Field label="Reason for change" hint="Saved in the history of this purchase">
                  <TextInput value={s.reason} maxLength={300} onChange={(e) => patch({ reason: e.target.value })} placeholder="e.g. rate corrected as per supplier's bill" />
                </Field>
              )}
            </div>
          </Card>
        </div>

        <div className="purchase-side">
          <Card title="Bill total">
            <div className="totals-box">
              <div className="tb-row">
                <span>Items total</span>
                <span className="money">{formatINR(totals.subtotal)}</span>
              </div>
              <div className="tb-row tb-input">
                <label htmlFor="purchase-discount">Less discount</label>
                <MoneyInput id="purchase-discount" value={s.discount} onChange={(v) => patch({ discount: v })} placeholder="0.00" />
              </div>
              <div className="tb-row tb-input">
                <label htmlFor="purchase-other" title="Freight, loading, packing…">
                  Add other charges
                </label>
                <MoneyInput id="purchase-other" value={s.otherCharges} onChange={(v) => patch({ otherCharges: v })} placeholder="0.00" />
              </div>
              <div className="tb-row">
                <Checkbox checked={s.roundOff} onChange={(v) => patch({ roundOff: v })} label="Round off" />
                <span className="money">{totals.roundOff ? formatINR(totals.roundOff, { plus: true }) : '0.00'}</span>
              </div>
              <div className="tb-row tb-total">
                <span>Total</span>
                <span className="money">{formatINR(totals.total)}</span>
              </div>
              <div className="tb-row">
                <span>Paid now</span>
                <span className="money">{formatINR(paid)}</span>
              </div>
              <div className="tb-row">
                <span>On credit</span>
                <span className={`money ${credit > 0 ? 'bal-due' : ''}`}>{formatINR(Math.max(credit, 0))}</span>
              </div>
              {hasSupplier && (
                <div className="tb-note">
                  {s.supplier!.name}:{' '}
                  {s.supplier!.payable > 0
                    ? `you owe ${formatINR(s.supplier!.payable)} now`
                    : s.supplier!.payable < 0
                      ? `advance of ${formatINR(-s.supplier!.payable)} paid`
                      : 'nothing payable now'}
                  {credit > 0 && existing === null
                    ? s.supplier!.payable + credit >= 0
                      ? `; you will owe ${formatINR(s.supplier!.payable + credit)} after this bill`
                      : `; advance left after this bill ${formatINR(-(s.supplier!.payable + credit))}`
                    : ''}
                  .
                </div>
              )}
            </div>
            {showErrors && problem && (
              <div className="mt-1">
                <Alert tone="amber">{problem}</Alert>
              </div>
            )}
            {m.error && (
              <div className="mt-1">
                <Alert tone="red">{m.error}</Alert>
              </div>
            )}
            <div className="side-actions">
              <Button variant="primary" size="lg" block icon={<Save size={17} />} kbd="Ctrl+S" loading={m.loading} onClick={() => void save(false)}>
                {existing ? 'Save changes' : 'Save purchase'}
              </Button>
              {!existing && (
                <Button block kbd="Ctrl+Enter" disabled={m.loading} onClick={() => void save(true)}>
                  Save &amp; enter another
                </Button>
              )}
              <Button block variant="ghost" onClick={leave}>
                Cancel
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}
