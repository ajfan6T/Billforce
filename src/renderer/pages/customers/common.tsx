/**
 * UI pieces shared by the customer, supplier, purchase and payment pages.
 */
import { useState, type ReactNode } from 'react';
import { rangeFromPreset, type RangeValue } from '../../components/report';
import { Badge } from '../../components/ui';
import { formatINR } from '../../../shared/money';
import { formatDate, formatDateTime, type DatePreset } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS } from '../../../shared/constants';
import type { ReportColumn, ReportData, ReportRow } from '../../../shared/report';
import './parties.css';

/** Customer balance: + = due (red), - = advance (green). */
export function BalanceText({ value, zero = 'Settled' }: { value: number; zero?: string }) {
  if (value > 0) return <span className="bal-due money">Due {formatINR(value)}</span>;
  if (value < 0) return <span className="bal-adv money">Advance {formatINR(-value)}</span>;
  return <span className="bal-nil">{zero}</span>;
}

/** Supplier balance: + = you owe (red), - = advance paid (green). */
export function PayableText({ value, zero = 'Nothing payable' }: { value: number; zero?: string }) {
  if (value > 0) return <span className="bal-due money">Payable {formatINR(value)}</span>;
  if (value < 0) return <span className="bal-adv money">Advance {formatINR(-value)}</span>;
  return <span className="bal-nil">{zero}</span>;
}

/** Payment mode badge. Pass `credit` for bills: a 'split' bill with an amount left on credit reads "Part paid". */
export function ModeBadge({ mode, credit = 0 }: { mode: string; credit?: number }) {
  const tone = mode === 'cash' ? 'green' : mode === 'upi' ? 'purple' : mode === 'bank' ? 'blue' : mode === 'credit' ? 'amber' : 'neutral';
  const label = mode === 'split' ? (credit > 0 ? 'Part paid' : 'Split') : (PAYMENT_MODE_LABELS as Record<string, string>)[mode] ?? mode;
  return <Badge tone={tone}>{label}</Badge>;
}

export function CancelledBadge() {
  return <Badge tone="red">Cancelled</Badge>;
}

export function InactiveBadge() {
  return <Badge tone="neutral">Inactive</Badge>;
}

/* ------------------------------ Accounting entry ------------------------------ */

export interface PostingLineView {
  account: string;
  party: string | null;
  debit: number;
  credit: number;
}

/** "How this was recorded in your accounts" table. */
export function PostingTable({ lines, voided }: { lines: PostingLineView[]; voided?: boolean }) {
  if (!lines.length) return <div className="muted small">No accounting entry.</div>;
  return (
    <>
      <table className="posting-table">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className={voided ? 'status-cancelled' : ''}>
              <td>
                {l.account}
                {l.party && <span className="party-sub"> · {l.party}</span>}
              </td>
              <td className="num money">{l.debit ? formatINR(l.debit) : ''}</td>
              <td className="num money">{l.credit ? formatINR(l.credit) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {voided && <div className="posting-note">This entry was reversed when the document was cancelled. It no longer affects any balance.</div>}
    </>
  );
}

/* ------------------------------ Revision history ------------------------------ */

export interface RevisionView {
  revision: number;
  action: string;
  snapshot: unknown;
  reason: string | null;
  username: string | null;
  at: string;
}

export interface DiffField {
  key: string;
  label: string;
  format?: (v: any, snap: any) => string;
}

/** "1 payment", "2 payments": a count with the right singular / plural word. */
export const countText = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const fmtMoney = (v: any) => formatINR(Number(v ?? 0));
export const fmtDate = (v: any) => (v ? formatDate(String(v)) : '—');
export const fmtText = (v: any) => (v === null || v === undefined || v === '' ? '—' : String(v));
export const fmtMode = (v: any, credit = 0) => (v === 'split' ? (credit > 0 ? 'Part paid' : 'Split') : ((PAYMENT_MODE_LABELS as Record<string, string>)[v] ?? String(v)));

function changes(prev: any, next: any, fields: DiffField[]): string[] {
  if (!prev || !next) return [];
  const out: string[] = [];
  for (const f of fields) {
    const fmt = f.format ?? fmtText;
    const a = fmt(prev[f.key], prev);
    const b = fmt(next[f.key], next);
    if (a !== b) out.push(`${f.label}: ${a} → ${b}`);
  }
  return out;
}

const ACTION_LABELS: Record<string, string> = { created: 'Created', edited: 'Edited', cancelled: 'Cancelled', restored: 'Restored' };

/** Timeline of every revision: who, when, why, and what changed from the previous version. */
export function RevisionHistory({ revisions, fields }: { revisions: RevisionView[]; fields: DiffField[] }) {
  if (!revisions.length) return <div className="muted small">No history recorded.</div>;
  return (
    <ol className="rev-list">
      {[...revisions].reverse().map((r) => {
        const prev = revisions.find((x) => x.revision === r.revision - 1);
        const diff = r.action === 'edited' ? changes(prev?.snapshot, r.snapshot, fields) : [];
        return (
          <li key={r.revision} className="rev-item">
            <span className={`rev-dot ${r.action}`} />
            <div className="rev-title">
              {ACTION_LABELS[r.action] ?? r.action} <span className="faint small">· version {r.revision}</span>
            </div>
            <div className="rev-meta">
              {r.username ?? 'system'} · {formatDateTime(r.at)}
            </div>
            {r.reason && (
              <div className="rev-reason">
                <b>Reason:</b> {r.reason}
              </div>
            )}
            {diff.length > 0 && (
              <ul className="rev-changes">
                {diff.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
            {r.action === 'edited' && !diff.length && <div className="rev-meta">No change to the main details.</div>}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------ Export helpers ------------------------------ */

/** Turn an on-screen list into ReportData so it can be exported / printed with <ExportButtons/>. */
export function listReport<T>(
  title: string,
  subtitle: string | undefined,
  columns: Array<ReportColumn & { get: (row: T) => string | number | null }>,
  rows: T[],
  opts: { totals?: Record<string, string | number | null>; summary?: ReportData['summary']; link?: (row: T) => ReportRow['link'] } = {},
): ReportData {
  const reportRows: ReportRow[] = rows.map((r) => ({
    cells: Object.fromEntries(columns.map((c) => [c.key, c.get(r)])),
    link: opts.link?.(r),
  }));
  if (opts.totals) reportRows.push({ cells: opts.totals, style: 'total' });
  return {
    title,
    subtitle,
    columns: columns.map(({ get: _get, ...c }) => c),
    rows: reportRows,
    summary: opts.summary,
  };
}

/** Small label + content row used in side cards. */
export function InfoRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="info-row">
      {icon}
      <div>{children}</div>
    </div>
  );
}

/**
 * Period filter remembered between visits. Presets ("This month") are
 * recalculated every time so they never go stale; custom ranges are kept as is.
 */
export function useRange(key: string, preset: DatePreset): [RangeValue, (v: RangeValue) => void] {
  const [v, setV] = useState<RangeValue>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('bf:' + key) ?? 'null') as RangeValue | null;
      if (saved?.preset && saved.preset !== 'custom') return rangeFromPreset(saved.preset);
      if (saved?.from && saved?.to) return saved;
    } catch {
      /* ignore */
    }
    return rangeFromPreset(preset);
  });
  const set = (nv: RangeValue) => {
    setV(nv);
    try {
      localStorage.setItem('bf:' + key, JSON.stringify(nv));
    } catch {
      /* ignore */
    }
  };
  return [v, set];
}

/**
 * Same look as <Field/>, but a <div> instead of a <label>. Use it around pickers
 * and button groups: inside a <label>, clicking the caption would "click" the
 * first button in the group (e.g. the picker's remove button).
 */
export function BoxField({ label, hint, error, required, children, className = '' }: { label: ReactNode; hint?: ReactNode; error?: string | null; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={`field${error ? ' has-error' : ''} ${className}`}>
      <span className="field-label">
        {label}
        {required && <span className="req">*</span>}
      </span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}
