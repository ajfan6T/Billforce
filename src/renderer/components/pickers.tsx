/**
 * Shared domain pickers used across modules. They rely only on the CONTRACT
 * routes (customers.search / quickCreate, suppliers.search / quickCreate,
 * accounts.list / paymentAccounts, employees.search).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Banknote, CreditCard, Landmark, Smartphone, UserPlus, X } from 'lucide-react';
import { call, type ApiOutput } from '../api';
import { useQuery } from '../hooks';
import { useAuth } from '../auth';
import { useToast } from '../feedback';
import { Combobox, Field, SegmentedControl, Select, TextInput } from './forms';
import { Button, Money } from './ui';
import { Modal } from './modal';
import { PAYMENT_MODE_LABELS, type AccountType, type PaymentMode, type SettlementMode } from '../../shared/constants';
import { formatDrCr, formatINR } from '../../shared/money';

export type CustomerOption = ApiOutput<'customers.search'>[number];
export type SupplierOption = ApiOutput<'suppliers.search'>[number];

/* ------------------------------ Customer ------------------------------ */

function QuickAddModal({
  open,
  title,
  initialName,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  initialName: string;
  onClose: () => void;
  onSave: (v: { name: string; phone: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      const digits = /^[0-9+\s-]{6,}$/.test(initialName.trim());
      setName(digits ? '' : initialName);
      setPhone(digits ? initialName.trim() : '');
      setError(null);
    }
  }, [open, initialName]);
  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), phone: phone.trim() });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            Add
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name" required>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              // Keyboard flow: Enter moves on to Phone; with the phone already there it adds at once.
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (!name.trim()) return;
              if (phone.trim()) void save();
              else phoneRef.current?.focus();
            }}
          />
        </Field>
        <Field label="Phone" hint="Optional: press Enter to add without it">
          <TextInput
            ref={phoneRef}
            value={phone}
            inputMode="tel"
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              void save();
            }}
          />
        </Field>
        {error && <div className="field-error">{error}</div>}
      </div>
    </Modal>
  );
}

/**
 * Pick a customer by typing a name or phone number. Shows the current balance;
 * optional "Add new customer" for users allowed to create customers.
 */
export function CustomerPicker({
  value,
  onChange,
  placeholder = 'Search customer by name or phone…',
  allowCreate = true,
  autoFocus,
  showBalance = true,
}: {
  value: CustomerOption | null;
  onChange: (c: CustomerOption | null) => void;
  placeholder?: string;
  allowCreate?: boolean;
  autoFocus?: boolean;
  showBalance?: boolean;
}) {
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const { can } = useAuth();
  const toast = useToast();
  if (value) {
    return (
      <div className="picked">
        <div className="picked-main">
          <span className="picked-name">{value.name}</span>
          {value.phone && <span className="picked-sub">{value.phone}</span>}
        </div>
        {showBalance && value.balance !== 0 && (
          <span className={`picked-bal ${value.balance > 0 ? 'neg' : 'pos'}`} title="Current balance">
            {value.balance > 0 ? `Due ${formatINR(value.balance)}` : `Advance ${formatINR(-value.balance)}`}
          </span>
        )}
        <button type="button" className="icon-btn" aria-label="Remove customer" onClick={() => onChange(null)}>
          <X size={15} />
        </button>
      </div>
    );
  }
  const canCreate = allowCreate && can('customers.manage');
  return (
    <>
      <Combobox<CustomerOption>
        value={text}
        onInputChange={setText}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label="Customer"
        openOnFocus
        loadOptions={(q) => call('customers.search', { q, limit: 12 })}
        getKey={(c) => c.id}
        onSelect={(c) => {
          onChange(c);
          setText('');
        }}
        // Keyboard users: Enter on a name that matches nobody opens "Add customer" with the name filled in.
        onEnterNoMatch={canCreate ? (t) => t.trim() && setAdding(true) : undefined}
        renderOption={(c) => (
          <div className="combo-option">
            <div>
              <div>{c.name}</div>
              {c.phone && <div className="sub">{c.phone}</div>}
            </div>
            {c.balance !== 0 && <span className={`small ${c.balance > 0 ? 'neg' : 'pos'}`}>{formatDrCr(c.balance)}</span>}
          </div>
        )}
        footer={
          canCreate
            ? (close) => (
                <button
                  type="button"
                  className="combo-add"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    close();
                    setAdding(true);
                  }}
                >
                  <UserPlus size={15} /> Add new customer{text.trim() ? ` "${text.trim()}"` : ''}
                </button>
              )
            : undefined
        }
      />
      <QuickAddModal
        open={adding}
        title="Add customer"
        initialName={text}
        onClose={() => setAdding(false)}
        onSave={async (v) => {
          const c = await call('customers.quickCreate', { name: v.name, phone: v.phone || null });
          toast.success(`Added customer ${c.name}`);
          setAdding(false);
          setText('');
          onChange(c);
        }}
      />
    </>
  );
}

/* ------------------------------ Supplier ------------------------------ */

export function SupplierPicker({
  value,
  onChange,
  placeholder = 'Search supplier…',
  allowCreate = true,
  autoFocus,
}: {
  value: SupplierOption | null;
  onChange: (s: SupplierOption | null) => void;
  placeholder?: string;
  allowCreate?: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const { can } = useAuth();
  const toast = useToast();
  if (value) {
    return (
      <div className="picked">
        <div className="picked-main">
          <span className="picked-name">{value.name}</span>
          {value.phone && <span className="picked-sub">{value.phone}</span>}
        </div>
        {value.payable !== 0 && (
          <span className={`picked-bal ${value.payable > 0 ? 'neg' : 'pos'}`}>
            {value.payable > 0 ? `Payable ${formatINR(value.payable)}` : `Advance ${formatINR(-value.payable)}`}
          </span>
        )}
        <button type="button" className="icon-btn" aria-label="Remove supplier" onClick={() => onChange(null)}>
          <X size={15} />
        </button>
      </div>
    );
  }
  const canCreate = allowCreate && can('suppliers.manage');
  return (
    <>
      <Combobox<SupplierOption>
        value={text}
        onInputChange={setText}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label="Supplier"
        openOnFocus
        loadOptions={(q) => call('suppliers.search', { q, limit: 12 })}
        getKey={(s) => s.id}
        onSelect={(s) => {
          onChange(s);
          setText('');
        }}
        renderOption={(s) => (
          <div className="combo-option">
            <div>
              <div>{s.name}</div>
              {s.phone && <div className="sub">{s.phone}</div>}
            </div>
            {s.payable !== 0 && <Money value={s.payable} className="small" />}
          </div>
        )}
        footer={
          canCreate
            ? (close) => (
                <button
                  type="button"
                  className="combo-add"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    close();
                    setAdding(true);
                  }}
                >
                  <UserPlus size={15} /> Add new supplier{text.trim() ? ` "${text.trim()}"` : ''}
                </button>
              )
            : undefined
        }
      />
      <QuickAddModal
        open={adding}
        title="Add supplier"
        initialName={text}
        onClose={() => setAdding(false)}
        onSave={async (v) => {
          const s = await call('suppliers.quickCreate', { name: v.name, phone: v.phone || null });
          toast.success(`Added supplier ${s.name}`);
          setAdding(false);
          setText('');
          onChange(s);
        }}
      />
    </>
  );
}

/* ------------------------------ Accounts ------------------------------ */

/** Account dropdown grouped by account group. */
export function AccountSelect({
  value,
  onChange,
  groups,
  types,
  placeholder = 'Choose account…',
  exclude,
  alsoShow,
  hideSystem,
  allowEmpty,
  disabled,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  groups?: string[];
  types?: AccountType[];
  placeholder?: string;
  /** Account ids to leave out (e.g. the "from" account in a transfer). */
  exclude?: number[];
  /** Inactive accounts to list anyway: those a document being edited already uses. */
  alsoShow?: number[];
  /** System accounts (by key) not offered, unless already used (alsoShow). */
  hideSystem?: string[];
  allowEmpty?: boolean;
  disabled?: boolean;
}) {
  const q = useQuery('accounts.list', alsoShow?.length ? { groups, types, includeInactive: true } : { groups, types });
  const byGroup = useMemo(() => {
    const m = new Map<string, Array<{ id: number; name: string; code: string | null }>>();
    for (const a of q.data ?? []) {
      if (exclude?.includes(a.id)) continue;
      if (!a.isActive && !alsoShow?.includes(a.id)) continue;
      if (a.systemKey && hideSystem?.includes(a.systemKey) && !alsoShow?.includes(a.id)) continue;
      const list = m.get(a.groupName) ?? [];
      list.push({ id: a.id, name: a.isActive ? a.name : `${a.name} (inactive)`, code: a.code });
      m.set(a.groupName, list);
    }
    return m;
  }, [q.data, exclude, alsoShow, hideSystem]);
  return (
    <select
      className="input select"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      aria-label="Account"
    >
      <option value="" disabled={!allowEmpty}>
        {q.loading ? 'Loading…' : placeholder}
      </option>
      {[...byGroup.entries()].map(([group, list]) => (
        <optgroup key={group} label={group}>
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/* ------------------------------ Payment mode ------------------------------ */

export const PAYMENT_ICONS: Record<PaymentMode, typeof Banknote> = { cash: Banknote, upi: Smartphone, bank: Landmark, credit: CreditCard };

export interface PaymentChoice {
  mode: PaymentMode;
  /** Specific cash / bank account; null = the default account for the mode. */
  accountId: number | null;
}

/**
 * Cash / UPI / Bank / Credit selector. When the business has more than one
 * cash or bank account, a second dropdown lets the user pick which one.
 */
export function PaymentModePicker({
  value,
  onChange,
  modes = ['cash', 'upi', 'bank', 'credit'],
  size = 'md',
  creditLabel,
}: {
  value: PaymentChoice;
  onChange: (v: PaymentChoice) => void;
  modes?: PaymentMode[];
  size?: 'sm' | 'md' | 'lg';
  /** Rename "Credit" (e.g. "Adjust in account" for refunds). */
  creditLabel?: string;
}) {
  const accounts = useQuery('accounts.paymentAccounts', undefined);
  const list: Array<{ id: number; name: string }> =
    value.mode === 'cash' ? (accounts.data?.cash ?? []) : value.mode === 'credit' ? [] : (accounts.data?.bank ?? []);
  const def = accounts.data ? (value.mode === 'cash' ? accounts.data.defaults.cash : value.mode === 'upi' ? accounts.data.defaults.upi : accounts.data.defaults.bank) : null;
  return (
    <div className="row-wrap">
      <SegmentedControl<PaymentMode>
        size={size}
        value={value.mode}
        onChange={(mode) => onChange({ mode, accountId: null })}
        options={modes.map((m) => {
          const Icon = PAYMENT_ICONS[m];
          return { value: m, label: m === 'credit' && creditLabel ? creditLabel : PAYMENT_MODE_LABELS[m], icon: <Icon size={size === 'lg' ? 18 : 15} /> };
        })}
      />
      {value.mode !== 'credit' && list.length > 1 && (
        <Select<number>
          value={value.accountId ?? def ?? undefined}
          onChange={(id) => onChange({ ...value, accountId: id === def ? null : id })}
          options={list.map((a) => ({ value: a.id, label: a.name }))}
          aria-label="Account"
          style={{ width: 'auto', minWidth: 160 }}
        />
      )}
    </div>
  );
}

/** Settlement-only variant (no credit): for receipts, payments, refunds. */
export function SettlementPicker({ value, onChange, size }: { value: { mode: SettlementMode; accountId: number | null }; onChange: (v: { mode: SettlementMode; accountId: number | null }) => void; size?: 'sm' | 'md' | 'lg' }) {
  return <PaymentModePicker value={value} onChange={(v) => onChange(v as { mode: SettlementMode; accountId: number | null })} modes={['cash', 'upi', 'bank']} size={size} />;
}

/* ------------------------------ Employees ------------------------------ */

export function EmployeeSelect({ value, onChange, includeInactive, placeholder = 'Choose employee…' }: { value: number | null; onChange: (id: number | null) => void; includeInactive?: boolean; placeholder?: string }) {
  const q = useQuery('employees.search', { includeInactive });
  return (
    <Select<number>
      value={value ?? undefined}
      onChange={(v) => onChange(v)}
      placeholder={q.loading ? 'Loading…' : placeholder}
      options={(q.data ?? []).map((e) => ({ value: e.id, label: e.designation ? `${e.name} (${e.designation})` : e.name }))}
    />
  );
}

/* ------------------------------ Receipt preview ------------------------------ */

/** Shows receipt / document HTML exactly as it will print, inside a sandboxed frame. */
export function ReceiptPreview({ html, widthMm = 80, height = 560 }: { html: string | null | undefined; widthMm?: number; height?: number }) {
  const px = Math.round((widthMm / 25.4) * 96) + 8;
  return (
    <div className="receipt-preview">
      {html ? <iframe title="Receipt preview" sandbox="" srcDoc={html} style={{ width: px, height }} /> : <div className="muted">No preview</div>}
    </div>
  );
}
