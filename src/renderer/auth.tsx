import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { call, onAppEvent, type ApiOutput } from './api';
import type { Permission } from '../shared/permissions';

type Status = ApiOutput<'app.status'>;
export type SessionInfo = NonNullable<Status['session']>;

interface AuthApi {
  status: Status | null;
  session: SessionInfo | null;
  /** Does the logged-in user have this permission? */
  can: (p: Permission) => boolean;
  /** Any of these permissions. */
  canAny: (ps: Permission[]) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  /** Show the lock screen (keeps the user, asks for the password again). */
  lock: () => void;
  locked: boolean;
  unlock: () => void;
}

const AuthContext = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [locked, setLocked] = useState(false);

  const refresh = useCallback(async () => {
    const s = await call('app.status');
    setStatus(s);
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauth = () => void refresh();
    window.addEventListener('billforce:unauthenticated', onUnauth);
    const off = onAppEvent((e) => {
      if (e === 'database-replaced') window.location.reload();
    });
    return () => {
      window.removeEventListener('billforce:unauthenticated', onUnauth);
      off();
    };
  }, [refresh]);

  // Auto-lock after inactivity (Settings > Security).
  const minutes = status?.autoLockMinutes ?? 0;
  const hasSession = !!status?.session;
  useEffect(() => {
    if (!minutes || !hasSession) return;
    let last = Date.now();
    const bump = () => {
      last = Date.now();
    };
    const events = ['mousemove', 'keydown', 'mousedown', 'wheel'];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - last > minutes * 60_000) setLocked(true);
    }, 15_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(t);
    };
  }, [minutes, hasSession]);

  const api = useMemo<AuthApi>(() => {
    const session = status?.session ?? null;
    const perms = new Set(session?.permissions ?? []);
    const can = (p: Permission) => !!session && (session.role === 'owner' || perms.has(p));
    return {
      status,
      session,
      can,
      canAny: (ps) => ps.some(can),
      refresh,
      logout: async () => {
        await call('auth.logout');
        setLocked(false);
        await refresh();
      },
      lock: () => setLocked(true),
      locked,
      unlock: () => setLocked(false),
    };
  }, [status, locked, refresh]);

  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const a = useContext(AuthContext);
  if (!a) throw new Error('useAuth outside AuthProvider');
  return a;
}

/** Render children only if the user has the permission. */
export function Can({ perm, children, fallback = null }: { perm: Permission | Permission[]; children: ReactNode; fallback?: ReactNode }) {
  const { can, canAny } = useAuth();
  const ok = Array.isArray(perm) ? canAny(perm) : can(perm);
  return <>{ok ? children : fallback}</>;
}
