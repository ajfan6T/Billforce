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

function zodToAppError(err: z.ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  const first = err.issues[0];
  const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
  return new AppError('VALIDATION', `Please check the details. ${where}${first?.message ?? 'Invalid input'}`, fields);
}

export async function dispatch(routes: RouteMap, ctx: Ctx, name: string, rawInput: unknown): Promise<unknown> {
  const def = routes[name];
  if (!def) throw new AppError('NOT_FOUND', `Unknown action "${name}"`);
  checkAccess(ctx, def.access);
  let input: unknown = undefined;
  if (def.input) {
    const parsed = def.input.safeParse(rawInput ?? {});
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
