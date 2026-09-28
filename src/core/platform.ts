/**
 * Operating-system services the core needs (printing, file dialogs, PDF).
 * Implemented by the Electron main process; tests and the browser test
 * server use lightweight fakes.
 */
import path from 'node:path';

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

/** Plain-English text for a failed print job (Chromium's reasons are technical, e.g. "Invalid deviceName provided"). */
export function friendlyPrintFailure(reason: string | undefined, printerName?: string): string | undefined {
  const r = (reason ?? '').trim();
  if (!r) return undefined;
  if (/cancel/i.test(r)) return 'Printing was cancelled';
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
