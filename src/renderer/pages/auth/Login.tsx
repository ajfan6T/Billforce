import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, UserCircle2 } from 'lucide-react';
import { Button, Alert } from '../../components/ui';
import { Field, TextInput } from '../../components/forms';
import { Modal } from '../../components/modal';
import { useMutation, useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { ROLE_LABELS, WRONG_LOGIN_MESSAGE } from '../../../shared/constants';

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

/**
 * Make everything on the page except `keep` inert (no focus, clicks or screen reader), including dialogs
 * that open later. Returns the function that undoes it.
 */
function isolate(keep: HTMLElement): () => void {
  const changed = new Map<Element, { inert: boolean; ariaHidden: string | null }>();
  const hide = (el: Element) => {
    if (el === keep || changed.has(el) || !(el instanceof HTMLElement) || el.tagName === 'SCRIPT') return;
    changed.set(el, { inert: el.inert, ariaHidden: el.getAttribute('aria-hidden') });
    el.inert = true;
    el.setAttribute('aria-hidden', 'true');
  };
  Array.from(document.body.children).forEach(hide);
  const observer = new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => n.parentNode === document.body && hide(n as Element))));
  observer.observe(document.body, { childList: true });
  return () => {
    observer.disconnect();
    changed.forEach((prev, el) => {
      (el as HTMLElement).inert = prev.inert;
      if (prev.ariaHidden === null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', prev.ariaHidden);
    });
  };
}

/**
 * Shown over the app after inactivity or "Lock screen": same user must re-enter the password.
 * The app underneath stays as it was but cannot be reached: it is inert, keyboard shortcuts are off
 * (useHotkeys checks the lock) and focus stays inside this card.
 */
export function LockScreen() {
  const { session, unlock, logout, refresh, lockReturnFocus } = useAuth();
  const [password, setPassword] = useState('');
  const m = useMutation('auth.login');
  const overlayRef = useRef<HTMLDivElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  // Where the user was when the screen locked. Read while rendering: by the time effects run, the password
  // box has taken the focus (autoFocus) and the page underneath has been made inert.
  const [before] = useState(() => {
    const given = lockReturnFocus();
    if (given?.isConnected) return given;
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const restore = isolate(overlay);
    const focusables = () => Array.from(overlay.querySelectorAll<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"])')).filter((el) => !(el as HTMLButtonElement).disabled);
    pwRef.current?.focus();
    // Tab cycles inside the card.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : i === list.length - 1 ? 0 : i + 1;
      e.preventDefault();
      list[next].focus();
    };
    // Keys typed in the card reach its own (React) handlers but never page-level window listeners.
    const onDocKey = (e: KeyboardEvent) => {
      if (overlay.contains(e.target as Node)) e.stopPropagation();
    };
    // Keys that start outside the card (e.g. after clicking the dark background) are swallowed.
    const onWindowKey = (e: KeyboardEvent) => {
      if (overlay.contains(e.target as Node)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      pwRef.current?.focus();
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!e.relatedTarget || !overlay.contains(e.relatedTarget as Node)) setTimeout(() => overlay.isConnected && !overlay.contains(document.activeElement) && pwRef.current?.focus(), 0);
    };
    overlay.addEventListener('keydown', onKey);
    overlay.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onDocKey);
    window.addEventListener('keydown', onWindowKey, true);
    return () => {
      overlay.removeEventListener('keydown', onKey);
      overlay.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onDocKey);
      window.removeEventListener('keydown', onWindowKey, true);
      restore();
      // Back to where the user was before the lock (after the page is no longer inert).
      setTimeout(() => before?.isConnected && before.focus?.(), 0);
    };
  }, [before]);

  if (!session) return null;
  const submit = async () => {
    try {
      await m.run({ username: session.username, password });
      await refresh();
      setPassword('');
      unlock();
    } catch {
      setPassword('');
      pwRef.current?.focus();
    }
  };
  // Only the password is asked here, so "Wrong username or password" would confuse; the lockout message stays.
  const error = m.error === WRONG_LOGIN_MESSAGE ? 'Wrong password. Try again.' : m.error;
  return createPortal(
    <div className="lock-overlay" ref={overlayRef} role="dialog" aria-modal="true" aria-labelledby="lock-title" onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <div className="auth-card">
        <div className="auth-icon">
          <Lock size={28} />
        </div>
        <h1 id="lock-title">Screen locked</h1>
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
            <TextInput ref={pwRef} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
          </Field>
          {error && <Alert tone="red">{error}</Alert>}
          <Button type="submit" variant="primary" size="lg" block loading={m.loading} disabled={!password}>
            Unlock
          </Button>
        </form>
        <button type="button" className="link-btn" onClick={() => void logout()}>
          Switch user
        </button>
      </div>
    </div>,
    document.body,
  );
}
