import { useEffect, useState } from 'react';
import { Modal } from '../../components/modal';
import { Alert, Button } from '../../components/ui';
import { Field, FormGrid, MoneyInput, SegmentedControl, TextArea, TextInput } from '../../components/forms';
import { useMutation, useQuery } from '../../hooks';
import { useToast } from '../../feedback';
import { useAuth } from '../../auth';
import type { ApiOutput } from '../../api';
import { formatDate } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import { BoxField } from '../customers/common';

type SupplierDetail = ApiOutput<'suppliers.get'>;

interface FormState {
  name: string;
  phone: string;
  contactPerson: string;
  email: string;
  address: string;
  notes: string;
  openingAmount: number | null;
  openingDirection: 'payable' | 'advance';
}

function initial(s?: SupplierDetail | null, name?: string): FormState {
  return {
    name: s?.name ?? name ?? '',
    phone: s?.phone ?? '',
    contactPerson: s?.contactPerson ?? '',
    email: s?.email ?? '',
    address: s?.address ?? '',
    notes: s?.notes ?? '',
    openingAmount: s?.openingBalance?.amount ?? null,
    openingDirection: s?.openingBalance?.direction ?? 'payable',
  };
}

/**
 * Add or edit a supplier, including the opening balance. The opening balance is an accounting
 * entry, so it needs "Journals, capital, drawings, loans, transfers" (accounts.manage); without it
 * it is shown read-only and not sent.
 */
export function SupplierFormModal({
  open,
  supplier,
  initialName,
  onClose,
  onSaved,
}: {
  open: boolean;
  supplier?: SupplierDetail | null;
  initialName?: string;
  onClose: () => void;
  onSaved: (s: SupplierDetail) => void;
}) {
  const [f, setF] = useState<FormState>(() => initial(supplier, initialName));
  const info = useQuery('customers.formInfo', open ? undefined : null);
  const create = useMutation('suppliers.create');
  const update = useMutation('suppliers.update');
  const m = supplier ? update : create;
  const toast = useToast();
  const { can } = useAuth();
  const canOpening = can('accounts.manage');

  useEffect(() => {
    if (open) {
      setF(initial(supplier, initialName));
      create.reset();
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, supplier?.id]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const locked = !!info.data?.openingLocked;

  const save = async () => {
    if (!f.name.trim()) return;
    const payload = {
      name: f.name.trim(),
      phone: f.phone.trim() || null,
      contactPerson: f.contactPerson.trim() || null,
      email: f.email.trim() || null,
      address: f.address.trim() || null,
      notes: f.notes.trim() || null,
      // Left out = kept as saved (the server refuses changes without accounts.manage).
      ...(locked || !canOpening ? {} : { openingBalance: f.openingAmount ? { amount: f.openingAmount, direction: f.openingDirection } : null }),
    };
    try {
      const saved = supplier ? await update.run({ id: supplier.id, ...payload }) : await create.run(payload);
      toast.success(supplier ? `Saved changes to ${saved.name}` : `Added supplier ${saved.name}`);
      onSaved(saved);
    } catch {
      /* shown in the form */
    }
  };

  const fe = m.fields;
  return (
    <Modal
      open={open}
      title={supplier ? 'Edit supplier' : 'Add supplier'}
      onClose={onClose}
      width={620}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="supplier-form" loading={m.loading} disabled={!f.name.trim()}>
            {supplier ? 'Save changes' : 'Add supplier'}
          </Button>
        </>
      }
    >
      <form
        id="supplier-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <FormGrid>
          <Field label="Supplier / firm name" required error={fe.name}>
            <TextInput autoFocus value={f.name} maxLength={120} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Gupta Traders" />
          </Field>
          <Field label="Contact person">
            <TextInput value={f.contactPerson} maxLength={120} onChange={(e) => set('contactPerson', e.target.value)} />
          </Field>
          <Field label="Phone" error={fe.phone}>
            <TextInput value={f.phone} maxLength={20} inputMode="tel" onChange={(e) => set('phone', e.target.value)} placeholder="98xxxxxxxx" />
          </Field>
          <Field label="Email" error={fe.email}>
            <TextInput value={f.email} maxLength={120} type="email" onChange={(e) => set('email', e.target.value)} />
          </Field>
          <Field label="Address" className="span-all">
            <TextArea rows={2} value={f.address} maxLength={500} onChange={(e) => set('address', e.target.value)} />
          </Field>
        </FormGrid>
        <div className="section-title" style={{ margin: '4px 0 0' }}>
          Opening balance
        </div>
        {!canOpening ? (
          <Alert tone="neutral">
            {supplier?.openingBalance
              ? `Opening balance ${formatINR(supplier.openingBalance.amount)} ${supplier.openingBalance.direction === 'payable' ? 'payable' : 'advance paid'}. `
              : supplier
                ? 'No opening balance. '
                : ''}
            Only the owner or manager can set or change opening balances.
          </Alert>
        ) : locked ? (
          <Alert tone="neutral">The year your books started in is closed, so the opening balance can no longer be changed.</Alert>
        ) : (
          <FormGrid>
            <Field
              label="Amount"
              hint={info.data ? `Balance on ${formatDate(info.data.booksStartDate)}, when you started using Billforce` : undefined}
              error={fe.openingBalance}
            >
              <MoneyInput value={f.openingAmount} onChange={(v) => set('openingAmount', v)} placeholder="0.00" />
            </Field>
            <BoxField label="Type">
              <SegmentedControl
                value={f.openingDirection}
                onChange={(v) => set('openingDirection', v)}
                options={[
                  { value: 'payable', label: 'I owe the supplier' },
                  { value: 'advance', label: 'Advance paid' },
                ]}
              />
            </BoxField>
          </FormGrid>
        )}
        <Field label="Notes">
          <TextArea rows={2} value={f.notes} maxLength={1000} onChange={(e) => set('notes', e.target.value)} placeholder="Bank details, credit days, what they supply…" />
        </Field>
        {m.error && <Alert tone="red">{m.error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
