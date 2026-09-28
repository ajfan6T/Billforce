/**
 * Human-readable labels for activity-log actions ("bill.create" -> "Created bill")
 * and the module groups used to filter the activity log. Unknown actions fall
 * back to a readable version of the key, so new modules never show raw codes.
 */
import { ATTENDANCE_LABELS, PAYMENT_MODE_LABELS, ROLE_LABELS, type AttendanceStatus, type PaymentMode, type Role } from './constants';
import { formatDate, formatDateTime, monthLabel } from './dates';
import { formatINR, formatIndianNumber, formatQty } from './money';
import { PERMISSIONS } from './permissions';

export const ACTIVITY_LABELS: Record<string, string> = {
  // Setup, login & users
  'setup.complete': 'Set up Billforce',
  'user.login': 'Logged in',
  'user.logout': 'Logged out',
  'user.login_failed': 'Failed login',
  'user.change_password': 'Changed own password',
  'user.recovered': 'Reset owner password with recovery code',
  'user.recovery_failed': 'Wrong recovery code entered',
  'user.recovery_regenerated': 'Generated new recovery code',
  'user.create': 'Added user',
  'user.update': 'Updated user',
  'user.activate': 'Re-activated user',
  'user.deactivate': 'Deactivated user',
  'user.reset_password': 'Reset user password',
  'role.update': 'Changed role permissions',

  // Sales & billing
  'bill.create': 'Created bill',
  'bill.edit': 'Edited bill',
  'bill.cancel': 'Cancelled bill',
  'bill.print': 'Printed bill',
  'bill.reprint': 'Reprinted bill',
  'return.create': 'Recorded sales return',
  'return.cancel': 'Cancelled sales return',
  'credit_note.create': 'Issued credit note',
  'credit_note.cancel': 'Cancelled credit note',
  'credit_note.print': 'Printed credit note',
  'credit_note.reprint': 'Reprinted credit note',
  'item.create': 'Added item',
  'item.update': 'Updated item',
  'item.delete': 'Deleted item',
  'item.activate': 'Re-activated item',
  'item.deactivate': 'Deactivated item',

  // Customers
  'customer.create': 'Added customer',
  'customer.update': 'Updated customer',
  'customer.delete': 'Deleted customer',
  'customer.activate': 'Re-activated customer',
  'customer.deactivate': 'Deactivated customer',
  'receipt.create': 'Payment received',
  'receipt.update': 'Edited payment received',
  'receipt.cancel': 'Cancelled payment received',
  'receipt.print': 'Printed payment receipt',

  // Suppliers & purchases
  'supplier.create': 'Added supplier',
  'supplier.update': 'Updated supplier',
  'supplier.delete': 'Deleted supplier',
  'supplier.activate': 'Re-activated supplier',
  'supplier.deactivate': 'Deactivated supplier',
  'purchase.create': 'Entered purchase bill',
  'purchase.update': 'Edited purchase bill',
  'purchase.cancel': 'Cancelled purchase bill',
  'supplier_payment.create': 'Paid supplier',
  'supplier_payment.update': 'Edited supplier payment',
  'supplier_payment.cancel': 'Cancelled supplier payment',
  'supplier_payment.print': 'Printed supplier payment',

  // Accounts
  'expense.create': 'Recorded expense',
  'expense.update': 'Edited expense',
  'expense.cancel': 'Cancelled expense',
  'journal.create': 'Entered journal voucher',
  'journal.update': 'Edited journal voucher',
  'journal.cancel': 'Cancelled journal voucher',
  'capital.add': 'Capital introduced',
  'drawings.add': 'Recorded drawings',
  'transfer.create': 'Cash / bank transfer',
  'loan.create': 'Added loan',
  'loan.update': 'Updated loan',
  'loan.transaction': 'Loan transaction',
  'loan.transaction_edit': 'Edited loan transaction',
  'loan.transaction_cancel': 'Cancelled loan transaction',
  'account.create': 'Added account',
  'account.update': 'Updated account',
  'account.delete': 'Deleted account',
  'account.activate': 'Re-activated account',
  'account.deactivate': 'Deactivated account',
  'account.payment_defaults': 'Changed default payment accounts',
  'year.close': 'Closed financial year',
  'year.reopen': 'Re-opened financial year',

  // Employees
  'employee.create': 'Added employee',
  'employee.update': 'Updated employee',
  'employee.activate': 'Re-activated employee',
  'employee.leave': 'Marked employee as left',
  'attendance.mark': 'Marked attendance',
  'attendance.markAll': 'Marked attendance for everyone',
  'attendance.weeklyOff': 'Filled weekly offs',
  'attendance.clear': 'Cleared attendance',
  'salary.process': 'Processed salary',
  'salary.update': 'Edited salary slip',
  'salary.cancel': 'Cancelled salary slip',
  'salary.pay': 'Paid salary',
  'salary.payment_cancel': 'Cancelled salary payment',
  'salary.paymentCancel': 'Cancelled salary payment',
  'salary.processAll': 'Processed salaries for the month',
  'salary.print': 'Printed salary slip',
  'advance.create': 'Gave advance',
  'advance.cancel': 'Cancelled advance',

  // Settings & data
  'settings.update': 'Changed settings',
  'backup.create': 'Backed up data',
  'backup.auto': 'Automatic backup',
  'backup.copy': 'Saved a backup copy',
  'backup.folder': 'Changed backup folder',
  'backup.failed': 'Backup failed',
  'backup.restore': 'Restored data from backup',
  'import.items': 'Imported items',
  'import.customers': 'Imported customers',
  'import.suppliers': 'Imported suppliers',
  'import.employees': 'Imported employees',
  'report.export': 'Exported report',
};

const VERBS: Record<string, string> = {
  create: 'Added',
  add: 'Added',
  update: 'Updated',
  edit: 'Edited',
  cancel: 'Cancelled',
  delete: 'Deleted',
  remove: 'Removed',
  activate: 'Re-activated',
  deactivate: 'Deactivated',
  print: 'Printed',
  reprint: 'Reprinted',
  restore: 'Restored',
  close: 'Closed',
  reopen: 'Re-opened',
  pay: 'Paid',
  export: 'Exported',
  import: 'Imported',
  mark: 'Marked',
  clear: 'Cleared',
};

const words = (s: string) => s.replace(/[_-]+/g, ' ').trim();
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "bill.create" -> "Created bill"; unknown keys become readable text ("stock_item.merge" -> "Stock item: merge"). */
export function activityLabel(action: string): string {
  const known = ACTIVITY_LABELS[action];
  if (known) return known;
  const dot = action.indexOf('.');
  if (dot < 0) return capitalize(words(action));
  const entity = words(action.slice(0, dot));
  const verb = action.slice(dot + 1);
  const v = VERBS[verb];
  if (v) return `${v} ${entity}`;
  return `${capitalize(entity)}: ${words(verb)}`;
}

export interface ActivityModule {
  key: string;
  label: string;
  /** Action prefixes (e.g. "bill.") or exact actions that belong to the group. */
  prefixes: string[];
}

/** Groups for the "What" filter of the activity log. */
export const ACTIVITY_MODULES: ActivityModule[] = [
  { key: 'sales', label: 'Bills, returns & items', prefixes: ['bill.', 'return.', 'credit_note.', 'item.'] },
  { key: 'customers', label: 'Customers & payments received', prefixes: ['customer.', 'receipt.'] },
  { key: 'purchases', label: 'Suppliers & purchases', prefixes: ['supplier.', 'purchase.', 'supplier_payment.'] },
  { key: 'accounts', label: 'Accounts & expenses', prefixes: ['expense.', 'journal.', 'capital.', 'drawings.', 'transfer.', 'loan.', 'account.', 'year.'] },
  { key: 'employees', label: 'Employees & salary', prefixes: ['employee.', 'attendance.', 'salary.', 'advance.'] },
  { key: 'logins', label: 'Logins & passwords', prefixes: ['user.login', 'user.logout', 'user.change_password', 'user.recover'] },
  { key: 'users', label: 'Users & permissions', prefixes: ['user.create', 'user.update', 'user.activate', 'user.deactivate', 'user.reset_password', 'role.'] },
  { key: 'settings', label: 'Settings, backups & imports', prefixes: ['settings.', 'backup.', 'import.', 'setup.', 'report.'] },
];

/** Activity actions whose entity no longer exists (no link to open). */
export function isDeleteAction(action: string): boolean {
  return /\.(delete|remove)$/.test(action);
}

/* ------------------------------ Details in plain words ------------------------------ */
/*
 * Modules store `details` for the audit trail in their own internal shape: money in paise, ISO dates,
 * ids and field names such as "journalEntryId". The activity log shows them to the shop owner, so they are
 * turned into labelled, formatted rows here: ₹ with Indian grouping, DD-MM-YYYY dates, readable labels,
 * and internal bookkeeping fields (ids, revision numbers, timestamps of the edit itself) left out.
 * The raw details stay available behind "Technical details".
 */

export interface ActivityChangeRow {
  label: string;
  before: string;
  after: string;
}

export interface ActivityFactRow {
  label: string;
  value: string;
}

export interface ActivityDetailsView {
  /** What changed (edits): one row per changed field. */
  changes: ActivityChangeRow[];
  /** Other facts recorded with the action (reason, total, file...). */
  facts: ActivityFactRow[];
}

/** Last word of a field name that means the value is money (paise). */
const MONEY_WORDS = new Set([
  'amount', 'amounts', 'total', 'subtotal', 'rate', 'paid', 'credit', 'debit', 'balance', 'limit', 'gross', 'net', 'bonus',
  'deduction', 'deductions', 'recovery', 'profit', 'loss', 'drawings', 'due', 'discount', 'price', 'payable', 'receivable',
  'principal', 'interest', 'salary', 'wage', 'wages', 'refund', 'outstanding', 'advance', 'charge', 'charges', 'fee', 'fees',
  'cash', 'bank', 'upi', 'income', 'expense', 'expenses', 'payment', 'change', 'tendered',
]);
const PERCENT_WORDS = new Set(['pct', 'percent', 'percentage']);

/** Internal fields: never shown to the user (they are in "Technical details"). */
const HIDDEN_KEYS = new Set([
  'id', 'revision', 'printcount', 'journalentryid', 'entryid', 'closingentryid', 'voidedclosingentryid', 'mapping', 'posting',
  'revisions', 'createdby', 'createdat', 'updatedby', 'updatedat', 'createdbyname', 'updatedbyname', 'passwordhash', 'password',
  'hash', 'salt', 'sourcetype', 'sourceid', 'usagecount', 'lastusedat', 'sortorder', 'seq',
]);

/** Better labels than the field name gives. Keys are lower-case without separators. */
const KEY_LABELS: Record<string, string> = {
  sizebytes: 'Size',
  paymentmode: 'Paid by',
  refundmode: 'Refund by',
  mode: 'Paid by',
  printcount: 'Times printed',
  items: 'Lines',
  customername: 'Customer',
  customerphone: 'Customer phone',
  suppliername: 'Supplier',
  accountname: 'Account',
  employeename: 'Employee',
  receiptno: 'Receipt no.',
  billno: 'Bill no.',
  voucherno: 'Voucher no.',
  purchaseno: 'Purchase no.',
  paymentno: 'Payment no.',
  creditnoteno: 'Credit note no.',
  isactive: 'Active',
  fullname: 'Full name',
  mustchangepassword: 'Must choose a new password',
  path: 'File',
  file: 'File',
  from: 'From',
  to: 'To',
  safetybackup: 'Safety copy saved to',
  backup: 'Safety backup',
  by: 'By',
  when: 'When',
  duplicatemode: 'Rows already in Billforce',
  counts: 'Rows',
  subtitle: 'Report',
  pruned: 'Old automatic backups removed',
  added: 'Allowed',
  removed: 'No longer allowed',
  cancelreason: 'Cancel reason',
  paymentscancelled: 'Payments cancelled',
  ratechanges: 'Rates changed while billing',
  listrate: 'List rate',
  advancerecovery: 'Advance recovered',
  paiddays: 'Paid days',
  paynow: 'Paid now',
  leavedate: 'Last working day',
  removedattendance: 'Attendance entries removed',
  onlyunmarked: 'Only days not yet marked',
  openingbalance: 'Opening balance',
  openingadvance: 'Opening advance',
  openingoutstanding: 'Opening outstanding',
  creditlimit: 'Credit limit',
  interestrate: 'Interest rate',
  netprofit: 'Net profit',
  paperwidth: 'Paper width',
  autolockminutes: 'Lock after (minutes)',
  keepcount: 'Automatic backups to keep',
  upiid: 'UPI ID',
  folder: 'Backup folder',
  upiqr: 'UPI QR code',
  gstin: 'GSTIN',
};

/** How a number in the details is shown. */
export type DetailFormat = 'money' | 'count' | 'number' | 'weekday' | 'percent' | 'bytes' | 'mm';

interface FieldSpec {
  format?: DetailFormat;
  label?: string;
}

/** Field formats and labels for every action. Keys are lower-case without separators. */
const COMMON_FIELDS: Record<string, FieldSpec> = {
  roundoff: { format: 'money', label: 'Round off' },
};

/**
 * Numbers whose field name does not say (or says wrongly) what they are, per action; "employee.*" covers
 * every action of the module. A format given for an object (e.g. the "counts" of an import) applies to every
 * number inside it. These come before the rules that go by the field name (MONEY_WORDS).
 */
const ACTION_FIELDS: Record<string, Record<string, FieldSpec>> = {
  // weekly_off is the day of the week (0 = Sunday).
  'employee.*': { weeklyoff: { format: 'weekday', label: 'Weekly off' }, removedattendance: { format: 'count' } },
  'attendance.markAll': {
    marked: { format: 'count', label: 'Employees marked' },
    weeklyoff: { format: 'count', label: 'On weekly off' },
    alreadymarked: { format: 'count', label: 'Already marked (left as they were)' },
    locked: { format: 'count', label: 'Skipped (salary already processed)' },
    status: { label: 'Marked as' },
    onlyunmarked: { label: 'Only employees not yet marked' },
  },
  'attendance.weeklyOff': {
    filled: { format: 'count', label: 'Days marked weekly off' },
    employees: { format: 'count', label: 'Employees' },
    locked: { format: 'count', label: 'Skipped (salary already processed)' },
  },
  // Row counts of an import: { total, create, update, skip, errors }.
  'import.*': {
    counts: { format: 'count' },
    create: { label: 'Added' },
    update: { label: 'Updated' },
    skip: { label: 'Already there' },
    errors: { label: 'With errors' },
  },
  'bill.*': { items: { format: 'count' } },
  'account.*': { entrycount: { format: 'count', label: 'Entries' } },
  'settings.*': { copies: { format: 'count' }, keepcount: { format: 'count' }, autolockminutes: { format: 'count' } },
};

type Fields = Record<string, FieldSpec>;

/** The field specs that apply to an action. */
function fieldsFor(action: string): Fields {
  const dot = action.indexOf('.');
  const moduleWide = dot > 0 ? ACTION_FIELDS[`${action.slice(0, dot)}.*`] : undefined;
  return { ...COMMON_FIELDS, ...moduleWide, ...ACTION_FIELDS[action] };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** When `before` / `after` are single values, what they are (by action). */
const ACTION_VALUE_KEYS: Record<string, string> = {
  'item.update': 'rate',
  'backup.folder': 'folder',
};

const ACRONYMS: Record<string, string> = { upi: 'UPI', id: 'ID', gst: 'GST', gstin: 'GSTIN', pan: 'PAN', ifsc: 'IFSC', qr: 'QR', no: 'no.', pct: '%' };

/** "openingBalance" / "opening_balance" -> ["opening", "balance"] */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.\-\s]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
}

const flatKey = (key: string) => keyWords(key).join('');

function isHiddenKey(key: string): boolean {
  const w = keyWords(key);
  const last = w[w.length - 1];
  return HIDDEN_KEYS.has(w.join('')) || last === 'id' || last === 'ids';
}

/** "openingBalance" -> "Opening balance" */
export function detailLabel(key: string, fields: Fields = COMMON_FIELDS): string {
  const own = fields[flatKey(key)]?.label;
  if (own) return own;
  const known = KEY_LABELS[flatKey(key)];
  if (known) return known;
  const text = keyWords(key)
    .map((w) => ACRONYMS[w] ?? w)
    .join(' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Value';
}

function isMoneyKey(key: string): boolean {
  const w = keyWords(key);
  const last = w[w.length - 1];
  if (!last || PERCENT_WORDS.has(last)) return false;
  if (last === 'rate' && w.includes('interest')) return false;
  if (w.includes('count') || w.includes('days') || w.includes('qty') || w.includes('quantity')) return false;
  return MONEY_WORDS.has(last);
}

function isPercentKey(key: string): boolean {
  const w = keyWords(key);
  const last = w[w.length - 1];
  return PERCENT_WORDS.has(last) || (last === 'rate' && w.includes('interest'));
}

const PERMISSION_LABELS = new Map<string, string>(PERMISSIONS.map((p) => [p.key, p.label]));
const ENUM_KEYS = new Set(['mode', 'paymentmode', 'refundmode', 'status', 'direction', 'kind', 'duplicatemode', 'section', 'when', 'role', 'type', 'fontsize', 'upiqr', 'defaultpaymentmode', 'salarytype']);

function humanize(code: string): string {
  const w = code.replace(/[_-]+/g, ' ').trim();
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

function formatBytesText(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${formatIndianNumber(n / 1024, n < 10 * 1024 ? 1 : 0)} KB`;
  return `${formatIndianNumber(n / (1024 * 1024), 1)} MB`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function formatString(key: string, v: string): string {
  if (ISO_DATE_RE.test(v)) return formatDate(v);
  if (TIMESTAMP_RE.test(v)) return formatDateTime(v);
  const fk = flatKey(key);
  if (MONTH_RE.test(v) && fk.endsWith('month')) return monthLabel(v, true);
  if (PERMISSION_LABELS.has(v)) return PERMISSION_LABELS.get(v)!;
  if (/^[PAHLW]$/.test(v) && (fk === 'from' || fk === 'to' || fk === 'status')) return ATTENDANCE_LABELS[v as AttendanceStatus];
  if (ENUM_KEYS.has(fk) || fk.endsWith('mode')) {
    if (v in PAYMENT_MODE_LABELS) return PAYMENT_MODE_LABELS[v as PaymentMode];
    if (v in ROLE_LABELS) return ROLE_LABELS[v as Role];
    if (/^[a-z][a-z0-9 _-]*$/.test(v)) return humanize(v);
  }
  return v;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function formatNumberAs(format: DetailFormat, v: number): string {
  switch (format) {
    case 'money':
      return Number.isInteger(v) ? formatINR(v) : formatQty(v);
    case 'count':
      return Number.isInteger(v) ? formatIndianNumber(v, 0) : formatQty(v);
    case 'weekday':
      return WEEKDAYS[v] ?? formatQty(v);
    case 'percent':
      return `${formatQty(v)}%`;
    case 'bytes':
      return formatBytesText(v);
    case 'mm':
      return `${v} mm`;
    default:
      return formatQty(v);
  }
}

/**
 * One value, formatted for reading. `key` is the field it belongs to (decides money, dates, labels);
 * `fields` are the formats of the action (see ACTION_FIELDS) and `inherited` the format of the object it is in.
 */
export function formatDetailValue(key: string, v: unknown, fields: Fields = COMMON_FIELDS, inherited?: DetailFormat): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const format = fields[flatKey(key)]?.format ?? inherited;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    if (format) return formatNumberAs(format, v);
    const fk = flatKey(key);
    if (fk === 'sizebytes' || fk.endsWith('bytes')) return formatBytesText(v);
    if (isPercentKey(key)) return `${formatQty(v)}%`;
    if (fk === 'paperwidth') return `${v} mm`;
    if (isMoneyKey(key) && Number.isInteger(v)) return formatINR(v);
    return formatQty(v);
  }
  if (typeof v === 'string') return formatString(key, v);
  if (Array.isArray(v)) {
    if (!v.length) return 'None';
    if (v.every((x) => typeof x === 'number') && !format && !isMoneyKey(key)) return formatIndianNumber(v.length, 0); // lists of ids: how many
    if (v.every((x) => x === null || typeof x !== 'object')) return v.map((x) => formatDetailValue(key, x, fields, format)).join(', ');
    return v.map((x) => formatDetailValue(key, x, fields, format)).join('\n');
  }
  if (isPlainObject(v)) {
    // Opening balance style: { amount, direction }
    if (typeof v.amount === 'number' && typeof v.direction === 'string' && Object.keys(v).length === 2) {
      return v.amount ? `${formatINR(v.amount)} (${humanize(v.direction).toLowerCase()})` : formatINR(0);
    }
    // bill.edit style: { label, before, after }
    if (typeof v.label === 'string' && 'before' in v && 'after' in v) {
      return `${v.label}: ${v.before ?? '—'} → ${v.after ?? '—'}`;
    }
    const parts = Object.entries(v)
      .filter(([k]) => !isHiddenKey(k))
      .map(([k, x]) => `${detailLabel(k, fields)}: ${formatDetailValue(k, x, fields, format)}`);
    return parts.length ? parts.join(', ') : '—';
  }
  return String(v);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Turn the stored details of an activity entry into rows a shop owner can read. */
export function describeActivityDetails(action: string, details: unknown): ActivityDetailsView {
  const view: ActivityDetailsView = { changes: [], facts: [] };
  if (details === null || details === undefined || details === '') return view;
  const fields = fieldsFor(action);
  const label = (k: string) => detailLabel(k, fields);
  const value = (k: string, v: unknown) => formatDetailValue(k, v, fields);
  if (!isPlainObject(details)) {
    view.facts.push({ label: 'Details', value: value('details', details) });
    return view;
  }
  const rest = new Set(Object.keys(details));

  // Changes already described by the module (bill edits): [{ label, before, after }]
  const listed = details.changes;
  if (Array.isArray(listed) && listed.every((c) => isPlainObject(c) && typeof c.label === 'string')) {
    for (const c of listed as Array<{ label: string; before?: unknown; after?: unknown }>) {
      view.changes.push({ label: c.label, before: c.before == null ? '—' : String(c.before), after: c.after == null ? '—' : String(c.after) });
    }
    rest.delete('changes');
  }

  if ('before' in details && 'after' in details) {
    const before = details.before;
    const after = details.after;
    if (isPlainObject(before) && isPlainObject(after)) {
      // Only fields the change was about: `after` may be the input of an edit (a subset of the record).
      for (const k of Object.keys(after)) {
        if (isHiddenKey(k) || same(before[k], after[k])) continue;
        const b = before[k];
        const a = after[k];
        // A group of settings (e.g. document number prefixes): one row per changed entry.
        if (isPlainObject(b) && isPlainObject(a) && !('amount' in a && 'direction' in a)) {
          for (const sub of Object.keys(a)) {
            if (isHiddenKey(sub) || same(b[sub], a[sub])) continue;
            view.changes.push({ label: `${label(k)}: ${label(sub)}`, before: value(sub, b[sub]), after: value(sub, a[sub]) });
          }
          continue;
        }
        view.changes.push({ label: label(k), before: k in before ? value(k, b) : '—', after: value(k, a) });
      }
      rest.delete('before');
      rest.delete('after');
    } else if (Array.isArray(before) && Array.isArray(after)) {
      // e.g. a role's permission list: "added" / "removed" (when given) say it better.
      if (!('added' in details) && !('removed' in details) && !same(before, after)) {
        view.changes.push({ label: 'Value', before: value('value', before), after: value('value', after) });
      }
      rest.delete('before');
      rest.delete('after');
    } else if (!isPlainObject(before) && !isPlainObject(after) && !Array.isArray(before) && !Array.isArray(after)) {
      const key = ACTION_VALUE_KEYS[action] ?? 'value';
      if (!same(before, after)) view.changes.push({ label: label(key), before: value(key, before), after: value(key, after) });
      rest.delete('before');
      rest.delete('after');
    }
  }

  for (const k of rest) {
    if (isHiddenKey(k) && flatKey(k) !== 'printcount') continue;
    const v = details[k];
    if (v === null || v === undefined || v === '') continue;
    view.facts.push({ label: label(k), value: value(k, v) });
  }
  return view;
}
