/**
 * A tabular report that can be shown on screen and exported to Excel, CSV and
 * PDF without any report-specific export code. Every report service returns
 * this shape; the UI renders it with <ReportView/>.
 */

export type ReportColumnType = 'text' | 'money' | 'number' | 'qty' | 'date' | 'datetime' | 'percent' | 'drcr';

export interface ReportColumn {
  key: string;
  label: string;
  type?: ReportColumnType;
  /** Relative width hint (characters) for Excel / PDF. */
  width?: number;
  align?: 'left' | 'right' | 'center';
}

/**
 * Cell values: money / drcr columns hold paise (integers); number / qty / percent
 * hold plain numbers (percent 12.5 = 12.5%); date columns hold "YYYY-MM-DD".
 */
export type ReportCell = string | number | null;

export type ReportRowStyle = 'normal' | 'group' | 'subtotal' | 'total' | 'muted' | 'section';

export interface ReportRow {
  cells: Record<string, ReportCell>;
  style?: ReportRowStyle;
  /** Indentation level for the first column (0 = none). */
  indent?: number;
  /** Optional link target in the app, e.g. { kind: 'bill', id: 12 }. */
  link?: { kind: string; id: number | string };
}

export interface ReportSummaryItem {
  label: string;
  value: ReportCell;
  type?: ReportColumnType;
}

export interface ReportData {
  /** Report title, e.g. "Profit & Loss". */
  title: string;
  /** Second line, typically the period: "01-04-2026 to 28-09-2026". */
  subtitle?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Key figures shown above the table (and in exports). */
  summary?: ReportSummaryItem[];
  /** Footnotes printed below the table. */
  notes?: string[];
  /** Suggested page orientation for PDF. */
  landscape?: boolean;
}

export type ExportFormat = 'xlsx' | 'csv' | 'pdf';
