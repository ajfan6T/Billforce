/**
 * Pieces shared by the report pages: remembered filters, the standard report
 * layout (header, filter bar, status line, report table) and the balanced badge.
 */
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { Card, Page, PageHeader, Toolbar } from '../../components/ui';
import { ExportButtons, ReportView, rangeFromPreset, type RangeValue } from '../../components/report';
import { useStoredState } from '../../hooks';
import { useLinkedRange, useOpenLink, type LinkPeriod } from '../../links';
import { isValidISODate, todayISO, type DatePreset } from '../../../shared/dates';
import type { ReportData } from '../../../shared/report';
import './reports.css';

/**
 * A period remembered per report. Presets ("This month") move with the calendar; custom ranges stay as chosen.
 * A drill-down link (dashboard card, another report) that puts `?from=&to=` in the address wins while it is there.
 */
export function useReportRange(key: string, preset: DatePreset = 'this_month'): [RangeValue, (v: RangeValue) => void] {
  const [stored, setStored] = useStoredState<RangeValue>(`reports.${key}`, rangeFromPreset(preset));
  const value = stored?.preset && stored.preset !== 'custom' ? rangeFromPreset(stored.preset) : stored?.from && stored?.to ? stored : rangeFromPreset(preset);
  return useLinkedRange(value, setStored);
}

/**
 * An "as on" date remembered per report. Until the user picks a date it follows today.
 * `?asOf=` in the address (a dashboard card) wins while it is there.
 */
export function useAsOnDate(key: string): [string, (v: string) => void] {
  const [stored, setStored] = useStoredState<{ date: string | null }>(`reports.${key}`, { date: null });
  const [params, setParams] = useSearchParams();
  const today = todayISO();
  const linked = params.get('asOf');
  const value = linked && isValidISODate(linked) ? linked : (stored?.date ?? today);
  const set = (v: string) => {
    if (params.has('asOf')) {
      const next = new URLSearchParams(params);
      next.delete('asOf');
      setParams(next, { replace: true });
    }
    setStored({ date: v === today ? null : v });
  };
  return [value, set];
}

export interface ReportLayoutProps {
  title: string;
  /** Shown under the title; falls back to the report's own subtitle (the period). */
  subtitle?: ReactNode;
  report: ReportData | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  filters: ReactNode;
  /** Status line between the filters and the table (e.g. "Balanced"). */
  status?: ReactNode;
  /** Extra content above the table (charts, stat cards). */
  children?: ReactNode;
  emptyMessage?: ReactNode;
  wide?: boolean;
  /** The report's period: rows that open a ledger or a party's account open it on these dates, so the figures match. */
  linkPeriod?: LinkPeriod | null;
}

/** Standard report page: header with export, filter bar, optional status, the report. */
export function ReportLayout({ title, subtitle, report, loading, error, onRetry, filters, status, children, emptyMessage, wide, linkPeriod }: ReportLayoutProps) {
  const openLink = useOpenLink(linkPeriod);
  return (
    <Page wide={wide}>
      <PageHeader title={title} subtitle={subtitle ?? report?.subtitle ?? ' '} back="/reports" actions={<ExportButtons report={report} disabled={loading && !report} />} />
      <Card padded={false} className="rp-card">
        <div className="rp-filters">
          <Toolbar>{filters}</Toolbar>
        </div>
        {status}
        {children}
        <ReportView report={report} loading={loading} error={error} onRetry={onRetry} onLink={openLink} hideTitle emptyMessage={emptyMessage} />
      </Card>
    </Page>
  );
}

/** Status line under the filters: green when all is well, red when the books disagree. */
export function BalanceStatus({ ok, okText, badText, badTone = 'bad' }: { ok: boolean | undefined; okText: ReactNode; badText: ReactNode; badTone?: 'bad' | 'warn' }) {
  if (ok === undefined) return null;
  const tone = ok ? 'ok' : badTone;
  return (
    <div className={`rp-status ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      {ok ? <CheckCircle2 size={16} /> : tone === 'warn' ? <Info size={16} /> : <AlertTriangle size={16} />}
      <span>{ok ? okText : badText}</span>
    </div>
  );
}

/** Neutral information line in the same place as the status. */
export function InfoStatus({ children }: { children: ReactNode }) {
  return (
    <div className="rp-status info" role="status">
      <Info size={16} />
      <span>{children}</span>
    </div>
  );
}
