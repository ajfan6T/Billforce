import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BillforceApp } from '../src/core/app';
import { ElectronPlatform } from './platform';
import { startBackupScheduler, type BackupScheduler } from '../src/core/modules/data/scheduler';
import { runSmokeTest } from '../src/core/smoke';

const DEV_URL = process.env.BILLFORCE_DEV_URL;
let mainWindow: BrowserWindow | null = null;
let core: BillforceApp | null = null;
let scheduler: BackupScheduler | null = null;

// Indian locale: dd/mm/yyyy in date pickers, en-IN number formatting.
app.commandLine.appendSwitch('lang', 'en-IN');
app.setAppUserModelId('in.billforce.desktop');

function logDir(): string {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function logError(where: string, err: unknown): void {
  try {
    const line = `[${new Date().toISOString()}] ${where}: ${err instanceof Error ? err.stack : String(err)}\n`;
    fs.appendFileSync(path.join(logDir(), 'main.log'), line);
  } catch {
    /* ignore */
  }
}

process.on('uncaughtException', (e) => logError('uncaughtException', e));
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Billforce',
    backgroundColor: '#f4f6fa',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize();
    mainWindow?.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // The app never navigates away or opens pop-ups; external links open in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return;
    e.preventDefault();
  });
  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Open data folder', click: () => core && shell.openPath(core.info.dataDir) },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn', accelerator: 'CommandOrControl+=' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ role: 'reload' }, { role: 'toggleDevTools' }] as Electron.MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Billforce',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: 'About Billforce',
              message: `Billforce ${app.getVersion()}`,
              detail: `Billing, accounts and business management.\nYour data is stored on this computer:\n${core?.info.dataDir ?? ''}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function startSmokeTest(outFile: string): Promise<void> {
  // Used by CI on Windows: exercise the real packaged app (database, ledger, reports) without a window.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billforce-smoke-'));
  let code = 0;
  try {
    const result = await runSmokeTest(dir, new ElectronPlatform(() => null), app.getVersion());
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    code = result.ok ? 0 : 1;
  } catch (e) {
    fs.writeFileSync(outFile, JSON.stringify({ ok: false, error: String((e as Error)?.stack ?? e) }, null, 2));
    code = 1;
  }
  app.exit(code);
}

const smokeArg = process.argv.find((a) => a.startsWith('--smoke-test='));

if (smokeArg) {
  app.whenReady().then(() => startSmokeTest(smokeArg.slice('--smoke-test='.length)));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const dataDir = process.env.BILLFORCE_DATA_DIR || app.getPath('userData');
    const platform = new ElectronPlatform(() => mainWindow);
    try {
      core = new BillforceApp({ dataDir, platform, version: app.getVersion() });
    } catch (e) {
      logError('open database', e);
      const choice = dialog.showMessageBoxSync({
        type: 'error',
        title: 'Billforce could not open your data',
        message: 'Billforce could not open your data file.',
        detail: `${(e as Error).message}\n\nData folder: ${dataDir}\n\nYou can restore a backup by replacing billforce.db in the data folder with a backup copy.`,
        buttons: ['Open data folder', 'Exit'],
        defaultId: 1,
      });
      if (choice === 0) shell.openPath(dataDir);
      app.exit(1);
      return;
    }
    core.onEvent((event) => mainWindow?.webContents.send('bf:event', event));
    ipcMain.handle('bf:invoke', (_e, name: string, input: unknown) => core!.invoke(name, input));
    buildMenu();
    createWindow();
    scheduler = startBackupScheduler(core);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    try {
      scheduler?.backupOnExit();
      scheduler?.stop();
    } catch (e) {
      logError('backup on exit', e);
    }
    try {
      core?.close();
    } catch (e) {
      logError('close database', e);
    }
    core = null;
  });
}
