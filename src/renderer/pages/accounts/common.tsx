/**
 * UI pieces shared by the accounts pages: date ranges remembered per page,
 * badges, the "how this is recorded" posting table and revision history.
 */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { rangeFromPreset, type RangeValue } from '../../components/report';
import { Badge, Button, type Tone } from '../../components/ui';
import { useStoredState } from '../../hooks';
import { useAuth } from '../../auth';
import { useLinkedRange } from '../../links';
import { formatINR } from '../../../shared/money';
import { formatDate, formatDateTime, type DatePreset } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS, VOUCHER_TYPE_LABELS, type VoucherType } from '../../../shared/constants';
import type { ReportColumn, ReportData, ReportRow } from '../../../shared/report';
import './accounts.css';

/**
 * A date range remembered per page; presets ("This month") stay current across days.
 * A drill-down link's `?from=&to=` (from a report or the dashboard) wins while it is in the address.
 */
export function useRange(key: string, preset: DatePreset = 'this_month'): [RangeValue, (v: RangeValue) => void] {
  const [stored, setStored] = useStoredState<RangeValue>(`accounts.${key}`, rangeFromPreset(preset));
  const value = stored.preset === 'custom' ? stored : rangeFromPreset(stored.preset);
  return useLinkedRange(value, setStored);
}

const VOUCHER_TONES: Partial<Record<VoucherType, Tone>> = {
  sale: 'green',
  receipt: 'green',
  sale_return: 'amber',
  purchase: 'blue',
  payment: 'blue',
  expense: 'red',
  journal: 'purple',
  capital: 'purple',
  drawings: 'amber',
  loan: 'blue',
  salary: 'neutral',
  salary_payment: 'neutral',
  advance: 'neutral',
  contra: 'neutral',
  opening: 'neutral',
  closing: 'neutral',
};

export function VoucherBadge({ type, label }: { type: VoucherType | string; label?: string }) {
  return <Badge tone={VOUCHER_TONES[type as VoucherType] ?? 'neutral'}>{label ?? VOUCHER_TYPE_LABELS[type as VoucherType] ?? type}</Badge>;
}

export function ModeBadge({ mode }: { mode: string }) {
  const tone: Tone = mode === 'cash' ? 'green' : mode === 'upi' ? 'purple' : mode === 'bank' ? 'blue' : mode === 'credit' ? 'amber' : 'neutral';
  return <Badge tone={tone}>{(PAYMENT_MODE_LABELS as Record<string, string>)[mode] ?? mode}</Badge>;
}

export function CancelledBadge() {
  return <Badge tone="red">Cancelled</Badge>;
}

export const VOUCHER_OPTIONS = (Object.keys(VOUCHER_TYPE_LABELS) as VoucherType[]).map((v) => ({ value: v, label: VOUCHER_TYPE_LABELS[v] }));

/* ------------------------------ Posting table ------------------------------ */

export interface PostingLine {
  accountId: number;
  accountName: string;
  accountCode?: string | null;
  partyName?: string | null;
  partyType?: string | null;
  debit: number;
  credit: number;
  memo?: string | null;
}

/** The debit / credit lines of an entry, with totals. Account names open their ledger. */
export function PostingTable({ lines, voided, showMemo = true, linkAccounts = true }: { lines: PostingLine[]; voided?: boolean; showMemo?: boolean; linkAccounts?: boolean }) {
  const { can } = useAuth();
  const links = linkAccounts && can('accounts.view');
  if (!lines.length) return <div className="muted small">No accounting entry.</div>;
  const dr = lines.reduce((s, l) => s + l.debit, 0);
  const cr = lines.reduce((s, l) => s + l.credit, 0);
  return (
    <table className={`ac-posting${voided ? ' void' : ''}`}>
      <thead>
        <tr>
          <th>Account</th>
          <th className="num">Debit</th>
          <th className="num">Credit</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i}>
            <td>
              {links ? <Link to={`/accounts/ledger?account=${l.accountId}`}>{l.accountName}</Link> : l.accountName}
              {l.partyName && <span className="ac-party"> · {l.partyName}</span>}
              {showMemo && l.memo && <span className="ac-memo">{l.memo}</span>}
            </td>
            <td className="num money">{l.debit ? formatINR(l.debit) : ''}</td>
            <td className="num money">{l.credit ? formatINR(l.credit) : ''}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td className="num money">{formatINR(dr)}</td>
          <td className="num money">{formatINR(cr)}</td>
        </tr>
      </tfoot>
    </table>
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

export const fmtMoney = (v: any) => formatINR(Number(v ?? 0));
export const fmtDate = (v: any) => (v ? formatDate(String(v)) : '—');
export const fmtText = (v: any) => (v === null || v === undefined || v === '' ? '—' : String(v));
export const fmtMode = (v: any) => (PAYMENT_MODE_LABELS as Record<string, string>)[v] ?? String(v ?? '—');

/** Lines of a journal snapshot as short text ("Rent Dr ₹1,000.00; Cash in Hand Cr ₹1,000.00"). */
export const fmtLines = (v: any) =>
  Array.isArray(v)
    ? v.map((l: any) => `${l.account}${l.party ? ` (${l.party})` : ''} ${l.debit ? `Dr ${formatINR(l.debit)}` : `Cr ${formatINR(l.credit)}`}`).join('; ')
    : '—';

export const JOURNAL_DIFF: DiffField[] = [
  { key: 'date', label: 'Date', format: fmtDate },
  { key: 'narration', label: 'Narration' },
  { key: 'total', label: 'Amount', format: fmtMoney },
  { key: 'lines', label: 'Lines', format: fmtLines },
];

const ACTION_LABELS: Record<string, string> = { created: 'Created', edited: 'Edited', cancelled: 'Cancelled', restored: 'Restored' };

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

/** Timeline of every version: who, when, why, and what changed. */
export function RevisionHistory({ revisions, fields }: { revisions: RevisionView[]; fields: DiffField[] }) {
  if (!revisions.length) return <div className="muted small">No history recorded.</div>;
  return (
    <ol className="ac-revs">
      {[...revisions].reverse().map((r) => {
        const prev = revisions.find((x) => x.revision === r.revision - 1);
        const diff = r.action === 'edited' ? changes(prev?.snapshot, r.snapshot, fields) : [];
        return (
          <li key={r.revision} className="ac-rev">
            <span className={`ac-rev-dot ${r.action}`} />
            <div className="ac-rev-title">
              {ACTION_LABELS[r.action] ?? r.action} <span className="faint small">· version {r.revision}</span>
            </div>
            <div className="ac-rev-meta">
              {r.username ?? 'system'} · {formatDateTime(r.at)}
            </div>
            {r.reason && (
              <div className="ac-rev-reason">
                <b>Reason:</b> {r.reason}
              </div>
            )}
            {diff.length > 0 && (
              <ul className="ac-rev-changes">
                {diff.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------ Export helpers ------------------------------ */

export interface ListColumn<T> extends ReportColumn {
  get: (row: T) => string | number | null | undefined;
}

/** Build an exportable report from on-screen list rows. */
export function listReport<T>(
  title: string,
  subtitle: string,
  columns: Array<ListColumn<T>>,
  rows: T[],
  opts: { totals?: Record<string, string | number | null>; summary?: ReportData['summary']; link?: (r: T) => ReportRow['link']; landscape?: boolean; notes?: string[] } = {},
): ReportData {
  const out: ReportRow[] = rows.map((r) => ({
    cells: Object.fromEntries(columns.map((c) => [c.key, c.get(r) ?? null])),
    link: opts.link?.(r),
  }));
  if (opts.totals && rows.length) out.push({ cells: opts.totals, style: 'total' });
  return {
    title,
    subtitle,
    columns: columns.map(({ get: _get, ...c }) => c),
    rows: out,
    summary: opts.summary,
    notes: opts.notes,
    landscape: opts.landscape,
  };
}

/**
 * Like <Field> but a <div> instead of a <label>: for groups of buttons
 * (payment mode, segmented choices) where clicking the caption must not
 * press the first button.
 */
export function FieldGroup({ label, hint, error, required, children }: { label: ReactNode; hint?: ReactNode; error?: string | null; required?: boolean; children: ReactNode }) {
  return (
    <div className={`field${error ? ' has-error' : ''}`} role="group" aria-label={typeof label === 'string' ? label : undefined}>
      <span className="field-label">
        {label}
        {required && <span className="req">*</span>}
      </span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

/* ------------------------------ Long lists shown a page at a time ------------------------------ */

export interface PageState {
  page: number;
  pageCount: number;
  firstShown: number;
  lastShown: number;
}

const n = (v: number) => v.toLocaleString('en-IN');

/** Page number of a paged list; back to page 1 whenever `key` (the filters) changes. */
export function usePage(key: string): [number, (page: number) => void] {
  const [state, setState] = useState({ key, page: 1 });
  return [state.key === key ? state.page : 1, (page) => setState({ key, page })];
}

/**
 * Bar shown above (and below) a book or list that is too long for one screen:
 * which rows are shown, previous / next page, and that the figures and exports
 * cover the whole period. Nothing is shown when everything fits on one page.
 */
export function PageBar({ info, total, what, onPage, figuresNote = true, bottom }: { info: PageState | undefined; total: number; what: string; onPage: (page: number) => void; figuresNote?: boolean; bottom?: boolean }) {
  if (!info || info.pageCount <= 1) return null;
  return (
    <div className={`ac-pagebar${bottom ? ' bottom' : ''}`} role="navigation" aria-label={`Pages of ${what}`}>
      <div className="ac-pagebar-text">
        <b>
          Showing {what} {n(info.firstShown)}–{n(info.lastShown)} of {n(total)}
        </b>{' '}
        · page {info.page} of {info.pageCount}
        {!bottom && (
          <span className="ac-pagebar-note">
            {figuresNote ? 'Opening balance, totals and closing balance are for the whole period. ' : 'Totals are for the whole period. '}
            Excel, CSV, PDF and Print include every entry.
          </span>
        )}
      </div>
      <div className="row">
        <Button size="sm" icon={<ChevronLeft size={15} />} disabled={info.page <= 1} onClick={() => onPage(info.page - 1)}>
          Previous
        </Button>
        <Button size="sm" disabled={info.page >= info.pageCount} onClick={() => onPage(info.page + 1)}>
          Next <ChevronRight size={15} />
        </Button>
      </div>
    </div>
  );
}
