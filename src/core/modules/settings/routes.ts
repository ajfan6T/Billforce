import { z } from 'zod';
import { route } from '../../api/router';
import * as settings from './service';

const zLoose = z.record(z.string(), z.unknown()).nullish();

export const settingsRoutes = {
  /** All settings (with defaults). Any logged-in user: the UI needs receipt, billing and security options. */
  'settings.get': route({ access: 'user', handler: (ctx) => settings.readSettings(ctx) }),

  /**
   * Save part of one section: { section: 'receipt', values: { footer: 'Thank you' } }.
   * Needs "Change settings"; the backup section may also be changed with "Backup data".
   */
  'settings.update': route({
    access: ['settings.manage', 'data.backup'],
    mutation: true,
    input: z.object({ section: z.string().min(1).max(20), values: z.record(z.string(), z.unknown()) }),
    handler: (ctx, input) => settings.updateSettings(ctx, input.section, input.values),
  }),

  /** HTML of a sample bill printed with the given (unsaved) business / receipt values. */
  'settings.receiptPreview': route({
    access: 'settings.manage',
    input: z.object({ business: zLoose, receipt: zLoose, duplicate: z.boolean().optional() }),
    handler: (ctx, input) => {
      const { html, paperWidth } = settings.receiptPreview(ctx, input);
      return { html, paperWidth };
    },
  }),

  'settings.testPrint': route({
    access: 'settings.manage',
    input: z.object({ printerName: z.string().max(200).nullish(), business: zLoose, receipt: zLoose }),
    handler: (ctx, input) => settings.testPrint(ctx, input),
  }),

  'settings.about': route({ access: 'settings.manage', handler: (ctx) => settings.aboutInfo(ctx) }),
};
