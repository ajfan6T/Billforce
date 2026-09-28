import { useState } from 'react';
import { Modal } from '../components/modal';
import { Button } from '../components/ui';
import { Field, TextInput } from '../components/forms';
import { useMutation } from '../hooks';
import { useToast } from '../feedback';

export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const m = useMutation('auth.changePassword');
  const toast = useToast();
  const mismatch = confirm.length > 0 && next !== confirm;
  const submit = async () => {
    try {
      await m.run({ currentPassword: current, newPassword: next });
      toast.success('Password changed');
      setCurrent('');
      setNext('');
      setConfirm('');
      onClose();
    } catch {
      /* shown below */
    }
  };
  return (
    <Modal
      open={open}
      title="Change password"
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!current || next.length < 4 || next !== confirm} onClick={submit}>
            Change password
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Current password" error={m.fields.currentPassword}>
          <TextInput type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
        </Field>
        <Field label="New password" hint="At least 4 characters" error={m.fields.newPassword}>
          <TextInput type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirm new password" error={mismatch ? 'Passwords do not match' : null}>
          <TextInput type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </Field>
        {m.error && !m.fields.currentPassword && !m.fields.newPassword && <div className="field-error">{m.error}</div>}
      </div>
    </Modal>
  );
}
