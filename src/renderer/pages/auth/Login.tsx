import { useEffect, useRef, useState } from 'react';
import { Lock, UserCircle2 } from 'lucide-react';
import { Button, Alert } from '../../components/ui';
import { Field, TextInput } from '../../components/forms';
import { Modal } from '../../components/modal';
import { useMutation, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { ROLE_LABELS } from '../../../shared/constants';

function RecoveryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [result, setResult] = useState<{ username: string; recoveryCode: string } | null>(null);
  const m = useMutation('auth.recover');
  return (
    <Modal
      open={open}
      title="Reset owner password"
      onClose={() => (setResult(null), onClose())}
      width={460}
      footer={
        result ? (
          <Button variant="primary" onClick={() => (setResult(null), onClose())}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={m.loading} disabled={!code || pw.length < 4} onClick={async () => setResult(await m.run({ recoveryCode: code, newPassword: pw }).catch(() => null))}>
              Reset password
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="stack">
          <Alert tone="green" title="Password changed">
            Log in as <b>{result.username}</b> with your new password.
          </Alert>
          <p>Your old recovery code no longer works. Write down the new one:</p>
          <div className="recovery-code">{result.recoveryCode}</div>
        </div>
      ) : (
        <div className="stack">
          <p className="muted">Enter the recovery code you wrote down when Billforce was set up.</p>
          <Field label="Recovery code" error={m.fields.recoveryCode}>
            <TextInput value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" autoFocus />
          </Field>
          <Field label="New owner password" hint="At least 4 characters" error={m.fields.newPassword}>
            <TextInput type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          {m.error && !m.fields.recoveryCode && <Alert tone="red">{m.error}</Alert>}
        </div>
      )}
    </Modal>
  );
}

export function LoginScreen() {
  const { status, refresh } = useAuth();
  const users = useQuery('auth.loginUsers', undefined);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [recover, setRecover] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null);
  const m = useMutation('auth.login');

  useEffect(() => {
    if (users.data?.length === 1 && !username) setUsername(users.data[0].username);
  }, [users.data, username]);

  const submit = async () => {
    try {
      await m.run({ username, password });
      await refresh();
    } catch {
      setPassword('');
      pwRef.current?.focus();
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="setup-brand center">
          <div className="brand-mark big">₹</div>
          <div>
            <h1>{status?.businessName || 'Billforce'}</h1>
            <p className="muted">Log in to continue</p>
          </div>
        </div>
        {(users.data?.length ?? 0) > 1 && (
          <div className="user-tiles">
            {users.data!.map((u) => (
              <button
                key={u.username}
                type="button"
                className={`user-tile${u.username === username ? ' active' : ''}`}
                onClick={() => {
                  setUsername(u.username);
                  setTimeout(() => pwRef.current?.focus(), 0);
                }}
              >
                <UserCircle2 size={26} />
                <span className="ut-name">{u.fullName}</span>
                <span className="ut-role">{ROLE_LABELS[u.role]}</span>
              </button>
            ))}
          </div>
        )}
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Username">
            <TextInput value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={!username} autoComplete="username" />
          </Field>
          <Field label="Password">
            <TextInput ref={pwRef} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!username} autoComplete="current-password" />
          </Field>
          {m.error && <Alert tone="red">{m.error}</Alert>}
          <Button type="submit" variant="primary" size="lg" block loading={m.loading} disabled={!username || !password} icon={<Lock size={16} />}>
            Log in
          </Button>
        </form>
        <button type="button" className="link-btn" onClick={() => setRecover(true)}>
          Forgot the owner password?
        </button>
      </div>
      <RecoveryModal open={recover} onClose={() => setRecover(false)} />
    </div>
  );
}

/** Shown over the app after inactivity or "Lock screen": same user must re-enter the password. */
export function LockScreen() {
  const { session, unlock, logout, refresh } = useAuth();
  const [password, setPassword] = useState('');
  const m = useMutation('auth.login');
  if (!session) return null;
  const submit = async () => {
    try {
      await m.run({ username: session.username, password });
      await refresh();
      setPassword('');
      unlock();
    } catch {
      setPassword('');
    }
  };
  return (
    <div className="lock-overlay">
      <div className="auth-card">
        <div className="auth-icon">
          <Lock size={28} />
        </div>
        <h1>Screen locked</h1>
        <p className="muted">
          {session.fullName} ({ROLE_LABELS[session.role]})
        </p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Password">
            <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </Field>
          {m.error && <Alert tone="red">{m.error}</Alert>}
          <Button type="submit" variant="primary" size="lg" block loading={m.loading} disabled={!password}>
            Unlock
          </Button>
        </form>
        <button type="button" className="link-btn" onClick={() => void logout()}>
          Switch user
        </button>
      </div>
    </div>
  );
}
