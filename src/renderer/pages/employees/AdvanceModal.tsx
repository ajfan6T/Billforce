import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button } from '../../components/ui';
import { DateInput, Field, MoneyInput, TextInput } from '../../components/forms';
import { EmployeeSelect, SettlementPicker } from '../../components/pickers';
import { Modal } from '../../components/modal';
import { useMutation, useQuery } from '../../hooks';
import { useToast } from '../../feedback';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { GroupField } from './common';
import { PaymentBalanceHint, useShortfallConfirm } from '../accounts/PaymentBalance';
import { todayISO } from '../../../shared/dates';
import type { SettlementMode } from '../../../shared/constants';

/** Give an advance to an employee (recovered later from salary). */
export function AdvanceModal({
  open,
  employeeId: fixedEmployee,
  lockEmployee,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Pre-select the employee. */
  employeeId?: number | null;
  /** Do not allow choosing another employee (employee's own page). */
  lockEmployee?: boolean;
  onClose: () => void;
  onSaved: (a: ApiOutput<'advances.create'>) => void;
}) {
  const m = useMutation('advances.create');
  const toast = useToast();
  const [employeeId, setEmployeeId] = useState<number | null>(fixedEmployee ?? null);
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(todayISO());
  const [pay, setPay] = useState<{ mode: SettlementMode; accountId: number | null }>({ mode: 'cash', accountId: null });
  const [remarks, setRemarks] = useState('');
  const balance = useQuery('advances.outstanding', open && employeeId ? { employeeId } : null);

  useEffect(() => {
    if (open) {
      setEmployeeId(fixedEmployee ?? null);
      setAmount(null);
      setDate(todayISO());
      setPay({ mode: 'cash', accountId: null });
      setRemarks('');
      m.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fixedEmployee]);

  const problem = !employeeId ? 'Choose the employee' : !amount ? 'Enter the amount' : null;
  const payment = { mode: pay.mode, accountId: pay.accountId, amount, date };
  const confirmShortfall = useShortfallConfirm();

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (problem || m.loading) return;
    // Ask before cash / bank goes below zero, not only after the advance is saved.
    const accepted = await confirmShortfall(payment);
    if (!accepted) return;
    try {
      const a = await m.run({ employeeId: employeeId!, amount: amount!, date, mode: pay.mode, accountId: pay.accountId, remarks: remarks.trim() || null });
      toast.success(`Advance ${a.advanceNo} of ${formatINR(a.amount)} given to ${a.employeeName}`);
      for (const w of a.warnings) if (!accepted.includes(w)) toast.warning(w);
      onSaved(a);
    } catch {
      /* shown below */
    }
  };

  const b = balance.data;
  return (
    <Modal
      open={open}
      title="Give advance"
      onClose={onClose}
      width={500}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={m.loading}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!!problem} title={problem ?? undefined} onClick={() => void save()}>
            Give {amount ? formatINR(amount) : 'advance'}
          </Button>
        </>
      }
    >
      <form className="stack" onSubmit={save}>
        <Field
          label="Employee"
          required
          error={m.fields.employeeId}
          hint={b ? (b.outstanding > 0 ? `Advance already outstanding: ${formatINR(b.outstanding)}` : 'No advance outstanding') : undefined}
        >
          {lockEmployee && fixedEmployee ? (
            <div className="input" style={{ display: 'flex', alignItems: 'center' }}>
              {b?.name ?? '…'}
            </div>
          ) : (
            <EmployeeSelect value={employeeId} onChange={setEmployeeId} />
          )}
        </Field>
        <Field label="Amount" required error={m.fields.amount}>
          <MoneyInput value={amount} onChange={setAmount} autoFocus={!!fixedEmployee} placeholder="0.00" />
        </Field>
        <GroupField label="Paid by">
          <SettlementPicker value={pay} onChange={setPay} />
          <PaymentBalanceHint payment={payment} />
        </GroupField>
        <div className="form-grid cols-2">
          <Field label="Date" error={m.fields.date}>
            <DateInput value={date} onChange={setDate} max={todayISO()} />
          </Field>
          <Field label="Remarks">
            <TextInput value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={200} placeholder="e.g. Medical, festival" />
          </Field>
        </div>
        <div className="muted small">The advance is recovered from salary when you process it (you choose how much each month).</div>
        {m.error && <Alert tone="red">{m.error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
