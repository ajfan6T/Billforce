import nodePath from 'node:path';
import type { Ctx } from '../../context';
import { now } from '../../context';
import { fail } from '../../errors';
import { pathKey, wasSavedByApp } from '../../platform';
import { backupFolder } from '../data/backup';
import type { ExportFormat, ReportData } from '../../../shared/report';
import { reportToCsv } from '../../export/csv';
import { reportToXlsx } from '../../export/xlsx';
import { reportToHtml } from '../../export/html';
import { safeFileName } from '../../export/format';
import { getSection } from '../../settings';
import { logActivity } from '../../audit';

const FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  xlsx: { name: 'Excel workbook', extensions: ['xlsx'] },
  csv: { name: 'CSV (comma separated)', extensions: ['csv'] },
  pdf: { name: 'PDF document', extensions: ['pdf'] },
};

export function reportHtml(ctx: Ctx, report: ReportData): string {
  const business = getSection(ctx, 'business');
  return reportToHtml(report, {
    businessName: business.name,
    businessAddress: [business.address, business.phone ? `Ph: ${business.phone}` : ''].filter(Boolean).join('\n'),
    generatedAt: now(ctx),
    generatedBy: ctx.session?.fullName,
  });
}

/** Convert a report to the chosen format and ask the user where to save it. */
export async function exportReport(ctx: Ctx, report: ReportData, format: ExportFormat): Promise<{ path: string | null }> {
  const business = getSection(ctx, 'business');
  let data: Uint8Array | string;
  if (format === 'csv') data = reportToCsv(report);
  else if (format === 'xlsx') data = await reportToXlsx(report, business.name);
  else data = await ctx.platform.htmlToPdf(reportHtml(ctx, report), { landscape: report.landscape });
  const name = `${safeFileName([report.title, report.subtitle].filter(Boolean).join(' '))}.${format}`;
  const path = await ctx.platform.saveFile({ defaultName: name, data, filters: [FILTERS[format]] });
  if (path) {
    logActivity(ctx, 'report.export', `Exported "${report.title}" as ${format.toUpperCase()}`, { details: { path, subtitle: report.subtitle } });
  }
  return { path };
}

export async function printReport(ctx: Ctx, report: ReportData): Promise<{ printed: boolean }> {
  const result = await ctx.platform.printHtml(reportHtml(ctx, report), { silent: false });
  return { printed: result.printed };
}

/**
 * files.open / files.showInFolder only work on what Billforce itself produced: files saved this session
 * (exports, templates, backup copies), the data folder, the backup folder and Billforce backup files
 * (.bfbackup) in it or in the backup history. Anything else is refused, so these routes can never be
 * used to start a program or open an arbitrary file or network path.
 */
export function assertAppFile(ctx: Ctx, p: string): void {
  const refuse = () => fail.forbidden('Billforce can only open files and folders it saved itself.');
  const abs = /^([a-zA-Z]:[\\/]|\/)/.test(p) || /^\\\\/.test(p);
  if (!abs || p.includes('\0')) throw refuse();
  if (wasSavedByApp(ctx.platform, p)) return;
  const key = pathKey(p);
  const folder = backupFolder(ctx);
  if (key === pathKey(ctx.info.dataDir) || key === pathKey(folder)) return;
  if (/\.bfbackup$/i.test(p)) {
    if (pathKey(nodePath.dirname(p)) === pathKey(folder)) return;
    const recorded = ctx.db.all<{ path: string }>('SELECT path FROM backup_history');
    if (recorded.some((r) => pathKey(r.path) === key)) return;
  }
  throw refuse();
}
