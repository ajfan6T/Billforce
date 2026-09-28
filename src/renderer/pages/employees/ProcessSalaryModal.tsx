import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Info } from 'lucide-react';
import { Alert, Button, Loading } from '../../components/ui';
import { DateInput, Field, MoneyInput, Switch, TextInput } from '../../components/forms';
import { SettlementPicker } from '../../components/pickers';
import { Modal } from '../../components/modal';
import { useMutation, useQuery } from '../../hooks';
import { useToast } from '../../feedback';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, todayISO } from '../../../shared/dates';
import type { SettlementMode } from '../../../shared/constants';
import { AttendanceChips, MonthPicker, fmtDays, salaryLabel } from './common';

type Slip = ApiOutput<'salary.process'>;

/**
 * Work out and save one employee's salary for a month: shows the attendance
 * and the rule, takes bonus / deductions / advance recovery and can pay at once.
 */
export function ProcessSalaryModal({
  open,
  employeeId,
  month: initialMonth,
  onClose,
  onSaved,
}: {
  open: boolean;
  employeeId: number | null;
  month: string;
  onClose: () => void;
  onSaved: (slip: Slip) => void;
}) {
  const [month, setMonth] = useState(initialMonth);
  const preview = useQuery('salary.preview', open && employeeId ? { employeeId, month } : null);
  const m = useMutation('salary.process');
  const toast = useToast();
  const [bonus, setBonus] = useState<number | null>(null);
  const [deductions, setDeductions] = useState<number | null>(null);
  const [recovery, setRecovery] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [payNow, setPayNow] = useState(true);
  const [pay, setPay] = useState<{ mode: SettlementMode; accountId: number | null }>({ mode: 'cash', accountId: null });
  const [payAmount, setPayAmount] = useState<number | null>(null);
  const [payTouched, setPayTouched] = useState(false);
  const loadedFor = useRef<string | null>(null);
  const bonusRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setMonth(initialMonth);
      setBonus(null);
      setDeductions(null);
      setRemarks('');
      setPayNow(true);
      setPay({ mode: 'cash', accountId: null });
      setPayTouched(false);
      loadedFor.current = null;
      m.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialMonth, employeeId]);

  const p = preview.data;
  // Fill the suggested recovery and date whenever a new month / employee is loaded.
  useEffect(() => {
    if (!p) return;
    const key = `${p.employeeId}:${p.month}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    setRecovery(p.suggestedRecovery || null);
    setDate(p.defaultDate);
    setPayTouched(false);
    // The form appears once the preview has loaded: start typing in Bonus.
    setTimeout(() => bonusRef.current?.focus(), 30);
  }, [p]);

  const gross = p?.gross ?? 0;
  const net = gross + (bonus ?? 0) - (deductions ?? 0) - (recovery ?? 0);
  // Until the user types an amount, "pay now" follows the net salary (derived, so Enter right after typing a bonus is safe).
  const payNowAmount = payTouched ? payAmount : net > 0 ? net : null;

  const recoveryTooHigh = !!p && (recovery ?? 0) > Math.max(p.outstandingAdvance, 0);
  // "Nothing earned" can still be saved when a bonus is given; every other problem blocks.
  const blocking = !!p?.problemKind && p.problemKind !== 'zero';
  const expense = gross + (bonus ?? 0) - (deductions ?? 0);
  const problem = !p
    ? 'Loading…'
    : blocking
      ? p.problem
      : recoveryTooHigh
        ? `Only ${formatINR(p.outstandingAdvance)} advance is outstanding`
        : net < 0
          ? 'Deductions and recovery are more than the salary'
          : expense === 0
            ? (p.problem ?? 'Nothing to record')
            : payNow && net > 0 && (!payNowAmount || payNowAmount > net)
              ? `Pay between ₹0.01 and ${formatINR(net)}`
              : null;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!p || problem || m.loading) return;
    try {
      const slip = await m.run({
        employeeId: p.employeeId,
        month: p.month,
        date: date || null,
        bonus: bonus ?? 0,
        deductions: deductions ?? 0,
        advanceRecovery: recovery ?? 0,
        remarks: remarks.trim() || null,
        payNow: payNow && net > 0 && payNowAmount ? { mode: pay.mode, accountId: pay.accountId, amount: payNowAmount } : null,
      });
      toast.success(`Salary ${slip.salaryNo} saved for ${slip.employeeName}${slip.paid ? ` · paid ${formatINR(slip.paid)}` : ''}`);
      onSaved(slip);
    } catch {
      /* shown below */
    }
  };

  const partial = p && p.daysEmployed > 0 && p.daysEmployed < p.daysInMonth;

  return (
    <Modal
      open={open}
      title={p ? `Salary for ${p.employeeName}` : 'Process salary'}
      onClose={onClose}
      width={820}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={m.loading}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!!problem} title={problem ?? undefined} onClick={() => void save()}>
            {payNow && net > 0 && payNowAmount ? `Save & pay ${formatINR(payNowAmount)}` : 'Save salary'}
          </Button>
        </>
      }
    >
      <form onSubmit={save} className="stack">
        <div className="row-between">
          <MonthPicker value={month} onChange={setMonth} compact />
          {p && (
            <span className="muted small">
              {p.designation ? `${p.designation} · ` : ''}
              {salaryLabel(p.salaryType, p.rate)}
            </span>
          )}
        </div>
        {preview.error && <Alert tone="red">{preview.error}</Alert>}
        {!p && !preview.error && <Loading />}
        {p && (
          <>
            {p.problem && <Alert tone="amber">{p.problem}{p.problemKind === 'zero' ? ' You can still record a bonus.' : ''}</Alert>}
            <div className="process-grid">
              <div className="stack-sm">
                <div className="process-box">
                  <h4>Attendance in {p.monthLabel}</h4>
                  <AttendanceChips counts={p.counts} unmarkedLabel="Not marked" />
                  <table className="calc-table mt-1">
                    <tbody>
                      <tr>
                        <td>Days in month</td>
                        <td>{p.daysInMonth}</td>
                      </tr>
                      {partial && (
                        <tr>
                          <td>
                            Worked here {formatDate(p.employedFrom)} to {formatDate(p.employedTo)}
                          </td>
                          <td>{p.daysEmployed} days</td>
                        </tr>
                      )}
                      <tr>
                        <td>Paid days</td>
                        <td>
                          <b>{fmtDays(p.paidDays)}</b>
                        </td>
                      </tr>
                      <tr className="total">
                        <td>Salary earned</td>
                        <td className="money">{formatINR(p.gross)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <Alert tone="blue" icon={<Info size={16} className="emp-alert-icon" />}>
                  <div className="salary-rule">
                    {p.rule}
                    <div className="mt-1">
                      <b>{p.working}</b>
                    </div>
                  </div>
                </Alert>
              </div>
              <div className="stack-sm">
                <div className="form-grid cols-2">
                  <Field label="Bonus / extra" error={m.fields.bonus}>
                    <MoneyInput ref={bonusRef} value={bonus} onChange={setBonus} placeholder="0.00" />
                  </Field>
                  <Field label="Deductions" error={m.fields.deductions} hint="Fines, damages, other cuts">
                    <MoneyInput value={deductions} onChange={setDeductions} placeholder="0.00" />
                  </Field>
                </div>
                <Field
                  label="Recover from advance"
                  error={recoveryTooHigh ? `At most ${formatINR(Math.max(p.outstandingAdvance, 0))}` : m.fields.advanceRecovery}
                  hint={p.outstandingAdvance > 0 ? `Advance outstanding ${formatINR(p.outstandingAdvance)}` : 'No advance outstanding'}
                >
                  <MoneyInput value={recovery} onChange={setRecovery} placeholder="0.00" disabled={p.outstandingAdvance <= 0} />
                </Field>
                <div className={`net-line${net < 0 ? ' bad' : ''}`}>
                  <span>Net salary</span>
                  <span className="money">{formatINR(net)}</span>
                </div>
                <div className="form-grid cols-2">
                  <Field label="Salary date" error={m.fields.date} hint="Entered in the accounts on this day">
                    <DateInput value={date} onChange={setDate} min={`${p.month}-01`} max={todayISO()} />
                  </Field>
                  <Field label="Remarks">
                    <TextInput value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={300} placeholder="Optional" />
                  </Field>
                </div>
                <Switch checked={payNow && net > 0} disabled={net <= 0} onChange={setPayNow} label={net > 0 ? 'Pay now' : 'Nothing to pay now'} />
                {payNow && net > 0 && (
                  <div className="process-box stack-sm">
                    <SettlementPicker value={pay} onChange={setPay} size="sm" />
                    <Field label="Amount paid now" error={m.fields['payNow.amount']} hint={payNowAmount && payNowAmount < net ? `${formatINR(net - payNowAmount)} stays as salary due` : 'Full net salary'}>
                      <MoneyInput
                        value={payNowAmount}
                        onChange={(v) => {
                          setPayTouched(true);
                          setPayAmount(v);
                        }}
                      />
                    </Field>
                  </div>
                )}
              </div>
            </div>
            {m.error && <Alert tone="red">{m.error}</Alert>}
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
