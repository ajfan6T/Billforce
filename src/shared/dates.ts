/**
 * Date helpers. Dates are stored as ISO strings "YYYY-MM-DD" (local calendar
 * date, no timezone) and timestamps as "YYYY-MM-DD HH:MM:SS" in local time.
 * Display format is the Indian convention DD-MM-YYYY.
 * The Indian financial year runs from 1 April to 31 March.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO(now: Date = new Date()): string {
  return toISODate(now);
}

/** Local timestamp "YYYY-MM-DD HH:MM:SS". */
export function toTimestamp(d: Date = new Date()): string {
  return `${toISODate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function isValidISODate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Parse "YYYY-MM-DD" into a local Date at midnight. */
export function parseISODate(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** "2026-09-28" -> "28-09-2026". Anything that is not a date (e.g. a "Total" label in a date column) is returned as it is. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

/** "2026-09-28" -> "28 Sep 2026" */
export function formatDateLong(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "2026-09-28 14:05:00" -> "28-09-2026 02:05 PM" */
export function formatDateTime(ts: string | null | undefined): string {
  if (!ts) return '';
  const date = formatDate(ts.slice(0, 10));
  const time = ts.length >= 16 ? formatTime(ts) : '';
  return time ? `${date} ${time}` : date;
}

/** "2026-09-28 14:05:00" -> "02:05 PM" */
export function formatTime(ts: string): string {
  const t = ts.length > 10 ? ts.slice(11, 16) : ts.slice(0, 5);
  const [hh, mm] = t.split(':').map(Number);
  if (Number.isNaN(hh)) return '';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${pad(h12)}:${pad(mm)} ${hh < 12 ? 'AM' : 'PM'}`;
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

export function addMonths(iso: string, months: number): string {
  const d = parseISODate(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISODate(d);
}

/** Whole days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
  const ms = parseISODate(b).getTime() - parseISODate(a).getTime();
  return Math.round(ms / 86_400_000);
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function endOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return toISODate(new Date(y, m, 0));
}

export function daysInMonth(monthKey: string): number {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** "2026-09-28" -> "2026-09" */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** "2026-09" -> "Sep 2026" */
export function monthLabel(key: string, long = false): string {
  const [y, m] = key.split('-').map(Number);
  return `${(long ? MONTHS_LONG : MONTHS)[m - 1]} ${y}`;
}

/** Day of week, 0 = Sunday. */
export function dayOfWeek(iso: string): number {
  return parseISODate(iso).getDay();
}

export function weekdayShort(iso: string): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dayOfWeek(iso)];
}

export interface FinancialYear {
  /** "2026-27" */
  name: string;
  /** "26-27", used in document numbers */
  short: string;
  /** "2026-04-01" */
  start: string;
  /** "2027-03-31" */
  end: string;
}

/** Financial year (April - March) containing the given date. */
export function fyOf(iso: string): FinancialYear {
  const [y, m] = iso.split('-').map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return fyFromStartYear(startYear);
}

export function fyFromStartYear(startYear: number): FinancialYear {
  const endYear = startYear + 1;
  return {
    name: `${startYear}-${String(endYear).slice(2)}`,
    short: `${String(startYear).slice(2)}-${String(endYear).slice(2)}`,
    start: `${startYear}-04-01`,
    end: `${endYear}-03-31`,
  };
}

/** All month keys from a to b inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = startOfMonth(from);
  const last = monthKey(to);
  while (monthKey(cur) <= last && out.length < 1200) {
    out.push(monthKey(cur));
    cur = addMonths(cur, 1);
  }
  return out;
}

/** Every date from a to b inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  while (cur <= to && out.length < 4000) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export type DatePreset =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_7_days'
  | 'this_month'
  | 'last_month'
  | 'last_30_days'
  | 'this_quarter'
  | 'this_fy'
  | 'last_fy'
  | 'custom';

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_7_days: 'Last 7 days',
  this_month: 'This month',
  last_month: 'Last month',
  last_30_days: 'Last 30 days',
  this_quarter: 'This quarter',
  this_fy: 'This financial year',
  last_fy: 'Last financial year',
  custom: 'Custom range',
};

export interface DateRange {
  from: string;
  to: string;
}

/** Resolve a preset to a concrete date range. Quarters follow the financial year (Apr-Jun = Q1). */
export function presetRange(preset: DatePreset, today: string = todayISO()): DateRange {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'this_week': {
      // Week starts on Monday.
      const dow = (dayOfWeek(today) + 6) % 7;
      return { from: addDays(today, -dow), to: today };
    }
    case 'last_7_days':
      return { from: addDays(today, -6), to: today };
    case 'this_month':
      return { from: startOfMonth(today), to: today };
    case 'last_month': {
      const prev = addMonths(startOfMonth(today), -1);
      return { from: prev, to: endOfMonth(prev) };
    }
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'this_quarter': {
      const [y, m] = today.split('-').map(Number);
      const qStartMonth = [4, 7, 10, 1][Math.floor(((m + 8) % 12) / 3)];
      return { from: `${y}-${pad(qStartMonth)}-01`, to: today };
    }
    case 'this_fy':
      return { from: fyOf(today).start, to: today };
    case 'last_fy': {
      const fy = fyOf(addDays(fyOf(today).start, -1));
      return { from: fy.start, to: fy.end };
    }
    default:
      return { from: startOfMonth(today), to: today };
  }
}

/** Human description of a range, e.g. "01-04-2026 to 28-09-2026". */
export function describeRange(range: DateRange): string {
  if (range.from === range.to) return formatDate(range.from);
  return `${formatDate(range.from)} to ${formatDate(range.to)}`;
}
