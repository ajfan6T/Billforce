import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, session, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BillforceApp } from '../src/core/app';
import { ElectronPlatform } from './platform';
import { closeQuestion, readCloseWarning, type CloseWarning } from './close-warning';
import { startBackupScheduler, type BackupScheduler } from '../src/core/modules/data/scheduler';
import { BACKUP_FILE_FILTERS } from '../src/core/modules/data/backup';
import { backupFolderFromDamagedFile, describeOpenFailure, findBackups, RecoveryError, restoreDamagedDatabase } from '../src/core/recovery';
import { runSmokeTest } from '../src/core/smoke';
import { formatDateTime } from '../src/shared/dates';

const DEV_URL = process.env.BILLFORCE_DEV_URL;
let mainWindow: BrowserWindow | null = null;
let core: BillforceApp | null = null;
let scheduler: BackupScheduler | null = null;
/** Set while the window reloads after a restore: the "unsaved changes" question is skipped then. */
let reloadingAfterRestore = false;

/** What the page says closing the window would do (sent by the renderer's guards.ts whenever it changes). */
let closeWarning: CloseWarning | null = null;

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

function documentsDir(): string {
  try {
    return app.getPath('documents');
  } catch {
    return os.homedir();
  }
}

/**
 * The app works fully offline: Chromium's spell checker would otherwise download a dictionary from
 * Google at every start (webPreferences.spellcheck only hides it in the page).
 */
function keepOffline(): void {
  const ses = session.defaultSession;
  ses.setSpellCheckerEnabled(false);
  try {
    ses.setSpellCheckerLanguages([]);
  } catch {
    /* not supported on this platform */
  }
  // If anything still asks for a dictionary, it goes nowhere instead of to the internet.
  ses.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/');
}

/**
 * Last backup and a clean close of the database. Runs once, when Billforce really quits: after all
 * windows closed (not when a close was cancelled by "Stay"), or when Windows shuts down / logs off
 * ('before-quit' does not fire then).
 */
function shutDownCore(reason: string): void {
  if (!core) return;
  try {
    scheduler?.backupOnExit();
    scheduler?.stop();
  } catch (e) {
    logError(`backup on exit (${reason})`, e);
  }
  try {
    core.close();
  } catch (e) {
    logError(`close database (${reason})`, e);
  }
  core = null;
  scheduler = null;
}

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
  // Windows shutdown / restart / log-off: take the exit backup while there is still time, then close
  // the database cleanly. (No 'before-quit' / 'will-quit' in this case.)
  mainWindow.on('query-session-end', () => {
    try {
      scheduler?.backupOnExit();
    } catch (e) {
      logError('backup before session end', e);
    }
  });
  mainWindow.on('session-end', () => shutDownCore('session end'));
  // A form with unsaved changes blocks the close with 'beforeunload'; Electron then does nothing unless asked.
  mainWindow.webContents.on('will-prevent-unload', (e) => {
    if (reloadingAfterRestore) {
      e.preventDefault();
      return;
    }
    const win = mainWindow;
    // A bill in progress on the billing screen is kept as a draft: say so instead of "will be lost".
    const opts = closeQuestion(closeWarning);
    const choice = win && !win.isDestroyed() ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts);
    // preventDefault() here means "ignore the page's beforeunload and leave".
    if (choice === 0) e.preventDefault();
  });
  // A new page (reload) starts with nothing to warn about; it tells us again when something is entered.
  mainWindow.webContents.on('did-navigate', () => {
    closeWarning = null;
  });
  mainWindow.webContents.on('did-finish-load', () => {
    reloadingAfterRestore = false;
  });
  // The app never navigates away or opens pop-ups; external links open in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return;
    // A reload of the app's own page (e.g. location.reload()) is fine; going anywhere else is not.
    const current = mainWindow?.webContents.getURL() ?? '';
    if (current && url.split('#')[0] === current.split('#')[0]) return;
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

  app.whenReady().then(async () => {
    keepOffline();
    const dataDir = process.env.BILLFORCE_DATA_DIR || app.getPath('userData');
    const platform = new ElectronPlatform(() => mainWindow);
    try {
      core = new BillforceApp({ dataDir, platform, version: app.getVersion() });
    } catch (e) {
      logError('open database', e);
      await recoverFromOpenFailure(e, dataDir, path.join(dataDir, 'billforce.db'));
      return;
    }
    core.onEvent((event) => {
      if (event === 'database-replaced') {
        // After a restore the page must start again on the new data. Reload from here: a reload the page
        // starts itself can be held up, and this also resets every cached screen. The short delay lets the
        // restore screen show "restored" first.
        setTimeout(() => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          reloadingAfterRestore = true;
          mainWindow.webContents.reload();
        }, 1500);
        return;
      }
      mainWindow?.webContents.send('bf:event', event);
    });
    ipcMain.on('bf:close-warning', (e, warning: unknown) => {
      if (mainWindow && e.sender === mainWindow.webContents) closeWarning = readCloseWarning(warning);
    });
    ipcMain.handle('bf:invoke', (_e, name: string, input: unknown) =>
      core ? core.invoke(name, input) : { ok: false, error: { code: 'INTERNAL', message: 'Billforce is closing.' } },
    );
    buildMenu();
    createWindow();
    scheduler = startBackupScheduler(core);
    // Linux / macOS shutdown (Windows uses the window's session-end event above).
    powerMonitor.on('shutdown', () => shutDownCore('system shutdown'));
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // Not 'before-quit': that also fires when File > Exit is then cancelled by "Stay" on unsaved changes,
  // which would close the database under a window that is still open.
  app.on('will-quit', () => shutDownCore('quit'));
}

/** Start Billforce again (e.g. after restoring a backup at start-up); the portable exe restarts itself. */
function relaunch(): void {
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  app.relaunch(portableExe ? { execPath: portableExe } : undefined);
  app.exit(0);
}

/**
 * billforce.db could not be opened, so the app (and its Backup & restore screen) cannot start.
 * Explain what happened and offer a real way back: restore a .bfbackup here, open the data folder, or exit.
 */
async function recoverFromOpenFailure(error: unknown, dataDir: string, dbPath: string): Promise<void> {
  const failure = describeOpenFailure(error);
  // The folder chosen in Settings if it can still be read from the file, else the default one.
  const defaultDir = path.join(documentsDir(), 'Billforce Backups');
  const chosenDir = failure.canRestore ? backupFolderFromDamagedFile(dbPath) : null;
  for (;;) {
    const newest = failure.canRestore ? [...(chosenDir ? findBackups(chosenDir) : []), ...findBackups(defaultDir)].sort((a, b) => (a.at < b.at ? 1 : -1))[0] : undefined;
    const backupDir = chosenDir && fs.existsSync(chosenDir) ? chosenDir : defaultDir;
    const buttons = failure.canRestore ? ['Restore from a backup…', 'Open data folder', 'Exit'] : ['Open data folder', 'Exit'];
    const hint = newest ? `\n\nNewest backup found: ${newest.fileName} (${formatDateTime(newest.at)})` : '';
    const { response } = await dialog.showMessageBox({
      type: failure.kind === 'newer-version' ? 'warning' : 'error',
      title: 'Billforce could not open your data',
      message: failure.title,
      detail: `${failure.detail}\n\nData folder: ${dataDir}${hint}`,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    });
    const choice = buttons[response];
    if (choice === 'Exit' || choice === undefined) break;
    if (choice === 'Open data folder') {
      await shell.openPath(dataDir);
      continue;
    }
    const picked = await dialog.showOpenDialog({
      title: 'Choose the Billforce backup to restore',
      defaultPath: newest?.path ?? (fs.existsSync(backupDir) ? backupDir : documentsDir()),
      filters: BACKUP_FILE_FILTERS,
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths[0]) continue;
    try {
      const r = restoreDamagedDatabase(dbPath, picked.filePaths[0]);
      await dialog.showMessageBox({
        type: 'info',
        title: 'Data restored',
        message: `Your data${r.businessName ? ` for ${r.businessName}` : ''} was restored from the backup.`,
        detail: `Restored from: ${r.restoredFrom}${r.damagedCopy ? `\nThe file that could not be opened was kept as: ${r.damagedCopy}` : ''}\n\nBillforce will now start again. Anything entered after this backup was taken needs to be entered again.`,
        buttons: ['Start Billforce'],
        noLink: true,
      });
      relaunch();
      return;
    } catch (e) {
      logError('restore at start-up', e);
      await dialog.showMessageBox({
        type: 'warning',
        title: 'This backup cannot be used',
        message: 'This backup cannot be used.',
        detail: `${e instanceof RecoveryError ? e.message : `The backup could not be put in place: ${(e as Error).message}`}\n\nYour data has not been changed. Choose another backup.`,
        buttons: ['OK'],
        noLink: true,
      });
    }
  }
  app.exit(1);
}
