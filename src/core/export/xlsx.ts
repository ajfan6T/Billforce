import ExcelJS from 'exceljs';
import type { ReportData } from '../../shared/report';
import { cellText, columnAlign } from './format';
import { parseISODate } from '../../shared/dates';

/**
 * Number pattern with Indian grouping (12,34,567.00) for a value of this size. Excel only allows two
 * conditions per format, which cannot cover lakh + crore for both signs, so the pattern is chosen per
 * cell from the value: below one lakh the usual thousands pattern is identical; from one lakh up the
 * commas are literal and exactly as many groups as the value needs are written (a literal comma with
 * no digit before it would show).
 */
export function indianPattern(value: number): string {
  const digits = Math.max(1, Math.floor(Math.abs(Math.round(value * 100) / 100)).toString().length);
  if (digits <= 5) return '#,##0.00';
  // Last group of three, then groups of two: 6-7 digits -> ##,##,##0 ; 8-9 -> ##,##,##,##0 ; ...
  const pairs = Math.ceil((digits - 3) / 2);
  return `${'##\\,'.repeat(pairs)}##0.00`;
}

/** Excel number format for an amount in rupees: Indian grouping, minus sign for negatives. */
export function moneyFormat(value: number): string {
  const p = indianPattern(value);
  return `${p};-${p};0.00`;
}

/** Excel number format for a Dr/Cr balance (positive = Dr): the amount without sign, with Indian grouping. */
export function drCrFormat(value: number): string {
  const p = indianPattern(value);
  return `${p} "Dr";${p} "Cr";0.00`;
}

/** Build an .xlsx workbook for a report: title rows, summary, formatted table, notes. */
export async function reportToXlsx(report: ReportData, businessName?: string): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Billforce';
  wb.created = new Date();
  const ws = wb.addWorksheet(report.title.slice(0, 31).replace(/[\\/?*[\]:]/g, '-') || 'Report', {
    views: [{ state: 'frozen', ySplit: 0 }],
    pageSetup: { orientation: report.landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  const ncol = Math.max(report.columns.length, 1);
  let r = 1;
  const titleRow = (text: string, size: number, bold: boolean) => {
    const row = ws.getRow(r++);
    row.getCell(1).value = text;
    row.getCell(1).font = { size, bold };
    if (ncol > 1) ws.mergeCells(row.number, 1, row.number, ncol);
  };
  if (businessName) titleRow(businessName, 14, true);
  titleRow(report.title, 12, true);
  if (report.subtitle) titleRow(report.subtitle, 10, false);

  if (report.summary?.length) {
    r++;
    for (const s of report.summary) {
      const row = ws.getRow(r++);
      row.getCell(1).value = s.label;
      row.getCell(1).font = { bold: true };
      const cell = row.getCell(2);
      if (typeof s.value === 'number' && (s.type === 'money' || s.type === 'drcr')) {
        cell.value = s.value / 100;
        cell.numFmt = s.type === 'drcr' ? drCrFormat(s.value / 100) : moneyFormat(s.value / 100);
      } else {
        cell.value = s.value ?? '';
      }
    }
  }
  r++;
  const headerRow = ws.getRow(r++);
  report.columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    cell.alignment = { horizontal: columnAlign(c), vertical: 'middle', wrapText: true };
  });
  ws.views = [{ state: 'frozen', ySplit: headerRow.number }];

  for (const row of report.rows) {
    const xr = ws.getRow(r++);
    report.columns.forEach((c, i) => {
      const cell = xr.getCell(i + 1);
      const v = row.cells[c.key];
      if (v === null || v === undefined || v === '') return;
      switch (c.type) {
        case 'money':
        case 'drcr':
          if (typeof v === 'number') {
            cell.value = v / 100;
            cell.numFmt = c.type === 'drcr' ? drCrFormat(v / 100) : moneyFormat(v / 100);
          } else cell.value = v;
          break;
        case 'number':
        case 'qty':
          cell.value = typeof v === 'number' ? v : v;
          if (typeof v === 'number') cell.numFmt = Number.isInteger(v) ? '#,##0' : '#,##0.###';
          break;
        case 'percent':
          if (typeof v === 'number') {
            cell.value = v / 100;
            cell.numFmt = '0.0%';
          } else cell.value = v;
          break;
        case 'date':
          if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
            const d = parseISODate(v);
            cell.value = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
            cell.numFmt = 'dd-mm-yyyy';
          } else cell.value = v;
          break;
        default:
          cell.value = i === 0 && row.indent ? '    '.repeat(row.indent) + cellText(c, v) : cellText(c, v);
      }
      cell.alignment = { horizontal: columnAlign(c), vertical: 'top', wrapText: c.type === 'text' || !c.type };
    });
    if (row.style === 'total' || row.style === 'subtotal' || row.style === 'group' || row.style === 'section') {
      xr.font = { bold: true };
      if (row.style === 'total') {
        report.columns.forEach((_, i) => {
          xr.getCell(i + 1).border = { top: { style: 'thin' }, bottom: { style: 'double' } };
        });
      }
    }
    if (row.style === 'muted') xr.font = { color: { argb: 'FF64748B' } };
  }
  if (report.notes?.length) {
    r++;
    for (const n of report.notes) {
      const row = ws.getRow(r++);
      row.getCell(1).value = n;
      row.getCell(1).font = { italic: true, color: { argb: 'FF64748B' } };
    }
  }
  report.columns.forEach((c, i) => {
    const longest = Math.max(c.label.length, ...report.rows.slice(0, 500).map((row) => cellText(c, row.cells[c.key] ?? null).length));
    ws.getColumn(i + 1).width = Math.min(Math.max(c.width ?? longest + 2, 8), 60);
  });
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

/** Workbook with one sheet from header + rows (import templates). */
export async function rowsToXlsx(sheetName: string, header: string[], rows: Array<Array<string | number | null>>, notes?: string[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  const h = ws.addRow(header);
  h.font = { bold: true };
  for (const r of rows) ws.addRow(r);
  header.forEach((name, i) => {
    ws.getColumn(i + 1).width = Math.max(14, name.length + 4);
  });
  if (notes?.length) {
    const info = wb.addWorksheet('Instructions');
    notes.forEach((n) => info.addRow([n]));
    info.getColumn(1).width = 100;
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
