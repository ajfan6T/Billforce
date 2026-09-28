import { useEffect, useState } from 'react';
import { Modal } from '../../components/modal';
import { Alert, Button } from '../../components/ui';
import { Field, FormGrid, MoneyInput, SegmentedControl, TextArea, TextInput } from '../../components/forms';
import { useMutation, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { useToast } from '../../feedback';
import type { ApiOutput } from '../../api';
import { formatDate } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import { BoxField } from './common';

type CustomerDetail = ApiOutput<'customers.get'>;

interface FormState {
  name: string;
  phone: string;
  email: string;
  address: string;
  creditLimit: number | null;
  notes: string;
  openingAmount: number | null;
  openingDirection: 'receivable' | 'advance';
}

function initial(c?: CustomerDetail | null, name?: string): FormState {
  return {
    name: c?.name ?? name ?? '',
    phone: c?.phone ?? '',
    email: c?.email ?? '',
    address: c?.address ?? '',
    creditLimit: c?.creditLimit ?? null,
    notes: c?.notes ?? '',
    openingAmount: c?.openingBalance?.amount ?? null,
    openingDirection: c?.openingBalance?.direction ?? 'receivable',
  };
}

/**
 * Add or edit a customer, including the opening balance. The credit limit and opening balance need
 * "Set credit limits & opening balances" (customers.credit); without it they are shown read-only and not sent.
 */
export function CustomerFormModal({
  open,
  customer,
  initialName,
  onClose,
  onSaved,
}: {
  open: boolean;
  customer?: CustomerDetail | null;
  initialName?: string;
  onClose: () => void;
  onSaved: (c: CustomerDetail) => void;
}) {
  const [f, setF] = useState<FormState>(() => initial(customer, initialName));
  const info = useQuery('customers.formInfo', open ? undefined : null);
  const create = useMutation('customers.create');
  const update = useMutation('customers.update');
  const m = customer ? update : create;
  const toast = useToast();
  const { can } = useAuth();
  const canCredit = can('customers.credit');

  useEffect(() => {
    if (open) {
      setF(initial(customer, initialName));
      create.reset();
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, customer?.id]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const locked = !!info.data?.openingLocked;

  const save = async () => {
    if (!f.name.trim()) return;
    const payload = {
      name: f.name.trim(),
      phone: f.phone.trim() || null,
      email: f.email.trim() || null,
      address: f.address.trim() || null,
      notes: f.notes.trim() || null,
      // Left out = kept as saved (the server refuses changes without customers.credit).
      ...(canCredit ? { creditLimit: f.creditLimit } : {}),
      ...(locked || !canCredit ? {} : { openingBalance: f.openingAmount ? { amount: f.openingAmount, direction: f.openingDirection } : null }),
    };
    try {
      const saved = customer ? await update.run({ id: customer.id, ...payload }) : await create.run(payload);
      toast.success(customer ? `Saved changes to ${saved.name}` : `Added customer ${saved.name}`);
      onSaved(saved);
    } catch {
      /* shown in the form */
    }
  };

  const fe = m.fields;
  return (
    <Modal
      open={open}
      title={customer ? `Edit customer` : 'Add customer'}
      onClose={onClose}
      width={620}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="customer-form" loading={m.loading} disabled={!f.name.trim()}>
            {customer ? 'Save changes' : 'Add customer'}
          </Button>
        </>
      }
    >
      <form
        id="customer-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <FormGrid>
          <Field label="Name" required error={fe.name}>
            <TextInput autoFocus value={f.name} maxLength={120} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Anita Desai" />
          </Field>
          <Field label="Phone" error={fe.phone} hint="Used to find the customer while billing">
            <TextInput value={f.phone} maxLength={20} inputMode="tel" onChange={(e) => set('phone', e.target.value)} placeholder="98xxxxxxxx" />
          </Field>
          <Field label="Email" error={fe.email}>
            <TextInput value={f.email} maxLength={120} type="email" onChange={(e) => set('email', e.target.value)} />
          </Field>
          {canCredit ? (
            <Field label="Credit limit" hint="Leave blank for no limit" error={fe.creditLimit}>
              <MoneyInput value={f.creditLimit} onChange={(v) => set('creditLimit', v)} placeholder="No limit" />
            </Field>
          ) : (
            <BoxField label="Credit limit" hint="Only the owner or manager can set credit limits">
              <div className="readonly-date" aria-label="Credit limit">
                {customer?.creditLimit != null ? formatINR(customer.creditLimit) : 'No limit'}
              </div>
            </BoxField>
          )}
          <Field label="Address" className="span-all">
            <TextArea rows={2} value={f.address} maxLength={500} onChange={(e) => set('address', e.target.value)} />
          </Field>
        </FormGrid>
        <div className="section-title" style={{ margin: '4px 0 0' }}>
          Opening balance
        </div>
        {!canCredit ? (
          <Alert tone="neutral">
            {customer?.openingBalance
              ? `Opening balance ${formatINR(customer.openingBalance.amount)} ${customer.openingBalance.direction === 'receivable' ? 'due' : 'advance'}. `
              : customer
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
                  { value: 'receivable', label: 'Customer owes me' },
                  { value: 'advance', label: 'Advance from customer' },
                ]}
              />
            </BoxField>
          </FormGrid>
        )}
        <Field label="Notes">
          <TextArea rows={2} value={f.notes} maxLength={1000} onChange={(e) => set('notes', e.target.value)} placeholder="Anything to remember about this customer" />
        </Field>
        {m.error && <Alert tone="red">{m.error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
