/**
 * Development / test server: runs the same core as the desktop app and serves
 * the built UI to an ordinary browser, so the UI can be tested with
 * Playwright without Electron. NOT used by the shipped Windows app.
 *
 *   npm run build && node dist/web/server.cjs --port 4173 --data .e2e-data
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { BillforceApp } from '../src/core/app';
import type { FileFilter, Platform, PrinterInfo, PrintOptions, PrintResult } from '../src/core/platform';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(arg('port', process.env.PORT ?? '4173'));
const dataDir = path.resolve(arg('data', process.env.BILLFORCE_DATA_DIR ?? '.e2e-data'));
const staticDir = path.resolve(__dirname, '../renderer');
fs.mkdirSync(dataDir, { recursive: true });

/** Fake OS services that write to the data folder instead of showing dialogs. */
class WebPlatform implements Platform {
  kind = 'web' as const;
  nextPickFile: string | null = null;
  nextPickFolder: string | null = null;
  printCount = 0;
  async printHtml(html: string, opts: PrintOptions): Promise<PrintResult> {
    const dir = path.join(dataDir, 'prints');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `print-${String(++this.printCount).padStart(4, '0')}.html`);
    fs.writeFileSync(file, html);
    fs.writeFileSync(path.join(dir, 'last.json'), JSON.stringify({ file, opts }));
    return { printed: true };
  }
  async listPrinters(): Promise<PrinterInfo[]> {
    return [
      { name: 'POS-80', displayName: 'POS-80 Thermal Printer', isDefault: false },
      { name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF', isDefault: true },
    ];
  }
  async htmlToPdf(html: string): Promise<Uint8Array> {
    return new TextEncoder().encode(`%PDF-1.4\n% test server placeholder\n${html}`);
  }
  async saveFile(opts: { defaultName: string; data: Uint8Array | string; filters?: FileFilter[] }): Promise<string | null> {
    const dir = path.join(dataDir, 'downloads');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, opts.defaultName);
    fs.writeFileSync(file, typeof opts.data === 'string' ? opts.data : Buffer.from(opts.data));
    return file;
  }
  async pickFile(): Promise<string | null> {
    const f = this.nextPickFile;
    this.nextPickFile = null;
    return f;
  }
  async pickFolder(): Promise<string | null> {
    const f = this.nextPickFolder;
    this.nextPickFolder = null;
    return f;
  }
  async openPath(): Promise<void> {}
  showInFolder(): void {}
  documentsDir(): string {
    return path.join(dataDir, 'documents');
  }
}

const platform = new WebPlatform();
const core = new BillforceApp({ dataDir, platform, version: 'web-test' });
const events: string[] = [];
core.onEvent((e) => events.push(e));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/invoke') {
      const { name, input } = JSON.parse((await readBody(req)) || '{}');
      const result = await core.invoke(name, input);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(events.splice(0)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__test/pick-file') {
      platform.nextPickFile = JSON.parse(await readBody(req)).path;
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__test/pick-folder') {
      platform.nextPickFolder = JSON.parse(await readBody(req)).path;
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/__test/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ dataDir, printCount: platform.printCount }));
      return;
    }
    let file = path.join(staticDir, decodeURIComponent(url.pathname));
    if (!file.startsWith(staticDir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(staticDir, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(e));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Billforce test server on http://127.0.0.1:${port} (data: ${dataDir})`);
});
