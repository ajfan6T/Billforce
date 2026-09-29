/**
 * Business settings: validation per section, saving (merged into what is
 * stored), change logging and the live receipt preview.
 *
 * The "accounts" section (books start date, default payment accounts) belongs
 * to the accounting module and cannot be changed here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Ctx } from '../../context';
import { can, now, requireSession, today } from '../../context';
import { AppError, fail } from '../../errors';
import { logActivity } from '../../audit';
import { getMeta, getSection, getSettings, updateSection } from '../../settings';
import { formatDocNumber } from '../../numbering';
import { renderReceiptHtml, upiLink, type ReceiptDoc, type ReceiptTotal } from '../../print/receipt';
import type { AppSettings, BusinessSettings, GstSettings, ReceiptSettings } from '../../../shared/settings';
import { calcBill } from '../../../shared/billing';
import { gstTable, useGstAccounts } from '../gst/common';
import { ensureStockAccounts } from '../../seed';
import { PAYMENT_MODES, PAYMENT_MODE_LABELS, SEQUENCE_KEYS, SEQUENCE_LABELS, type SequenceKey } from '../../../shared/constants';
import { amountInWords, formatAmount, formatINR } from '../../../shared/money';
import { formatDate, formatTime, fyOf } from '../../../shared/dates';
import { backupFolder } from '../data/backup';
import { COMPOSITION_RATES, GST_REGISTRATION_LABELS, GST_REGISTRATIONS, formatRate, gstinProblem, isGstRate, normalizeGstin } from '../../../shared/gst';

/* ------------------------------ Schemas ------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** UPI IDs (VPA) look like "shopname@okaxis" or "9820012345@ybl". */
export const UPI_RE = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$/;

const multiline = (max: number, what: string) =>
  z
    .string()
    .transform((s) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, ''))
    .pipe(z.string().max(max, `${what} can be at most ${max} characters`));

export const BUSINESS_SCHEMA = z.object({
  name: z.string().trim().min(1, 'Enter the business name').max(120, 'Business name is too long (max 120 characters)'),
  address: multiline(500, 'Address'),
  phone: z
    .string()
    .trim()
    .max(40, 'Phone is too long')
    .regex(/^[0-9+\-\s()/,]*$/, 'Phone can contain only digits, spaces and + - ( ) / ,'),
  email: z
    .string()
    .trim()
    .max(120, 'Email is too long')
    .refine((v) => !v || EMAIL_RE.test(v), 'Enter a valid email address, e.g. name@example.com'),
  upiId: z
    .string()
    .trim()
    .max(100, 'UPI ID is too long')
    .refine((v) => !v || UPI_RE.test(v), 'Enter a valid UPI ID, e.g. sharmastore@okaxis'),
  upiName: z.string().trim().max(60, 'Payee name is too long (max 60 characters)'),
});

export const RECEIPT_SCHEMA = z.object({
  header: multiline(500, 'Receipt header'),
  footer: multiline(500, 'Receipt footer'),
  paperWidth: z.union([z.literal(80), z.literal(58)], { message: 'Paper width must be 80 mm or 58 mm' }),
  fontSize: z.enum(['small', 'normal', 'large'], { message: 'Choose small, normal or large text' }),
  printerName: z.string().trim().max(200, 'Printer name is too long'),
  copies: z.number({ message: 'Enter the number of copies' }).int('Copies must be a whole number').min(1, 'Print at least 1 copy').max(5, 'At most 5 copies'),
  autoPrint: z.boolean(),
  showCustomer: z.boolean(),
  showCashier: z.boolean(),
  showAmountInWords: z.boolean(),
  upiQr: z.enum(['never', 'unpaid', 'always'], { message: 'Choose when to print the UPI QR code' }),
  markDuplicate: z.boolean(),
});

const zPrefix = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,8}$/, 'Use 1 to 8 letters or digits (A-Z, 0-9), no spaces or symbols');

export const BILLING_SCHEMA = z.object({
  roundOff: z.boolean(),
  defaultPaymentMode: z.enum(PAYMENT_MODES, { message: 'Choose Cash, UPI, Bank or Credit' }),
  prefixes: z.object(Object.fromEntries(SEQUENCE_KEYS.map((k) => [k, zPrefix])) as Record<SequenceKey, typeof zPrefix>).partial().strict(),
  enforceCreditLimit: z.boolean(),
});

export const SECURITY_SCHEMA = z.object({
  autoLockMinutes: z
    .number({ message: 'Enter the number of minutes' })
    .int('Enter whole minutes')
    .min(0, 'Cannot be negative')
    .max(240, 'At most 240 minutes (4 hours)'),
});

export const BACKUP_SCHEMA = z.object({
  autoBackup: z.boolean(),
  folder: z.string().trim().max(500, 'Folder path is too long'),
  keepCount: z
    .number({ message: 'Enter how many automatic backups to keep' })
    .int('Enter a whole number')
    .min(3, 'Keep at least 3 automatic backups')
    .max(365, 'At most 365 automatic backups'),
});

export const GST_SCHEMA = z.object({
  registration: z.enum(GST_REGISTRATIONS, { message: 'Choose how the business is registered for GST' }),
  gstin: z
    .string()
    .max(20, 'A GSTIN has 15 characters')
    .transform((v) => normalizeGstin(v))
    .superRefine((v, c) => {
      const problem = v ? gstinProblem(v) : null;
      if (problem) c.addIssue({ code: 'custom', message: problem });
    }),
  ratesIncludeGst: z.boolean(),
  defaultRate: z.number({ message: 'Choose the usual GST rate' }).refine(isGstRate, 'Choose a GST rate from the list'),
  compositionRate: z
    .number({ message: 'Choose the composition tax rate' })
    .refine((v) => (COMPOSITION_RATES as readonly number[]).includes(v), 'Choose 1%, 5% or 6%'),
});

export const STOCK_SCHEMA = z.object({ enabled: z.boolean() });

export const EDITABLE_SECTIONS = ['business', 'gst', 'stock', 'receipt', 'billing', 'security', 'backup'] as const;
export type EditableSection = (typeof EDITABLE_SECTIONS)[number];

const SCHEMAS = {
  business: BUSINESS_SCHEMA,
  gst: GST_SCHEMA,
  stock: STOCK_SCHEMA,
  receipt: RECEIPT_SCHEMA,
  billing: BILLING_SCHEMA,
  security: SECURITY_SCHEMA,
  backup: BACKUP_SCHEMA,
} as const;

const SECTION_LABELS: Record<EditableSection, string> = {
  business: 'business',
  gst: 'GST',
  stock: 'stock',
  receipt: 'receipt & printer',
  billing: 'billing',
  security: 'security',
  backup: 'backup',
};

const FIELD_LABELS: Record<string, string> = {
  'business.name': 'business name',
  'business.address': 'address',
  'business.phone': 'phone',
  'business.email': 'email',
  'business.upiId': 'UPI ID',
  'business.upiName': 'UPI payee name',
  'gst.registration': 'GST registration',
  'gst.gstin': 'GSTIN',
  'gst.ratesIncludeGst': 'rates include GST',
  'gst.defaultRate': 'usual GST rate',
  'gst.compositionRate': 'composition tax rate',
  'stock.enabled': 'stock tracking',
  'receipt.header': 'receipt header',
  'receipt.footer': 'receipt footer',
  'receipt.paperWidth': 'paper width',
  'receipt.fontSize': 'text size',
  'receipt.printerName': 'printer',
  'receipt.copies': 'copies',
  'receipt.autoPrint': 'print automatically',
  'receipt.showCustomer': 'show customer',
  'receipt.showCashier': 'show cashier',
  'receipt.showAmountInWords': 'amount in words',
  'receipt.upiQr': 'UPI QR code',
  'receipt.markDuplicate': 'DUPLICATE on reprints',
  'billing.roundOff': 'round off',
  'billing.defaultPaymentMode': 'default payment mode',
  'billing.enforceCreditLimit': 'credit limit check',
  'security.autoLockMinutes': 'auto-lock',
  'backup.autoBackup': 'automatic backup',
  'backup.folder': 'backup folder',
  'backup.keepCount': 'automatic backups kept',
};

/* ------------------------------ Helpers ------------------------------ */

/** Turn a zod error into a message a shopkeeper understands, with per-field messages. */
function zodFail(err: z.ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    let msg = issue.message;
    if (issue.code === 'unrecognized_keys') msg = `Unknown setting: ${(issue as any).keys?.join(', ')}`;
    else if (issue.code === 'invalid_type') msg = msg.startsWith('Invalid input') ? 'This value is not valid' : msg;
    if (!fields[key]) fields[key] = msg;
  }
  const firstKey = Object.keys(fields)[0];
  return new AppError('VALIDATION', fields[firstKey] ?? 'Please check the details', fields);
}

/** Error message if the folder cannot be used for backups, else null. */
export function folderProblem(dir: string): string | null {
  if (!dir) return 'Choose a folder';
  if (!path.isAbsolute(dir)) return 'Choose a full folder path (for example D:\\Billforce Backups)';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.billforce-write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return null;
  } catch (e) {
    return `Billforce cannot save files in "${dir}" (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). Choose another folder.`;
  }
}

function describeValue(key: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (key === 'receipt.paperWidth') return `${v} mm`;
  if (key === 'security.autoLockMinutes') return v ? `${v} min` : 'never';
  if (key === 'billing.defaultPaymentMode') return PAYMENT_MODE_LABELS[v as keyof typeof PAYMENT_MODE_LABELS] ?? String(v);
  if (key === 'receipt.printerName') return v ? `"${v}"` : 'ask every time';
  if (key === 'receipt.upiQr') return v === 'unpaid' ? 'when unpaid' : String(v);
  if (key === 'receipt.fontSize') return String(v);
  if (key === 'gst.registration') return GST_REGISTRATION_LABELS[v as keyof typeof GST_REGISTRATION_LABELS] ?? String(v);
  if (key === 'gst.defaultRate' || key === 'gst.compositionRate') return typeof v === 'number' ? formatRate(v) : String(v);
  if (typeof v === 'string') return v.length > 40 || v.includes('\n') ? '' : v ? `"${v}"` : 'blank';
  return String(v);
}

function changeText(section: EditableSection, before: Record<string, unknown>, after: Record<string, unknown>, keys: string[]): string {
  return keys
    .map((k) => {
      if (section === 'billing' && k === 'prefixes') {
        const b = before.prefixes as Record<string, string>;
        const a = after.prefixes as Record<string, string>;
        return SEQUENCE_KEYS.filter((s) => b[s] !== a[s])
          .map((s) => `${SEQUENCE_LABELS[s].toLowerCase()} prefix ${b[s]} → ${a[s]}`)
          .join(', ');
      }
      const full = `${section}.${k}`;
      const label = FIELD_LABELS[full] ?? k;
      const from = describeValue(full, before[k]);
      const to = describeValue(full, after[k]);
      // Long or multi-line text (addresses, receipt header / footer) is not repeated in the summary.
      return from && to ? `${label} ${from} → ${to}` : `${label} changed`;
    })
    .filter(Boolean)
    .join(', ');
}

/* ------------------------------ Read / update ------------------------------ */

export function readSettings(ctx: Ctx): AppSettings {
  requireSession(ctx);
  return getSettings(ctx);
}

export function updateSettings(ctx: Ctx, section: string, values: Record<string, unknown>): { section: EditableSection; values: AppSettings[EditableSection]; changed: string[] } {
  requireSession(ctx);
  if (section === 'accounts') {
    throw fail.validation('The books start date and default payment accounts are changed in Accounts, not here.');
  }
  if (!(EDITABLE_SECTIONS as readonly string[]).includes(section)) throw fail.validation(`Unknown settings section "${section}"`);
  const sec = section as EditableSection;
  if (sec === 'backup') {
    if (!can(ctx, 'settings.manage') && !can(ctx, 'data.backup')) throw fail.forbidden('You do not have permission to change backup settings.');
  } else if (!can(ctx, 'settings.manage')) {
    throw fail.forbidden('You do not have permission to change settings. Ask the owner.');
  }
  const parsed = (SCHEMAS[sec] as z.ZodObject<any>).partial().strict().safeParse(values ?? {});
  if (!parsed.success) throw zodFail(parsed.error);
  const patch = parsed.data as Record<string, unknown>;
  const before = getSection(ctx, sec) as unknown as Record<string, unknown>;

  if (sec === 'billing' && patch.prefixes) {
    const merged = { ...(before.prefixes as Record<SequenceKey, string>), ...(patch.prefixes as Record<string, string>) };
    const seen = new Map<string, SequenceKey>();
    const fields: Record<string, string> = {};
    for (const k of SEQUENCE_KEYS) {
      const other = seen.get(merged[k]);
      if (other) fields[`prefixes.${k}`] = `Already used for ${SEQUENCE_LABELS[other].toLowerCase()}`;
      else seen.set(merged[k], k);
    }
    const first = Object.keys(fields)[0];
    if (first) {
      const key = first.slice('prefixes.'.length) as SequenceKey;
      throw fail.validation(`Each document series needs its own prefix. "${merged[key]}" is used for both ${SEQUENCE_LABELS[seen.get(merged[key])!].toLowerCase()} and ${SEQUENCE_LABELS[key].toLowerCase()}.`, fields);
    }
  }
  if (sec === 'gst') {
    const registration = (patch.registration ?? before.registration) as string;
    const gstin = (patch.gstin ?? before.gstin) as string;
    if (registration !== 'unregistered') {
      if (!gstin) throw fail.validation('Enter the GSTIN of the business to bill with GST.', { gstin: 'Enter the GSTIN' });
      const problem = gstinProblem(gstin);
      if (problem) throw fail.validation(problem, { gstin: problem });
    }
  }
  if (sec === 'backup' && typeof patch.folder === 'string' && patch.folder && patch.folder !== before.folder) {
    const problem = folderProblem(patch.folder);
    if (problem) throw fail.validation(problem, { folder: problem });
  }

  // Nested objects (billing prefixes) are merged, so compare the merged result with what is stored.
  const nextValue = (k: string) => (k === 'prefixes' ? { ...(before.prefixes as object), ...(patch.prefixes as object) } : patch[k]);
  const changedKeys = Object.keys(patch).filter((k) => JSON.stringify(nextValue(k)) !== JSON.stringify(before[k]));
  if (!changedKeys.length) return { section: sec, values: before as any, changed: [] };
  const after = updateSection(ctx, sec, patch as any) as unknown as Record<string, unknown>;
  if (sec === 'gst' && after.registration !== 'unregistered') useGstAccounts(ctx);
  if (sec === 'stock' && after.enabled) ensureStockAccounts(ctx.db, now(ctx));
  const pick = (o: Record<string, unknown>) => Object.fromEntries(changedKeys.map((k) => [k, o[k]]));
  logActivity(ctx, 'settings.update', `Changed ${SECTION_LABELS[sec]} settings: ${changeText(sec, before, after, changedKeys)}`, {
    entityType: 'settings',
    details: { section: sec, before: pick(before), after: pick(after) },
  });
  return { section: sec, values: after as any, changed: changedKeys };
}

/* ------------------------------ Receipt preview ------------------------------ */

/** Loose versions of the schemas for previews: wrong or half-typed values fall back to the saved ones. */
function overlay<T extends object>(saved: T, schema: z.ZodObject<any>, unsaved: Record<string, unknown> | null | undefined): T {
  const out: any = { ...saved };
  if (!unsaved) return out;
  for (const [k, v] of Object.entries(unsaved)) {
    const field = schema.shape[k] as z.ZodType | undefined;
    if (!field) continue;
    const r = field.safeParse(v);
    if (r.success) out[k] = r.data;
    else if (typeof v === 'string' && typeof out[k] === 'string') out[k] = v.slice(0, 2000);
  }
  return out;
}

export interface PreviewInput {
  business?: Record<string, unknown> | null;
  receipt?: Record<string, unknown> | null;
  gst?: Record<string, unknown> | null;
  /** Show the sample as a reprint (DUPLICATE, when that setting is on). */
  duplicate?: boolean;
}

/** A realistic bill printed with the given settings (used for the live preview and test print). */
export function sampleBillDoc(ctx: Ctx, business: BusinessSettings, receipt: ReceiptSettings, duplicate: boolean, gst: GstSettings = getSection(ctx, 'gst')): ReceiptDoc {
  const billing = getSection(ctx, 'billing');
  const date = today(ctx);
  const lines = [
    { name: 'Toor Dal 1 kg', qty: 2, unit: 'pcs', rate: 14500, pct: 0, hsn: '0713', gstRate: 5 },
    { name: 'Basmati Rice 5 kg', qty: 1, unit: 'bag', rate: 52000, pct: 0, hsn: '1006', gstRate: 5 },
    { name: 'Sunflower Oil 1 L', qty: 3, unit: 'bottle', rate: 16250, pct: 5, hsn: '1512', gstRate: 5 },
    { name: 'Parle-G Biscuits', qty: 6, unit: 'pcs', rate: 1000, pct: 0, hsn: '1905', gstRate: 18 },
  ];
  const mode = gst.registration;
  const gstin = normalizeGstin(gst.gstin);
  const taxInvoice = mode === 'regular';
  const calc = calcBill({
    lines: lines.map((l) => ({ qty: l.qty, rate: l.rate, discountPct: l.pct || null, gstRate: l.gstRate })),
    roundOff: billing.roundOff,
    gst: taxInvoice ? { inclusive: gst.ratesIncludeGst, interState: false } : null,
  });
  const { subtotal, itemDiscount, roundOff, total } = calc;
  const paid = 100000;
  const credit = Math.max(0, total - paid);

  const meta: Array<[string, string]> = [
    ['Bill No', formatDocNumber(billing.prefixes.bill ?? 'INV', fyOf(date).short, 42)],
    ['Date', `${formatDate(date)}  ${formatTime(now(ctx))}`],
  ];
  if (receipt.showCashier) meta.push(['Cashier', ctx.session?.fullName ?? 'Cashier']);
  const totals: ReceiptTotal[] = [];
  totals.push({ label: 'Subtotal', value: formatINR(subtotal) });
  if (itemDiscount) totals.push({ label: 'Item discount', value: `-${formatINR(itemDiscount)}` });
  if (calc.gst && !calc.gst.inclusive) {
    totals.push({ label: 'Taxable value', value: formatINR(calc.gst.taxable) });
    totals.push({ label: 'CGST', value: formatINR(calc.gst.cgst) });
    totals.push({ label: 'SGST', value: formatINR(calc.gst.sgst) });
  }
  if (roundOff) totals.push({ label: 'Round off', value: formatINR(roundOff, { plus: true }) });
  totals.push({ label: 'TOTAL', value: formatINR(total), big: true });
  totals.push({ label: `Paid by ${PAYMENT_MODE_LABELS.cash}`, value: formatINR(paid) });
  if (credit) totals.push({ label: 'Balance on credit', value: formatINR(credit), bold: true });

  const extra: string[] = [`Items: ${lines.length}`];
  if (calc.gst?.inclusive) extra.push(`Prices include GST of ${formatINR(calc.gst.tax)}`);
  if (mode === 'composition') extra.push('Composition taxable person, not eligible to collect tax on supplies');
  if (itemDiscount) extra.push(`You saved ${formatINR(itemDiscount)} on this bill`);
  if (receipt.showAmountInWords) extra.push(amountInWords(total));
  if (credit) extra.push(`Total due from you: ${formatINR(credit + 50000)} (as on ${formatDate(date)})`);

  let qr: ReceiptDoc['qr'];
  const upiId = business.upiId?.trim();
  if (upiId && (receipt.upiQr === 'always' || (receipt.upiQr === 'unpaid' && credit > 0))) {
    const amount = credit > 0 ? credit : total;
    qr = { data: upiLink(upiId, business.upiName?.trim() || business.name || 'Shop', amount, 'Bill sample'), caption: `Scan to pay ${formatINR(amount)} by UPI` };
  }
  const taxLines = calc.gst ? calc.gst.lines.map((t) => ({ gstRate: t.gstRate, taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst })) : [];
  return {
    title: taxInvoice ? 'TAX INVOICE' : mode === 'composition' ? 'BILL OF SUPPLY' : 'BILL',
    headerLines: mode !== 'unregistered' && gstin ? [`GSTIN: ${gstin}`] : undefined,
    duplicate: duplicate && receipt.markDuplicate,
    meta,
    party: receipt.showCustomer ? { label: 'Customer', name: 'Anita Desai', phone: '98200 11111' } : undefined,
    items: lines.map((l, i) => {
      const c = calc.lines[i];
      const notes: string[] = [];
      if (taxInvoice) notes.push(`HSN ${l.hsn} · GST ${formatRate(l.gstRate)}`);
      if (c.discount) notes.push(`Less discount ${l.pct}%: -${formatAmount(c.discount)}`);
      return { name: l.name, qty: `${l.qty} ${l.unit}`, rate: formatAmount(l.rate), amount: formatAmount(c.gross), note: notes.join(' · ') || undefined };
    }),
    totals,
    table: taxInvoice ? gstTable(taxLines, false) : undefined,
    lines: extra,
    qr,
  };
}

export function receiptPreview(ctx: Ctx, input: PreviewInput): { html: string; paperWidth: 80 | 58; business: BusinessSettings; receipt: ReceiptSettings } {
  requireSession(ctx);
  const business = overlay(getSection(ctx, 'business'), BUSINESS_SCHEMA, input.business);
  const receipt = overlay(getSection(ctx, 'receipt'), RECEIPT_SCHEMA, input.receipt);
  const gst = overlay(getSection(ctx, 'gst'), GST_SCHEMA, input.gst);
  const html = renderReceiptHtml(sampleBillDoc(ctx, business, receipt, !!input.duplicate, gst), business, receipt);
  return { html, paperWidth: receipt.paperWidth, business, receipt };
}

/** Print the sample bill on the chosen (or saved) receipt printer. */
export async function testPrint(ctx: Ctx, input: PreviewInput & { printerName?: string | null }): Promise<{ printed: boolean; message: string }> {
  const receiptInput = { ...(input.receipt ?? {}), ...(input.printerName !== undefined && input.printerName !== null ? { printerName: input.printerName } : {}) };
  const { html, receipt } = receiptPreview(ctx, { ...input, receipt: receiptInput });
  const printerName = receipt.printerName.trim() || undefined;
  const res = await ctx.platform.printHtml(html, { printerName, silent: !!printerName, paperWidthMm: receipt.paperWidth, copies: 1 });
  if (!res.printed) return { printed: false, message: res.message || 'Printing was cancelled.' };
  return { printed: true, message: printerName ? `Test receipt sent to ${printerName}` : 'Test receipt sent to the printer' };
}

/* ------------------------------ Document numbers ------------------------------ */

/**
 * The number the next document of each series will get in the current financial year (what
 * peekDocNumber would give), for "Next number" in Settings > Billing. Takes no number.
 */
export function nextNumbers(ctx: Ctx): { fyShort: string; next: Record<SequenceKey, number> } {
  const fy = fyOf(today(ctx));
  const rows = ctx.db.all<{ key: string; last_value: number }>('SELECT key, last_value FROM sequences WHERE fy_start = ?', [fy.start]);
  const last = new Map(rows.map((r) => [r.key, r.last_value]));
  const next = Object.fromEntries(SEQUENCE_KEYS.map((k) => [k, (last.get(k) ?? 0) + 1])) as Record<SequenceKey, number>;
  return { fyShort: fy.short, next };
}

/* ------------------------------ About ------------------------------ */

export function aboutInfo(ctx: Ctx) {
  requireSession(ctx);
  let dbSizeBytes: number | null = null;
  try {
    if (ctx.info.dbPath !== ':memory:') dbSizeBytes = fs.statSync(ctx.info.dbPath).size;
  } catch {
    dbSizeBytes = null;
  }
  return {
    version: ctx.info.version,
    dataDir: ctx.info.dataDir,
    dbPath: ctx.info.dbPath,
    dbSizeBytes,
    backupFolder: backupFolder(ctx),
    defaultBackupFolder: ctx.info.defaultBackupDir,
    platform: ctx.platform.kind,
    setupAt: getMeta(ctx, 'setup_at'),
    booksStartDate: getSection(ctx, 'accounts').booksStartDate,
  };
}
