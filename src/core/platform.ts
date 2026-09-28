/**
 * Operating-system services the core needs (printing, file dialogs, PDF).
 * Implemented by the Electron main process; tests and the browser test
 * server use lightweight fakes.
 */

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
