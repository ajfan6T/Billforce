import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button } from '../../components/ui';
import { DateInput, Field, FormGrid, MoneyInput, SegmentedControl, Select, TextArea, TextInput } from '../../components/forms';
import { Modal } from '../../components/modal';
import { useMutation, useQuery } from '../../hooks';
import { useToast } from '../../feedback';
import type { ApiOutput } from '../../api';
import { formatDate, todayISO } from '../../../shared/dates';
import { GroupField, WEEKDAYS } from './common';

type Employee = ApiOutput<'employees.get'>;

interface FormState {
  name: string;
  phone: string;
  designation: string;
  joinDate: string;
  salaryType: 'monthly' | 'daily';
  salaryAmount: number | null;
  weeklyOff: number | -1;
  address: string;
  idProof: string;
  bankDetails: string;
  notes: string;
  openingAdvance: number | null;
}

function initial(e?: Employee | null, name = ''): FormState {
  return {
    name: e?.name ?? name,
    phone: e?.phone ?? '',
    designation: e?.designation ?? '',
    joinDate: e ? (e.joinDate ?? '') : todayISO(),
    salaryType: e?.salaryType ?? 'monthly',
    salaryAmount: e ? e.salaryAmount : null,
    weeklyOff: e ? (e.weeklyOff ?? -1) : 0,
    address: e?.address ?? '',
    idProof: e?.idProof ?? '',
    bankDetails: e?.bankDetails ?? '',
    notes: e?.notes ?? '',
    openingAdvance: e ? (e.openingAdvance ?? null) : null,
  };
}

/** Add or edit an employee. Enter saves (outside the multi-line fields), Esc closes. */
export function EmployeeFormModal({
  open,
  employee,
  initialName,
  onClose,
  onSaved,
}: {
  open: boolean;
  employee?: Employee | null;
  initialName?: string;
  onClose: () => void;
  onSaved: (e: Employee) => void;
}) {
  const [f, setF] = useState<FormState>(() => initial(employee, initialName));
  const create = useMutation('employees.create');
  const update = useMutation('employees.update');
  const toast = useToast();
  const m = employee ? update : create;
  const info = useQuery('employees.formInfo', open && !employee ? undefined : null);

  useEffect(() => {
    if (open) {
      setF(initial(employee, initialName));
      create.reset();
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, employee?.id]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const problem = !f.name.trim() ? "Enter the employee's name" : f.salaryAmount === null ? `Enter the ${f.salaryType === 'monthly' ? 'monthly salary' : 'daily wage'}` : null;
  const booksStart = employee?.booksStartDate ?? info.data?.booksStartDate;
  const openingLocked = employee ? employee.openingLocked : !!info.data?.openingLocked;
  const showPay = employee ? employee.showPay : true;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (problem || m.loading) return;
    const input = {
      name: f.name.trim(),
      phone: f.phone.trim() || null,
      designation: f.designation.trim() || null,
      joinDate: f.joinDate || null,
      salaryType: f.salaryType,
      salaryAmount: f.salaryAmount ?? 0,
      weeklyOff: f.weeklyOff === -1 ? null : f.weeklyOff,
      address: f.address.trim() || null,
      idProof: f.idProof.trim() || null,
      bankDetails: f.bankDetails.trim() || null,
      notes: f.notes.trim() || null,
      openingAdvance: openingLocked ? undefined : (f.openingAdvance ?? 0),
    };
    try {
      const saved = employee ? await update.run({ ...input, id: employee.id }) : await create.run(input);
      toast.success(employee ? `Saved ${saved.name}` : `Added ${saved.name}`);
      onSaved(saved);
    } catch {
      /* shown in the form */
    }
  };

  const err = (k: string) => m.fields[k];

  return (
    <Modal
      open={open}
      title={employee ? `Edit ${employee.name}` : 'Add employee'}
      onClose={onClose}
      width={680}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={m.loading}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!!problem} onClick={() => void save()} title={problem ?? undefined}>
            {employee ? 'Save changes' : 'Add employee'}
          </Button>
        </>
      }
    >
      <form onSubmit={save} className="stack">
        <FormGrid cols={2}>
          <Field label="Name" required error={err('name')}>
            <TextInput autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Ramesh Kumar" maxLength={100} />
          </Field>
          <Field label="Phone" error={err('phone')}>
            <TextInput value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="98xxxxxxxx" inputMode="tel" maxLength={20} />
          </Field>
          <Field label="Designation / work" error={err('designation')}>
            <TextInput value={f.designation} onChange={(e) => set('designation', e.target.value)} placeholder="e.g. Salesman, Helper, Cook" maxLength={60} />
          </Field>
          <Field label="Joining date" error={err('joinDate')} hint={employee ? 'Attendance and salary start from this day' : 'For staff already working here, enter the day they first joined'}>
            <DateInput value={f.joinDate} onChange={(v) => set('joinDate', v)} />
          </Field>
        </FormGrid>

        {showPay && (
          <FormGrid cols={2}>
            <GroupField label="Paid by">
              <SegmentedControl<'monthly' | 'daily'>
                value={f.salaryType}
                onChange={(v) => set('salaryType', v)}
                options={[
                  { value: 'monthly', label: 'Monthly salary' },
                  { value: 'daily', label: 'Daily wages' },
                ]}
              />
            </GroupField>
            <Field
              label={f.salaryType === 'monthly' ? 'Salary per month' : 'Wage per day'}
              required
              error={err('salaryAmount')}
              hint={f.salaryType === 'monthly' ? 'Absent days are cut from this amount' : 'Paid for each day present or on paid leave'}
            >
              <MoneyInput value={f.salaryAmount} onChange={(v) => set('salaryAmount', v)} placeholder="0.00" />
            </Field>
          </FormGrid>
        )}

        <FormGrid cols={2}>
          <Field label="Weekly off" hint="Shaded on the attendance sheet; can be filled in automatically">
            <Select<number>
              value={f.weeklyOff}
              onChange={(v) => set('weeklyOff', v)}
              options={[{ value: -1, label: 'No fixed weekly off' }, ...WEEKDAYS.map((d, i) => ({ value: i, label: d }))]}
            />
          </Field>
          {showPay && (
            <Field
              label="Advance already given"
              error={err('openingAdvance')}
              hint={
                openingLocked
                  ? 'Cannot be changed: the first financial year is closed'
                  : `Advance still to be recovered on ${booksStart ? formatDate(booksStart) : 'the day your books start'}`
              }
            >
              <MoneyInput value={f.openingAdvance} onChange={(v) => set('openingAdvance', v)} placeholder="0.00" disabled={openingLocked} />
            </Field>
          )}
        </FormGrid>

        <FormGrid cols={2}>
          <Field label="ID proof" hint="Aadhaar / PAN / voter ID number" error={err('idProof')}>
            <TextInput value={f.idProof} onChange={(e) => set('idProof', e.target.value)} maxLength={120} />
          </Field>
          {showPay && (
            <Field label="Bank / UPI details" hint="For paying salary by bank or UPI" error={err('bankDetails')}>
              <TextInput value={f.bankDetails} onChange={(e) => set('bankDetails', e.target.value)} placeholder="A/c no, IFSC or UPI ID" maxLength={300} />
            </Field>
          )}
          <Field label="Address" error={err('address')}>
            <TextArea rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} maxLength={300} />
          </Field>
          <Field label="Notes" error={err('notes')}>
            <TextArea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} maxLength={500} />
          </Field>
        </FormGrid>
        {m.error && <Alert tone="red">{m.error}</Alert>}
        {/* Enter in a single-line field submits the form. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
