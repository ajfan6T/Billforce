import type { Ctx } from '../../context';
import { now } from '../../context';
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
