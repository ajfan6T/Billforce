import type { ReportCell, ReportColumn } from '../../shared/report';
import { formatAmount, formatDrCr, formatIndianNumber, formatQty } from '../../shared/money';
import { formatDate, formatDateTime } from '../../shared/dates';

/** Text for a report cell, formatted the Indian way. Used for CSV, PDF and print. */
export function cellText(col: ReportColumn, value: ReportCell): string {
  if (value === null || value === undefined || value === '') return '';
  switch (col.type) {
    case 'money':
      return typeof value === 'number' ? formatAmount(value) : String(value);
    case 'drcr':
      return typeof value === 'number' ? formatDrCr(value, false) : String(value);
    case 'number':
      return typeof value === 'number' ? formatIndianNumber(value, Number.isInteger(value) ? 0 : 2) : String(value);
    case 'qty':
      return typeof value === 'number' ? formatQty(value) : String(value);
    case 'percent':
      return typeof value === 'number' ? `${value.toFixed(1)}%` : String(value);
    case 'date':
      return typeof value === 'string' ? formatDate(value) : String(value);
    case 'datetime':
      return typeof value === 'string' ? formatDateTime(value) : String(value);
    default:
      return String(value);
  }
}

export function isNumericColumn(col: ReportColumn): boolean {
  return ['money', 'drcr', 'number', 'qty', 'percent'].includes(col.type ?? 'text');
}

export function columnAlign(col: ReportColumn): 'left' | 'right' | 'center' {
  return col.align ?? (isNumericColumn(col) ? 'right' : 'left');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Safe file name from a title: "Profit & Loss 01-04-2026 to 31-03-2027" -> "Profit-and-Loss_01-04-2026_to_31-03-2027" */
export function safeFileName(title: string): string {
  return (
    title
      .replace(/&/g, 'and')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 120) || 'report'
  );
}
