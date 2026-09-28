/**
 * Typed client for the core API. In the desktop app calls go over Electron
 * IPC (window.billforce); in the browser test server they go over HTTP.
 * Types come straight from the core route definitions, so a wrong route name
 * or input shape is a compile error.
 */
import type { ApiInput, ApiOutput, RouteName } from '../core/api/routes';
import type { SerializedError } from '../core/errors';
import type { ExportFormat, ReportData } from '../shared/report';

export type { RouteName, ApiInput, ApiOutput };

type ApiResult = { ok: true; data: unknown } | { ok: false; error: SerializedError };

interface Bridge {
  platform: string;
  invoke(name: string, input?: unknown): Promise<ApiResult>;
  onEvent(cb: (event: string) => void): () => void;
}

declare global {
  interface Window {
    billforce?: Bridge;
  }
}

export class ApiError extends Error {
  code: SerializedError['code'];
  fields?: Record<string, string>;
  constructor(err: SerializedError) {
    super(err.message);
    this.code = err.code;
    this.fields = err.fields;
  }
}

async function transport(name: string, input: unknown): Promise<ApiResult> {
  if (window.billforce) return window.billforce.invoke(name, input);
  const res = await fetch('/api/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, input }),
  });
  return (await res.json()) as ApiResult;
}

const listeners = new Set<(name: string) => void>();

/** Subscribe to successful API calls (used to refresh data after changes). */
export function onApiCall(fn: (name: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function call<K extends RouteName>(name: K, ...args: ApiInput<K> extends void ? [] | [undefined] : [ApiInput<K>]): Promise<ApiOutput<K>> {
  const result = await transport(name, args[0]);
  if (!result.ok) {
    if (result.error.code === 'UNAUTHENTICATED' && name !== 'auth.login') {
      window.dispatchEvent(new CustomEvent('billforce:unauthenticated'));
    }
    throw new ApiError(result.error);
  }
  for (const fn of listeners) fn(name);
  return result.data as ApiOutput<K>;
}

/** App-level events from the main process (e.g. "database-replaced" after a restore). */
export function onAppEvent(cb: (event: string) => void): () => void {
  if (window.billforce) return window.billforce.onEvent(cb);
  const timer = setInterval(async () => {
    try {
      const res = await fetch('/api/events');
      const events = (await res.json()) as string[];
      events.forEach(cb);
    } catch {
      /* ignore */
    }
  }, 3000);
  return () => clearInterval(timer);
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Export a report and return the saved path (null if the user cancelled). */
export async function exportReport(report: ReportData, format: ExportFormat): Promise<string | null> {
  const res = await call('files.exportReport', { report, format });
  return res.path;
}
