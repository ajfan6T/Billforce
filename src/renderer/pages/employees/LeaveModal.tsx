import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button } from '../../components/ui';
import { DateInput, Field } from '../../components/forms';
import { Modal } from '../../components/modal';
import { useMutation } from '../../hooks';
import { useToast } from '../../feedback';
import { formatDate, todayISO } from '../../../shared/dates';

/** Mark an employee as left, with their last working day. */
export function LeaveModal({
  open,
  employee,
  onClose,
  onSaved,
}: {
  open: boolean;
  employee: { id: number; name: string; joinDate: string | null };
  onClose: () => void;
  onSaved: () => void;
}) {
  const m = useMutation('employees.setActive');
  const toast = useToast();
  const [date, setDate] = useState(todayISO());

  useEffect(() => {
    if (open) {
      setDate(todayISO());
      m.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!date || m.loading) return;
    try {
      const res = await m.run({ id: employee.id, active: false, leaveDate: date });
      toast.success(`${employee.name} marked as left on ${formatDate(date)}`);
      for (const w of res.warnings) toast.warning(w);
      onSaved();
    } catch {
      /* shown below */
    }
  };

  return (
    <Modal
      open={open}
      title={`Mark ${employee.name} as left`}
      onClose={onClose}
      width={480}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={m.loading}>
            Cancel
          </Button>
          <Button variant="danger" loading={m.loading} disabled={!date} onClick={() => void save()}>
            Mark as left
          </Button>
        </>
      }
    >
      <form className="stack" onSubmit={save}>
        <p className="muted mt-0">
          {employee.name} will no longer appear on the attendance sheet after this day or in the employee pickers. Their salary slips, advances and history stay in your
          books. You can re-activate them later.
        </p>
        <Field label="Last working day" required error={m.fields.leaveDate} hint="Any attendance marked after this day is removed">
          <DateInput value={date} onChange={setDate} max={todayISO()} min={employee.joinDate ?? undefined} autoFocus />
        </Field>
        {m.error && <Alert tone="red">{m.error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
