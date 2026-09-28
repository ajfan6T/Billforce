/**
 * Import items, customers, suppliers and employees from Excel / CSV.
 *
 * preview: read the file, match columns to fields by their names, validate every
 *          row (required values, numbers, dates, duplicates inside the file and
 *          against existing records) and say what will happen to each row.
 * commit:  validate again and apply every valid row in ONE transaction using the
 *          modules' own create / update functions (so opening balances post to
 *          the ledger exactly like entering them by hand).
 */
import type { Ctx } from '../../context';
import { assertCan, requireSession } from '../../context';
import { AppError, fail } from '../../errors';
import { logActivity } from '../../audit';
import { getSection } from '../../settings';
import { isDateInClosedYear } from '../../accounting/periods';
import type { Permission } from '../../../shared/permissions';
import { formatDate, fyOf, toISODate } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import { rowsToCsv } from '../../export/csv';
import { rowsToXlsx } from '../../export/xlsx';
import { createItem, getItem, setItemActive, updateItem, type Item } from '../items/service';
import { createCustomer, getCustomer, updateCustomer } from '../customers/service';
import { createSupplier, getSupplier, updateSupplier } from '../suppliers/service';
import { createEmployee, getEmployeeRow, openingAdvanceOf, updateEmployee, type EmployeeRow } from '../employees/service';
import { openingDebit, phoneKey } from '../customers/common';
import { cellText, normHeader, normHeaderFull, parseAmount, parseDateCell, phoneText, readSheet, type Cell, type ParsedSheet, type SheetRow } from './sheet';

export const IMPORT_TYPES = ['items', 'customers', 'suppliers', 'employees'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];
export type DuplicateMode = 'skip' | 'update';

export interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
  /** Column names that mean this field (compared after lower-casing and removing punctuation). */
  synonyms: string[];
}

interface TypeDef {
  type: ImportType;
  label: string;
  singular: string;
  permission: Permission;
  fields: FieldDef[];
  examples: string[][];
  notes: (ctx: Ctx) => string[];
}

const PHONE = ['phone', 'mobile', 'mobile no', 'mobile number', 'phone no', 'phone number', 'contact no', 'contact number', 'whatsapp', 'whatsapp no', 'whatsapp number', 'cell', 'tel', 'telephone', 'mob', 'mob no', 'ph', 'ph no', 'phone mobile'];
const ADDRESS = ['address', 'full address', 'city', 'location', 'area', 'place'];
const EMAIL = ['email', 'email id', 'e mail', 'mail', 'email address', 'e mail id'];
const OPENING = ['opening balance', 'opening', 'balance', 'outstanding', 'opening due', 'opening amount', 'previous balance', 'old balance', 'balance amount', 'pending amount', 'amount due', 'due amount', 'closing balance'];
const OPENING_TYPE = ['balance type', 'type', 'dr cr', 'drcr', 'dr or cr', 'direction', 'opening type', 'opening balance type', 'nature', 'balance dr cr'];

const DEFS: Record<ImportType, TypeDef> = {
  items: {
    type: 'items',
    label: 'Items & rates',
    singular: 'item',
    permission: 'items.manage',
    fields: [
      { key: 'name', label: 'Item name', required: true, synonyms: ['item name', 'item', 'name', 'product', 'product name', 'item description', 'description', 'particulars', 'goods', 'service', 'item service'] },
      { key: 'code', label: 'Code', hint: 'Short code or barcode for quick search', synonyms: ['code', 'item code', 'sku', 'barcode', 'bar code', 'product code', 'short code'] },
      { key: 'unit', label: 'Unit', hint: 'pcs, kg, ltr, box… (default pcs)', synonyms: ['unit', 'units', 'uom', 'unit of measure', 'unit of measurement', 'measure'] },
      { key: 'rate', label: 'Rate', hint: 'Default selling rate in ₹', synonyms: ['rate', 'price', 'selling price', 'sale price', 'sales price', 'selling rate', 'sale rate', 'mrp', 'default rate', 'unit price', 'rate per unit', 'price per unit', 'amount', 'sp'] },
      { key: 'category', label: 'Category', synonyms: ['category', 'group', 'item group', 'type', 'department', 'section', 'item category'] },
    ],
    examples: [
      ['Sugar 1 kg', 'SUG1', 'pcs', '48.00', 'Grocery'],
      ['Basmati Rice 25 kg', 'BR25', 'bag', '1,850.00', 'Grocery'],
    ],
    notes: () => [
      'One row per item. Keep the first row (the column names) as it is and delete the two example rows.',
      'Only the item name is required. Rate is the default selling rate in rupees, e.g. 48 or 1,250.50 (no ₹ needed).',
      'Unit can be pcs, kg, g, ltr, ml, mtr, box, pack, dozen, bag, bottle… If left blank, pcs is used.',
      'An item that already exists (same name) is skipped, or updated if you choose "Update it with the file".',
    ],
  },
  customers: {
    type: 'customers',
    label: 'Customers',
    singular: 'customer',
    permission: 'customers.manage',
    fields: [
      { key: 'name', label: 'Name', required: true, synonyms: ['name', 'customer name', 'customer', 'party name', 'party', 'client name', 'client', 'account name', 'full name'] },
      { key: 'phone', label: 'Phone', synonyms: PHONE },
      { key: 'address', label: 'Address', synonyms: ADDRESS },
      { key: 'email', label: 'Email', synonyms: EMAIL },
      { key: 'creditLimit', label: 'Credit limit', hint: 'Maximum credit in ₹ (blank = no limit)', synonyms: ['credit limit', 'limit', 'max credit', 'credit allowed', 'udhar limit'] },
      { key: 'opening', label: 'Opening balance', hint: 'Amount due on your books start date', synonyms: OPENING },
      { key: 'openingType', label: 'Balance type', hint: 'Receivable (they owe you) or Advance', synonyms: OPENING_TYPE },
    ],
    examples: [
      ['Anita Desai', '98200 11111', 'Kothrud, Pune', 'anita@example.com', '5,000', '1,250.50', 'Receivable'],
      ['Rahul Traders', '98765 43210', 'MG Road, Pune', '', '', '500', 'Advance'],
    ],
    notes: (ctx) => [
      'One row per customer. Keep the first row (the column names) as it is and delete the two example rows.',
      'Only the name is required. Phone numbers must be unique - a customer with the same phone number (or the same name, when there is no phone) is treated as already existing.',
      `Opening balance: what the customer owed you (Receivable) or the advance you were holding for them (Advance) on your books start date, ${formatDate(getSection(ctx, 'accounts').booksStartDate)}. You can also write "1,250 Dr" / "500 Cr", or a minus sign for an advance.`,
      'Amounts can be written like 1,23,456.50 or 123456.5 (no ₹ needed).',
    ],
  },
  suppliers: {
    type: 'suppliers',
    label: 'Suppliers',
    singular: 'supplier',
    permission: 'suppliers.manage',
    fields: [
      { key: 'name', label: 'Name', required: true, synonyms: ['name', 'supplier name', 'supplier', 'vendor name', 'vendor', 'party name', 'party', 'company name', 'company', 'firm name', 'firm', 'distributor', 'wholesaler'] },
      { key: 'phone', label: 'Phone', synonyms: PHONE },
      { key: 'address', label: 'Address', synonyms: ADDRESS },
      { key: 'contactPerson', label: 'Contact person', synonyms: ['contact person', 'contact name', 'person', 'contact', 'representative', 'salesman', 'owner name', 'contact person name'] },
      { key: 'email', label: 'Email', synonyms: EMAIL },
      { key: 'opening', label: 'Opening balance', hint: 'Amount you owed them on your books start date', synonyms: OPENING },
      { key: 'openingType', label: 'Balance type', hint: 'Payable (you owe them) or Advance', synonyms: OPENING_TYPE },
    ],
    examples: [
      ['Balaji Distributors', '98220 55555', 'Market Yard, Pune', 'Suresh Patil', '', '12,500.00', 'Payable'],
      ['Fresh Dairy Farm', '90110 22222', 'Hadapsar, Pune', 'Mahesh', 'dairy@example.com', '', ''],
    ],
    notes: (ctx) => [
      'One row per supplier. Keep the first row (the column names) as it is and delete the two example rows.',
      'Only the name is required. A supplier with the same name is treated as already existing.',
      `Opening balance: what you owed the supplier (Payable) or an advance you had paid them (Advance) on your books start date, ${formatDate(getSection(ctx, 'accounts').booksStartDate)}. You can also write "12,500 Cr" / "2,000 Dr".`,
    ],
  },
  employees: {
    type: 'employees',
    label: 'Employees',
    singular: 'employee',
    permission: 'employees.manage',
    fields: [
      { key: 'name', label: 'Name', required: true, synonyms: ['name', 'employee name', 'employee', 'staff name', 'staff', 'worker name', 'worker', 'full name'] },
      { key: 'phone', label: 'Phone', synonyms: PHONE },
      { key: 'designation', label: 'Designation', synonyms: ['designation', 'role', 'post', 'position', 'job', 'job title', 'title', 'work', 'department'] },
      { key: 'joinDate', label: 'Joining date', hint: 'DD-MM-YYYY', synonyms: ['joining date', 'join date', 'date of joining', 'doj', 'joined', 'joined on', 'start date', 'joining', 'date joined'] },
      { key: 'salaryType', label: 'Salary type', hint: 'Monthly or Daily', synonyms: ['salary type', 'pay type', 'wage type', 'type', 'salary basis', 'basis', 'payment type', 'monthly daily'] },
      { key: 'salaryAmount', label: 'Salary amount', hint: 'Per month, or per day for daily wages', synonyms: ['salary amount', 'salary', 'monthly salary', 'wage', 'wages', 'daily wage', 'daily wages', 'pay', 'amount', 'rate', 'salary per month', 'wage per day', 'per day wage'] },
      { key: 'address', label: 'Address', synonyms: ADDRESS },
      { key: 'openingAdvance', label: 'Advance given', hint: 'Advance not yet recovered on your books start date', synonyms: ['advance given', 'advance', 'opening advance', 'advance balance', 'outstanding advance', 'loan', 'advance pending'] },
    ],
    examples: [
      ['Ramesh Kumar', '98900 12345', 'Salesman', '01-06-2024', 'Monthly', '15,000', 'Kothrud, Pune', '2,000'],
      ['Sunita Pawar', '98111 22233', 'Helper', '15-01-2025', 'Daily', '600', '', ''],
    ],
    notes: (ctx) => [
      'One row per employee. Keep the first row (the column names) as it is and delete the two example rows.',
      'Only the name is required. Dates are day first: 15-06-2024 or 15/06/2024.',
      'Salary type is Monthly or Daily. Salary amount is per month for monthly staff and per day for daily wages.',
      `Advance given: advance money not yet recovered from the employee on your books start date, ${formatDate(getSection(ctx, 'accounts').booksStartDate)}.`,
    ],
  },
};

export function importTypes(ctx: Ctx) {
  return IMPORT_TYPES.map((t) => {
    const d = DEFS[t];
    return {
      type: t,
      label: d.label,
      singular: d.singular,
      allowed: ctxCan(ctx, d.permission),
      fields: d.fields.map((f) => ({ key: f.key, label: f.label, required: !!f.required, hint: f.hint ?? null })),
      notes: d.notes(ctx),
    };
  });
}

function ctxCan(ctx: Ctx, p: Permission): boolean {
  const s = ctx.session;
  return !!s && (s.role === 'owner' || s.permissions.includes(p));
}

/* ------------------------------ Templates ------------------------------ */

export async function buildTemplate(ctx: Ctx, type: ImportType, format: 'xlsx' | 'csv'): Promise<{ fileName: string; data: Uint8Array | string }> {
  const d = DEFS[type];
  const header = d.fields.map((f) => f.label);
  const fileName = `Billforce ${d.label.replace(/[^A-Za-z ]/g, '').trim()} template.${format}`.replace(/\s+/g, '-');
  if (format === 'csv') return { fileName, data: rowsToCsv(header, d.examples) };
  return { fileName, data: await rowsToXlsx(d.label.slice(0, 31), header, d.examples, d.notes(ctx)) };
}

/* ------------------------------ Column mapping ------------------------------ */

export type Mapping = Record<string, number | null>;

export interface ColumnInfo {
  index: number;
  header: string;
  samples: string[];
}

function headerMatches(field: FieldDef, header: string): boolean {
  const a = normHeader(header);
  const b = normHeaderFull(header);
  return field.synonyms.some((s) => {
    const n = normHeader(s);
    return n === a || n === b;
  });
}

function findHeaderRow(def: TypeDef, rows: SheetRow[]): number {
  let best = 0;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = rows[i].cells.map(cellText);
    const score = def.fields.filter((f) => cells.some((c) => c && headerMatches(f, c))).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

export function autoMap(def: TypeDef, headers: string[]): Mapping {
  const used = new Set<number>();
  const mapping: Mapping = {};
  for (const f of def.fields) {
    mapping[f.key] = null;
    outer: for (const syn of f.synonyms) {
      const n = normHeader(syn);
      for (let i = 0; i < headers.length; i++) {
        if (used.has(i) || !headers[i]) continue;
        if (normHeader(headers[i]) === n || normHeaderFull(headers[i]) === n) {
          mapping[f.key] = i;
          used.add(i);
          break outer;
        }
      }
    }
  }
  return mapping;
}

/* ------------------------------ Row validation ------------------------------ */

export interface PreviewRow {
  rowNo: number;
  /** Values as they will be saved, formatted for display (raw text when invalid). */
  values: Record<string, string>;
  errors: string[];
  fieldErrors: Record<string, string>;
  warnings: string[];
  action: 'create' | 'update' | 'skip';
  /** Why the row is skipped, or what will change. */
  note: string | null;
}

export interface PreviewCounts {
  total: number;
  create: number;
  update: number;
  skip: number;
  errors: number;
}

export interface ImportPreview {
  type: ImportType;
  fileName: string;
  sheetName: string | null;
  headerRowNo: number;
  columns: ColumnInfo[];
  fields: Array<{ key: string; label: string; required: boolean; hint: string | null }>;
  mapping: Mapping;
  missingRequired: string[];
  duplicateMode: DuplicateMode;
  rows: PreviewRow[];
  counts: PreviewCounts;
}

interface Prepared extends PreviewRow {
  data: Record<string, any> | null;
  matchId: number | null;
  reactivate?: boolean;
}

class RowCtx {
  values: Record<string, string> = {};
  errors: string[] = [];
  fieldErrors: Record<string, string> = {};
  warnings: string[] = [];
  constructor(
    private readonly def: TypeDef,
    private readonly cells: Cell[],
    private readonly mapping: Mapping,
  ) {}
  raw(key: string): Cell {
    const idx = this.mapping[key];
    if (idx === null || idx === undefined) return null;
    const v = this.cells[idx];
    return v === undefined ? null : v;
  }
  has(key: string): boolean {
    return cellText(this.raw(key)) !== '';
  }
  label(key: string): string {
    return this.def.fields.find((f) => f.key === key)?.label ?? key;
  }
  error(key: string, msg: string): void {
    const full = /^is /.test(msg) ? `${this.label(key)} ${msg}` : `${this.label(key)}: ${msg}`;
    if (!this.fieldErrors[key]) this.fieldErrors[key] = msg;
    this.errors.push(full);
    if (this.values[key] === undefined) this.values[key] = cellText(this.raw(key));
  }
  /** Trimmed text (single spaces), undefined when empty. */
  text(key: string, max: number, opts: { multiline?: boolean } = {}): string | undefined {
    let s = cellText(this.raw(key));
    s = opts.multiline ? s.replace(/[ \t]+/g, ' ').replace(/\r\n?/g, '\n').trim() : s.replace(/\s+/g, ' ').trim();
    if (!s) return undefined;
    if (s.length > max) {
      this.error(key, `is too long (max ${max} characters)`);
      return undefined;
    }
    this.values[key] = s;
    return s;
  }
  phone(key: string): string | undefined {
    const s = phoneText(this.raw(key)).replace(/\s+/g, ' ').trim();
    if (!s) return undefined;
    if (s.length > 20 || !/^[0-9+\-\s()]*$/.test(s)) {
      this.error(key, `"${s}" is not a phone number (use digits, spaces and + - ( ) only)`);
      return undefined;
    }
    this.values[key] = s;
    return s;
  }
  email(key: string): string | undefined {
    const s = this.text(key, 120);
    if (s === undefined) return undefined;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
      this.error(key, `"${s}" is not a valid email address`);
      return undefined;
    }
    return s;
  }
  amount(key: string, opts: { max?: number } = {}): number | undefined {
    const r = parseAmount(this.raw(key));
    if (r === null) return undefined;
    if (!r.ok) {
      this.error(key, r.error);
      return undefined;
    }
    if (opts.max !== undefined && r.value > opts.max) {
      this.error(key, 'looks too large. Please check the amount');
      return undefined;
    }
    this.values[key] = formatINR(r.value);
    return r.value;
  }
  date(key: string, now: Date): string | undefined {
    const r = parseDateCell(this.raw(key), now);
    if (r === null) return undefined;
    if (!r.ok) {
      this.error(key, r.error);
      return undefined;
    }
    this.values[key] = formatDate(r.value);
    return r.value;
  }
}

const UNIT_ALIASES: Record<string, string> = {
  pc: 'pcs', pcs: 'pcs', piece: 'pcs', pieces: 'pcs', no: 'pcs', nos: 'pcs', number: 'pcs', numbers: 'pcs', unit: 'pcs', units: 'pcs', each: 'pcs', ea: 'pcs',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g', gr: 'g',
  l: 'ltr', lt: 'ltr', ltr: 'ltr', ltrs: 'ltr', litre: 'ltr', litres: 'ltr', liter: 'ltr', liters: 'ltr',
  ml: 'ml', mls: 'ml', millilitre: 'ml', milliliter: 'ml',
  m: 'mtr', mtr: 'mtr', mtrs: 'mtr', meter: 'mtr', meters: 'mtr', metre: 'mtr', metres: 'mtr',
  box: 'box', boxes: 'box', bx: 'box',
  pack: 'pack', packs: 'pack', pkt: 'pack', pkts: 'pack', packet: 'pack', packets: 'pack',
  dozen: 'dozen', doz: 'dozen', dz: 'dozen',
  pair: 'pair', pairs: 'pair', set: 'set', sets: 'set',
  bag: 'bag', bags: 'bag', bottle: 'bottle', bottles: 'bottle', btl: 'bottle',
  plate: 'plate', plates: 'plate', hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour', service: 'service',
};

export function normalizeUnit(s: string): string {
  const k = s.trim().toLowerCase().replace(/\.$/, '');
  return UNIT_ALIASES[k] ?? s.trim();
}

const OPENING_WORDS = {
  customer: {
    debit: ['receivable', 'due', 'dr', 'debit', 'to receive', 'receive', 'owes', 'owes us', 'owes you', 'lena', 'udhar', 'udhaar', 'baki', 'baaki', 'outstanding', 'pending', 'balance due', 'naam'],
    credit: ['advance', 'cr', 'credit', 'to pay', 'deposit', 'jama', 'advance received', 'paid in advance'],
  },
  supplier: {
    credit: ['payable', 'due', 'cr', 'credit', 'to pay', 'pay', 'we owe', 'you owe', 'dena', 'outstanding', 'pending', 'balance due', 'owed', 'jama'],
    debit: ['advance', 'dr', 'debit', 'advance paid', 'paid in advance', 'to receive', 'receivable', 'deposit', 'naam'],
  },
};

/** Opening balance as a debit on the party's control account (+ customer owes / supplier advance). */
function openingOf(r: RowCtx, party: 'customer' | 'supplier'): number | undefined {
  const rawAmount = r.raw('opening');
  let text = cellText(rawAmount);
  if (!text) return undefined;
  let suffix: 'debit' | 'credit' | null = null;
  if (typeof rawAmount === 'string') {
    const m = /^(.*?)\s*\b(dr|cr)\.?$/i.exec(text) ?? /^(dr|cr)\.?\s*(.*)$/i.exec(text);
    if (m) {
      const word = (/^(dr|cr)$/i.test(m[1]) ? m[1] : m[2]).toLowerCase();
      text = /^(dr|cr)$/i.test(m[1]) ? m[2] : m[1];
      suffix = word === 'dr' ? 'debit' : 'credit';
    }
  }
  const parsed = parseAmount(typeof rawAmount === 'number' ? rawAmount : text, { allowNegative: true });
  if (parsed === null) return undefined;
  if (!parsed.ok) {
    r.error('opening', parsed.error);
    return undefined;
  }
  let side: 'debit' | 'credit' | null = suffix;
  const typeText = normHeaderFull(cellText(r.raw('openingType')));
  if (typeText) {
    const words = OPENING_WORDS[party];
    const fromType = words.debit.includes(typeText) ? 'debit' : words.credit.includes(typeText) ? 'credit' : null;
    if (!fromType) {
      r.error('openingType', `"${cellText(r.raw('openingType'))}" is not understood. Use ${party === 'customer' ? 'Receivable or Advance' : 'Payable or Advance'}`);
      return undefined;
    }
    if (side && side !== fromType) {
      r.error('openingType', `does not match the amount (${suffix === 'debit' ? 'Dr' : 'Cr'})`);
      return undefined;
    }
    side = fromType;
  }
  const abs = Math.abs(parsed.value);
  let debit: number;
  if (side) debit = side === 'debit' ? abs : -abs;
  // No type given: customers + = owes you; suppliers + = you owe them.
  else debit = party === 'customer' ? parsed.value : -parsed.value;
  if (abs > 1_000_000_000_00) {
    r.error('opening', 'Amount is too large');
    return undefined;
  }
  const words = party === 'customer' ? (debit >= 0 ? 'receivable' : 'advance') : debit <= 0 ? 'payable' : 'advance';
  r.values.opening = abs ? `${formatINR(abs)} ${words}` : formatINR(0);
  if (typeText) r.values.openingType = words[0].toUpperCase() + words.slice(1);
  return debit;
}

function salaryTypeOf(r: RowCtx, amountHeader: string | null): 'monthly' | 'daily' | undefined {
  const t = normHeaderFull(cellText(r.raw('salaryType')));
  if (!t) {
    // "Daily wage" as the amount column name tells us the type.
    if (amountHeader && /\b(daily|day|wage|wages)\b/.test(normHeaderFull(amountHeader))) return 'daily';
    return undefined;
  }
  const monthly = ['monthly', 'month', 'per month', 'pm', 'p m', 'mahina', 'mahine', 'masik', 'salary', 'fixed', 'monthly salary', 'salaried'];
  const daily = ['daily', 'day', 'per day', 'pd', 'p d', 'daily wages', 'daily wage', 'wages', 'wage', 'dihadi', 'rozana', 'roz', 'daily basis'];
  if (monthly.includes(t)) {
    r.values.salaryType = 'Monthly';
    return 'monthly';
  }
  if (daily.includes(t)) {
    r.values.salaryType = 'Daily';
    return 'daily';
  }
  r.error('salaryType', `"${cellText(r.raw('salaryType'))}" is not understood. Use Monthly or Daily`);
  return undefined;
}

const MAX_SALARY = 1_000_000_000;

interface ExistingCustomer {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  email: string | null;
  credit_limit: number | null;
  opening_entry_id: number | null;
}
interface ExistingSupplier {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  email: string | null;
  contact_person: string | null;
  opening_entry_id: number | null;
}

const lower = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function describeChanges(pairs: Array<[string, unknown, unknown]>): string[] {
  return pairs.filter(([, a, b]) => b !== undefined && (a ?? null) !== (b ?? null)).map(([label]) => label);
}

function prepareRows(ctx: Ctx, def: TypeDef, sheet: ParsedSheet, headerIdx: number, mapping: Mapping, mode: DuplicateMode, headers: string[]): Prepared[] {
  const now = ctx.clock();
  const booksStart = getSection(ctx, 'accounts').booksStartDate;
  const openingLocked = isDateInClosedYear(ctx, booksStart);
  const lockedMsg = `cannot be added or changed because the financial year ${fyOf(booksStart).name} (your first year) is closed`;
  const dataRows = sheet.rows.slice(headerIdx + 1);
  const out: Prepared[] = [];

  // Existing records.
  const items = new Map<string, Item>();
  const customersByPhone = new Map<string, ExistingCustomer>();
  const customersByName = new Map<string, ExistingCustomer[]>();
  const suppliers = new Map<string, ExistingSupplier>();
  const employees = new Map<string, EmployeeRow>();
  if (def.type === 'items') {
    for (const r of ctx.db.all<{ id: number }>('SELECT id FROM items')) {
      const it = getItem(ctx, r.id);
      items.set(lower(it.name), it);
    }
  } else if (def.type === 'customers') {
    for (const c of ctx.db.all<ExistingCustomer>('SELECT id, name, phone, address, email, credit_limit, opening_entry_id FROM customers WHERE is_active = 1')) {
      const pk = phoneKey(c.phone);
      if (pk) customersByPhone.set(pk, c);
      const list = customersByName.get(lower(c.name)) ?? [];
      list.push(c);
      customersByName.set(lower(c.name), list);
    }
  } else if (def.type === 'suppliers') {
    for (const s of ctx.db.all<ExistingSupplier>('SELECT id, name, phone, address, email, contact_person, opening_entry_id FROM suppliers WHERE is_active = 1')) suppliers.set(lower(s.name), s);
  } else {
    for (const e of ctx.db.all<EmployeeRow>('SELECT * FROM employees WHERE is_active = 1')) employees.set(lower(e.name), e);
  }

  // Keys seen earlier in the file -> row number.
  const seen = new Map<string, number>();
  const seenNames = new Map<string, number>();

  for (const row of dataRows) {
    const r = new RowCtx(def, row.cells, mapping);
    let data: Record<string, any> | null = null;
    let matchId: number | null = null;
    let reactivate = false;
    let changes: string[] = [];
    let exists = false;

    const name = r.text('name', def.type === 'employees' ? 100 : 120);
    if (!name && !r.fieldErrors.name) r.error('name', 'is required');

    if (def.type === 'items') {
      const code = r.text('code', 40);
      const unitText = r.text('unit', 20);
      const unit = unitText ? normalizeUnit(unitText) : undefined;
      if (unit) r.values.unit = unit;
      const rate = r.amount('rate', { max: 1_000_000_000_00 });
      const category = r.text('category', 60);
      if (name) {
        const key = `n:${lower(name)}`;
        const earlier = seen.get(key);
        if (earlier) r.error('name', `same item as row ${earlier}`);
        else seen.set(key, row.rowNo);
        const ex = items.get(lower(name));
        if (ex) {
          exists = true;
          matchId = ex.id;
          reactivate = !ex.isActive;
          changes = describeChanges([
            ['name', ex.name, name],
            ['code', ex.code, code],
            ['unit', ex.unit, unit],
            ['rate', ex.rate, rate],
            ['category', ex.category, category],
          ]);
          if (reactivate) changes.push('re-activate');
        } else if (rate === undefined && !r.fieldErrors.rate) {
          r.warnings.push('No rate - you can type the rate when billing');
        }
      }
      data = { name, code, unit, rate, category };
    } else if (def.type === 'customers') {
      const phone = r.phone('phone');
      const address = r.text('address', 500, { multiline: true });
      const email = r.email('email');
      const creditLimit = r.amount('creditLimit');
      const opening = openingOf(r, 'customer');
      if (name) {
        const pk = phoneKey(phone);
        if (pk) {
          const earlier = seen.get(`p:${pk}`);
          if (earlier) r.error('phone', `same phone number as row ${earlier}`);
          else seen.set(`p:${pk}`, row.rowNo);
        } else {
          const earlier = seenNames.get(lower(name));
          if (earlier) r.error('name', `same name as row ${earlier}. Add a phone number if they are different people`);
        }
        if (!seenNames.has(lower(name))) seenNames.set(lower(name), row.rowNo);
        let ex: ExistingCustomer | undefined;
        if (pk) {
          ex = customersByPhone.get(pk);
          const sameName = customersByName.get(lower(name));
          if (!ex && sameName?.length) r.warnings.push(`Another customer named "${sameName[0].name}" already exists with a different phone - a new customer will be added`);
        } else {
          const list = customersByName.get(lower(name)) ?? [];
          if (list.length > 1) r.error('name', `${list.length} customers are named "${list[0].name}". Add the phone number so Billforce knows which one`);
          else ex = list[0];
        }
        if (ex) {
          exists = true;
          matchId = ex.id;
          const exOpening = openingDebit(ctx, 'customer', ex.id, ex.opening_entry_id);
          changes = describeChanges([
            ['name', ex.name, name],
            ['phone', ex.phone, phone],
            ['address', ex.address, address],
            ['email', ex.email, email],
            ['credit limit', ex.credit_limit, creditLimit],
            ['opening balance', exOpening, opening],
          ]);
          if (opening !== undefined && opening !== exOpening && openingLocked && mode === 'update') r.error('opening', lockedMsg);
        } else if (opening && openingLocked) r.error('opening', lockedMsg);
      }
      data = { name, phone, address, email, creditLimit, opening };
    } else if (def.type === 'suppliers') {
      const phone = r.phone('phone');
      const address = r.text('address', 500, { multiline: true });
      const contactPerson = r.text('contactPerson', 120);
      const email = r.email('email');
      const opening = openingOf(r, 'supplier');
      if (name) {
        const key = `n:${lower(name)}`;
        const earlier = seen.get(key);
        if (earlier) r.error('name', `same supplier as row ${earlier}`);
        else seen.set(key, row.rowNo);
        const ex = suppliers.get(lower(name));
        if (ex) {
          exists = true;
          matchId = ex.id;
          const exOpening = openingDebit(ctx, 'supplier', ex.id, ex.opening_entry_id);
          changes = describeChanges([
            ['name', ex.name, name],
            ['phone', ex.phone, phone],
            ['address', ex.address, address],
            ['contact person', ex.contact_person, contactPerson],
            ['email', ex.email, email],
            ['opening balance', exOpening, opening],
          ]);
          if (opening !== undefined && opening !== exOpening && openingLocked && mode === 'update') r.error('opening', lockedMsg);
        } else if (opening && openingLocked) r.error('opening', lockedMsg);
      }
      data = { name, phone, address, contactPerson, email, opening };
    } else {
      const phone = r.phone('phone');
      const designation = r.text('designation', 60);
      const joinDate = r.date('joinDate', now);
      const amountIdx = mapping.salaryAmount;
      const salaryType = salaryTypeOf(r, amountIdx === null || amountIdx === undefined ? null : headers[amountIdx] ?? null);
      const salaryAmount = r.amount('salaryAmount', { max: MAX_SALARY });
      const address = r.text('address', 300, { multiline: true });
      const openingAdvance = r.amount('openingAdvance', { max: MAX_SALARY });
      if (joinDate && joinDate > toISODate(now)) r.warnings.push('Joining date is in the future');
      if (name) {
        const key = `n:${lower(name)}`;
        const earlier = seen.get(key);
        if (earlier) r.error('name', `same employee as row ${earlier}`);
        else seen.set(key, row.rowNo);
        const ex = employees.get(lower(name));
        if (ex) {
          exists = true;
          matchId = ex.id;
          const exOpening = openingAdvanceOf(ctx, ex);
          changes = describeChanges([
            ['name', ex.name, name],
            ['phone', ex.phone, phone],
            ['designation', ex.designation, designation],
            ['joining date', ex.join_date, joinDate],
            ['salary type', ex.salary_type, salaryType],
            ['salary', ex.salary_amount, salaryAmount],
            ['address', ex.address, address],
            ['advance', exOpening, openingAdvance],
          ]);
          if (openingAdvance !== undefined && openingAdvance !== exOpening && openingLocked && mode === 'update') r.error('openingAdvance', lockedMsg);
        } else {
          if (openingAdvance && openingLocked) r.error('openingAdvance', lockedMsg);
          if (salaryAmount === undefined && !r.fieldErrors.salaryAmount) r.warnings.push('No salary amount - you can add it later');
        }
      }
      data = { name, phone, designation, joinDate, salaryType, salaryAmount, address, openingAdvance };
    }

    let action: PreviewRow['action'] = 'create';
    let note: string | null = null;
    if (r.errors.length) {
      action = 'skip';
      note = 'Has errors - will not be imported';
    } else if (exists) {
      if (mode === 'skip') {
        action = 'skip';
        note = `Already exists - skipped`;
      } else if (!changes.length) {
        action = 'skip';
        note = 'Already exists with the same details';
      } else {
        action = 'update';
        note = `Will update ${changes.join(', ')}`;
      }
    }
    out.push({
      rowNo: row.rowNo,
      values: r.values,
      errors: r.errors,
      fieldErrors: r.fieldErrors,
      warnings: r.warnings,
      action,
      note,
      data: r.errors.length ? null : data,
      matchId,
      reactivate,
    });
  }
  return out;
}

function countsOf(rows: PreviewRow[]): PreviewCounts {
  const c: PreviewCounts = { total: rows.length, create: 0, update: 0, skip: 0, errors: 0 };
  for (const r of rows) {
    if (r.errors.length) c.errors++;
    else c[r.action]++;
  }
  return c;
}

async function analyse(ctx: Ctx, type: ImportType, file: string, mappingIn: Mapping | null | undefined, mode: DuplicateMode) {
  requireSession(ctx);
  const def = DEFS[type];
  if (!def) throw fail.validation('Choose what to import');
  assertCan(ctx, def.permission, `You do not have permission to add ${def.label.toLowerCase()}, so you cannot import them.`);
  const sheet = await readSheet(file);
  if (!sheet.rows.length) throw fail.validation('The file is empty. Add a row of column names and at least one row of data.');
  const headerIdx = findHeaderRow(def, sheet.rows);
  const headerCells = sheet.rows[headerIdx].cells;
  const width = Math.max(...sheet.rows.map((r) => r.cells.length));
  const headers = Array.from({ length: width }, (_, i) => cellText(headerCells[i] ?? null));
  const dataRows = sheet.rows.slice(headerIdx + 1);
  const columns: ColumnInfo[] = headers.map((header, index) => ({
    index,
    header: header || `Column ${index + 1}`,
    samples: dataRows
      .map((r) => cellText(r.cells[index] ?? null))
      .filter(Boolean)
      .slice(0, 3),
  }));

  const mapping = autoMap(def, headers);
  if (mappingIn) {
    for (const [key, idx] of Object.entries(mappingIn)) {
      if (!def.fields.some((f) => f.key === key)) continue;
      if (idx !== null && (!Number.isInteger(idx) || idx < 0 || idx >= width)) throw fail.validation('The chosen column does not exist in the file. Choose again.');
      mapping[key] = idx;
    }
  }
  const usedBy = new Map<number, string>();
  for (const f of def.fields) {
    const idx = mapping[f.key];
    if (idx === null || idx === undefined) continue;
    const other = usedBy.get(idx);
    if (other) {
      throw fail.validation(`The column "${columns[idx].header}" is chosen for both "${def.fields.find((x) => x.key === other)!.label}" and "${f.label}". Choose a different column for one of them.`);
    }
    usedBy.set(idx, f.key);
  }
  const missingRequired = def.fields.filter((f) => f.required && (mapping[f.key] === null || mapping[f.key] === undefined)).map((f) => f.label);
  const rows = missingRequired.length
    ? dataRows.map<Prepared>((r) => ({
        rowNo: r.rowNo,
        values: {},
        errors: missingRequired.map((l) => `Choose the column that has the ${l.toLowerCase()}`),
        fieldErrors: {},
        warnings: [],
        action: 'skip',
        note: 'Has errors - will not be imported',
        data: null,
        matchId: null,
      }))
    : prepareRows(ctx, def, sheet, headerIdx, mapping, mode, headers);
  return { def, sheet, headerIdx, columns, mapping, missingRequired, rows };
}

export async function previewImport(ctx: Ctx, input: { type: ImportType; path: string; mapping?: Mapping | null; duplicateMode?: DuplicateMode }): Promise<ImportPreview> {
  const mode = input.duplicateMode ?? 'skip';
  const a = await analyse(ctx, input.type, input.path, input.mapping, mode);
  return {
    type: input.type,
    fileName: a.sheet.fileName,
    sheetName: a.sheet.sheetName,
    headerRowNo: a.sheet.rows[a.headerIdx].rowNo,
    columns: a.columns,
    fields: a.def.fields.map((f) => ({ key: f.key, label: f.label, required: !!f.required, hint: f.hint ?? null })),
    mapping: a.mapping,
    missingRequired: a.missingRequired,
    duplicateMode: mode,
    rows: a.rows.map(({ data: _d, matchId: _m, reactivate: _r, ...row }) => row),
    counts: countsOf(a.rows),
  };
}

export interface ImportResult {
  type: ImportType;
  fileName: string;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

function customerOpening(debit: number | undefined) {
  if (debit === undefined) return undefined;
  if (!debit) return null;
  return debit > 0 ? { amount: debit, direction: 'receivable' as const } : { amount: -debit, direction: 'advance' as const };
}

function supplierOpening(debit: number | undefined) {
  if (debit === undefined) return undefined;
  if (!debit) return null;
  return debit < 0 ? { amount: -debit, direction: 'payable' as const } : { amount: debit, direction: 'advance' as const };
}

function applyRow(ctx: Ctx, type: ImportType, row: Prepared): void {
  const d = row.data!;
  if (type === 'items') {
    if (row.action === 'create') {
      createItem(ctx, { name: d.name, code: d.code ?? null, unit: d.unit ?? 'pcs', rate: d.rate ?? 0, category: d.category ?? null });
    } else {
      const ex = getItem(ctx, row.matchId!);
      updateItem(ctx, ex.id, { name: d.name ?? ex.name, code: d.code ?? ex.code, unit: d.unit ?? ex.unit, rate: d.rate ?? ex.rate, category: d.category ?? ex.category });
      if (row.reactivate) setItemActive(ctx, ex.id, true);
    }
  } else if (type === 'customers') {
    if (row.action === 'create') {
      createCustomer(ctx, { name: d.name, phone: d.phone ?? null, address: d.address ?? null, email: d.email ?? null, creditLimit: d.creditLimit ?? null, openingBalance: customerOpening(d.opening) ?? null });
    } else {
      const ex = getCustomer(ctx, row.matchId!);
      updateCustomer(ctx, ex.id, {
        name: d.name ?? ex.name,
        phone: d.phone ?? ex.phone,
        address: d.address ?? ex.address,
        email: d.email ?? ex.email,
        creditLimit: d.creditLimit ?? ex.creditLimit,
        notes: ex.notes,
        openingBalance: customerOpening(d.opening),
      });
    }
  } else if (type === 'suppliers') {
    if (row.action === 'create') {
      createSupplier(ctx, { name: d.name, phone: d.phone ?? null, address: d.address ?? null, email: d.email ?? null, contactPerson: d.contactPerson ?? null, openingBalance: supplierOpening(d.opening) ?? null });
    } else {
      const ex = getSupplier(ctx, row.matchId!);
      updateSupplier(ctx, ex.id, {
        name: d.name ?? ex.name,
        phone: d.phone ?? ex.phone,
        address: d.address ?? ex.address,
        email: d.email ?? ex.email,
        contactPerson: d.contactPerson ?? ex.contactPerson,
        notes: ex.notes,
        openingBalance: supplierOpening(d.opening),
      });
    }
  } else {
    if (row.action === 'create') {
      createEmployee(ctx, {
        name: d.name,
        phone: d.phone ?? null,
        address: d.address ?? null,
        designation: d.designation ?? null,
        joinDate: d.joinDate ?? null,
        salaryType: d.salaryType ?? 'monthly',
        salaryAmount: d.salaryAmount ?? 0,
        openingAdvance: d.openingAdvance ?? null,
      });
    } else {
      const ex = getEmployeeRow(ctx, row.matchId!);
      updateEmployee(ctx, ex.id, {
        name: d.name ?? ex.name,
        phone: d.phone ?? ex.phone,
        address: d.address ?? ex.address,
        designation: d.designation ?? ex.designation,
        joinDate: d.joinDate ?? ex.join_date,
        salaryType: d.salaryType ?? ex.salary_type,
        salaryAmount: d.salaryAmount ?? ex.salary_amount,
        weeklyOff: ex.weekly_off,
        idProof: ex.id_proof,
        bankDetails: ex.bank_details,
        notes: ex.notes,
        openingAdvance: d.openingAdvance,
      });
    }
  }
}

/** Validate again and import every valid row in one transaction (all or nothing). */
export async function commitImport(
  ctx: Ctx,
  input: { type: ImportType; path: string; mapping?: Mapping | null; duplicateMode: DuplicateMode },
): Promise<ImportResult> {
  const a = await analyse(ctx, input.type, input.path, input.mapping, input.duplicateMode);
  if (a.missingRequired.length) throw fail.validation(`Choose the column that has the ${a.missingRequired[0].toLowerCase()}.`);
  const todo = a.rows.filter((r) => !r.errors.length && (r.action === 'create' || r.action === 'update'));
  const counts = countsOf(a.rows);
  if (!todo.length) {
    const parts: string[] = [];
    if (counts.skip) parts.push(`${counts.skip} already exist${input.duplicateMode === 'update' ? ' with the same details' : ''}`);
    if (counts.errors) parts.push(`${counts.errors} ${counts.errors === 1 ? 'has' : 'have'} errors`);
    throw fail.validation(`There is nothing to import: ${parts.join(' and ') || 'the file has no rows'}.${counts.errors ? ' Fix the errors shown and try again.' : ''}`);
  }
  ctx.db.tx(() => {
    for (const row of todo) {
      try {
        applyRow(ctx, input.type, row);
      } catch (e) {
        const msg = e instanceof AppError ? e.message : (e as Error).message;
        throw new AppError(e instanceof AppError && e.code === 'PERIOD_CLOSED' ? 'PERIOD_CLOSED' : 'VALIDATION', `Row ${row.rowNo}: ${msg} Nothing was imported - fix this row and try again.`);
      }
    }
    const parts = [`${counts.create} added`];
    if (counts.update) parts.push(`${counts.update} updated`);
    if (counts.skip) parts.push(`${counts.skip} skipped`);
    if (counts.errors) parts.push(`${counts.errors} with errors not imported`);
    logActivity(ctx, `import.${input.type}`, `Imported ${a.def.label.toLowerCase()} from ${a.sheet.fileName}: ${parts.join(', ')}`, {
      details: { file: input.path, duplicateMode: input.duplicateMode, mapping: a.mapping, counts },
    });
  });
  return { type: input.type, fileName: a.sheet.fileName, created: counts.create, updated: counts.update, skipped: counts.skip, errors: counts.errors };
}
