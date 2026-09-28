import { useEffect, useState } from 'react';
import { Modal } from '../../components/modal';
import { Alert, Button } from '../../components/ui';
import { Checkbox, Field, FormGrid, SegmentedControl, TextInput } from '../../components/forms';
import { useMutation } from '../../hooks';
import { useToast } from '../../feedback';
import { useAuth } from '../../auth';
import type { ApiOutput } from '../../api';
import { ROLE_LABELS, type Role } from '../../../shared/constants';
import { BoxField } from './common';

export type UserItem = ApiOutput<'users.list'>[number];

const USERNAME_RE = /^[A-Za-z0-9._-]{2,40}$/;

const ROLE_HINTS: Record<Role, string> = {
  owner: 'Everything, including users, settings and restore.',
  manager: 'Day-to-day running: billing, purchases, accounts, reports.',
  cashier: 'Billing counter: bills, returns and customer payments.',
};

function RolePicker({ value, onChange, disabled, allowOwner }: { value: Role; onChange: (r: Role) => void; disabled?: boolean; allowOwner: boolean }) {
  return (
    <BoxField label="Role" hint={ROLE_HINTS[value]}>
      <SegmentedControl<Role>
        value={value}
        onChange={onChange}
        options={(['owner', 'manager', 'cashier'] as Role[]).map((r) => ({
          value: r,
          label: ROLE_LABELS[r],
          disabled: disabled || (r === 'owner' && !allowOwner && value !== 'owner'),
          title: r === 'owner' && !allowOwner ? 'Only the owner can make someone an owner' : undefined,
        }))}
      />
    </BoxField>
  );
}

/** Add a login, or edit name / username / role of an existing one. */
export function UserFormModal({ open, user, onClose, onSaved }: { open: boolean; user: UserItem | null; onClose: () => void; onSaved: (u: UserItem) => void }) {
  const { session } = useAuth();
  const isOwner = session?.role === 'owner';
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('cashier');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [touchedUsername, setTouchedUsername] = useState(false);
  const create = useMutation('users.create');
  const update = useMutation('users.update');
  const m = user ? update : create;
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setFullName(user?.fullName ?? '');
    setUsername(user?.username ?? '');
    setRole(user?.role ?? 'cashier');
    setPassword('');
    setConfirm('');
    setMustChange(true);
    setTouchedUsername(!!user);
    create.reset();
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.id]);

  // Suggest a username from the first name while adding.
  const onName = (v: string) => {
    setFullName(v);
    if (!user && !touchedUsername) setUsername(v.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, '') ?? '');
  };

  const problem = !fullName.trim()
    ? 'Enter the full name'
    : !USERNAME_RE.test(username)
      ? 'Username: 2 to 40 letters, numbers, dot, dash or underscore'
      : !user && password.length < 4
        ? 'Password must be at least 4 characters'
        : !user && password !== confirm
          ? 'Passwords do not match'
          : null;

  const self = !!user?.isSelf;
  const editingOwnerAsManager = !!user && user.role === 'owner' && !isOwner;

  const save = async () => {
    if (problem) return;
    try {
      const saved = user
        ? await update.run({ id: user.id, fullName: fullName.trim(), username: username.trim(), role, isActive: user.isActive })
        : await create.run({ fullName: fullName.trim(), username: username.trim(), role, password, mustChangePassword: mustChange });
      toast.success(user ? `Saved ${saved.fullName}` : `Added ${ROLE_LABELS[saved.role]} login "${saved.username}"`);
      onSaved(saved);
    } catch {
      /* shown below */
    }
  };

  return (
    <Modal
      open={open}
      title={user ? `Edit ${user.fullName}` : 'Add user'}
      onClose={onClose}
      width={560}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="user-form" loading={m.loading} disabled={!!problem || editingOwnerAsManager}>
            {user ? 'Save changes' : 'Add user'}
          </Button>
        </>
      }
    >
      <form
        id="user-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {editingOwnerAsManager && <Alert tone="amber">Only the owner can change the owner's login.</Alert>}
        <FormGrid>
          <Field label="Full name" required error={m.fields.fullName}>
            <TextInput autoFocus value={fullName} maxLength={80} onChange={(e) => onName(e.target.value)} placeholder="e.g. Priya Patil" />
          </Field>
          <Field label="Username" required hint="Used to log in" error={m.fields.username}>
            <TextInput
              value={username}
              maxLength={40}
              autoComplete="off"
              onChange={(e) => {
                setTouchedUsername(true);
                setUsername(e.target.value.trim());
              }}
            />
          </Field>
        </FormGrid>
        <RolePicker value={role} onChange={setRole} disabled={self || editingOwnerAsManager} allowOwner={isOwner} />
        {self && <div className="field-hint">You cannot change your own role.</div>}
        {!user && (
          <>
            <FormGrid>
              <Field label="Password" required hint="At least 4 characters (a 4-digit PIN is fine)" error={m.fields.password}>
                <TextInput type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Field label="Confirm password" required error={confirm && password !== confirm ? 'Passwords do not match' : null}>
                <TextInput type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
              </Field>
            </FormGrid>
            <Checkbox checked={mustChange} onChange={setMustChange} label="Ask them to choose their own password when they first log in" />
          </>
        )}
        {m.error && <Alert tone="red">{m.error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Set a temporary password for someone who forgot theirs. */
export function ResetPasswordModal({ user, onClose, onDone }: { user: UserItem | null; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const m = useMutation('users.resetPassword');
  const toast = useToast();
  useEffect(() => {
    setPw('');
    setConfirm('');
    m.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  const ok = pw.length >= 4 && pw === confirm;
  const save = async () => {
    if (!user || !ok) return;
    try {
      await m.run({ id: user.id, newPassword: pw });
      toast.success(`New password set for ${user.fullName}. They will choose their own at next login.`);
      onDone();
    } catch {
      /* shown below */
    }
  };
  return (
    <Modal
      open={!!user}
      title={`Reset password${user ? ` - ${user.fullName}` : ''}`}
      onClose={onClose}
      width={440}
      locked={m.loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="reset-form" loading={m.loading} disabled={!ok}>
            Set new password
          </Button>
        </>
      }
    >
      <form
        id="reset-form"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="muted mt-0">
          Give <b>{user?.fullName}</b> this temporary password. When they log in with it, Billforce will ask them to choose a new one.
        </p>
        <Field label="Temporary password" hint="At least 4 characters" error={m.fields.newPassword}>
          <TextInput type="password" autoFocus value={pw} autoComplete="new-password" onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label="Confirm password" error={confirm && pw !== confirm ? 'Passwords do not match' : null}>
          <TextInput type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {m.error && !m.fields.newPassword && <Alert tone="red">{m.error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Owner only: replace the recovery code (after confirming the owner password). */
export function RecoveryCodeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const m = useMutation('auth.regenerateRecoveryCode');
  useEffect(() => {
    if (open) {
      setPw('');
      setCode(null);
      m.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const run = async () => {
    if (!pw) return;
    try {
      const res = await m.run({ password: pw });
      setCode(res.recoveryCode);
    } catch {
      /* shown below */
    }
  };
  return (
    <Modal
      open={open}
      title="New recovery code"
      onClose={onClose}
      width={480}
      locked={m.loading}
      footer={
        code ? (
          <Button variant="primary" onClick={onClose}>
            I have written it down
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="recovery-form" loading={m.loading} disabled={!pw}>
              Generate new code
            </Button>
          </>
        )
      }
    >
      {code ? (
        <div className="stack">
          <Alert tone="green" title="New recovery code created">
            The old code no longer works. Write this one down and keep it somewhere safe - it will not be shown again.
          </Alert>
          <div className="recovery-code">{code}</div>
        </div>
      ) : (
        <form
          id="recovery-form"
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <p className="muted mt-0">
            The recovery code lets you set a new owner password if you forget it. Generate a new one if the old code was lost or someone else may have seen it.
          </p>
          <Field label="Your password" hint="To confirm it is you" error={m.fields.password}>
            <TextInput type="password" autoFocus value={pw} autoComplete="current-password" onChange={(e) => setPw(e.target.value)} />
          </Field>
          {m.error && !m.fields.password && <Alert tone="red">{m.error}</Alert>}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}
