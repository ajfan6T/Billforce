import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Alert, Button } from '../../components/ui';
import { Checkbox, DateInput, Field, Switch } from '../../components/forms';
import { SettlementPicker } from '../../components/pickers';
import { Modal } from '../../components/modal';
import { useMutation } from '../../hooks';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { todayISO } from '../../../shared/dates';
import type { SettlementMode } from '../../../shared/constants';

type Sheet = ApiOutput<'salary.monthSheet'>;
type Result = ApiOutput<'salary.processAll'>;

/** Process every employee whose salary for the month is not yet saved. */
export function ProcessAllModal({ open, sheet, onClose, onDone }: { open: boolean; sheet: Sheet | undefined; onClose: () => void; onDone: () => void }) {
  const m = useMutation('salary.processAll');
  const [date, setDate] = useState('');
  const [recover, setRecover] = useState(true);
  const [payNow, setPayNow] = useState(true);
  const [pay, setPay] = useState<{ mode: SettlementMode; accountId: number | null }>({ mode: 'cash', accountId: null });
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (open && sheet) {
      setDate(sheet.defaultDate);
      setRecover(true);
      setPayNow(true);
      setResult(null);
      m.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheet?.month]);

  const pending = (sheet?.rows ?? []).filter((r) => !r.slip && !r.problem);
  const gross = pending.reduce((s, r) => s + r.gross, 0);
  const recovery = recover ? pending.reduce((s, r) => s + r.suggestedRecovery, 0) : 0;
  const net = gross - recovery;

  const run = async () => {
    if (!sheet) return;
    try {
      const res = await m.run({ month: sheet.month, date: date || null, recoverAdvances: recover, payNow: payNow ? { mode: pay.mode, accountId: pay.accountId } : null });
      setResult(res);
      onDone();
    } catch {
      /* shown below */
    }
  };

  if (result) {
    return (
      <Modal
        open={open}
        title="Salaries saved"
        onClose={onClose}
        width={520}
        footer={
          <Button variant="primary" onClick={onClose} autoFocus>
            Done
          </Button>
        }
      >
        <div className="stack">
          <Alert tone="green" icon={<CheckCircle2 size={18} className="emp-alert-icon" />} title={`${result.processed.length} salar${result.processed.length === 1 ? 'y' : 'ies'} saved`}>
            Net salary {formatINR(result.totalNet)}
            {result.totalPaid ? `, paid ${formatINR(result.totalPaid)}` : ', not paid yet'}.
          </Alert>
          {result.skipped.length > 0 && (
            <Alert tone="amber" title={`${result.skipped.length} skipped`}>
              <ul className="skip-list">
                {result.skipped.map((s) => (
                  <li key={s.employeeId}>
                    <b>{s.name}</b>: {s.reason}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      title={sheet ? `Process all salaries · ${sheet.monthLabel}` : 'Process all salaries'}
      onClose={onClose}
      width={560}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={m.loading}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!pending.length} onClick={() => void run()}>
            Save {pending.length} salar{pending.length === 1 ? 'y' : 'ies'}
            {payNow ? ' & pay' : ''}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted mt-0">
          Salaries are worked out from attendance with no bonus or deductions. To add a bonus or deduction for someone, process that employee on their own first.
        </p>
        <table className="calc-table">
          <tbody>
            <tr>
              <td>Employees</td>
              <td>{pending.length}</td>
            </tr>
            <tr>
              <td>Salary earned</td>
              <td className="money">{formatINR(gross)}</td>
            </tr>
            {recover && recovery > 0 && (
              <tr className="sub">
                <td>Less: advance recovered</td>
                <td className="money">-{formatINR(recovery)}</td>
              </tr>
            )}
            <tr className="total">
              <td>Net salary</td>
              <td className="money">{formatINR(net)}</td>
            </tr>
          </tbody>
        </table>
        <Checkbox checked={recover} onChange={setRecover} label="Recover outstanding advances" hint="Up to each employee's salary for the month" />
        <Field label="Salary date" hint="Entered in the accounts on this day">
          <DateInput value={date} onChange={setDate} min={sheet ? `${sheet.month}-01` : undefined} max={todayISO()} />
        </Field>
        <Switch checked={payNow} onChange={setPayNow} label="Pay everyone in full now" />
        {payNow && <SettlementPicker value={pay} onChange={setPay} />}
        {m.error && <Alert tone="red">{m.error}</Alert>}
      </div>
    </Modal>
  );
}
