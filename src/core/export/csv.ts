import type { ReportCell, ReportColumnType, ReportData } from '../../shared/report';
import { cellText } from './format';

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Text that a spreadsheet would run as a formula (= + - @, or a leading tab / carriage return) gets a
 * leading apostrophe, so a customer named "=HYPERLINK(...)" stays text when the owner opens the CSV
 * in Excel (OWASP CSV injection guidance). Only for text: numbers are written by the callers as numbers.
 */
export function guardText(s: string): string {
  // A lone "-" / "+" (a "nothing here" mark) cannot be a formula; leave it readable.
  if (/^[-+]\s*$/.test(s)) return s;
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** A CSV field holding user text. */
function textField(s: string): string {
  return csvField(guardText(s));
}

/** Plain number (no grouping) so it stays numeric in a spreadsheet; Dr/Cr amounts carry their side. */
function numericText(type: ReportColumnType | undefined, v: number): string {
  if (type === 'money') return (v / 100).toFixed(2);
  if (type === 'drcr') return v === 0 ? '0.00' : `${(Math.abs(v) / 100).toFixed(2)} ${v > 0 ? 'Dr' : 'Cr'}`;
  return String(v);
}

function summaryText(type: ReportColumnType | undefined, v: ReportCell): string {
  if (typeof v === 'number' && (type === 'money' || type === 'drcr')) return numericText(type, v);
  if (typeof v === 'number') return String(v);
  return guardText(String(v ?? ''));
}

/**
 * CSV with a UTF-8 BOM so Excel on Windows shows the rupee sign and Indian
 * language text correctly. Numbers are written without grouping commas so
 * they stay numeric when opened in a spreadsheet.
 */
export function reportToCsv(report: ReportData): string {
  const lines: string[] = [];
  lines.push(textField(report.title));
  if (report.subtitle) lines.push(textField(report.subtitle));
  if (report.summary?.length) {
    for (const s of report.summary) {
      lines.push([textField(s.label), csvField(summaryText(s.type, s.value))].join(','));
    }
  }
  lines.push('');
  lines.push(report.columns.map((c) => textField(c.label)).join(','));
  for (const row of report.rows) {
    const cells = report.columns.map((c, i) => {
      const v = row.cells[c.key];
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return numericText(c.type, v);
      const text = guardText(cellText(c, v));
      return csvField(i === 0 && row.indent ? '  '.repeat(row.indent) + text : text);
    });
    lines.push(cells.join(','));
  }
  if (report.notes?.length) {
    lines.push('');
    for (const n of report.notes) lines.push(textField(n));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** Parse-free CSV builder for simple exports (templates etc.). */
export function rowsToCsv(header: string[], rows: Array<Array<string | number | null>>): string {
  const out = [header.map(textField).join(',')];
  for (const r of rows) out.push(r.map((v) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : textField(v))).join(','));
  return '\uFEFF' + out.join('\r\n') + '\r\n';
}
