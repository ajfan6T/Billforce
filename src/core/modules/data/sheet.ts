/**
 * Reading spreadsheets for import (.xlsx via exceljs, .csv via papaparse) and
 * parsing the values people actually type in India: "1,23,456.50", "₹500/-",
 * "15-06-2024", "15/06/24", Excel date serials, "1,500 Dr" and so on.
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { AppError, fail } from '../../errors';
import { isValidISODate } from '../../../shared/dates';
import { parseMoney, rupeesToPaise } from '../../../shared/money';

export type Cell = string | number | boolean | Date | null;

export interface SheetRow {
  /** Row number as the user sees it in Excel (1 = first row). */
  rowNo: number;
  cells: Cell[];
}

export interface ParsedSheet {
  fileName: string;
  format: 'xlsx' | 'csv';
  sheetName: string | null;
  rows: SheetRow[];
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;

/* ------------------------------ Files ------------------------------ */

function excelCell(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as any;
    if (Array.isArray(o.richText)) return o.richText.map((t: { text: string }) => t.text).join('');
    if ('result' in o) return excelCell(o.result);
    if ('formula' in o || 'sharedFormula' in o) return null;
    if ('text' in o) return typeof o.text === 'string' ? o.text : excelCell(o.text);
    if ('error' in o) return null;
    return null;
  }
  return v as string | number | boolean;
}

async function readXlsx(file: string): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(file);
  } catch {
    throw fail.validation('This Excel file could not be read. Open it in Excel and save it again as "Excel Workbook (.xlsx)", then try again.');
  }
  const sheets = wb.worksheets.filter((w) => w.state !== 'hidden' && w.state !== 'veryHidden');
  const ws = sheets.find((w) => w.actualRowCount > 0 && w.name.trim().toLowerCase() !== 'instructions') ?? sheets[0] ?? wb.worksheets[0];
  if (!ws) throw fail.validation('This Excel file has no sheets.');
  const rows: SheetRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = row.values as ExcelJS.CellValue[];
    const cells: Cell[] = [];
    for (let c = 1; c < values.length; c++) cells.push(excelCell(values[c]));
    rows.push({ rowNo: rowNumber, cells });
  });
  return { fileName: path.basename(file), format: 'xlsx', sheetName: ws.name, rows };
}

/** Decode CSV bytes: UTF-8 (with or without BOM), UTF-16 with BOM, else Windows-1252 (Excel "CSV" on older Windows). */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export function parseCsvText(text: string): SheetRow[] {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: false });
  const rows: SheetRow[] = [];
  res.data.forEach((cells, i) => {
    if (!Array.isArray(cells)) return;
    rows.push({ rowNo: i + 1, cells: cells.map((c) => (typeof c === 'string' ? c : c == null ? null : String(c))) });
  });
  return rows;
}

async function readCsv(file: string): Promise<ParsedSheet> {
  const text = decodeText(fs.readFileSync(file));
  return { fileName: path.basename(file), format: 'csv', sheetName: null, rows: parseCsvText(text) };
}

/** Read the first sheet of an .xlsx file or a .csv file. */
export async function readSheet(file: string): Promise<ParsedSheet> {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new AppError('NOT_FOUND', 'The file was not found. It may have been moved or renamed - choose it again.');
  }
  if (!st.isFile()) throw fail.validation('Choose a file, not a folder.');
  if (st.size > MAX_FILE_BYTES) throw fail.validation('This file is too large to import (more than 25 MB). Split it into smaller files.');
  const ext = path.extname(file).toLowerCase();
  let sheet: ParsedSheet;
  if (ext === '.xlsx' || ext === '.xlsm') sheet = await readXlsx(file);
  else if (ext === '.csv' || ext === '.txt') sheet = await readCsv(file);
  else if (ext === '.xls') throw fail.validation('Old Excel files (.xls) cannot be read. In Excel choose File > Save As > "Excel Workbook (.xlsx)" or "CSV", then import that file.');
  else throw fail.validation('Choose an Excel (.xlsx) or CSV (.csv) file.');
  sheet.rows = sheet.rows.filter((r) => r.cells.some((c) => cellText(c) !== ''));
  if (sheet.rows.length > MAX_IMPORT_ROWS + 1) {
    throw fail.validation(`This file has more than ${MAX_IMPORT_ROWS.toLocaleString('en-IN')} rows. Split it into smaller files and import them one by one.`);
  }
  return sheet;
}

/* ------------------------------ Headers ------------------------------ */

/** "Opening Balance (₹)*" -> "opening balance" (used to match column names). */
export function normHeader(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Like normHeader but keeps words inside brackets: "Balance (Dr/Cr)" -> "balance dr cr". */
export function normHeaderFull(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* ------------------------------ Values ------------------------------ */

/** Plain text of a cell ("" when empty). */
export function cellText(c: Cell): string {
  if (c === null || c === undefined) return '';
  if (c instanceof Date) return Number.isNaN(c.getTime()) ? '' : c.toISOString().slice(0, 10);
  if (typeof c === 'number') return Number.isFinite(c) ? String(c) : '';
  if (typeof c === 'boolean') return c ? 'TRUE' : 'FALSE';
  return String(c).replace(/ /g, ' ').trim();
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string } | null;

/** Money in paise from 1,23,456.50 / ₹500 / Rs. 500/- / (500) / 1.5k. Null when empty. */
export function parseAmount(c: Cell, opts: { allowNegative?: boolean } = {}): Parsed<number> {
  if (c === null || c === undefined || (typeof c === 'string' && !c.trim())) return null;
  let paise: number | null;
  if (typeof c === 'number') {
    paise = Number.isFinite(c) ? rupeesToPaise(c) : null;
  } else if (typeof c === 'string') {
    let s = c.replace(/ /g, ' ').trim();
    let negative = false;
    if (/^\(.*\)$/.test(s)) {
      negative = true;
      s = s.slice(1, -1);
    }
    s = s
      .replace(/\/-$/, '')
      .replace(/^(inr|rs\.?|₹)\s*/i, '')
      .replace(/\s*(inr|rs\.?|₹)$/i, '')
      .replace(/^₹/, '')
      .trim();
    if (s === '-' || s === '') return null;
    paise = parseMoney(s);
    if (paise !== null && negative) paise = -paise;
  } else {
    paise = null;
  }
  if (paise === null) return { ok: false, error: `"${cellText(c)}" is not an amount` };
  if (!opts.allowNegative && paise < 0) return { ok: false, error: 'Amount cannot be negative' };
  if (Math.abs(paise) > 1_000_000_000_00) return { ok: false, error: 'Amount is too large' };
  return { ok: true, value: paise };
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

function isoOf(y: number, m: number, d: number): string | null {
  const s = `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
  return isValidISODate(s) ? s : null;
}

function fullYear(y: number, now: Date): number {
  if (y >= 100) return y;
  const cur = now.getFullYear() % 100;
  return y <= cur + 1 ? 2000 + y : 1900 + y;
}

/** Excel stores dates as days since 30-12-1899. */
export function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Math.round((Math.floor(serial) - 25569) * 86_400_000);
  const d = new Date(ms);
  return isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Dates: DD-MM-YYYY, DD/MM/YYYY, DD.MM.YY (day first, the Indian way), YYYY-MM-DD,
 * 15-Jan-2024, 15 January 2024, Jan 15, 2024, Excel date cells and serial numbers.
 */
export function parseDateCell(c: Cell, now: Date = new Date()): Parsed<string> {
  if (c === null || c === undefined || (typeof c === 'string' && !c.trim())) return null;
  const bad = { ok: false as const, error: `"${cellText(c)}" is not a date. Use DD-MM-YYYY, for example 15-06-2024` };
  if (c instanceof Date) {
    if (Number.isNaN(c.getTime())) return bad;
    // exceljs gives dates as UTC midnight of the calendar date.
    const v = isoOf(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate());
    return v ? { ok: true, value: v } : bad;
  }
  if (typeof c === 'number') {
    if (c >= 19000101 && c <= 21001231 && Number.isInteger(c)) {
      const v = isoOf(Math.floor(c / 10000), Math.floor((c % 10000) / 100), c % 100);
      if (v) return { ok: true, value: v };
    }
    const v = excelSerialToISO(c);
    return v ? { ok: true, value: v } : bad;
  }
  const s = String(c).trim().replace(/\s+/g, ' ');
  let m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const v = isoOf(fullYear(Number(m[3]), now), Number(m[2]), Number(m[1]));
    return v ? { ok: true, value: v } : bad;
  }
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) {
    const v = isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
    return v ? { ok: true, value: v } : bad;
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?[-/ ]([A-Za-z]{3,9})\.?[-/ ,]*(\d{2}|\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const v = isoOf(fullYear(Number(m[3]), now), MONTHS[m[2].toLowerCase()], Number(m[1]));
    return v ? { ok: true, value: v } : bad;
  }
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) {
    const v = isoOf(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]));
    return v ? { ok: true, value: v } : bad;
  }
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const v = excelSerialToISO(Number(s));
    if (v) return { ok: true, value: v };
  }
  return bad;
}

/** Text of a phone cell: Excel often stores numbers as 9820012345 or "9820012345.0". */
export function phoneText(c: Cell): string {
  if (typeof c === 'number') return Number.isInteger(c) ? String(c) : String(Math.round(c));
  return cellText(c).replace(/\.0+$/, '');
}
