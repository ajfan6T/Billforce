import type { ReactNode } from 'react';
import { Badge, type Tone } from '../../components/ui';
import { ROLE_LABELS, type Role } from '../../../shared/constants';
import { formatDateTime, toTimestamp } from '../../../shared/dates';
import { formatIndianNumber } from '../../../shared/money';

export const ROLE_TONES: Record<Role, Tone> = { owner: 'purple', manager: 'blue', cashier: 'green' };

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={ROLE_TONES[role]}>{ROLE_LABELS[role]}</Badge>;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** 12345678 -> "11.8 MB" */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${formatIndianNumber(n / 1024, n < 10 * 1024 ? 1 : 0)} KB`;
  return `${formatIndianNumber(n / (1024 * 1024), 1)} MB`;
}

function tsToDate(ts: string): Date {
  const [d, t = '00:00:00'] = ts.split(' ');
  const [y, m, day] = d.split('-').map(Number);
  const [h, mi, s] = t.split(':').map(Number);
  return new Date(y, m - 1, day, h || 0, mi || 0, s || 0);
}

/** "5 minutes ago", "yesterday", "3 days ago" ... */
export function timeAgo(ts: string | null | undefined, nowTs: string = toTimestamp(new Date())): string {
  if (!ts) return '';
  const diff = (tsToDate(nowTs).getTime() - tsToDate(ts).getTime()) / 1000;
  if (diff < 0) return 'just now';
  if (diff < 60) return 'just now';
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(diff / 86400);
  if (days === 1) return 'yesterday';
  if (days < 45) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 18) return `${months} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

export function hoursSince(ts: string | null | undefined): number | null {
  if (!ts) return null;
  return (Date.now() - tsToDate(ts).getTime()) / 3_600_000;
}

export function WhenText({ ts }: { ts: string | null | undefined }) {
  if (!ts) return <span className="faint">Never</span>;
  return (
    <span title={formatDateTime(ts)}>
      {formatDateTime(ts)} <span className="muted small">({timeAgo(ts)})</span>
    </span>
  );
}

/** A labelled block for controls that are not plain inputs (segmented controls, switches). */
export function BoxField({ label, hint, children, className = '' }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`field box-field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** One row of a settings list: title + explanation on the left, control on the right. */
export function SwitchRow({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="switch-row">
      <div className="switch-row-text">
        <div className="switch-row-title">{title}</div>
        {hint && <div className="switch-row-hint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
