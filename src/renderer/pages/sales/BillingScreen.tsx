import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { AlertTriangle, History, Plus, Printer, RotateCcw, Save, Search, SplitSquareHorizontal, Star, Trash2, X } from 'lucide-react';
import { call, errorMessage, type ApiOutput } from '../../api';
import { useQuery, useHotkeys } from '../../hooks';
import { useAuth } from '../../auth';
import { useDialogs, useToast, useUnsavedWarning } from '../../feedback';
import { Alert, Button, ErrorBox, Loading } from '../../components/ui';
import { Combobox, DateInput, SegmentedControl, Select, TextInput } from '../../components/forms';
import { CustomerPicker, PaymentModePicker, type CustomerOption, type PaymentChoice } from '../../components/pickers';
import { calcBill, roundQty } from '../../../shared/billing';
import { PAYMENT_MODE_LABELS, type SettlementMode } from '../../../shared/constants';
import { formatINR, formatQty } from '../../../shared/money';
import { formatDate, fyOf } from '../../../shared/dates';
import { LoadError, discountToText, parseDiscountText, parseQuickEntry, usePrintDoc } from './common';
import { PosLines, type CellField, type PosLine } from './PosLines';
import { FastMoneyInput, FastNumberInput } from './inputs';

type ItemOption = ApiOutput<'items.search'>[number];
type BillDetail = ApiOutput<'sales.get'>;

interface SplitRow {
  key: string;
  mode: SettlementMode;
  amount: number | null;
  /** Cash / bank account the money went to; null = the default account for the mode. */
  accountId?: number | null;
  reference?: string | null;
}

interface Draft {
  lines: PosLine[];
  customer: CustomerOption | null;
  walkInName: string;
  walkInPhone: string;
  billDiscMode: 'amt' | 'pct';
  billDiscValue: number | null;
  pay: PaymentChoice;
  split: boolean;
  splitRows: SplitRow[];
  remarks: string;
}

let uidCounter = 0;
const uid = () => `l${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

function itemMatches(item: ItemOption, q: string): boolean {
  const s = q.toLowerCase();
  return item.name.toLowerCase().includes(s) || (!!item.code && item.code.toLowerCase().startsWith(s));
}

function sameLine(a: PosLine, b: Omit<PosLine, 'key'>): boolean {
  if (a.discText || a.rate !== b.rate) return false;
  if (a.itemId || b.itemId) return a.itemId === b.itemId;
  return a.itemName.trim().toLowerCase() === b.itemName.trim().toLowerCase();
}

const DRAFT_KEY = (userId: number) => `bf:pos-draft:${userId}`;

export function BillingScreen() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : null;
  const [search] = useSearchParams();
  const repeatId = Number(search.get('repeat')) || null;
  const presetCustomerId = Number(search.get('customer')) || null;

  const billQ = useQuery('sales.get', editId ? { id: editId } : null);
  const cfgQ = useQuery('sales.posConfig', undefined);
  const reloadCfg = cfgQ.reload;

  // The counter is often left open overnight: fetch the date (and next bill number) again when the
  // window comes back and every minute, so the screen follows the clock across midnight.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void reloadCfg();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      clearInterval(timer);
    };
  }, [reloadCfg]);

  if (editId && billQ.error) {
    return (
      <div className="page">
        <LoadError title="This bill cannot be edited" error={billQ.error} back={`/sales/bills/${editId}`} backLabel="Back to the bill" onRetry={billQ.reload} />
      </div>
    );
  }
  if (cfgQ.error) return <div className="page"><ErrorBox error={cfgQ.error} onRetry={cfgQ.reload} /></div>;
  if (!cfgQ.data || (editId && !billQ.data)) return <Loading label={editId ? 'Opening bill…' : 'Getting the counter ready…'} />;

  const bill = billQ.data;
  if (editId && bill) {
    const activeReturns = bill.creditNotes.filter((c) => c.status === 'active');
    if (bill.status !== 'active' || activeReturns.length) {
      return (
        <div className="page">
          <Alert tone="amber" title={`Bill ${bill.billNo} cannot be edited`} icon={<AlertTriangle size={18} />}>
            {bill.status !== 'active'
              ? 'This bill is cancelled.'
              : `It has sales returns (${activeReturns.map((c) => c.cnNo).join(', ')}). Cancel those returns first, then edit the bill.`}
            <div className="mt-1">
              <Link to={`/sales/bills/${bill.id}`}>Back to the bill</Link>
            </div>
          </Alert>
        </div>
      );
    }
  }
  return <PosForm key={editId ?? 'new'} cfg={cfgQ.data} reloadCfg={cfgQ.reload} editBill={editId ? bill! : null} repeatId={repeatId} presetCustomerId={presetCustomerId} />;
}

function PosForm({
  cfg,
  reloadCfg,
  editBill,
  repeatId,
  presetCustomerId,
}: {
  cfg: ApiOutput<'sales.posConfig'>;
  reloadCfg: () => Promise<void>;
  editBill: BillDetail | null;
  repeatId: number | null;
  presetCustomerId: number | null;
}) {
  const { can, session } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const navigate = useNavigate();
  const printDoc = usePrintDoc();
  const editing = !!editBill;
  const canDiscount = can('billing.discount');
  const canBackdate = can('billing.backdate');
  const canRate = can('billing.rate');
  const userId = session?.userId ?? 0;

  /* ------------------------------ state ------------------------------ */
  const [lines, setLinesState] = useState<PosLine[]>([]);
  const linesRef = useRef<PosLine[]>([]);
  const setLines = useCallback((next: PosLine[]) => {
    linesRef.current = next;
    setLinesState(next);
  }, []);
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [walkInName, setWalkInName] = useState('');
  const [walkInPhone, setWalkInPhone] = useState('');
  // A new bill is dated today at the moment it is saved, unless the user picked a date.
  const [date, setDate] = useState(cfg.today);
  const [dateTouched, setDateTouched] = useState(false);
  const billDate = editing || dateTouched ? date : cfg.today;
  const [billDiscMode, setBillDiscMode] = useState<'amt' | 'pct'>('amt');
  const [billDiscValue, setBillDiscValue] = useState<number | null>(null);
  const defaultMode = cfg.defaultPaymentMode;
  const [pay, setPay] = useState<PaymentChoice>({ mode: defaultMode, accountId: null });
  const [split, setSplit] = useState(false);
  const [splitRows, setSplitRows] = useState<SplitRow[]>([]);
  const [cashReceived, setCashReceived] = useState<number | null>(null);
  const [remarks, setRemarks] = useState('');
  const [searchText, setSearchText] = useState('');
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [focusedLine, setFocusedLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [badKeys, setBadKeys] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const cashRef = useRef<HTMLInputElement>(null);
  const saveBtnRef = useRef<HTMLButtonElement>(null);
  const billDiscRef = useRef<HTMLInputElement>(null);
  const cells = useRef(new Map<string, HTMLInputElement>());

  const nextNo = useQuery('sales.nextNumber', editing ? null : { date: billDate });
  const payAccounts = useQuery('accounts.paymentAccounts', undefined);
  const recent = useQuery('items.recent', { limit: 14 });
  const custItems = useQuery('sales.customerItems', customer ? { customerId: customer.id, limit: 12 } : null);
  const last = useQuery('sales.lastBill', editing ? null : undefined);

  // A new bill keeps a draft (restored when New bill opens again), so moving to another page needs no question.
  useUnsavedWarning(lines.length > 0, { navigation: editing });

  // Toasts go to the bottom-left on this screen so they never cover the Save buttons.
  useEffect(() => {
    document.body.classList.add('pos-active');
    return () => document.body.classList.remove('pos-active');
  }, []);

  // Focus at once; the late retry only fills in when nothing has focus (e.g. after a dialog closed),
  // so it never steals focus from a box the cashier has already moved to.
  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body) searchRef.current?.focus();
    }, 0);
  }, []);
  const focusCell = useCallback((key: string, field: CellField) => {
    // Focus at once when the cell exists (so fast typing lands in the right box);
    // new lines are focused as soon as they have rendered.
    const go = (tries: number) => {
      const el = cells.current.get(`${key}:${field}`);
      if (el && el.isConnected) {
        el.focus();
        el.select?.();
      } else if (tries > 0) requestAnimationFrame(() => go(tries - 1));
    };
    go(10);
  }, []);
  const registerCell = useCallback((key: string, field: CellField, el: HTMLInputElement | null) => {
    if (el) cells.current.set(`${key}:${field}`, el);
  }, []);

  /* ------------------------------ load: edit / repeat / customer / draft ------------------------------ */
  const applyRepeat = useCallback(
    async (billId: number, askFirst: boolean) => {
      try {
        const data = await call('sales.repeatData', { billId });
        if (askFirst && linesRef.current.length) {
          const ok = await dialogs.confirm({ title: 'Replace the current items?', message: `The items on this bill will be replaced by the items of ${data.sourceBillNo}.`, confirmText: 'Replace' });
          if (!ok) return;
        }
        setLines(
          data.lines.map((l) => ({
            key: uid(),
            itemId: l.itemId,
            itemName: l.itemName,
            unit: l.unit,
            qty: l.qty,
            rate: l.itemId && !canRate && l.defaultRate ? l.defaultRate : l.rate,
            discText: discountToText(l.discount, l.discountPct),
            defaultRate: l.defaultRate,
          })),
        );
        setCustomer(data.customer ? { id: data.customer.id, name: data.customer.name, phone: data.customer.phone, balance: data.customer.balance, creditLimit: data.customer.creditLimit } : null);
        setWalkInName(data.customerName ?? '');
        setWalkInPhone(data.customerPhone ?? '');
        if (data.billDiscountPct) {
          setBillDiscMode('pct');
          setBillDiscValue(data.billDiscountPct);
        } else {
          setBillDiscMode('amt');
          setBillDiscValue(data.billDiscount);
        }
        toast.info(
          `Items copied from ${data.sourceBillNo}.${data.rateChanges ? ` ${data.rateChanges} item${data.rateChanges === 1 ? ' has' : 's have'} a different list rate now — check the rates.` : ''}`,
        );
        focusSearch();
      } catch (e) {
        toast.error(e);
      }
    },
    [dialogs, focusSearch, setLines, toast, canRate],
  );

  useEffect(() => {
    if (editBill) {
      const b = editBill;
      setLines(
        b.items.map((i) => ({
          key: uid(),
          itemId: i.itemId,
          itemName: i.itemName,
          unit: i.unit,
          qty: i.qty,
          rate: i.rate,
          discText: discountToText(i.discount, i.discountPct),
          defaultRate: null,
        })),
      );
      setCustomer(b.customer ? { id: b.customer.id, name: b.customer.name, phone: b.customer.phone, balance: b.customer.balance, creditLimit: b.customer.creditLimit } : null);
      setWalkInName(b.customerId ? '' : (b.customerName ?? ''));
      setWalkInPhone(b.customerId ? '' : (b.customerPhone ?? ''));
      setDate(b.date);
      if (b.billDiscountPct) {
        setBillDiscMode('pct');
        setBillDiscValue(b.billDiscountPct);
      } else {
        setBillDiscValue(b.billDiscount || null);
      }
      if (b.payments.length === 0) setPay({ mode: 'credit', accountId: null });
      else if (b.payments.length === 1 && b.credit === 0) setPay({ mode: b.payments[0].mode, accountId: b.payments[0].accountId });
      else {
        setSplit(true);
        setSplitRows(b.payments.map((p) => ({ key: uid(), mode: p.mode, amount: p.amount, accountId: p.accountId, reference: p.reference })));
      }
      setRemarks(b.remarks ?? '');
      setReady(true);
      focusSearch();
      return;
    }
    try {
      const raw = localStorage.getItem(DRAFT_KEY(userId));
      const d = raw ? (JSON.parse(raw) as Draft) : null;
      if (d && d.lines?.length) {
        setLines(d.lines);
        setCustomer(d.customer);
        setWalkInName(d.walkInName ?? '');
        setWalkInPhone(d.walkInPhone ?? '');
        setBillDiscMode(d.billDiscMode ?? 'amt');
        setBillDiscValue(canDiscount ? (d.billDiscValue ?? null) : null);
        setPay(d.pay ?? { mode: defaultMode, accountId: null });
        setSplit(!!d.split);
        setSplitRows(d.splitRows ?? []);
        setRemarks(d.remarks ?? '');
        if (!repeatId) toast.info('Your unsaved bill was restored.');
      }
    } catch {
      /* ignore a corrupt draft */
    }
    setReady(true);
    focusSearch();
    // Run once per form instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // /billing/new?repeat=<billId> and ?customer=<id> (links from bills and customer pages).
  useEffect(() => {
    if (editing || !ready || (!repeatId && !presetCustomerId)) return;
    (async () => {
      if (repeatId) await applyRepeat(repeatId, true);
      if (presetCustomerId) {
        try {
          const c = await call('sales.customer', { id: presetCustomerId });
          if (c.isActive) setCustomer({ id: c.id, name: c.name, phone: c.phone, balance: c.balance, creditLimit: c.creditLimit });
          else toast.warning(`${c.name} is inactive and cannot be billed.`);
        } catch (e) {
          toast.error(e);
        }
      }
      navigate('/billing/new', { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, repeatId, presetCustomerId]);

  // Keep a draft of the bill in progress so an accidental click elsewhere loses nothing.
  useEffect(() => {
    if (editing || !ready) return;
    const t = setTimeout(() => {
      try {
        if (!lines.length) localStorage.removeItem(DRAFT_KEY(userId));
        else {
          const d: Draft = { lines, customer, walkInName, walkInPhone, billDiscMode, billDiscValue, pay, split, splitRows, remarks };
          localStorage.setItem(DRAFT_KEY(userId), JSON.stringify(d));
        }
      } catch {
        /* storage full or unavailable */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [editing, ready, userId, lines, customer, walkInName, walkInPhone, billDiscMode, billDiscValue, pay, split, splitRows, remarks]);

  /* ------------------------------ calculations ------------------------------ */
  const calc = useMemo(
    () =>
      calcBill({
        lines: lines.map((l) => {
          const d = parseDiscountText(l.discText);
          return { qty: l.qty ?? 0, rate: l.rate ?? 0, discount: canDiscount || editing ? d.discount : null, discountPct: canDiscount || editing ? d.discountPct : null };
        }),
        billDiscount: billDiscMode === 'amt' ? billDiscValue : null,
        billDiscountPct: billDiscMode === 'pct' ? billDiscValue : null,
        roundOff: cfg.roundOff,
      }),
    [lines, billDiscMode, billDiscValue, cfg.roundOff, canDiscount, editing],
  );
  const total = calc.total;
  const splitPaid = splitRows.reduce((s, r) => s + (r.amount ?? 0), 0);
  const payments = split
    ? splitRows.filter((r) => r.amount && r.amount > 0).map((r) => ({ mode: r.mode, amount: r.amount!, accountId: r.accountId ?? null, reference: r.reference ?? null }))
    : pay.mode === 'credit'
      ? []
      : total > 0
        ? [{ mode: pay.mode as SettlementMode, amount: total, accountId: pay.accountId }]
        : [];
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const creditPart = Math.max(0, total - paid);
  const totalQty = roundQty(lines.reduce((s, l) => s + (l.qty ?? 0), 0));
  const oldCreditSameCustomer = editBill && customer && editBill.customerId === customer.id ? editBill.credit : 0;
  const dueAfter = customer ? customer.balance - oldCreditSameCustomer + creditPart : 0;
  const overLimit = !!customer && creditPart > 0 && !!customer.creditLimit && customer.creditLimit > 0 && dueAfter > customer.creditLimit;

  const problems = useMemo(() => {
    const out: Array<{ message: string; key?: string; field?: CellField | 'customer' | 'split' | 'billDisc' }> = [];
    if (!lines.length) out.push({ message: 'Add at least one item to the bill.' });
    lines.forEach((l, i) => {
      if (!l.qty || l.qty <= 0) out.push({ message: `Enter the quantity of "${l.itemName}".`, key: l.key, field: 'qty' });
      if (l.rate === null) out.push({ message: `Enter the rate of "${l.itemName}".`, key: l.key, field: 'rate' });
      const d = parseDiscountText(l.discText);
      if (!d.valid) out.push({ message: `Check the discount on "${l.itemName}".`, key: l.key, field: 'disc' });
      const p = calc.problems.find((x) => x.line === i);
      if (p) out.push({ message: `Discount on "${l.itemName}" is more than its amount.`, key: l.key, field: 'disc' });
    });
    if (calc.problems.some((p) => p.line === null)) out.push({ message: 'The bill discount is more than the bill amount.', field: 'billDisc' });
    if (lines.length && total <= 0 && !out.length) out.push({ message: 'The bill total must be more than zero.' });
    if (split && splitPaid > total) out.push({ message: `Payments (${formatINR(splitPaid)}) are more than the total (${formatINR(total)}).`, field: 'split' });
    if (creditPart > 0 && !customer && total > 0) out.push({ message: `Choose a customer to keep ${formatINR(creditPart)} on credit.`, field: 'customer' });
    if (overLimit && cfg.enforceCreditLimit) out.push({ message: `${customer!.name} would go over the credit limit of ${formatINR(customer!.creditLimit!)}.`, field: 'customer' });
    return out;
  }, [lines, calc, total, split, splitPaid, creditPart, customer, overLimit, cfg.enforceCreditLimit]);

  useEffect(() => {
    if (error) setError(null);
    if (badKeys.size) setBadKeys(new Set());
    // Clear messages as soon as the bill changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, customer, pay, split, splitRows, billDiscValue, cashReceived]);

  /* ------------------------------ lines ------------------------------ */
  const flash = (key: string) => {
    setFlashKey(null);
    setTimeout(() => setFlashKey(key), 0);
    // On a long bill the new (or increased) line may be out of sight: bring it into view once rendered.
    const show = (tries: number) => {
      const row = cells.current.get(`${key}:qty`)?.closest('tr');
      if (row && row.isConnected) row.scrollIntoView({ block: 'nearest' });
      else if (tries > 0) requestAnimationFrame(() => show(tries - 1));
    };
    requestAnimationFrame(() => show(10));
  };

  const addLine = (l: Omit<PosLine, 'key'>): string => {
    const prev = linesRef.current;
    const idx = prev.findIndex((p) => sameLine(p, l));
    if (idx >= 0) {
      const next = [...prev];
      next[idx] = { ...next[idx], qty: roundQty((next[idx].qty ?? 0) + (l.qty ?? 1)) };
      setLines(next);
      flash(next[idx].key);
      return next[idx].key;
    }
    const key = uid();
    setLines([...prev, { ...l, key }]);
    flash(key);
    return key;
  };

  const addItem = (item: { id: number; name: string; unit: string; rate: number }, qty: number, rate?: number) => {
    const key = addLine({ itemId: item.id, itemName: item.name, unit: item.unit, qty, rate: rate ?? item.rate, discText: '', defaultRate: item.rate });
    if ((rate ?? item.rate) === 0) focusCell(key, 'rate');
    else focusSearch();
  };

  const addFreeText = (name: string, qty: number) => {
    const clean = name.trim().replace(/\s+/g, ' ');
    const key = addLine({ itemId: null, itemName: clean.charAt(0).toUpperCase() + clean.slice(1), unit: null, qty, rate: null, discText: '', defaultRate: null });
    focusCell(key, 'rate');
  };

  const updateLine = (key: string, patch: Partial<PosLine>) => setLines(linesRef.current.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const stepLine = (key: string, delta: number) => {
    const l = linesRef.current.find((x) => x.key === key);
    if (!l) return;
    const next = roundQty((l.qty ?? 0) + delta);
    if (next > 0) updateLine(key, { qty: next });
  };
  const removeLine = (key: string) => {
    const idx = linesRef.current.findIndex((l) => l.key === key);
    setLines(linesRef.current.filter((l) => l.key !== key));
    const next = linesRef.current[Math.min(idx, linesRef.current.length - 1)];
    if (next) focusCell(next.key, 'qty');
    else focusSearch();
  };

  // Catalogue items are billed at their list rate unless the user may change rates
  // (one-time items and items without a list rate always take the typed rate).
  const rateLocked = (l: PosLine) => !canRate && !!l.itemId && l.defaultRate !== 0;

  const onCellEnter = (key: string, field: CellField) => {
    const l = linesRef.current.find((x) => x.key === key);
    if (field === 'qty' && !(l && rateLocked(l))) focusCell(key, 'rate');
    else if ((field === 'qty' || field === 'rate') && canDiscount) focusCell(key, 'disc');
    else focusSearch();
  };

  const pickItem = async (item: ItemOption) => {
    const { qty, name } = parseQuickEntry(searchText);
    let chosen: ItemOption | null = item;
    // The suggestion list may still be from a shorter text typed a moment ago.
    if (name && !itemMatches(item, name)) {
      try {
        chosen = (await call('items.search', { q: name, limit: 1 }))[0] ?? null;
      } catch {
        chosen = null;
      }
    }
    setSearchText('');
    if (chosen) addItem(chosen, qty);
    else if (name) addFreeText(name, qty);
  };

  const enterNoMatch = async (text: string) => {
    const { qty, name } = parseQuickEntry(text);
    if (!name) {
      if (linesRef.current.length) {
        // Empty search + Enter: go to payment (cash box), or to the save button for other modes.
        if (!split && pay.mode === 'cash') cashRef.current?.focus();
        else saveBtnRef.current?.focus();
      }
      return;
    }
    setSearchText('');
    try {
      // Barcode scanners and fast typists press Enter before suggestions arrive: take the exact
      // match, else the first suggestion (what Enter picks once the list is showing). Only text
      // that matches no item at all becomes a one-time item.
      const res = await call('items.search', { q: name, limit: 5 });
      const exact = res.find((i) => (i.code && i.code.toLowerCase() === name.toLowerCase()) || i.name.toLowerCase() === name.toLowerCase());
      const top = exact ?? res[0];
      if (top) return addItem(top, qty);
    } catch {
      /* fall through to a one-time line */
    }
    addFreeText(name, qty);
  };

  /** Enter in a side-panel box goes back to the item search (or the cash box once items are in). */
  const sideEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (linesRef.current.length && !split && pay.mode === 'cash') cashRef.current?.focus();
    else focusSearch();
  };

  /* ------------------------------ reset / save ------------------------------ */
  const reset = () => {
    setLines([]);
    setCustomer(null);
    setWalkInName('');
    setWalkInPhone('');
    setDate(cfg.today);
    setDateTouched(false);
    setBillDiscMode('amt');
    setBillDiscValue(null);
    setPay({ mode: defaultMode, accountId: null });
    setSplit(false);
    setSplitRows([]);
    setCashReceived(null);
    setRemarks('');
    setSearchText('');
    setError(null);
    setBadKeys(new Set());
    try {
      localStorage.removeItem(DRAFT_KEY(userId));
    } catch {
      /* ignore */
    }
    focusSearch();
  };

  const clearBill = async () => {
    if (editing) {
      const ok = await dialogs.confirm({ title: 'Discard your changes?', message: `Bill ${editBill!.billNo} will stay as it was.`, confirmText: 'Discard changes', danger: true });
      if (ok) navigate(`/sales/bills/${editBill!.id}`);
      return;
    }
    if (!linesRef.current.length && !customer) return reset();
    const ok = await dialogs.confirm({ title: 'Clear this bill?', message: 'All items on the screen will be removed. Nothing has been saved yet.', confirmText: 'Clear bill', danger: true });
    if (!ok) return;
    // Keep what was cleared so a slip of the keyboard can be undone.
    const cleared: Draft = { lines: linesRef.current, customer, walkInName, walkInPhone, billDiscMode, billDiscValue, pay, split, splitRows, remarks };
    reset();
    toast.info(`Bill cleared (${cleared.lines.length} item${cleared.lines.length === 1 ? '' : 's'}).`, { label: 'Undo', onClick: () => restoreDraft(cleared) });
  };

  const restoreDraft = (d: Draft) => {
    setLines(d.lines);
    setCustomer(d.customer);
    setWalkInName(d.walkInName ?? '');
    setWalkInPhone(d.walkInPhone ?? '');
    setBillDiscMode(d.billDiscMode ?? 'amt');
    setBillDiscValue(d.billDiscValue ?? null);
    setPay(d.pay ?? { mode: defaultMode, accountId: null });
    setSplit(!!d.split);
    setSplitRows(d.splitRows ?? []);
    setRemarks(d.remarks ?? '');
    focusSearch();
  };

  const save = async (print: boolean) => {
    if (saving) return;
    if (problems.length) {
      const p = problems[0];
      setError(p.message);
      setBadKeys(new Set(problems.filter((x) => x.key).map((x) => x.key!)));
      if (p.key && (p.field === 'qty' || p.field === 'rate' || p.field === 'disc')) focusCell(p.key, p.field);
      else if (p.field === 'customer') (document.querySelector('.pos-customer input') as HTMLInputElement | null)?.focus();
      else if (p.field === 'billDisc') billDiscRef.current?.focus();
      else focusSearch();
      return;
    }
    // "Cash received" less than the total is never saved as fully paid: the rest goes on the
    // customer's credit only when the user says so, and a walk-in customer must pay in full.
    let pays = payments;
    let cashNote = '';
    if (!split && pay.mode === 'cash' && cashReceived !== null && total > 0) {
      if (cashReceived < total) {
        const short = total - cashReceived;
        if (!customer) {
          setError(`Cash received (${formatINR(cashReceived)}) is less than the total (${formatINR(total)}). Take the full amount, or choose a customer to keep ${formatINR(short)} on credit.`);
          cashRef.current?.focus();
          return;
        }
        const ok = await dialogs.confirm({
          title: `Keep ${formatINR(short)} on credit?`,
          message: `Only ${formatINR(cashReceived)} was received against ${formatINR(total)}. ${customer.name} will owe ${formatINR(short)} more for this bill.`,
          confirmText: 'Keep on credit',
          cancelText: 'Go back',
        });
        if (!ok) {
          cashRef.current?.focus();
          return;
        }
        pays = cashReceived > 0 ? [{ mode: 'cash', amount: cashReceived, accountId: pay.accountId }] : [];
        cashNote = ` · ${formatINR(short)} on credit`;
      } else if (cashReceived > total) cashNote = ` · Cash ${formatINR(cashReceived)} · Change ${formatINR(cashReceived - total)}`;
    }
    const input = {
      // Only a date the user picked is sent; otherwise the bill gets today's date when it is saved.
      date: editing || dateTouched ? date : null,
      customerId: customer?.id ?? null,
      customerName: customer ? null : walkInName.trim() || null,
      customerPhone: customer ? null : walkInPhone.trim() || null,
      items: lines.map((l) => {
        const d = parseDiscountText(l.discText);
        const allow = canDiscount || editing;
        return { itemId: l.itemId, itemName: l.itemName, unit: l.unit, qty: l.qty!, rate: l.rate!, discount: allow ? d.discount : null, discountPct: allow ? d.discountPct : null };
      }),
      billDiscount: billDiscMode === 'amt' && (canDiscount || editing) ? billDiscValue || null : null,
      billDiscountPct: billDiscMode === 'pct' && (canDiscount || editing) ? billDiscValue || null : null,
      payments: pays,
      remarks: remarks.trim() || null,
    };
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        const reason = await dialogs.prompt({
          title: `Save changes to ${editBill!.billNo}?`,
          message: 'The earlier version stays in the bill history.',
          label: 'Reason for the change (optional)',
          placeholder: 'e.g. Wrong rate entered',
          confirmText: 'Save changes',
        });
        if (reason === null) return;
        const res = await call('sales.update', { id: editBill!.id, ...input, reason: reason || null });
        res.warnings.forEach((w) => toast.warning(w));
        toast.success(`Bill ${res.billNo} updated`);
        if (print) await printDoc('bill', res.id);
        navigate(`/sales/bills/${res.id}`);
        return;
      }
      const res = await call('sales.create', input);
      res.warnings.forEach((w) => toast.warning(w));
      if (res.date < res.createdAt.slice(0, 10)) toast.warning(`Bill ${res.billNo} is dated ${formatDate(res.date)}, a past date.`);
      // "Save" (F10) never prints; "Save & print" (F9) does.
      const willPrint = print;
      toast.success(`Bill ${res.billNo} saved · ${formatINR(res.total)}${cashNote}${willPrint ? ' · printing' : ''}`, {
        label: willPrint ? 'Reprint' : 'Print',
        onClick: () => void printDoc('bill', res.id),
      });
      reset();
      void nextNo.reload();
      void last.reload();
      void recent.reload();
      void reloadCfg();
      if (willPrint) void printDoc('bill', res.id, { quiet: true });
    } catch (e) {
      setError(errorMessage(e));
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  const repeatLast = async () => {
    const lb = last.data ?? (await call('sales.lastBill').catch(() => null));
    if (!lb) return toast.info('You have not saved any bill yet.');
    await applyRepeat(lb.id, true);
  };

  /* ------------------------------ payment helpers ------------------------------ */
  const setMode = (mode: PaymentChoice['mode']) => {
    setSplit(false);
    setPay({ mode, accountId: null });
    if (mode === 'cash') setTimeout(() => cashRef.current?.focus(), 30);
  };
  const startSplit = () => {
    setSplit(true);
    setSplitRows([
      { key: uid(), mode: pay.mode === 'credit' ? 'cash' : (pay.mode as SettlementMode), amount: null },
      { key: uid(), mode: pay.mode === 'upi' ? 'cash' : 'upi', amount: null },
    ]);
    setTimeout(() => (document.querySelector('.sl-split-row input') as HTMLInputElement | null)?.focus(), 30);
  };
  const updateSplit = (key: string, patch: Partial<SplitRow>) => setSplitRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /* ------------------------------ keyboard ------------------------------ */
  useHotkeys({
    F9: () => void save(true),
    F10: () => void save(false),
    'ctrl+p': () => void save(true),
    'ctrl+s': () => void save(false),
    F3: () => focusSearch(),
    F4: () => (document.querySelector('.pos-customer input') as HTMLInputElement | null)?.focus(),
    F7: () => billDiscRef.current?.focus(),
    F8: () => {
      if (split || pay.mode !== 'cash') setMode('cash');
      else cashRef.current?.focus();
    },
    'alt+1': () => setMode('cash'),
    'alt+2': () => setMode('upi'),
    'alt+3': () => setMode('bank'),
    'alt+4': () => setMode('credit'),
    'ctrl+Delete': () => focusedLine && removeLine(focusedLine),
    Escape: () => {
      const active = document.activeElement as HTMLElement | null;
      if (active && active.closest('.sl-lines-table, .pos-side')) return focusSearch();
      if (searchText) return setSearchText('');
      void clearBill();
    },
  });

  /* ------------------------------ render ------------------------------ */
  const parsed = parseQuickEntry(searchText);
  const recentChips = (recent.data ?? []).slice(0, 14);
  const custChips = customer ? (custItems.data ?? []) : [];
  const cashChange = pay.mode === 'cash' && !split && cashReceived !== null ? cashReceived - total : null;
  const billNo = editing ? editBill!.billNo : (nextNo.data?.billNo ?? cfg.nextBillNo);
  // An edited bill must stay in its own financial year (its number belongs to it).
  const fy = editing ? fyOf(editBill!.date) : null;
  const dateMin = fy && fy.start > cfg.booksStartDate ? fy.start : cfg.booksStartDate;
  const dateMax = fy && fy.end < cfg.today ? fy.end : cfg.today;

  return (
    <div className="pos-screen">
      <div className="pos-main">
        <div className="pos-top">
          <div className="pos-title">
            {editing ? 'Edit bill' : 'New bill'}
            <span className="pos-billno" title={editing ? 'Bill number' : 'Number this bill will get'}>
              {billNo}
            </span>
          </div>
          <span className="spacer" />
          {!editing && (
            <Button size="sm" variant="ghost" icon={<RotateCcw size={15} />} onClick={repeatLast} disabled={!last.data} title={last.data ? `Copy items of ${last.data.billNo}` : 'No saved bills yet'}>
              Repeat last bill
            </Button>
          )}
          {editing && (
            <Button size="sm" variant="ghost" icon={<History size={15} />} onClick={() => navigate(`/sales/bills/${editBill!.id}`)}>
              Back to bill
            </Button>
          )}
        </div>
        {editing && (
          <div className="pos-edit-banner">
            <AlertTriangle size={16} />
            <span>
              Editing <b>{editBill!.billNo}</b> dated {formatDate(editBill!.date)} ({formatINR(editBill!.total)}). The bill number stays the same and the old version is kept in its history.
            </span>
          </div>
        )}

        <div className="pos-search">
          <Search size={18} className="search-icon" />
          <Combobox<ItemOption>
            ref={searchRef}
            value={searchText}
            onInputChange={setSearchText}
            aria-label="Item search"
            placeholder="Type item name or code, or scan a barcode… (2*sugar for quantity 2)"
            loadOptions={(q) => call('items.search', { q: parseQuickEntry(q).name, limit: 10 })}
            getKey={(i) => i.id}
            onSelect={(i) => void pickItem(i)}
            onEnterNoMatch={(t) => void enterNoMatch(t)}
            renderOption={(i) => (
              <div className="sl-item-option">
                <div>
                  <div className="sl-io-name">
                    {parsed.hasQty && <span className="sl-io-qty">{formatQty(parsed.qty)} ×</span>}
                    {i.name}
                  </div>
                  <div className="sl-io-sub">{[i.code, i.category].filter(Boolean).join(' · ') || `per ${i.unit}`}</div>
                </div>
                <span className="sl-io-rate">
                  {formatINR(i.rate)}
                  <span className="faint small">/{i.unit}</span>
                </span>
              </div>
            )}
            footer={
              parsed.name
                ? () => (
                    <div className="small muted">
                      <kbd>Enter</kbd> on no match adds “{parsed.name}” as a one-time item{parsed.hasQty ? ` × ${formatQty(parsed.qty)}` : ''}
                    </div>
                  )
                : undefined
            }
          />
        </div>

        {custChips.length > 0 && (
          <div className="pos-chips" tabIndex={-1} aria-label={`${customer!.name}'s usual items`}>
            <span className="pos-chips-label">
              <Star size={12} /> {customer!.name.split(' ')[0]}'s usual
            </span>
            {custChips.map((ci) => (
              <button
                key={`${ci.itemId ?? ci.itemName}`}
                type="button"
                tabIndex={-1}
                className="sl-chip cust"
                title={`Last bought ${formatQty(ci.lastQty)}${ci.unit ? ' ' + ci.unit : ''} at ${formatINR(ci.lastRate)} on ${formatDate(ci.lastDate)}`}
                onClick={() => {
                  // Without "change rates" a catalogue item goes in at its list rate, not last time's rate.
                  if (ci.itemId) addItem({ id: ci.itemId, name: ci.itemName, unit: ci.unit ?? 'pcs', rate: ci.defaultRate ?? ci.lastRate }, 1, canRate || !ci.defaultRate ? ci.lastRate : undefined);
                  else {
                    addLine({ itemId: null, itemName: ci.itemName, unit: ci.unit, qty: 1, rate: ci.lastRate, discText: '', defaultRate: null });
                    focusSearch();
                  }
                }}
              >
                {ci.itemName}
                <span className="sl-chip-rate">{formatINR(ci.lastRate)}</span>
              </button>
            ))}
          </div>
        )}
        {recentChips.length > 0 && (
          <div className="pos-chips" tabIndex={-1} aria-label="Frequently billed items">
            <span className="pos-chips-label">Quick add</span>
            {recentChips.map((it) => (
              <button key={it.id} type="button" tabIndex={-1} className="sl-chip" title={`${it.name} · ${formatINR(it.rate)}/${it.unit}`} onClick={() => addItem(it, 1)}>
                {it.name}
                <span className="sl-chip-rate">{formatINR(it.rate, { decimals: it.rate % 100 ? 2 : 0 })}</span>
              </button>
            ))}
          </div>
        )}

        <div className="pos-lines">
          <PosLines
            lines={lines}
            calc={calc}
            canDiscount={canDiscount}
            rateLocked={rateLocked}
            flashKey={flashKey}
            badKeys={badKeys}
            onChange={updateLine}
            onStep={stepLine}
            onRemove={removeLine}
            registerCell={registerCell}
            onCellEnter={onCellEnter}
            onFocusLine={setFocusedLine}
            empty={
              <>
                <div className="pe-title">No items yet</div>
                <div>
                  Type an item name above and press <kbd>Enter</kbd>, or tap a quick-add button.
                </div>
                <div className="small">
                  Tip: <code>3*tea</code> adds 3 teas · a name not in the list becomes a one-time item
                </div>
              </>
            }
          />
          <div className="pos-lines-foot">
            <span>
              {lines.length} item{lines.length === 1 ? '' : 's'} · Qty {formatQty(totalQty)}
            </span>
            <span className="pos-keys">
              <span>
                <kbd>F3</kbd>Item
              </span>
              <span>
                <kbd>F4</kbd>Customer
              </span>
              {canDiscount && (
                <span className="opt">
                  <kbd>F7</kbd>Discount
                </span>
              )}
              <span>
                <kbd>F8</kbd>Cash
              </span>
              <span className="opt">
                <kbd>Alt+1–4</kbd>Mode
              </span>
              <span>
                <kbd>Esc</kbd>
                {editing ? 'Discard' : 'Clear'}
              </span>
            </span>
          </div>
        </div>
      </div>

      <aside className="pos-side" aria-label="Bill summary">
        <div className="pos-side-body">
          <div>
            <div className="pos-section-label">
              Customer <span className="sl-kbd-hint faint small">optional · F4</span>
            </div>
            <div
              className="pos-customer"
              onBlur={(e) => {
                // A name typed here that matches no customer is not thrown away: use it as the walk-in name.
                const typed = e.target instanceof HTMLInputElement && e.target.getAttribute('role') === 'combobox' ? e.target.value.trim() : '';
                if (!typed || customer || walkInName.trim() || document.querySelector('.modal')) return;
                setWalkInName(typed.slice(0, 120));
                toast.info(`"${typed}" will be printed as the walk-in name. To bill a saved customer, press F4 and pick or add them.`);
              }}
            >
              <CustomerPicker
                value={customer}
                onChange={(c) => {
                  setCustomer(c);
                  if (c) focusSearch();
                }}
                placeholder="Search name or phone…"
              />
            </div>
            {!customer && (
              <div className="sl-walkin">
                <TextInput value={walkInName} onChange={(e) => setWalkInName(e.target.value)} onKeyDown={sideEnter} placeholder="Walk-in name" aria-label="Walk-in customer name" maxLength={120} />
                <TextInput value={walkInPhone} onChange={(e) => setWalkInPhone(e.target.value.replace(/[^0-9+\-\s()]/g, ''))} onKeyDown={sideEnter} placeholder="Phone" aria-label="Walk-in phone" maxLength={20} />
              </div>
            )}
          </div>

          {(canBackdate || (editing && billDate !== cfg.today)) && (
            <div className="pos-date">
              <span className="pos-section-label" style={{ margin: 0 }}>
                Bill date
              </span>
              <DateInput
                value={billDate}
                onChange={(d) => {
                  if (!d) return;
                  setDate(d);
                  // Picking today again means "today when saved" (follows the clock).
                  if (!editing) setDateTouched(d !== cfg.today);
                }}
                max={dateMax}
                min={dateMin}
                disabled={!canBackdate}
                aria-label="Bill date"
              />
              {billDate !== cfg.today && <span className="badge badge-amber">Past date</span>}
            </div>
          )}

          <div className="pos-totals">
            <div className="tr">
              <span>Subtotal</span>
              <span className="money">{formatINR(calc.subtotal)}</span>
            </div>
            {calc.itemDiscount > 0 && (
              <div className="tr muted">
                <span>Item discounts</span>
                <span className="money">−{formatINR(calc.itemDiscount)}</span>
              </div>
            )}
            {(canDiscount || calc.billDiscount > 0) && (
              <div className="tr sl-bill-disc-row">
                <span className="sl-bill-disc">
                  Bill discount
                  {canDiscount && (
                    <SegmentedControl<'amt' | 'pct'>
                      size="sm"
                      value={billDiscMode}
                      onChange={(m) => {
                        setBillDiscMode(m);
                        setBillDiscValue(null);
                      }}
                      options={[
                        { value: 'amt', label: '₹', title: 'Discount in rupees' },
                        { value: 'pct', label: '%', title: 'Discount in percent' },
                      ]}
                    />
                  )}
                </span>
                <span className="sl-bill-disc">
                  {canDiscount &&
                    (billDiscMode === 'amt' ? (
                      <FastMoneyInput ref={billDiscRef} value={billDiscValue} onChange={setBillDiscValue} onKeyDown={sideEnter} aria-label="Bill discount in rupees" placeholder="0" />
                    ) : (
                      <FastNumberInput inputRef={billDiscRef} value={billDiscValue} onChange={setBillDiscValue} onKeyDown={sideEnter} decimals={2} max={100} aria-label="Bill discount percent" placeholder="0 %" />
                    ))}
                  {calc.billDiscount > 0 && <span className="money muted">−{formatINR(calc.billDiscount)}</span>}
                </span>
              </div>
            )}
            {calc.roundOff !== 0 && (
              <div className="tr muted">
                <span>Round off</span>
                <span className="money">{formatINR(calc.roundOff, { plus: true })}</span>
              </div>
            )}
          </div>

          <div className="pos-pay">
            <div className="pos-section-label">
              Payment{' '}
              {!split ? (
                <button type="button" className="btn btn-link btn-sm" onClick={startSplit} title="Pay with more than one mode, rest on credit">
                  <SplitSquareHorizontal size={14} /> Split payment
                </button>
              ) : (
                <button type="button" className="btn btn-link btn-sm" onClick={() => setMode(pay.mode === 'credit' ? 'cash' : pay.mode)}>
                  <X size={14} /> Single mode
                </button>
              )}
            </div>
            {!split ? (
              <>
                <PaymentModePicker value={pay} onChange={(v) => setPay(v)} size="md" />
                {pay.mode === 'credit' && !customer && (
                  <div className="sl-pay-hint bad">
                    <AlertTriangle size={14} /> Credit needs a customer. Choose one above.
                  </div>
                )}
                {pay.mode === 'cash' && (
                  <div className="sl-cash-box">
                    <label className="field">
                      <span className="field-label">Cash received (F8)</span>
                      <FastMoneyInput
                        ref={cashRef}
                        value={cashReceived}
                        onChange={setCashReceived}
                        placeholder={total ? formatINR(total, { symbol: false }) : '0'}
                        aria-label="Cash received"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            // Enter here is the quick "done" key: it prints when automatic printing is on.
                            void save(cfg.autoPrint);
                          }
                        }}
                      />
                    </label>
                    <div className={`sl-change-box${cashChange !== null && cashChange < 0 ? ' short' : ''}`} aria-live="polite">
                      <span className="sl-cb-label">{cashChange !== null && cashChange < 0 ? 'Short by' : 'Return change'}</span>
                      <span className="sl-cb-value">{cashChange === null ? '—' : formatINR(Math.abs(cashChange))}</span>
                    </div>
                  </div>
                )}
                {pay.mode === 'cash' && cashChange !== null && cashChange < 0 && (
                  <div className="sl-pay-hint bad">
                    <AlertTriangle size={14} />
                    {customer
                      ? `Received less than the total. Saving will ask to keep ${formatINR(-cashChange)} on ${customer.name}'s credit.`
                      : `Received less than the total. Take the full amount, or choose a customer to keep ${formatINR(-cashChange)} on credit.`}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="sl-split-rows">
                  {splitRows.map((r) => {
                    const accts = (r.mode === 'cash' ? payAccounts.data?.cash : payAccounts.data?.bank) ?? [];
                    const def = payAccounts.data ? (r.mode === 'cash' ? payAccounts.data.defaults.cash : r.mode === 'upi' ? payAccounts.data.defaults.upi : payAccounts.data.defaults.bank) : null;
                    return (
                    <div className="sl-split-row" key={r.key}>
                      <Select<SettlementMode>
                        value={r.mode}
                        onChange={(mode) => updateSplit(r.key, { mode, accountId: null })}
                        options={(['cash', 'upi', 'bank'] as const).map((m) => ({ value: m, label: PAYMENT_MODE_LABELS[m] }))}
                        aria-label="Payment mode"
                      />
                      <FastMoneyInput
                        value={r.amount}
                        onChange={(amount) => updateSplit(r.key, { amount })}
                        aria-label={`${PAYMENT_MODE_LABELS[r.mode]} amount`}
                        placeholder={total - splitPaid > 0 ? `rest ${formatINR(total - splitPaid, { symbol: false })}` : '0'}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && r.amount === null && total - splitPaid > 0) {
                            e.preventDefault();
                            updateSplit(r.key, { amount: total - splitPaid });
                          }
                        }}
                      />
                      <button type="button" className="icon-btn danger" aria-label="Remove payment" onClick={() => setSplitRows((rows) => rows.filter((x) => x.key !== r.key))}>
                        <Trash2 size={14} />
                      </button>
                      {(accts.length > 1 || (r.accountId && r.accountId !== def)) && (
                        <Select<number>
                          className="sl-split-acct"
                          value={r.accountId ?? def ?? undefined}
                          onChange={(accountId) => updateSplit(r.key, { accountId })}
                          options={[
                            ...accts.map((a) => ({ value: a.id, label: a.name })),
                            // An edited bill's account that is no longer in the list (e.g. made inactive).
                            ...(r.accountId && !accts.some((a) => a.id === r.accountId)
                              ? [{ value: r.accountId, label: editBill?.payments.find((p) => p.accountId === r.accountId)?.accountName ?? 'Saved account' }]
                              : []),
                          ]}
                          aria-label={`${PAYMENT_MODE_LABELS[r.mode]} account`}
                        />
                      )}
                    </div>
                    );
                  })}
                  {splitRows.length < 6 && (
                    <button type="button" className="btn btn-link btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setSplitRows((rows) => [...rows, { key: uid(), mode: 'cash', amount: null }])}>
                      <Plus size={14} /> Add payment
                    </button>
                  )}
                </div>
                <div className="sl-split-sum">
                  <span className="muted">Paid now {formatINR(splitPaid)}</span>
                  <span className={creditPart > 0 ? 'bold' : 'muted'}>{splitPaid > total ? `Over by ${formatINR(splitPaid - total)}` : `On credit ${formatINR(creditPart)}`}</span>
                </div>
                {creditPart > 0 && !customer && (
                  <div className="sl-pay-hint bad">
                    <AlertTriangle size={14} /> Choose a customer to keep {formatINR(creditPart)} on credit.
                  </div>
                )}
              </>
            )}
            {customer && creditPart > 0 && (
              <div className={`sl-pay-hint${overLimit ? ' bad' : ''}`} style={overLimit ? undefined : { color: 'var(--text-2)' }}>
                {overLimit && <AlertTriangle size={14} />}
                {/* balanceHidden: the user may not see the customer's balance, so only this bill's credit is shown. */}
                {customer.balanceHidden ? `${formatINR(creditPart)} will be added to ${customer.name}'s account` : `${customer.name} will owe ${formatINR(dueAfter)} after this bill`}
                {overLimit ? ` — over the credit limit of ${formatINR(customer.creditLimit!)}` : ''}.
              </div>
            )}
          </div>

          <div>
            <div className="pos-section-label">Remarks</div>
            <TextInput value={remarks} onChange={(e) => setRemarks(e.target.value)} onKeyDown={sideEnter} placeholder="Optional note printed on the bill" maxLength={500} aria-label="Remarks" />
          </div>
        </div>

        <div className="pos-side-foot">
          <div className="pos-grand">
            <span className="pg-label">Total</span>
            <span className="pg-value">{formatINR(total)}</span>
          </div>
          {creditPart > 0 && total > 0 && (
            <div className="pos-grand-sub">
              Paid now {formatINR(paid)} · On credit <b>{formatINR(creditPart)}</b>
            </div>
          )}
          {error && <div className="pos-error" role="alert">{error}</div>}
          <div className="pos-actions">
            <Button ref={saveBtnRef} variant="primary" icon={<Printer size={18} />} kbd="F9" loading={saving} onClick={() => void save(true)}>
              {editing ? 'Save changes & print' : 'Save & print'}
            </Button>
            <Button icon={<Save size={16} />} kbd="F10" disabled={saving} onClick={() => void save(false)}>
              {editing ? 'Save changes' : 'Save'}
            </Button>
            <Button variant="ghost" kbd="Esc" disabled={saving} onClick={() => void clearBill()}>
              {editing ? 'Discard' : 'New'}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}
