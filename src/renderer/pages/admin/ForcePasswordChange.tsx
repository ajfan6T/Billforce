import { useState } from 'react';
import { useNavigate } from 'react-router';
import { KeyRound } from 'lucide-react';
import { Alert, Button } from '../../components/ui';
import { Field, TextInput } from '../../components/forms';
import { useMutation } from '../../hooks';
import { useAuth } from '../../auth';
import { useToast } from '../../feedback';
import './admin.css';

/**
 * Shown instead of the app when the owner has reset this user's password (or
 * created the login with "choose your own password"): the user must pick a
 * new password before doing anything else.
 */
export function ForcePasswordChange() {
  const { session, refresh, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const m = useMutation('auth.changePassword');
  const toast = useToast();
  const navigate = useNavigate();
  const problem =
    !current ? 'Enter the password you just logged in with' : next.length < 4 ? 'New password: at least 4 characters' : next === current ? 'Choose a password different from the temporary one' : next !== confirm ? 'Passwords do not match' : null;
  const submit = async () => {
    if (problem) return;
    try {
      await m.run({ currentPassword: current, newPassword: next });
      toast.success('Password changed. Welcome!');
      navigate('/', { replace: true });
      await refresh();
    } catch {
      /* shown below */
    }
  };
  if (!session) return null;
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-icon">
          <KeyRound size={28} />
        </div>
        <div>
          <h1>Choose your own password</h1>
          <p className="muted force-pw-note">
            Hello {session.fullName}. Your login was set up with a temporary password. Choose a new password that only you know before you continue.
          </p>
        </div>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Temporary password" error={m.fields.currentPassword}>
            <TextInput type="password" autoFocus value={current} autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" hint="At least 4 characters" error={m.fields.newPassword}>
            <TextInput type="password" value={next} autoComplete="new-password" onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Confirm new password" error={confirm && next !== confirm ? 'Passwords do not match' : null}>
            <TextInput type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          {m.error && !m.fields.currentPassword && !m.fields.newPassword && <Alert tone="red">{m.error}</Alert>}
          <Button type="submit" variant="primary" size="lg" block loading={m.loading} disabled={!!problem}>
            Save password and continue
          </Button>
          {problem && (current || next || confirm) && <div className="field-hint center">{problem}</div>}
        </form>
        <button type="button" className="link-btn" onClick={() => void logout()}>
          Log out
        </button>
      </div>
    </div>
  );
}
