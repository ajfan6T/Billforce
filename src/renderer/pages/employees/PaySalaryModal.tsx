import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button } from '../../components/ui';
import { DateInput, Field, MoneyInput, TextInput } from '../../components/forms';
import { SettlementPicker } from '../../components/pickers';
import { Modal } from '../../components/modal';
import { useMutation } from '../../hooks';
import { useToast } from '../../feedback';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { GroupField } from './common';
import { PaymentBalanceHint, useShortfallConfirm } from '../accounts/PaymentBalance';
import { formatDate, todayISO } from '../../../shared/dates';
import type { SettlementMode } from '../../../shared/constants';

export interface PayTarget {
  id: number;
  salaryNo: string;
  employeeName: string;
  monthLabel: string;
  date: string;
  net: number;
  balance: number;
}

/** Pay salary that is due on a slip (in full or in part). */
export function PaySalaryModal({ open, slip, onClose, onSaved }: { open: boolean; slip: PayTarget | null; onClose: () => void; onSaved: (s: ApiOutput<'salary.pay'>) => void }) {
  const m = useMutation('salary.pay');
  const toast = useToast();
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(todayISO());
  const [pay, setPay] = useState<{ mode: SettlementMode; accountId: number | null }>({ mode: 'cash', accountId: null });
  const [remarks, setRemarks] = useState('');

  useEffect(() => {
    if (open && slip) {
      setAmount(slip.balance);
      setDate(todayISO() < slip.date ? slip.date : todayISO());
      setPay({ mode: 'cash', accountId: null });
      setRemarks('');
      m.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slip?.id]);

  const problem = !slip ? 'Loading' : !amount ? 'Enter the amount' : amount > slip.balance ? `At most ${formatINR(slip.balance)}` : null;

  const payment = { mode: pay.mode, accountId: pay.accountId, amount, date };
  const confirmShortfall = useShortfallConfirm();

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!slip || problem || m.loading) return;
    // Ask before cash / bank goes below zero, not only after the payment is saved.
    const accepted = await confirmShortfall(payment);
    if (!accepted) return;
    try {
      const res = await m.run({ salaryId: slip.id, amount: amount!, date, mode: pay.mode, accountId: pay.accountId, remarks: remarks.trim() || null });
      toast.success(`Paid ${formatINR(amount!)} to ${slip.employeeName}${res.balance > 0 ? ` · ${formatINR(res.balance)} still due` : ''}`);
      for (const w of res.warnings) if (!accepted.includes(w)) toast.warning(w);
      onSaved(res);
    } catch {
      /* shown below */
    }
  };

  return (
    <Modal
      open={open}
      title={slip ? `Pay salary · ${slip.employeeName}` : 'Pay salary'}
      onClose={onClose}
      width={500}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={m.loading}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!!problem} onClick={() => void save()}>
            Pay {amount ? formatINR(amount) : ''}
          </Button>
        </>
      }
    >
      {slip && (
        <form className="stack" onSubmit={save}>
          <div className="muted small">
            {slip.salaryNo} · {slip.monthLabel} · net {formatINR(slip.net)} · <b>due {formatINR(slip.balance)}</b>
          </div>
          <Field label="Amount" required error={amount && amount > slip.balance ? `At most ${formatINR(slip.balance)}` : m.fields.amount}>
            <MoneyInput value={amount} onChange={setAmount} autoFocus />
          </Field>
          <GroupField label="Paid by">
            <SettlementPicker value={pay} onChange={setPay} />
            <PaymentBalanceHint payment={payment} />
          </GroupField>
          <div className="form-grid cols-2">
            <Field label="Date" error={m.fields.date} hint={`On or after ${formatDate(slip.date)}`}>
              <DateInput value={date} onChange={setDate} min={slip.date} max={todayISO()} />
            </Field>
            <Field label="Remarks">
              <TextInput value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={200} placeholder="e.g. UPI ref no" />
            </Field>
          </div>
          {m.error && <Alert tone="red">{m.error}</Alert>}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}
