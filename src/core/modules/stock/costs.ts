/**
 * Cost prices are for the people who buy or see the accounts. Stock levels are shown to
 * everyone who sells, but a cashier does not see what the goods cost (average cost, stock
 * value, opening stock cost, recipe cost).
 */
import type { Ctx } from '../../context';
import { can } from '../../context';
import type { Permission } from '../../../shared/permissions';
import type { ReportData } from '../../../shared/report';
import type { ItemStock } from './valuation';

export const COST_PERMISSIONS: Permission[] = ['stock.manage', 'purchases.manage', 'suppliers.view', 'reports.financial'];

export function canSeeCosts(ctx: Ctx): boolean {
  return COST_PERMISSIONS.some((p) => can(ctx, p));
}

export const withoutCost = <T extends ItemStock>(s: T): T => ({ ...s, avgCost: 0, value: 0 });

/** A report without its money columns and money summary figures. */
export function reportWithoutCosts(r: ReportData, keys: string[]): ReportData {
  const hide = new Set(keys);
  return {
    ...r,
    columns: r.columns.filter((c) => !hide.has(c.key)),
    rows: r.rows.filter((row) => row.style !== 'total').map((row) => ({ ...row, cells: Object.fromEntries(Object.entries(row.cells).filter(([k]) => !hide.has(k))) })),
    summary: r.summary?.filter((x) => x.type !== 'money'),
    notes: r.notes?.filter((n) => !/cost|value/i.test(n)),
  };
}
