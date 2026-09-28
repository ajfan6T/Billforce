/**
 * Operating-system services the core needs (printing, file dialogs, PDF).
 * Implemented by the Electron main process; tests and the browser test
 * server use lightweight fakes.
 */
import fs from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors';

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PrintOptions {
  /** Windows printer name; empty / undefined = show the system print dialog. */
  printerName?: string;
  /** Print without a dialog (only when printerName is given). */
  silent?: boolean;
  /** Receipt paper width in mm (80 or 58). Omit for normal A4 printing. */
  paperWidthMm?: number;
  copies?: number;
}

export interface PrintResult {
  printed: boolean;
  message?: string;
}

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
}

export interface Platform {
  kind: 'electron' | 'web' | 'test';
  printHtml(html: string, opts: PrintOptions): Promise<PrintResult>;
  listPrinters(): Promise<PrinterInfo[]>;
  htmlToPdf(html: string, opts: { landscape?: boolean }): Promise<Uint8Array>;
  /** Ask where to save and write the file. Returns the saved path or null if cancelled. */
  saveFile(opts: { defaultName: string; data: Uint8Array | string; filters?: FileFilter[] }): Promise<string | null>;
  /** Ask the user to choose a file to open. */
  pickFile(opts: { title?: string; filters?: FileFilter[] }): Promise<string | null>;
  pickFolder(opts: { title?: string; defaultPath?: string }): Promise<string | null>;
  openPath(path: string): Promise<void>;
  showInFolder(path: string): void;
  /** The user's Documents folder. */
  documentsDir(): string;
}

/** Platform used by unit tests: records calls, never shows UI. */
export class TestPlatform implements Platform {
  kind = 'test' as const;
  printed: Array<{ html: string; opts: PrintOptions }> = [];
  saved: Array<{ name: string; data: Uint8Array | string }> = [];
  nextPickFile: string | null = null;
  nextPickFolder: string | null = null;
  constructor(private docsDir: string = '/tmp') {}
  async printHtml(html: string, opts: PrintOptions): Promise<PrintResult> {
    this.printed.push({ html, opts });
    return { printed: true };
  }
  async listPrinters(): Promise<PrinterInfo[]> {
    return [{ name: 'POS-80', displayName: 'POS-80 Thermal', isDefault: true }];
  }
  async htmlToPdf(html: string): Promise<Uint8Array> {
    return new TextEncoder().encode(`%PDF-FAKE\n${html.length}`);
  }
  async saveFile(opts: { defaultName: string; data: Uint8Array | string }): Promise<string | null> {
    this.saved.push({ name: opts.defaultName, data: opts.data });
    return `${this.docsDir}/${opts.defaultName}`;
  }
  async pickFile(): Promise<string | null> {
    return this.nextPickFile;
  }
  async pickFolder(): Promise<string | null> {
    return this.nextPickFolder;
  }
  async openPath(): Promise<void> {}
  showInFolder(): void {}
  documentsDir(): string {
    return this.docsDir;
  }
}

/* ------------------------------ Saving a file where the user chose ------------------------------ */

/** Why a file could not be saved: decides the words (a backup copy says it its own way). */
export type SaveFailure = 'full' | 'read-only' | 'unavailable' | 'incomplete' | 'in-use' | 'other';

/** A file could not be saved where the user chose. Nothing was left there: the message says so. */
export class SaveFileError extends AppError {
  readonly reason: SaveFailure;
  constructor(reason: SaveFailure, message: string) {
    super('VALIDATION', message);
    this.name = 'SaveFileError';
    this.reason = reason;
  }
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

function saveFailureOf(e: unknown): SaveFailure {
  if (e instanceof SaveFileError) return e.reason;
  const code = (e as NodeJS.ErrnoException | undefined)?.code ?? '';
  if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EFBIG') return 'full';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'read-only';
  if (['ENOENT', 'ENODEV', 'ENXIO', 'EIO', 'ENOTDIR', 'ENOTCONN', 'ESTALE'].includes(code)) return 'unavailable';
  return 'other';
}

/** Plain-English message for a file that could not be saved (nothing was left behind). */
export function saveFailureMessage(reason: SaveFailure, detail?: string): string {
  switch (reason) {
    case 'full':
      return 'The pen drive or disk is full, so the file could not be saved. Nothing was left there. Free some space or choose another place, then try again.';
    case 'read-only':
      return 'Billforce is not allowed to save files there (it may be read-only). Nothing was saved. Choose another place.';
    case 'unavailable':
      return 'The pen drive or folder is not available (was the pen drive removed?). Nothing was saved. Connect it again or choose another place.';
    case 'incomplete':
      return 'The file could not be written completely (the pen drive may be full or faulty), so nothing was left there. Try again or choose another place.';
    case 'in-use':
      return 'A file with this name is open in another program (for example Excel) or is read-only, so it could not be replaced. Close it and try again, or save under another name.';
    default:
      return `The file could not be saved${detail ? ` (${detail})` : ''}. Nothing was left there. Choose another place and try again.`;
  }
}

/**
 * Save a file where the user chose (exports, templates, a backup copy on a pen drive) so that a failure
 * never leaves a cut-short file that looks complete: write "<name>.partial" next to it, flush it to the
 * disk, check its size, then rename it to the real name. On any failure the partial file is removed and a
 * SaveFileError with a plain message is thrown; a file that already had that name stays as it was.
 */
export async function writeFileSafely(target: string, data: Uint8Array | string): Promise<void> {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const partial = `${target}.partial`;
  let fh: FileHandle | null = null;
  let renaming = false;
  try {
    fh = await fsp.open(partial, 'w');
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off);
      if (bytesWritten <= 0) throw new SaveFileError('incomplete', saveFailureMessage('incomplete'));
      off += bytesWritten;
    }
    await fh.sync();
    const { size } = await fh.stat();
    await fh.close();
    fh = null;
    if (size !== buf.length) throw new SaveFileError('incomplete', saveFailureMessage('incomplete'));
    renaming = true;
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(partial, target);
        break;
      } catch (e) {
        // Antivirus / indexing can hold a brand-new file for a moment on Windows.
        if (i >= 4 || !RETRYABLE_RENAME.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  } catch (e) {
    await fh?.close().catch(() => undefined);
    await fsp.rm(partial, { force: true }).catch(() => undefined);
    if (e instanceof SaveFileError) throw e;
    // The new file was written but the old one could not be replaced: it is open somewhere (Windows locks it).
    const inUse = renaming && RETRYABLE_RENAME.has((e as NodeJS.ErrnoException)?.code ?? '') && fs.existsSync(target);
    const reason = inUse ? 'in-use' : saveFailureOf(e);
    throw new SaveFileError(reason, saveFailureMessage(reason, (e as Error)?.message));
  }
  // The new name must survive a power cut too (not possible on Windows: it has no directory handles).
  try {
    const dir = fs.openSync(path.dirname(target), 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch {
    /* best effort */
  }
}

/* ------------------------------ Safeguards around any platform ------------------------------ */

/** Comparable form of a file path (Windows paths are not case-sensitive). */
export function pathKey(p: string, platform: string = process.platform): string {
  const r = platform === 'win32' ? path.win32.resolve(p) : path.resolve(p);
  return platform === 'win32' ? r.toLowerCase() : r;
}

/** Shown when the printer chosen in the receipt settings is not installed (renamed, removed, reinstalled). */
export function printerMissingMessage(printerName: string): string {
  return `Printer '${printerName}' was not found. Choose your printer again in Settings > Receipt & printer.`;
}

/** Shown when the computer has no printer at all (Chromium: "Failed to enumerate printers"). */
export const NO_PRINTER_MESSAGE = 'No printer is installed on this computer. Add a printer in Windows Settings > Printers.';

/** Plain-English text for a failed print job (Chromium's reasons are technical, e.g. "Invalid deviceName provided"). */
export function friendlyPrintFailure(reason: string | undefined, printerName?: string): string | undefined {
  const r = (reason ?? '').trim();
  if (!r) return undefined;
  if (/cancel/i.test(r)) return 'Printing was cancelled';
  // No printer installed: "switched on / has paper" would be the wrong advice.
  if (/enumerate printers|no printers?\b.*\b(installed|available|found)|no printer (is )?(installed|available)/i.test(r)) return NO_PRINTER_MESSAGE;
  if (printerName && /device ?name|no such printer|printer (was )?not found|unknown printer/i.test(r)) return printerMissingMessage(printerName);
  if (/print job failed|failed|not accept/i.test(r)) {
    return `The printer${printerName ? ` '${printerName}'` : ''} did not print. Check that it is switched on, connected and has paper, then try again.`;
  }
  return r;
}

const PRINTER_CHECK_TTL_MS = 2 * 60_000;

interface Safeguards {
  /** Files written through saveFile (exports, templates, backup copies) this session. */
  produced: Set<string>;
  /** Printer name -> when it was last seen installed. */
  printersSeen: Map<string, number>;
}

const safeguards = new WeakMap<object, Safeguards>();

/**
 * Wrap a platform so that every caller gets the same safety rules:
 *  - paths returned by saveFile are remembered, so files.open / files.showInFolder can refuse anything
 *    Billforce did not produce itself (see isAppFile);
 *  - a silent print to a printer that is not installed returns a clear message instead of Chromium's
 *    raw error, and other print failures are put into plain English.
 * The wrapped object reads through to the original, so tests can still inspect / replace its members.
 */
export function withSafeguards<P extends Platform>(inner: P): P {
  const state: Safeguards = { produced: new Set(), printersSeen: new Map() };
  const saveFile: Platform['saveFile'] = async (opts) => {
    const saved = await inner.saveFile(opts);
    if (saved) state.produced.add(pathKey(saved));
    return saved;
  };
  const printHtml: Platform['printHtml'] = async (html, opts) => {
    const name = opts.printerName?.trim();
    if (opts.silent && name) {
      const seen = state.printersSeen.get(name);
      if (!seen || Date.now() - seen > PRINTER_CHECK_TTL_MS) {
        let printers: PrinterInfo[] = [];
        try {
          printers = await inner.listPrinters();
        } catch {
          printers = [];
        }
        // An empty list means the printers could not be read: let the print itself decide.
        if (printers.length) {
          const same = (a: string) => a.trim().toLowerCase() === name.toLowerCase();
          if (!printers.some((p) => same(p.name) || same(p.displayName))) return { printed: false, message: printerMissingMessage(name) };
          state.printersSeen.set(name, Date.now());
        }
      }
    }
    const res = await inner.printHtml(html, opts);
    if (res.printed) return res;
    if (name) state.printersSeen.delete(name);
    return { ...res, message: friendlyPrintFailure(res.message, name) };
  };
  const wrapped = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'saveFile') return saveFile;
      if (prop === 'printHtml') return printHtml;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  });
  safeguards.set(wrapped, state);
  return wrapped;
}

/** Did this (wrapped) platform save the file at `p` during this session? */
export function wasSavedByApp(platform: Platform, p: string): boolean {
  return !!safeguards.get(platform)?.produced.has(pathKey(p));
}
