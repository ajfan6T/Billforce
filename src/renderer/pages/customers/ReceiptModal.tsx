import { useEffect, useRef, useState } from 'react';
import { Printer } from 'lucide-react';
import { Modal } from '../../components/modal';
import { Alert, Button } from '../../components/ui';
import { DateInput, Field, FormGrid, MoneyInput, TextInput } from '../../components/forms';
import { CustomerPicker, SettlementPicker, type CustomerOption } from '../../components/pickers';
import { useHotkeys, useMutation } from '../../hooks';
import { useAuth } from '../../auth';
import { useToast } from '../../feedback';
import { call, type ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, todayISO } from '../../../shared/dates';
import type { SettlementMode } from '../../../shared/constants';
import { BoxField } from './common';

type ReceiptDetail = ApiOutput<'receipts.get'>;
type SavedReceipt = ApiOutput<'receipts.create'>;

export const REFERENCE_LABEL: Record<SettlementMode, { label: string; placeholder: string }> = {
  cash: { label: 'Reference (optional)', placeholder: 'e.g. slip number' },
  upi: { label: 'UPI transaction ID', placeholder: 'e.g. 4271 8890 1123' },
  bank: { label: 'Cheque / UTR number', placeholder: 'e.g. cheque 000123 or NEFT UTR' },
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** Pre-selected customer (from the customer page). */
  customer?: CustomerOption | null;
  /** Edit an existing payment. */
  receipt?: ReceiptDetail | null;
  onSaved?: (r: SavedReceipt) => void;
}

/** "Receive payment" dialog: record money received from a customer against their dues. */
export function ReceiptModal(props: Props) {
  if (!props.open) return null;
  return <ReceiptForm {...props} />;
}

function ReceiptForm({ onClose, customer: presetCustomer, receipt, onSaved }: Props) {
  const { can } = useAuth();
  const toast = useToast();
  const editing = !!receipt;
  const today = todayISO();
  const [customer, setCustomer] = useState<CustomerOption | null>(presetCustomer ?? null);
  const [amount, setAmount] = useState<number | null>(receipt ? receipt.amount : presetCustomer && presetCustomer.balance > 0 ? presetCustomer.balance : null);
  const amountRef = useRef<HTMLInputElement>(null);
  const amountTouched = useRef(editing);
  const [discount, setDiscount] = useState<number | null>(receipt?.discount || null);
  const [settle, setSettle] = useState<{ mode: SettlementMode; accountId: number | null }>({ mode: receipt?.mode ?? 'cash', accountId: receipt?.accountId ?? null });
  const [reference, setReference] = useState(receipt?.reference ?? '');
  const [date, setDate] = useState(receipt?.date ?? today);
  const [remarks, setRemarks] = useState(receipt?.remarks ?? '');
  const [reason, setReason] = useState('');
  const [printing, setPrinting] = useState(false);
  const create = useMutation('receipts.create');
  const update = useMutation('receipts.update');
  const m = editing ? update : create;
  const canBackdate = can('billing.backdate');
  // A settlement discount writes off dues, so it needs "Give discounts" (like a discount on a bill).
  const canDiscount = can('billing.discount');
  // Printing an edited payment that was printed before is a reprint.
  const canPrint = !receipt?.printCount || can('billing.reprint');

  // When editing, load the customer so the picker shows the current balance.
  useEffect(() => {
    if (receipt && !presetCustomer) {
      void call('customers.get', { id: receipt.customerId }).then((c) =>
        setCustomer({ id: c.id, name: c.name, phone: c.phone, balance: c.balance, creditLimit: c.creditLimit }),
      );
    }
  }, [receipt, presetCustomer]);

  // Default the amount to what is due.
  useEffect(() => {
    if (!amountTouched.current && customer) setAmount(customer.balance > 0 ? customer.balance : null);
  }, [customer]);

  // Amount due before this payment (an edited payment is added back).
  const dueBefore = customer ? customer.balance + (receipt && receipt.customerId === customer.id && receipt.status === 'active' ? receipt.amount + receipt.discount : 0) : 0;
  const settled = (amount ?? 0) + (discount ?? 0);
  const after = dueBefore - settled;
  const maxDiscount = Math.max(dueBefore - (amount ?? 0), 0);
  const discountTooBig = (discount ?? 0) > maxDiscount;
  const problem = !customer ? 'Choose the customer' : settled <= 0 ? 'Enter the amount received' : discountTooBig ? `Discount can be at most ${formatINR(maxDiscount)}` : null;

  const save = async (print: boolean) => {
    if (problem || !customer || m.loading) return;
    const input = {
      customerId: customer.id,
      date,
      amount: amount ?? 0,
      discount: discount ?? 0,
      mode: settle.mode,
      accountId: settle.accountId,
      reference: reference.trim() || null,
      remarks: remarks.trim() || null,
    };
    let saved: SavedReceipt;
    try {
      saved = editing ? await update.run({ id: receipt!.id, ...input, reason: reason.trim() || null }) : await create.run(input);
    } catch {
      return;
    }
    toast.success(editing ? `Payment ${saved.receiptNo} updated` : `Payment ${saved.receiptNo} saved: ${formatINR(saved.amount)} from ${saved.customerName}`);
    saved.warnings.forEach((w) => toast.warning(w));
    if (print) {
      setPrinting(true);
      try {
        const res = await call('receipts.print', { id: saved.id });
        if (!res.printed && res.message) toast.warning(res.message);
      } catch (e) {
        toast.error(e);
      } finally {
        setPrinting(false);
      }
    }
    onSaved?.(saved);
    onClose();
  };

  useHotkeys({ 'ctrl+p': () => void save(canPrint), 'ctrl+s': () => void save(false) });

  const ref = REFERENCE_LABEL[settle.mode];
  return (
    <Modal
      open
      title={editing ? `Edit payment ${receipt!.receiptNo}` : 'Receive payment'}
      onClose={onClose}
      width={600}
      locked={m.loading || printing}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {canPrint && (
            <Button icon={<Printer size={16} />} kbd="Ctrl+P" loading={printing} disabled={!!problem || m.loading} onClick={() => void save(true)}>
              Save &amp; print
            </Button>
          )}
          <Button variant="primary" type="submit" form="receipt-form" kbd="Enter" loading={m.loading && !printing} disabled={!!problem}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="receipt-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <BoxField label="Customer" required error={m.fields.customerId}>
          <CustomerPicker
            value={customer}
            onChange={(c) => {
              setCustomer(c);
              if (c) setTimeout(() => amountRef.current?.focus(), 60);
            }}
            autoFocus={!customer}
            allowCreate={false}
          />
        </BoxField>
        {customer && (
          <div className="pay-summary">
            <div>
              <div className="ps-label">{dueBefore >= 0 ? 'Amount due' : 'Advance held'}</div>
              <div className={`ps-value ${dueBefore > 0 ? 'bal-due' : dueBefore < 0 ? 'bal-adv' : ''}`}>{formatINR(Math.abs(dueBefore))}</div>
            </div>
            <div>
              <div className="ps-label">This payment</div>
              <div className="ps-value">{formatINR(settled)}</div>
            </div>
            <div>
              <div className="ps-label">{after > 0 ? 'Still due' : after < 0 ? 'Advance after' : 'Balance after'}</div>
              <div className={`ps-value ${after > 0 ? 'bal-due' : after < 0 ? 'bal-adv' : 'bal-nil'}`}>{after === 0 ? 'Nil' : formatINR(Math.abs(after))}</div>
            </div>
          </div>
        )}
        <FormGrid>
          <Field label="Amount received" required error={m.fields.amount}>
            <MoneyInput
              ref={amountRef}
              className="amount-big"
              value={amount}
              autoFocus={!!customer}
              onChange={(v) => {
                amountTouched.current = true;
                setAmount(v);
              }}
            />
          </Field>
          {canDiscount ? (
            <Field label="Discount allowed" hint="Settlement discount, if any" error={discountTooBig ? `At most ${formatINR(maxDiscount)}` : m.fields.discount}>
              <MoneyInput value={discount} onChange={setDiscount} placeholder="0.00" />
            </Field>
          ) : (
            <BoxField label="Discount allowed" hint="Giving discounts needs permission from the owner" error={discountTooBig ? `At most ${formatINR(maxDiscount)}` : m.fields.discount}>
              <div className="readonly-date" aria-label="Discount allowed">
                {discount ? formatINR(discount) : 'None'}
              </div>
            </BoxField>
          )}
        </FormGrid>
        <BoxField label="Received by">
          <SettlementPicker value={settle} onChange={setSettle} />
        </BoxField>
        <FormGrid>
          <Field label={ref.label} error={m.fields.reference}>
            <TextInput value={reference} maxLength={80} placeholder={ref.placeholder} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label="Date" error={m.fields.date} hint={canBackdate ? undefined : "Only today's date is allowed for your login"}>
            {canBackdate ? (
              <DateInput value={date} max={today} onChange={(v) => v && setDate(v)} />
            ) : (
              <div className="readonly-date">{formatDate(date)}</div>
            )}
          </Field>
        </FormGrid>
        <Field label="Remarks">
          <TextInput value={remarks} maxLength={500} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional note" />
        </Field>
        {editing && (
          <Field label="Reason for change" hint="Saved in the history of this payment">
            <TextInput value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong amount typed" />
          </Field>
        )}
        {customer && after < 0 && settled > 0 && (
          <Alert tone="amber">
            {dueBefore > 0
              ? `This is ${formatINR(-after)} more than the amount due. The extra will be kept as an advance for ${customer.name}.`
              : `${customer.name} has nothing due. ${formatINR(settled)} will be kept as an advance.`}
          </Alert>
        )}
        {m.error && <Alert tone="red">{m.error}</Alert>}
      </form>
    </Modal>
  );
}
