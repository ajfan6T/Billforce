import { useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { Alert, Button } from '../../components/ui';
import { DateInput, Field, MoneyInput, SegmentedControl, TextInput } from '../../components/forms';
import { AccountSelect, PaymentModePicker, SupplierPicker, type PaymentChoice, type SupplierOption } from '../../components/pickers';
import { Modal } from '../../components/modal';
import { useMutation } from '../../hooks';
import { useAuth } from '../../auth';
import { useToast } from '../../feedback';
import { todayISO } from '../../../shared/dates';
import { FieldGroup } from './common';
import './accounts.css';

export interface ExpenseDraft {
  date: string;
  accountId: number | null;
  amount: number | null;
  pay: PaymentChoice;
  supplier: SupplierOption | null;
  payee: string;
  reference: string;
  remarks: string;
}

export function emptyExpense(mode: PaymentChoice['mode'] = 'cash'): ExpenseDraft {
  return { date: todayISO(), accountId: null, amount: null, pay: { mode, accountId: null }, supplier: null, payee: '', reference: '', remarks: '' };
}

/** What is missing before the expense can be saved (null = ready). */
export function expenseProblem(d: ExpenseDraft): string | null {
  if (!d.accountId) return 'Choose the expense head';
  if (!d.amount) return 'Enter the amount';
  if (d.pay.mode === 'credit' && !d.supplier) return 'Choose the supplier you owe';
  return null;
}

export function expensePayload(d: ExpenseDraft) {
  return {
    date: d.date,
    accountId: d.accountId!,
    amount: d.amount!,
    mode: d.pay.mode,
    payAccountId: d.pay.mode === 'credit' ? null : d.pay.accountId,
    supplierId: d.supplier?.id ?? null,
    payee: d.supplier ? null : d.payee.trim() || null,
    reference: d.reference.trim() || null,
    remarks: d.remarks.trim() || null,
  };
}

/** The fields of an expense, used by the quick-entry card and the edit dialog. */
export function ExpenseFields({
  value,
  onChange,
  fields = {},
  autoFocus,
  layout = 'quick',
  actions,
}: {
  value: ExpenseDraft;
  onChange: (d: ExpenseDraft) => void;
  fields?: Record<string, string>;
  autoFocus?: boolean;
  layout?: 'quick' | 'modal';
  /** Buttons shown at the end of the last row (quick layout). */
  actions?: ReactNode;
}) {
  const { can } = useAuth();
  const [adding, setAdding] = useState(false);
  const [headsVersion, setHeadsVersion] = useState(0);
  const set = (patch: Partial<ExpenseDraft>) => onChange({ ...value, ...patch });
  const canAddHead = can('expenses.manage') || can('accounts.chart');

  const head = (
    <FieldGroup label="Expense head" required error={fields.accountId}>
      <div className="ac-head-field">
        <AccountSelect key={headsVersion} value={value.accountId} onChange={(id) => set({ accountId: id })} types={['expense']} placeholder="Rent, electricity, tea…" />
        {canAddHead && (
          <button type="button" className="ac-inline-link" onClick={() => setAdding(true)}>
            <Plus size={13} style={{ verticalAlign: -2 }} /> New head
          </button>
        )}
      </div>
    </FieldGroup>
  );
  const date = (
    <Field label="Date" required error={fields.date}>
      <DateInput value={value.date} max={todayISO()} onChange={(v) => set({ date: v })} />
    </Field>
  );
  const amount = (
    <Field label="Amount" required error={fields.amount}>
      <MoneyInput value={value.amount} onChange={(v) => set({ amount: v })} autoFocus={autoFocus} placeholder="0.00" />
    </Field>
  );
  const payBy = (
    <FieldGroup label="Paid by" error={fields.mode}>
      <PaymentModePicker value={value.pay} onChange={(pay) => set({ pay })} creditLabel="On credit" />
    </FieldGroup>
  );
  const who =
    value.pay.mode === 'credit' ? (
      <FieldGroup label="Supplier (you owe)" required error={fields.supplierId} hint="Added to the amount you owe this supplier">
        <SupplierPicker value={value.supplier} onChange={(s) => set({ supplier: s })} />
      </FieldGroup>
    ) : (
      <FieldGroup label="Paid to" hint="Optional: shop, person or supplier">
        {value.supplier ? (
          <SupplierPicker value={value.supplier} onChange={(s) => set({ supplier: s })} />
        ) : (
          <TextInput value={value.payee} onChange={(e) => set({ payee: e.target.value })} placeholder="e.g. Landlord, MSEB, Chaiwala" maxLength={120} aria-label="Paid to" />
        )}
      </FieldGroup>
    );
  const reference = (
    <Field label="Bill / ref no">
      <TextInput value={value.reference} onChange={(e) => set({ reference: e.target.value })} placeholder="Optional" maxLength={60} />
    </Field>
  );
  const remarks = (
    <Field label="Remarks">
      <TextInput value={value.remarks} onChange={(e) => set({ remarks: e.target.value })} placeholder="e.g. September rent" maxLength={500} />
    </Field>
  );

  return (
    <>
      {layout === 'quick' ? (
        <>
          <div className="ac-quick-grid">
            {date}
            {head}
            {amount}
          </div>
          <div className="ac-quick-row2">
            {payBy}
            {who}
          </div>
          <div className="ac-quick-row3">
            {reference}
            {remarks}
            {actions && <div className="ac-quick-actions">{actions}</div>}
          </div>
        </>
      ) : (
        <div className="stack">
          <div className="ac-quick-grid">
            {date}
            {head}
            {amount}
          </div>
          {payBy}
          {who}
          <div className="ac-quick-pair">
            {reference}
            {remarks}
          </div>
        </div>
      )}
      {adding && (
        <AddHeadModal
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false);
            setHeadsVersion((v) => v + 1);
            set({ accountId: id });
          }}
        />
      )}
    </>
  );
}

function AddHeadModal({ onClose, onAdded }: { onClose: () => void; onAdded: (id: number) => void }) {
  const toast = useToast();
  const m = useMutation('expenses.addHead');
  const [name, setName] = useState('');
  const [group, setGroup] = useState<'indirect_expenses' | 'direct_expenses'>('indirect_expenses');
  const save = async () => {
    try {
      const r = await m.run({ name, groupCode: group });
      toast.success(`Added expense head "${r.name}"`);
      onAdded(r.id);
    } catch {
      /* shown below */
    }
  };
  return (
    <Modal
      open
      title="New expense head"
      onClose={onClose}
      width={460}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!name.trim()} onClick={save}>
            Add head
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name" required error={m.fields.name}>
          <TextInput
            autoFocus
            value={name}
            maxLength={80}
            placeholder="e.g. Security Guard, Water Can"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                e.preventDefault();
                void save();
              }
            }}
          />
        </Field>
        <FieldGroup label="Type">
          <SegmentedControl<'indirect_expenses' | 'direct_expenses'>
            value={group}
            onChange={setGroup}
            options={[
              { value: 'indirect_expenses', label: 'Running cost', title: 'Rent, electricity, salaries, tea…' },
              { value: 'direct_expenses', label: 'Direct cost', title: 'Freight inward, labour and other costs of the goods you sell' },
            ]}
          />
        </FieldGroup>
        {m.error && <Alert tone="red">{m.error}</Alert>}
      </div>
    </Modal>
  );
}
