import { useState, type ReactNode } from 'react';
import { FileSpreadsheet, FileText, FileDown, Printer } from 'lucide-react';
import type { ExportFormat, ReportData, ReportRow } from '../../shared/report';
import { DATE_PRESET_LABELS, presetRange, todayISO, type DatePreset, type DateRange } from '../../shared/dates';
import { call, exportReport } from '../api';
import { useToast } from '../feedback';
import { useAuth } from '../auth';
import { Button, EmptyState, ErrorBox, Loading, Money, DrCr } from './ui';
import { DateInput, Select } from './forms';
import { formatCell } from './table';

/* ---------------------------- Date range ---------------------------- */

export interface RangeValue extends DateRange {
  preset: DatePreset;
}

export function rangeFromPreset(preset: DatePreset, today = todayISO()): RangeValue {
  return { preset, ...presetRange(preset, today) };
}

const PRESETS: DatePreset[] = ['today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'last_month', 'last_30_days', 'this_quarter', 'this_fy', 'last_fy', 'custom'];

/** Period filter used on every report: a preset list plus from / to dates. */
export function DateRangePicker({ value, onChange, presets = PRESETS }: { value: RangeValue; onChange: (v: RangeValue) => void; presets?: DatePreset[] }) {
  return (
    <div className="range-picker">
      <Select<DatePreset>
        value={value.preset}
        aria-label="Period"
        onChange={(p) => onChange(p === 'custom' ? { ...value, preset: 'custom' } : rangeFromPreset(p))}
        options={presets.map((p) => ({ value: p, label: DATE_PRESET_LABELS[p] }))}
      />
      <DateInput aria-label="From date" value={value.from} max={value.to} onChange={(from) => from && onChange({ ...value, from, preset: 'custom' })} />
      <span className="range-sep">to</span>
      <DateInput aria-label="To date" value={value.to} min={value.from} onChange={(to) => to && onChange({ ...value, to, preset: 'custom' })} />
    </div>
  );
}

/** "As on" single-date picker (balance sheet, ageing). */
export function AsOnPicker({ value, onChange, label = 'As on' }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="range-picker">
      <span className="range-sep">{label}</span>
      <DateInput aria-label={label} value={value} onChange={(v) => v && onChange(v)} />
    </div>
  );
}

/* ---------------------------- Export bar ---------------------------- */

/**
 * Excel / CSV / PDF / Print of a report. `load` fetches the full report to export when the screen
 * shows only part of it (e.g. one page of a long cash book); by default the report on screen is used.
 */
export function ExportButtons({ report, disabled, load }: { report: ReportData | undefined | null; disabled?: boolean; load?: () => Promise<ReportData> }) {
  const toast = useToast();
  const { can } = useAuth();
  const [busy, setBusy] = useState<ExportFormat | 'print' | null>(null);
  const run = async (format: ExportFormat) => {
    if (!report) return;
    setBusy(format);
    try {
      const path = await exportReport(load ? await load() : report, format);
      if (path) toast.success(`Saved ${format.toUpperCase()} to ${path}`, { label: 'Open', onClick: () => void call('files.open', { path }) });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const print = async () => {
    if (!report) return;
    setBusy('print');
    try {
      await call('files.printReport', { report: load ? await load() : report });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const off = disabled || !report;
  return (
    <div className="export-bar">
      {can('reports.export') && (
        <>
          <Button size="sm" icon={<FileSpreadsheet size={15} />} loading={busy === 'xlsx'} disabled={off} onClick={() => run('xlsx')}>
            Excel
          </Button>
          <Button size="sm" icon={<FileText size={15} />} loading={busy === 'csv'} disabled={off} onClick={() => run('csv')}>
            CSV
          </Button>
          <Button size="sm" icon={<FileDown size={15} />} loading={busy === 'pdf'} disabled={off} onClick={() => run('pdf')}>
            PDF
          </Button>
        </>
      )}
      <Button size="sm" icon={<Printer size={15} />} loading={busy === 'print'} disabled={off} onClick={print}>
        Print
      </Button>
    </div>
  );
}

/* ---------------------------- Report view ---------------------------- */

export interface ReportViewProps {
  report: ReportData | undefined | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Clicking a row that carries a link. */
  onLink?: (link: NonNullable<ReportRow['link']>) => void;
  /** Hide the title (when the page header already shows it). */
  hideTitle?: boolean;
  emptyMessage?: ReactNode;
  maxHeight?: number | string;
}

/** Renders any ReportData: summary figures, styled table, notes. */
export function ReportView({ report, loading, error, onRetry, onLink, hideTitle, emptyMessage, maxHeight }: ReportViewProps) {
  if (error) return <ErrorBox error={error} onRetry={onRetry} />;
  if (!report) return loading ? <Loading /> : null;
  const align = (t?: string, a?: string) => a ?? (t && ['money', 'drcr', 'number', 'qty', 'percent'].includes(t) ? 'right' : 'left');
  return (
    <div className={`report${loading ? ' is-loading' : ''}`}>
      {!hideTitle && (
        <div className="report-head">
          <h2>{report.title}</h2>
          {report.subtitle && <div className="report-sub">{report.subtitle}</div>}
        </div>
      )}
      {report.summary && report.summary.length > 0 && (
        <div className="report-summary">
          {report.summary.map((s, i) => (
            <div className="report-figure" key={i}>
              <div className="rf-label">{s.label}</div>
              <div className="rf-value">
                {typeof s.value === 'number' && s.type === 'money' ? (
                  <Money value={s.value} className={s.tone === 'bad' ? 'neg' : ''} />
                ) : typeof s.value === 'number' && s.type === 'drcr' ? (
                  <DrCr value={s.value} />
                ) : (
                  formatCell(s.type as any, s.value)
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {report.rows.length === 0 ? (
        <EmptyState title="No entries" message={emptyMessage ?? 'There is nothing to show for the selected period.'} />
      ) : (
        <div className="table-wrap sticky" style={maxHeight ? { maxHeight, overflow: 'auto' } : undefined}>
          <table className="table report-table">
            <thead>
              <tr>
                {report.columns.map((c) => (
                  <th key={c.key} style={{ textAlign: align(c.type, c.align) as any }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row, ri) => (
                <tr key={ri} className={`row-${row.style ?? 'normal'}${row.link && onLink ? ' link' : ''}`} onClick={row.link && onLink ? () => onLink(row.link!) : undefined}>
                  {report.columns.map((c, ci) => (
                    <td key={c.key} style={{ textAlign: align(c.type, c.align) as any, paddingLeft: ci === 0 && row.indent ? 10 + row.indent * 18 : undefined }}>
                      {formatCell(c.type as any, row.cells[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report.notes && report.notes.length > 0 && (
        <div className="report-notes">
          {report.notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      )}
    </div>
  );
}
