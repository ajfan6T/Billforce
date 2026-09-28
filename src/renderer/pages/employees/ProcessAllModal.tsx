import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Alert, Button } from '../../components/ui';
import { Checkbox, DateInput, Field, Switch } from '../../components/forms';
import { SettlementPicker } from '../../components/pickers';
import { Modal } from '../../components/modal';
import { useMutation, useQuery } from '../../hooks';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate, todayISO } from '../../../shared/dates';
import type { SettlementMode } from '../../../shared/constants';

type Sheet = ApiOutput<'salary.monthSheet'>;
type Result = ApiOutput<'salary.processAll'>;

/** Names for a sentence: "Arjun, Deepak and 5 more". */
function nameList(names: string[], max = 8): string {
  if (names.length <= max) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** Process every employee whose salary for the month is not yet saved. */
export function ProcessAllModal({ open, sheet: pageSheet, onClose, onDone }: { open: boolean; sheet: Sheet | undefined; onClose: () => void; onDone: () => void }) {
  const m = useMutation('salary.processAll');
  const [date, setDate] = useState('');
  const [recover, setRecover] = useState(true);
  // Employees with no attendance would be paid for the whole month: only when the owner says so.
  const [includeUnmarked, setIncludeUnmarked] = useState(false);
  const [payNow, setPayNow] = useState(false);
  const [pay, setPay] = useState<{ mode: SettlementMode; accountId: number | null }>({ mode: 'cash', accountId: null });
  const [result, setResult] = useState<Result | null>(null);
  // Only the advance outstanding on the salary date can be recovered, so the figures follow the chosen date.
  const live = useQuery('salary.monthSheet', open && pageSheet ? { month: pageSheet.month, date: date || null } : null);
  const sheet = live.data && live.data.month === pageSheet?.month ? live.data : pageSheet;

  useEffect(() => {
    if (open && pageSheet) {
      setDate(pageSheet.defaultDate);
      setRecover(true);
      setIncludeUnmarked(false);
      setPayNow(false);
      setPay({ mode: 'cash', accountId: null });
      setResult(null);
      m.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageSheet?.month]);

  const waiting = live.loading || (!!sheet && !!date && sheet.date !== date);
  const remaining = (sheet?.rows ?? []).filter((r) => !r.slip && !r.problem);
  const unmarked = remaining.filter((r) => r.noAttendance);
  const pending = includeUnmarked ? remaining : remaining.filter((r) => !r.noAttendance);
  const gross = pending.reduce((s, r) => s + r.gross, 0);
  const recovery = recover ? pending.reduce((s, r) => s + r.suggestedRecovery, 0) : 0;
  const net = gross - recovery;
  const unmarkedGross = unmarked.reduce((s, r) => s + r.gross, 0);
  const skippedUnmarked = includeUnmarked ? 0 : unmarked.length;

  const run = async () => {
    if (!sheet || waiting || !pending.length) return;
    try {
      const res = await m.run({
        month: sheet.month,
        date: date || null,
        recoverAdvances: recover,
        includeUnmarked,
        payNow: payNow ? { mode: pay.mode, accountId: pay.accountId } : null,
      });
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
        width={560}
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
          {result.warnings.map((w) => (
            <Alert key={w} tone="amber" icon={<AlertTriangle size={18} className="emp-alert-icon" />}>
              {w}
            </Alert>
          ))}
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

  const them = unmarked.length === 1 ? 'this employee' : `these ${unmarked.length} employees`;
  return (
    <Modal
      open={open}
      title={sheet ? `Process all salaries · ${sheet.monthLabel}` : 'Process all salaries'}
      onClose={onClose}
      width={600}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={m.loading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={m.loading}
            disabled={!pending.length || waiting}
            title={!pending.length ? 'Nobody to process' : waiting ? 'Working out the salaries for this date…' : undefined}
            onClick={() => void run()}
          >
            Save {pending.length} salar{pending.length === 1 ? 'y' : 'ies'}
            {payNow && net > 0 ? ` & pay ${formatINR(net)}` : ''}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted mt-0">
          Salaries are worked out from attendance with no bonus or deductions. To add a bonus or deduction for someone, process that employee on their own first.
        </p>
        {unmarked.length > 0 && (
          <Alert tone="amber" icon={<AlertTriangle size={18} className="emp-alert-icon" />} title={`No attendance marked for ${unmarked.length} employee${unmarked.length === 1 ? '' : 's'} in ${sheet?.monthLabel}`}>
            <div className="stack-sm">
              <div>
                {nameList(unmarked.map((r) => r.employeeName))}. Monthly salary pays every day that is not marked, so {them} would get a full month&apos;s salary (
                {formatINR(unmarkedGross)}). If you forgot to mark attendance, mark it first and process them later.
              </div>
              <Checkbox
                checked={includeUnmarked}
                onChange={setIncludeUnmarked}
                label={`Yes, pay ${them} for the full month`}
                hint={includeUnmarked ? undefined : `Left unticked, ${them} ${unmarked.length === 1 ? 'is' : 'are'} skipped.`}
              />
            </div>
          </Alert>
        )}
        <table className="calc-table">
          <tbody>
            <tr>
              <td>Employees</td>
              <td>{pending.length}</td>
            </tr>
            {skippedUnmarked > 0 && (
              <tr className="sub">
                <td>Skipped: no attendance marked</td>
                <td>{skippedUnmarked}</td>
              </tr>
            )}
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
        <Checkbox
          checked={recover}
          onChange={setRecover}
          label="Recover outstanding advances"
          hint={`Advance outstanding on ${date ? formatDate(date) : 'the salary date'}, up to each employee's salary for the month`}
        />
        <Field label="Salary date" hint="Entered in the accounts on this day">
          <DateInput value={date} onChange={setDate} min={sheet ? `${sheet.month}-01` : undefined} max={todayISO()} />
        </Field>
        <Switch checked={payNow} onChange={setPayNow} label="Pay everyone in full now" />
        {payNow && <SettlementPicker value={pay} onChange={setPay} />}
        {live.error && <Alert tone="red">{live.error}</Alert>}
        {m.error && <Alert tone="red">{m.error}</Alert>}
      </div>
    </Modal>
  );
}
