import type { Ctx } from '../../context';

/*
 * CONTRACT functions used by other modules. The employees module owner extends
 * this file but must keep these signatures.
 */

export interface EmployeeSummary {
  id: number;
  name: string;
  phone: string | null;
  designation: string | null;
  isActive: boolean;
}

export function searchEmployees(ctx: Ctx, q = '', includeInactive = false): EmployeeSummary[] {
  const text = q.trim();
  return ctx.db
    .all<any>(
      `SELECT id, name, phone, designation, is_active FROM employees
        WHERE (:all = 1 OR is_active = 1) AND (:q = '' OR name LIKE :like OR phone LIKE :like)
        ORDER BY name COLLATE NOCASE`,
      { all: includeInactive ? 1 : 0, q: text, like: `%${text}%` },
    )
    .map((r) => ({ id: r.id, name: r.name, phone: r.phone, designation: r.designation, isActive: !!r.is_active }));
}
