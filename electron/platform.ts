import { app, BrowserWindow, dialog, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FileFilter, Platform, PrinterInfo, PrintOptions, PrintResult } from '../src/core/platform';

/** Platform services backed by Electron: printing, PDF, native file dialogs. */
export class ElectronPlatform implements Platform {
  kind = 'electron' as const;
  private lastSaveDir: string | null = null;

  constructor(private getWindow: () => BrowserWindow | null) {}

  private async withHiddenPage<T>(html: string, widthPx: number, fn: (win: BrowserWindow) => Promise<T>): Promise<T> {
    const file = path.join(os.tmpdir(), `billforce-print-${randomBytes(6).toString('hex')}.html`);
    fs.writeFileSync(file, html, 'utf8');
    const win = new BrowserWindow({
      show: false,
      width: widthPx,
      height: 900,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await win.loadFile(file);
      return await fn(win);
    } finally {
      if (!win.isDestroyed()) win.destroy();
      fs.rm(file, { force: true }, () => {});
    }
  }

  async printHtml(html: string, opts: PrintOptions): Promise<PrintResult> {
    const receipt = !!opts.paperWidthMm;
    const widthPx = receipt ? Math.round(((opts.paperWidthMm ?? 80) / 25.4) * 96) + 20 : 900;
    return this.withHiddenPage(html, widthPx, async (win) => {
      let pageSize: Electron.WebContentsPrintOptions['pageSize'] = 'A4';
      if (receipt) {
        const heightPx: number = await win.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)');
        const heightMicrons = Math.ceil((heightPx / 96) * 25400) + 4000;
        pageSize = { width: (opts.paperWidthMm ?? 80) * 1000, height: Math.max(heightMicrons, 50_000) };
      }
      const silent = !!opts.silent && !!opts.printerName;
      return new Promise<PrintResult>((resolve) => {
        win.webContents.print(
          {
            silent,
            deviceName: opts.printerName || undefined,
            printBackground: true,
            copies: Math.max(1, opts.copies ?? 1),
            margins: receipt ? { marginType: 'none' } : { marginType: 'default' },
            pageSize,
          },
          (success, failureReason) => {
            if (success) resolve({ printed: true });
            else if (/cancel/i.test(failureReason ?? '')) resolve({ printed: false, message: 'Printing was cancelled' });
            else resolve({ printed: false, message: failureReason || 'The printer did not accept the job' });
          },
        );
      });
    });
  }

  async listPrinters(): Promise<PrinterInfo[]> {
    const win = this.getWindow();
    if (!win) return [];
    const printers = await win.webContents.getPrintersAsync();
    return printers.map((p: any) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!(p.isDefault ?? p.options?.['printer-is-default'] ?? false),
    }));
  }

  async htmlToPdf(html: string, opts: { landscape?: boolean }): Promise<Uint8Array> {
    return this.withHiddenPage(html, 900, async (win) => {
      const buf = await win.webContents.printToPDF({
        landscape: !!opts.landscape,
        printBackground: true,
        preferCSSPageSize: true,
        pageSize: 'A4',
      });
      return new Uint8Array(buf);
    });
  }

  async saveFile(opts: { defaultName: string; data: Uint8Array | string; filters?: FileFilter[] }): Promise<string | null> {
    const win = this.getWindow();
    const dir = this.lastSaveDir ?? this.documentsDir();
    const dialogOpts = { defaultPath: path.join(dir, opts.defaultName), filters: opts.filters };
    const res = win ? await dialog.showSaveDialog(win, dialogOpts) : await dialog.showSaveDialog(dialogOpts);
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, typeof opts.data === 'string' ? opts.data : Buffer.from(opts.data));
    this.lastSaveDir = path.dirname(res.filePath);
    return res.filePath;
  }

  async pickFile(opts: { title?: string; filters?: FileFilter[] }): Promise<string | null> {
    const win = this.getWindow();
    const dialogOpts: Electron.OpenDialogOptions = {
      title: opts.title,
      filters: opts.filters,
      properties: ['openFile'],
      defaultPath: this.documentsDir(),
    };
    const res = win ? await dialog.showOpenDialog(win, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  }

  async pickFolder(opts: { title?: string; defaultPath?: string }): Promise<string | null> {
    const win = this.getWindow();
    const dialogOpts: Electron.OpenDialogOptions = {
      title: opts.title,
      defaultPath: opts.defaultPath ?? this.documentsDir(),
      properties: ['openDirectory', 'createDirectory'],
    };
    const res = win ? await dialog.showOpenDialog(win, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  }

  async openPath(p: string): Promise<void> {
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  }

  showInFolder(p: string): void {
    shell.showItemInFolder(p);
  }

  documentsDir(): string {
    try {
      return app.getPath('documents');
    } catch {
      return os.homedir();
    }
  }
}
