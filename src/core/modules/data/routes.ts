import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { route } from '../../api/router';
import { fail } from '../../errors';
import { logActivity } from '../../audit';
import { getSection, updateSection } from '../../settings';
import { folderProblem } from '../settings/service';
import * as backup from './backup';
import * as importer from './import';

const zPath = z.string().trim().min(1, 'Choose a file').max(1000);
const zImportType = z.enum(importer.IMPORT_TYPES, { message: 'Choose what to import' });
const zMapping = z.record(z.string(), z.number().int().min(0).max(500).nullable()).nullish();

export const dataRoutes = {
  /* ------------------------------ Backup & restore ------------------------------ */
  'backup.status': route({ access: ['data.backup', 'data.restore'], handler: (ctx) => backup.backupStatus(ctx) }),

  /** "Back up now": a manual backup into the backup folder. Not a transaction (SQLite cannot VACUUM inside one). */
  'backup.create': route({
    access: 'data.backup',
    input: z.object({ note: z.string().trim().max(200).nullish() }),
    handler: (ctx, input) => backup.manualBackup(ctx, input.note),
  }),

  /** A fresh backup saved wherever the user chooses (e.g. a pen drive). */
  'backup.saveAs': route({ access: 'data.backup', handler: (ctx) => backup.saveBackupCopy(ctx) }),

  'backup.chooseFolder': route({
    access: 'data.backup',
    handler: async (ctx) => {
      const current = backup.backupFolder(ctx);
      const picked = await ctx.platform.pickFolder({ title: 'Choose the folder for Billforce backups', defaultPath: current });
      if (!picked) return { folder: null as string | null, changed: false };
      const problem = folderProblem(picked);
      if (problem) throw fail.validation(problem, { folder: problem });
      const before = getSection(ctx, 'backup').folder;
      if (before === picked) return { folder: picked, changed: false };
      ctx.db.tx(() => {
        updateSection(ctx, 'backup', { folder: picked });
        logActivity(ctx, 'backup.folder', `Changed the backup folder to ${picked}`, { entityType: 'settings', details: { before: before || ctx.info.defaultBackupDir, after: picked } });
      });
      return { folder: picked, changed: true };
    },
  }),

  'backup.openFolder': route({
    access: ['data.backup', 'data.restore'],
    handler: async (ctx) => {
      const folder = backup.backupFolder(ctx);
      try {
        fs.mkdirSync(folder, { recursive: true });
      } catch {
        throw fail.validation(`The backup folder "${folder}" cannot be opened. Choose another folder.`);
      }
      await ctx.platform.openPath(folder);
      return { folder };
    },
  }),

  'backup.pickFile': route({
    access: 'data.restore',
    handler: async (ctx) => {
      const file = await ctx.platform.pickFile({ title: 'Choose a Billforce backup to restore', filters: backup.BACKUP_FILE_FILTERS });
      return { path: file, fileName: file ? path.basename(file) : null };
    },
  }),

  /** What is inside a backup, for the confirmation dialog. Changes nothing. */
  'backup.inspect': route({ access: 'data.restore', input: z.object({ path: zPath }), handler: (ctx, input) => backup.inspectBackup(ctx, input.path) }),

  /**
   * Replace ALL current data with the backup (after saving a safety backup of the current data).
   * Not a transaction: the database file itself is swapped. The session ends; the UI reloads.
   */
  'backup.restore': route({ access: 'data.restore', input: z.object({ path: zPath }), handler: (ctx, input) => backup.restoreBackup(ctx, input.path) }),

  /*
   * First run on a new computer / after a reinstall: bring back a backup instead of setting up a new business.
   * No login exists yet, so these are public, and all three refuse once Billforce is set up. Only the file picked
   * in the dialog can be inspected or restored. No safety copy is taken (there is no data yet); the checks are the
   * same as a normal restore. Afterwards the app shows the login screen of the restored business.
   */
  'setup.pickBackup': route({ access: 'public', handler: (ctx) => backup.pickBackupOnFirstRun(ctx) }),
  'setup.inspectBackup': route({ access: 'public', input: z.object({ path: zPath }), handler: (ctx, input) => backup.inspectBackupOnFirstRun(ctx, input.path) }),
  'setup.restoreBackup': route({ access: 'public', input: z.object({ path: zPath }), handler: (ctx, input) => backup.restoreOnFirstRun(ctx, input.path) }),

  /* ------------------------------ Import ------------------------------ */
  'import.types': route({ access: 'data.import', handler: (ctx) => importer.importTypes(ctx) }),

  /** Save an Excel / CSV template with the column names, two example rows and instructions. */
  'import.template': route({
    access: 'data.import',
    input: z.object({ type: zImportType, format: z.enum(['xlsx', 'csv']) }),
    handler: async (ctx, input) => {
      const t = await importer.buildTemplate(ctx, input.type, input.format);
      const saved = await ctx.platform.saveFile({
        defaultName: t.fileName,
        data: t.data,
        filters: [input.format === 'xlsx' ? { name: 'Excel workbook', extensions: ['xlsx'] } : { name: 'CSV (comma separated)', extensions: ['csv'] }],
      });
      return { path: saved };
    },
  }),

  'import.pickFile': route({
    access: 'data.import',
    handler: async (ctx) => {
      const file = await ctx.platform.pickFile({
        title: 'Choose the Excel or CSV file to import',
        filters: [
          { name: 'Excel or CSV', extensions: ['xlsx', 'csv'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      return { path: file, fileName: file ? path.basename(file) : null };
    },
  }),

  'import.preview': route({
    access: 'data.import',
    input: z.object({ type: zImportType, path: zPath, mapping: zMapping, duplicateMode: z.enum(['skip', 'update']).optional() }),
    handler: (ctx, input) => importer.previewImport(ctx, input),
  }),

  /** Import every valid row in one transaction (the file is read first, then everything is saved at once). */
  'import.commit': route({
    access: 'data.import',
    input: z.object({ type: zImportType, path: zPath, mapping: zMapping, duplicateMode: z.enum(['skip', 'update']) }),
    handler: (ctx, input) => importer.commitImport(ctx, input),
  }),
};
