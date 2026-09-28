import { z } from 'zod';
import type { Ctx } from '../context';
import { can, requireSession } from '../context';
import { AppError } from '../errors';
import type { Permission } from '../../shared/permissions';

/**
 * Who may call a route:
 *  - 'public'  : anyone, even before login (login screen, first-run setup)
 *  - 'user'    : any logged-in user
 *  - a permission, or a list of permissions (any one is enough)
 */
export type Access = 'public' | 'user' | Permission | Permission[];

type InputOf<S> = S extends z.ZodType ? z.output<S> : void;

export interface RouteDef<S extends z.ZodType | undefined = any, O = any> {
  access: Access;
  input?: S;
  /**
   * Mutations run inside a database transaction; the handler must be
   * synchronous. Everything it writes (data, ledger entries, activity log)
   * commits or rolls back together.
   */
  mutation?: boolean;
  handler: (ctx: Ctx, input: InputOf<S>) => O;
}

/** Define an API route with an inferred input type. */
export function route<S extends z.ZodType | undefined = undefined, O = unknown>(def: RouteDef<S, O>): RouteDef<S, O> {
  return def;
}

export type RouteMap = Record<string, RouteDef<any, any>>;

/** What the caller sends (before zod defaults / transforms). */
export type RouteInput<R> = R extends RouteDef<infer S, any> ? (S extends z.ZodType ? z.input<S> : void) : never;
export type RouteOutput<R> = R extends RouteDef<any, infer O> ? Awaited<O> : never;

function checkAccess(ctx: Ctx, access: Access): void {
  if (access === 'public') return;
  requireSession(ctx);
  if (access === 'user') return;
  const perms = Array.isArray(access) ? access : [access];
  if (!perms.some((p) => can(ctx, p))) {
    throw new AppError('FORBIDDEN', 'You do not have permission to do this. Ask the owner to allow it.');
  }
}

/* ---------- Validation messages a shopkeeper can read ---------- */

/** Words that read better spelled out or in capitals when a field name is turned into a label. */
const LABEL_WORDS: Record<string, string> = { qty: 'quantity', pct: 'percent', upi: 'UPI', qr: 'QR', gst: 'GST', pan: 'PAN', ifsc: 'IFSC', no: 'number', dob: 'date of birth' };
/** What one element of a list is called ("Line 2: ..."). */
const LIST_ITEM: Record<string, string> = { items: 'Line', lines: 'Line', payments: 'Payment', rows: 'Row', splits: 'Payment' };

/** "itemName" -> "Item name", "customerId" -> "Customer", "billDiscountPct" -> "Bill discount percent". */
export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.toLowerCase());
  if (words.length > 1 && (words[words.length - 1] === 'id' || words[words.length - 1] === 'ids')) words.pop();
  const text = words.map((w) => LABEL_WORDS[w] ?? w).join(' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'This value';
}

type IssuePath = ReadonlyArray<PropertyKey>;

/** The field an issue is about: the last named part of its path. */
function issueLabel(path: IssuePath): string {
  for (let i = path.length - 1; i >= 0; i--) {
    if (typeof path[i] === 'string') return fieldLabel(path[i] as string);
  }
  return 'This value';
}

/** Where in a list the problem is: ["items", 0, "itemName"] -> "Line 1". Empty when not in a list. */
function issueWhere(path: IssuePath): string {
  const parts: string[] = [];
  path.forEach((p, i) => {
    if (typeof p !== 'number') return;
    const list = path[i - 1];
    const name = typeof list === 'string' ? (LIST_ITEM[list] ?? fieldLabel(list).replace(/s$/, '')) : 'Item';
    parts.push(`${name} ${p + 1}`);
  });
  return parts.join(', ');
}

const lower = (s: string) => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

/**
 * Plain-English text for zod's built-in checks (used when the schema gave no message of its own),
 * e.g. "Item name is too long (max 120 characters)" instead of "Too big: expected string to have <=120 characters".
 */
export function friendlyIssueMessage(issue: {
  code?: string;
  path?: IssuePath;
  input?: unknown;
  origin?: string;
  expected?: string;
  maximum?: number | bigint;
  minimum?: number | bigint;
  inclusive?: boolean;
  format?: string;
  keys?: string[];
}): string {
  const label = issueLabel(issue.path ?? []);
  const max = Number(issue.maximum);
  const min = Number(issue.minimum);
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined || issue.input === null) return `${label} is required`;
      if (issue.expected === 'number' || issue.expected === 'int' || issue.expected === 'bigint') return `${label} must be ${issue.expected === 'number' ? 'a number' : 'a whole number'}`;
      if (issue.expected === 'string') return `${label} must be text`;
      if (issue.expected === 'boolean') return `${label} must be yes or no`;
      if (issue.expected === 'date') return `${label} must be a date`;
      return `${label} is not valid`;
    case 'too_big':
      if (issue.origin === 'string') return `${label} is too long (max ${max} character${max === 1 ? '' : 's'})`;
      if (issue.origin === 'array' || issue.origin === 'set') return `${label}: at most ${max} allowed`;
      return `${label} is too large`;
    case 'too_small':
      if (issue.origin === 'string') return min <= 1 ? `${label} is required` : `${label} must be at least ${min} characters`;
      if (issue.origin === 'array' || issue.origin === 'set') return min <= 1 ? `Add at least one ${lower(label).replace(/s$/, '')}` : `${label}: at least ${min} needed`;
      if (min === 0) return issue.inclusive === false ? `${label} must be more than zero` : `${label} cannot be negative`;
      return `${label} must be ${issue.inclusive === false ? 'more than' : 'at least'} ${min}`;
    case 'invalid_format':
      if (issue.format === 'email') return 'Enter a valid email address';
      return `${label} is not in the right format`;
    case 'invalid_value':
      return `Choose a valid ${lower(label)}`;
    case 'unrecognized_keys':
      return `Unexpected detail${(issue.keys?.length ?? 0) === 1 ? '' : 's'}: ${(issue.keys ?? []).join(', ')}`;
    default:
      return `${label} is not valid`;
  }
}

/** Per-parse error map: only consulted when the schema itself did not give a message. */
const friendlyErrorMap: z.core.$ZodErrorMap = (issue) => friendlyIssueMessage(issue as Parameters<typeof friendlyIssueMessage>[0]);

export function zodToAppError(err: z.ZodError): AppError {
  const fields: Record<string, string> = {};
  const describe = (issue: z.core.$ZodIssue): string => {
    let msg = issue.message;
    // A schema message like "Item name is too long" gets the limit added when it does not say it.
    if (issue.code === 'too_big' && issue.origin === 'string' && !/\d/.test(msg)) msg += ` (max ${Number(issue.maximum)} characters)`;
    if (issue.code === 'too_small' && issue.origin === 'string' && Number(issue.minimum) > 1 && !/\d/.test(msg)) msg += ` (at least ${Number(issue.minimum)} characters)`;
    return msg;
  };
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = describe(issue);
  }
  const first = err.issues[0];
  if (!first) return new AppError('VALIDATION', 'Please check the details and try again.', fields);
  const where = issueWhere(first.path);
  return new AppError('VALIDATION', `${where ? `${where}: ` : ''}${describe(first)}`, fields);
}

export async function dispatch(routes: RouteMap, ctx: Ctx, name: string, rawInput: unknown): Promise<unknown> {
  const def = routes[name];
  if (!def) throw new AppError('NOT_FOUND', `Unknown action "${name}"`);
  checkAccess(ctx, def.access);
  let input: unknown = undefined;
  if (def.input) {
    const parsed = def.input.safeParse(rawInput ?? {}, { error: friendlyErrorMap });
    if (!parsed.success) throw zodToAppError(parsed.error);
    input = parsed.data;
  }
  if (def.mutation) {
    return ctx.db.tx(() => {
      const result = def.handler(ctx, input as any);
      if (result && typeof (result as any).then === 'function') {
        throw new AppError('INTERNAL', `Route ${name} is a mutation but returned a promise`);
      }
      return result;
    });
  }
  return await def.handler(ctx, input as any);
}

/* ---------- Reusable input schemas ---------- */

export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date');
export const zId = z.number().int().positive();
/** Amount in paise, >= 0. */
export const zPaise = z.number().int('Amount must be in whole paise').min(0, 'Amount cannot be negative');
export const zPositivePaise = z.number().int('Amount must be in whole paise').positive('Amount must be more than zero');
export const zQty = z.number().positive('Quantity must be more than zero').max(1_000_000_000);
export const zText = (max = 500) => z.string().trim().max(max);
export const zOptText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
export const zSettlementMode = z.enum(['cash', 'upi', 'bank']);
export const zPaymentMode = z.enum(['cash', 'upi', 'bank', 'credit']);
export const zRange = z.object({ from: zDate, to: zDate });
export const zPhone = z
  .string()
  .trim()
  .max(20)
  .regex(/^[0-9+\-\s()]*$/, 'Phone number can contain only digits, spaces and + - ( )')
  .nullish()
  .transform((v) => (v ? v : null));
export const zPaging = z.object({
  limit: z.number().int().min(1).max(5000).default(200),
  offset: z.number().int().min(0).default(0),
});
