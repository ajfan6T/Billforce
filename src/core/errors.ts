export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'PERIOD_CLOSED'
  | 'SETUP_REQUIRED'
  | 'CANCELLED'
  | 'INTERNAL';

/** An error whose message is safe and meaningful to show to the user. */
export class AppError extends Error {
  readonly code: ErrorCode;
  /** Field-level messages, e.g. { phone: 'Enter a 10 digit number' } */
  readonly fields?: Record<string, string>;

  constructor(code: ErrorCode, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.fields = fields;
  }
}

export const fail = {
  validation: (message: string, fields?: Record<string, string>) => new AppError('VALIDATION', message, fields),
  notFound: (what: string) => new AppError('NOT_FOUND', `${what} not found`),
  forbidden: (message = 'You do not have permission to do this') => new AppError('FORBIDDEN', message),
  conflict: (message: string) => new AppError('CONFLICT', message),
  periodClosed: (message: string) => new AppError('PERIOD_CLOSED', message),
};

/** Throw a validation error when the condition is false. */
export function ensure(condition: unknown, message: string, field?: string): asserts condition {
  if (!condition) throw new AppError('VALIDATION', message, field ? { [field]: message } : undefined);
}

export interface SerializedError {
  code: ErrorCode;
  message: string;
  fields?: Record<string, string>;
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof AppError) return { code: e.code, message: e.message, fields: e.fields };
  const message = e instanceof Error ? e.message : String(e);
  if (/UNIQUE constraint failed/i.test(message)) {
    return { code: 'CONFLICT', message: 'A record with the same details already exists.' };
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return { code: 'CONFLICT', message: 'This record is linked to other records and cannot be changed this way.' };
  }
  return { code: 'INTERNAL', message: `Unexpected error: ${message}` };
}
