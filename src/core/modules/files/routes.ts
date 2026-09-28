import { z } from 'zod';
import { route } from '../../api/router';
import { exportReport, printReport } from './service';

const zReport = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  columns: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(['text', 'money', 'number', 'qty', 'date', 'datetime', 'percent', 'drcr']).optional(),
      width: z.number().optional(),
      align: z.enum(['left', 'right', 'center']).optional(),
    }),
  ),
  rows: z.array(
    z.object({
      cells: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
      style: z.enum(['normal', 'group', 'subtotal', 'total', 'muted', 'section']).optional(),
      indent: z.number().optional(),
      link: z.object({ kind: z.string(), id: z.union([z.number(), z.string()]) }).optional(),
    }),
  ),
  summary: z
    .array(
      z.object({
        label: z.string(),
        value: z.union([z.string(), z.number(), z.null()]),
        type: z.enum(['text', 'money', 'number', 'qty', 'date', 'datetime', 'percent', 'drcr']).optional(),
      }),
    )
    .optional(),
  notes: z.array(z.string()).optional(),
  landscape: z.boolean().optional(),
});

export const filesRoutes = {
  /** Save any on-screen report as Excel, CSV or PDF. Returns the saved path, or null if cancelled. */
  'files.exportReport': route({
    access: 'reports.export',
    input: z.object({ report: zReport, format: z.enum(['xlsx', 'csv', 'pdf']) }),
    handler: (ctx, input) => exportReport(ctx, input.report, input.format),
  }),

  /** Print a report on an A4 printer (system print dialog). */
  'files.printReport': route({
    access: 'user',
    input: z.object({ report: zReport }),
    handler: (ctx, input) => printReport(ctx, input.report),
  }),

  'files.open': route({
    access: 'user',
    input: z.object({ path: z.string().min(1) }),
    handler: async (ctx, input) => {
      await ctx.platform.openPath(input.path);
    },
  }),

  'files.showInFolder': route({
    access: 'user',
    input: z.object({ path: z.string().min(1) }),
    handler: (ctx, input) => ctx.platform.showInFolder(input.path),
  }),

  'print.listPrinters': route({ access: 'user', handler: (ctx) => ctx.platform.listPrinters() }),
};
