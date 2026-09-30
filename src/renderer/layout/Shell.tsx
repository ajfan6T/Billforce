import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { ChevronDown, KeyRound, Lock, LogOut, Plus, UserCircle2 } from 'lucide-react';
import { NAV, NEW_BILL_PATH, type NavGroup } from '../nav';
import { useAuth, useFeatures } from '../auth';
import { useHotkeys } from '../hooks';
import { confirmLeave, useGuardedNavigate } from '../guards';
import { ROLE_LABELS } from '../../shared/constants';
import { fyOf, formatDateLong, todayISO } from '../../shared/dates';
import { ChangePasswordModal } from './ChangePassword';
import type { Permission } from '../../shared/permissions';

function allowed(can: (p: Permission) => boolean, perm?: Permission | Permission[]): boolean {
  if (!perm) return true;
  return Array.isArray(perm) ? perm.some(can) : can(perm);
}

function Sidebar() {
  const { can } = useAuth();
  const features = useFeatures();
  const location = useLocation();
  const { onLinkClick } = useGuardedNavigate();
  const groups = useMemo(
    () =>
      NAV.map((g) => ({ ...g, items: g.items?.filter((i) => allowed(can, i.perm) && (!i.feature || i.feature(features))) }))
        .filter((g) => allowed(can, g.perm) && (!g.feature || g.feature(features)))
        .filter((g) => g.to || (g.items && g.items.length)),
    [can, features],
  );
  const activeGroup = groups.find((g) => g.items?.some((i) => location.pathname === i.to || (i.to !== '/' && location.pathname.startsWith(i.to + '/'))))?.key;
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('bf:nav-open') ?? '{}');
    } catch {
      return {};
    }
  });
  useEffect(() => {
    if (activeGroup && !open[activeGroup]) setOpen((o) => ({ ...o, [activeGroup]: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroup]);
  useEffect(() => {
    localStorage.setItem('bf:nav-open', JSON.stringify(open));
  }, [open]);

  const renderGroup = (g: NavGroup) => {
    const Icon = g.icon;
    if (g.to) {
      return (
        <NavLink key={g.key} to={g.to} end className={({ isActive }) => `nav-top${isActive ? ' active' : ''}`} onClick={onLinkClick(g.to)}>
          <span className="nav-ic">
            <Icon size={17} />
          </span>
          <span>{g.label}</span>
        </NavLink>
      );
    }
    const isOpen = !!open[g.key];
    return (
      <div key={g.key} className={`nav-group${activeGroup === g.key ? ' has-active' : ''}`}>
        <button type="button" className="nav-top" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [g.key]: !isOpen }))}>
          <span className="nav-ic">
            <Icon size={17} />
          </span>
          <span>{g.label}</span>
          <ChevronDown size={15} className={`chev${isOpen ? ' open' : ''}`} />
        </button>
        {isOpen && (
          <div className="nav-items">
            {g.items!.map((i) => (
              <NavLink key={i.to} to={i.to} end className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} onClick={onLinkClick(i.to)}>
                {i.label}
              </NavLink>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">₹</div>
        <div className="brand-name">Billforce</div>
      </div>
      {can('billing.create') && (
        <NavLink to={NEW_BILL_PATH} className="new-bill-btn" onClick={onLinkClick(NEW_BILL_PATH)}>
          <Plus size={18} />
          <span>New bill</span>
          <kbd>F2</kbd>
        </NavLink>
      )}
      <nav className="nav">{groups.map(renderGroup)}</nav>
    </aside>
  );
}

function UserMenu() {
  const { session, logout, lock } = useAuth();
  const [open, setOpen] = useState(false);
  const [changePw, setChangePw] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Where the user was before reaching for this menu: "Lock screen" returns there after unlocking
  // (the menu item itself is gone by then).
  const cameFrom = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  if (!session) return null;
  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-btn"
        onFocus={(e) => {
          const from = e.relatedTarget;
          if (from instanceof HTMLElement && !ref.current?.contains(from)) cameFrom.current = from;
        }}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <UserCircle2 size={20} />
        <span className="user-name">{session.fullName}</span>
        <span className="user-role">{ROLE_LABELS[session.role]}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => (setOpen(false), setChangePw(true))}>
            <KeyRound size={15} /> Change password
          </button>
          <button role="menuitem" onClick={() => (setOpen(false), lock(cameFrom.current))}>
            <Lock size={15} /> Lock screen
          </button>
          <button role="menuitem" onClick={() => (setOpen(false), void confirmLeave().then((ok) => (ok ? logout() : undefined)))}>
            <LogOut size={15} /> Log out / switch user
          </button>
        </div>
      )}
      <ChangePasswordModal open={changePw} onClose={() => setChangePw(false)} />
    </div>
  );
}

export function Shell({ children, fullBleed }: { children: ReactNode; fullBleed?: boolean }) {
  const { status, can } = useAuth();
  const { go } = useGuardedNavigate();
  const today = todayISO();
  useHotkeys({
    F2: () => can('billing.create') && void go(NEW_BILL_PATH),
  });
  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <span className="biz-name">{status?.businessName}</span>
          </div>
          <div className="topbar-right">
            <span className="today">{formatDateLong(today)}</span>
            <span className="fy-badge" title="Current financial year">
              FY {fyOf(today).name}
            </span>
            <UserMenu />
          </div>
        </header>
        <main className={`content${fullBleed ? ' full-bleed' : ''}`}>{children}</main>
      </div>
    </div>
  );
}
