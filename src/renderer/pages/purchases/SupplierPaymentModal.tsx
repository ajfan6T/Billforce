import { useEffect, useRef, useState } from 'react';
import { Printer } from 'lucide-react';
import { Modal } from '../../components/modal';
import { Alert, Button } from '../../components/ui';
import { DateInput, Field, FormGrid, MoneyInput, TextInput } from '../../components/forms';
import { SettlementPicker, SupplierPicker, type SupplierOption } from '../../components/pickers';
import { useHotkeys, useMutation } from '../../hooks';
import { useAuth } from '../../auth';
import { useToast } from '../../feedback';
import { call, type ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { todayISO } from '../../../shared/dates';
import type { SettlementMode } from '../../../shared/constants';
import { REFERENCE_LABEL } from '../customers/ReceiptModal';
import { BoxField } from '../customers/common';

type PaymentDetail = ApiOutput<'supplierPayments.get'>;
type SavedPayment = ApiOutput<'supplierPayments.create'>;

interface Props {
  open: boolean;
  onClose: () => void;
  supplier?: SupplierOption | null;
  payment?: PaymentDetail | null;
  onSaved?: (p: SavedPayment) => void;
}

/** "Pay supplier" dialog: record money paid to a supplier against what you owe. */
export function SupplierPaymentModal(props: Props) {
  if (!props.open) return null;
  return <PaymentForm {...props} />;
}

function PaymentForm({ onClose, supplier: preset, payment, onSaved }: Props) {
  const toast = useToast();
  const { can } = useAuth();
  // Printing an edited payment whose voucher was printed before is a reprint.
  const canPrint = !payment?.printCount || can('billing.reprint');
  const editing = !!payment;
  const today = todayISO();
  const [supplier, setSupplier] = useState<SupplierOption | null>(preset ?? null);
  const [amount, setAmount] = useState<number | null>(payment ? payment.amount : preset && preset.payable > 0 ? preset.payable : null);
  const amountRef = useRef<HTMLInputElement>(null);
  const amountTouched = useRef(editing);
  const [discount, setDiscount] = useState<number | null>(payment?.discount || null);
  const [settle, setSettle] = useState<{ mode: SettlementMode; accountId: number | null }>({ mode: payment?.mode ?? 'cash', accountId: payment?.accountId ?? null });
  const [reference, setReference] = useState(payment?.reference ?? '');
  const [date, setDate] = useState(payment?.date ?? today);
  const [remarks, setRemarks] = useState(payment?.remarks ?? '');
  const [reason, setReason] = useState('');
  const [printing, setPrinting] = useState(false);
  const create = useMutation('supplierPayments.create');
  const update = useMutation('supplierPayments.update');
  const m = editing ? update : create;

  useEffect(() => {
    if (payment && !preset) {
      void call('suppliers.get', { id: payment.supplierId }).then((s) => setSupplier({ id: s.id, name: s.name, phone: s.phone, payable: s.payable }));
    }
  }, [payment, preset]);

  useEffect(() => {
    if (!amountTouched.current && supplier) setAmount(supplier.payable > 0 ? supplier.payable : null);
  }, [supplier]);

  const payableBefore = supplier
    ? supplier.payable + (payment && payment.supplierId === supplier.id && payment.status === 'active' ? payment.amount + payment.discount : 0)
    : 0;
  const settled = (amount ?? 0) + (discount ?? 0);
  const after = payableBefore - settled;
  const maxDiscount = Math.max(payableBefore - (amount ?? 0), 0);
  const discountTooBig = (discount ?? 0) > maxDiscount;
  const problem = !supplier ? 'Choose the supplier' : settled <= 0 ? 'Enter the amount paid' : discountTooBig ? `Discount can be at most ${formatINR(maxDiscount)}` : null;

  const save = async (print: boolean) => {
    if (problem || !supplier || m.loading) return;
    const input = {
      supplierId: supplier.id,
      date,
      amount: amount ?? 0,
      discount: discount ?? 0,
      mode: settle.mode,
      accountId: settle.accountId,
      reference: reference.trim() || null,
      remarks: remarks.trim() || null,
    };
    let saved: SavedPayment;
    try {
      saved = editing ? await update.run({ id: payment!.id, ...input, reason: reason.trim() || null }) : await create.run(input);
    } catch {
      return;
    }
    toast.success(editing ? `Payment ${saved.paymentNo} updated` : `Payment ${saved.paymentNo} saved: ${formatINR(saved.amount)} to ${saved.supplierName}`);
    saved.warnings.forEach((w) => toast.warning(w));
    if (print) {
      setPrinting(true);
      try {
        const res = await call('supplierPayments.print', { id: saved.id });
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
      title={editing ? `Edit payment ${payment!.paymentNo}` : 'Pay supplier'}
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
              Save &amp; print voucher
            </Button>
          )}
          <Button variant="primary" type="submit" form="supplier-payment-form" kbd="Enter" loading={m.loading && !printing} disabled={!!problem}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="supplier-payment-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <BoxField label="Supplier" required error={m.fields.supplierId}>
          <SupplierPicker
            value={supplier}
            onChange={(v) => {
              setSupplier(v);
              if (v) setTimeout(() => amountRef.current?.focus(), 60);
            }}
            autoFocus={!supplier}
            allowCreate={false}
          />
        </BoxField>
        {supplier && (
          <div className="pay-summary">
            <div>
              <div className="ps-label">{payableBefore >= 0 ? 'You owe' : 'Advance paid'}</div>
              <div className={`ps-value ${payableBefore > 0 ? 'bal-due' : payableBefore < 0 ? 'bal-adv' : ''}`}>{formatINR(Math.abs(payableBefore))}</div>
            </div>
            <div>
              <div className="ps-label">This payment</div>
              <div className="ps-value">{formatINR(settled)}</div>
            </div>
            <div>
              <div className="ps-label">{after > 0 ? 'Still payable' : after < 0 ? 'Advance after' : 'Balance after'}</div>
              <div className={`ps-value ${after > 0 ? 'bal-due' : after < 0 ? 'bal-adv' : 'bal-nil'}`}>{after === 0 ? 'Nil' : formatINR(Math.abs(after))}</div>
            </div>
          </div>
        )}
        <FormGrid>
          <Field label="Amount paid" required error={m.fields.amount}>
            <MoneyInput
              ref={amountRef}
              className="amount-big"
              value={amount}
              autoFocus={!!supplier}
              onChange={(v) => {
                amountTouched.current = true;
                setAmount(v);
              }}
            />
          </Field>
          <Field label="Discount received" hint="If the supplier let you pay less" error={discountTooBig ? `At most ${formatINR(maxDiscount)}` : m.fields.discount}>
            <MoneyInput value={discount} onChange={setDiscount} placeholder="0.00" />
          </Field>
        </FormGrid>
        <BoxField label="Paid by">
          <SettlementPicker value={settle} onChange={setSettle} />
        </BoxField>
        <FormGrid>
          <Field label={ref.label}>
            <TextInput value={reference} maxLength={80} placeholder={ref.placeholder} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label="Date" error={m.fields.date}>
            <DateInput value={date} max={today} onChange={(v) => v && setDate(v)} />
          </Field>
        </FormGrid>
        <Field label="Remarks">
          <TextInput value={remarks} maxLength={500} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional note, e.g. against bill GT/101" />
        </Field>
        {editing && (
          <Field label="Reason for change" hint="Saved in the history of this payment">
            <TextInput value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        {supplier && after < 0 && settled > 0 && (
          <Alert tone="amber">
            {payableBefore > 0
              ? `This is ${formatINR(-after)} more than you owe. The extra will be recorded as an advance paid to ${supplier.name}.`
              : `Nothing is payable to ${supplier.name}. ${formatINR(settled)} will be recorded as an advance.`}
          </Alert>
        )}
        {m.error && <Alert tone="red">{m.error}</Alert>}
      </form>
    </Modal>
  );
}
