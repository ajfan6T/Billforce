import type { ReportData } from '../../shared/report';
import { cellText } from './format';

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV with a UTF-8 BOM so Excel on Windows shows the rupee sign and Indian
 * language text correctly. Numbers are written without grouping commas so
 * they stay numeric when opened in a spreadsheet.
 */
export function reportToCsv(report: ReportData): string {
  const lines: string[] = [];
  lines.push(csvField(report.title));
  if (report.subtitle) lines.push(csvField(report.subtitle));
  if (report.summary?.length) {
    for (const s of report.summary) {
      const v = typeof s.value === 'number' && (s.type === 'money' || s.type === 'drcr') ? (s.value / 100).toFixed(2) : String(s.value ?? '');
      lines.push([csvField(s.label), csvField(v)].join(','));
    }
  }
  lines.push('');
  lines.push(report.columns.map((c) => csvField(c.label)).join(','));
  for (const row of report.rows) {
    const cells = report.columns.map((c, i) => {
      const v = row.cells[c.key];
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') {
        if (c.type === 'money') return (v / 100).toFixed(2);
        if (c.type === 'drcr') return v === 0 ? '0.00' : `${(Math.abs(v) / 100).toFixed(2)} ${v > 0 ? 'Dr' : 'Cr'}`;
        return String(v);
      }
      const text = cellText(c, v);
      return csvField(i === 0 && row.indent ? '  '.repeat(row.indent) + text : text);
    });
    lines.push(cells.join(','));
  }
  if (report.notes?.length) {
    lines.push('');
    for (const n of report.notes) lines.push(csvField(n));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Parse-free CSV builder for simple exports (templates etc.). */
export function rowsToCsv(header: string[], rows: Array<Array<string | number | null>>): string {
  const out = [header.map(csvField).join(',')];
  for (const r of rows) out.push(r.map((v) => csvField(v === null || v === undefined ? '' : String(v))).join(','));
  return '﻿' + out.join('\r\n') + '\r\n';
}
