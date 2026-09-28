import type { ReportData } from '../../shared/report';
import { cellText, columnAlign, escapeHtml } from './format';
import { formatDrCr, formatINR } from '../../shared/money';
import { formatDateTime } from '../../shared/dates';

export interface ReportHtmlOptions {
  businessName?: string;
  businessAddress?: string;
  generatedAt?: string;
  generatedBy?: string;
}

/** A4 printable HTML for any report; used for PDF export and printing. */
export function reportToHtml(report: ReportData, opts: ReportHtmlOptions = {}): string {
  const head = report.columns
    .map((c) => `<th style="text-align:${columnAlign(c)}">${escapeHtml(c.label)}</th>`)
    .join('');
  const body = report.rows
    .map((row) => {
      const tds = report.columns
        .map((c, i) => {
          const text = cellText(c, row.cells[c.key] ?? null);
          const pad = i === 0 && row.indent ? ` style="padding-left:${6 + row.indent * 14}px"` : '';
          return `<td class="${columnAlign(c)}"${pad}>${escapeHtml(text)}</td>`;
        })
        .join('');
      return `<tr class="${row.style ?? 'normal'}">${tds}</tr>`;
    })
    .join('\n');
  const summary = report.summary?.length
    ? `<div class="summary">${report.summary
        .map((s) => {
          const v =
            typeof s.value === 'number' && s.type === 'money'
              ? formatINR(s.value)
              : typeof s.value === 'number' && s.type === 'drcr'
                ? formatDrCr(s.value)
                : escapeHtml(String(s.value ?? ''));
          return `<div class="card"><div class="label">${escapeHtml(s.label)}</div><div class="value">${v}</div></div>`;
        })
        .join('')}</div>`
    : '';
  const notes = report.notes?.length ? `<div class="notes">${report.notes.map((n) => `<p>${escapeHtml(n)}</p>`).join('')}</div>` : '';
  const footer = [opts.generatedAt ? `Generated ${formatDateTime(opts.generatedAt)}` : '', opts.generatedBy ? `by ${escapeHtml(opts.generatedBy)}` : '']
    .filter(Boolean)
    .join(' ');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(report.title)}</title>
<style>
  @page { size: A4 ${report.landscape ? 'landscape' : 'portrait'}; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, "Nirmala UI", sans-serif; font-size: 10.5pt; color: #0f172a; margin: 0; }
  header { border-bottom: 2px solid #0f172a; padding-bottom: 6px; margin-bottom: 10px; }
  .biz { font-size: 15pt; font-weight: 700; }
  .addr { color: #475569; font-size: 9pt; white-space: pre-line; }
  h1 { font-size: 13pt; margin: 8px 0 2px; }
  .sub { color: #475569; font-size: 9.5pt; }
  .summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 12px; }
  .card { border: 1px solid #cbd5e1; border-radius: 4px; padding: 5px 10px; min-width: 120px; }
  .card .label { color: #64748b; font-size: 8.5pt; }
  .card .value { font-weight: 700; font-size: 11pt; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th { background: #e2e8f0; font-size: 9pt; padding: 5px 6px; border-bottom: 1px solid #94a3b8; }
  td { padding: 4px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; font-variant-numeric: tabular-nums; }
  td.right { text-align: right; white-space: nowrap; }
  td.center { text-align: center; }
  tr { page-break-inside: avoid; }
  tr.group td, tr.section td { font-weight: 700; background: #f1f5f9; }
  tr.subtotal td { font-weight: 600; border-top: 1px solid #94a3b8; }
  tr.total td { font-weight: 700; border-top: 1.5px solid #0f172a; border-bottom: 3px double #0f172a; }
  tr.muted td { color: #64748b; }
  .notes { margin-top: 10px; color: #475569; font-size: 8.5pt; }
  .notes p { margin: 2px 0; }
  footer { margin-top: 14px; color: #94a3b8; font-size: 8pt; text-align: right; }
</style></head>
<body>
<header>
  ${opts.businessName ? `<div class="biz">${escapeHtml(opts.businessName)}</div>` : ''}
  ${opts.businessAddress ? `<div class="addr">${escapeHtml(opts.businessAddress)}</div>` : ''}
  <h1>${escapeHtml(report.title)}</h1>
  ${report.subtitle ? `<div class="sub">${escapeHtml(report.subtitle)}</div>` : ''}
</header>
${summary}
<table><thead><tr>${head}</tr></thead><tbody>
${body || `<tr><td colspan="${report.columns.length}" class="center">No entries for this period</td></tr>`}
</tbody></table>
${notes}
${footer ? `<footer>${footer} &middot; Billforce</footer>` : ''}
</body></html>`;
}
