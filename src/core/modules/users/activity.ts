/**
 * Activity log ("who did what and when") and document revision history.
 */
import type { Ctx } from '../../context';
import { can, requireSession, today } from '../../context';
import { AppError, fail } from '../../errors';
import { listRevisions, type RevisionRow } from '../../audit';
import type { LinkKind } from '../../accounting/links';
import type { Permission } from '../../../shared/permissions';
import type { ReportData, ReportRow } from '../../../shared/report';
import { activityLabel, isDeleteAction } from '../../../shared/activity';
import { addDays, describeRange, isValidISODate } from '../../../shared/dates';
import { formatIndianNumber } from '../../../shared/money';

export interface ActivityQuery {
  from: string;
  to: string;
  userId?: number | null;
  /** Action prefix such as "bill." (or an exact action), or several of them (any-of). */
  action?: string | string[] | null;
  entityType?: string | null;
  q?: string | null;
  limit?: number;
  offset?: number;
}

export interface ActivityItem {
  id: number;
  at: string;
  userId: number | null;
  username: string | null;
  /** Full name of the user (or the username / "System"). */
  userName: string;
  action: string;
  actionLabel: string;
  summary: string;
  entityType: string | null;
  entityId: number | null;
  /** Page to open for the record, when there is one. */
  link: { kind: LinkKind; id: number } | null;
  hasDetails: boolean;
}

export interface ActivityDetail extends ActivityItem {
  details: unknown;
}

const LINKABLE = new Set<string>([
  'bill',
  'credit_note',
  'receipt',
  'purchase',
  'supplier_payment',
  'expense',
  'journal',
  'salary',
  'advance',
  'customer',
  'supplier',
  'employee',
  'account',
  'loan',
]);

interface ActivityDbRow {
  id: number;
  at: string;
  user_id: number | null;
  username: string | null;
  full_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  summary: string;
  details: string | null;
}

function toItem(r: ActivityDbRow): ActivityItem {
  const linkable = r.entity_type && r.entity_id && LINKABLE.has(r.entity_type) && !isDeleteAction(r.action);
  return {
    id: r.id,
    at: r.at,
    userId: r.user_id,
    username: r.username,
    userName: r.full_name || r.username || 'System',
    action: r.action,
    actionLabel: activityLabel(r.action),
    summary: r.summary,
    entityType: r.entity_type,
    entityId: r.entity_id,
    link: linkable ? { kind: r.entity_type as LinkKind, id: r.entity_id! } : null,
    hasDetails: !!r.details,
  };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

function buildWhere(q: ActivityQuery): { sql: string; params: Record<string, unknown> } {
  if (!isValidISODate(q.from) || !isValidISODate(q.to)) throw fail.validation('Choose a valid period');
  if (q.from > q.to) throw fail.validation('The "from" date must be on or before the "to" date');
  const where = ['a.at >= :from', 'a.at < :toNext'];
  const params: Record<string, unknown> = { from: q.from, toNext: addDays(q.to, 1) };
  if (q.userId) {
    where.push('a.user_id = :userId');
    params.userId = q.userId;
  }
  const actions = (Array.isArray(q.action) ? q.action : q.action ? [q.action] : []).map((a) => a.trim()).filter(Boolean);
  if (actions.length) {
    const ors = actions.map((a, i) => {
      params[`act${i}`] = `${escapeLike(a)}%`;
      return `a.action LIKE :act${i} ESCAPE '\\'`;
    });
    where.push(`(${ors.join(' OR ')})`);
  }
  if (q.entityType) {
    where.push('a.entity_type = :entityType');
    params.entityType = q.entityType;
  }
  const text = q.q?.trim();
  if (text) {
    where.push("(a.summary LIKE :like ESCAPE '\\' OR a.username LIKE :like ESCAPE '\\' OR u.full_name LIKE :like ESCAPE '\\' OR a.action LIKE :like ESCAPE '\\')");
    params.like = `%${escapeLike(text)}%`;
  }
  return { sql: where.join(' AND '), params };
}

const SELECT = `SELECT a.id, a.at, a.user_id, a.username, u.full_name, a.action, a.entity_type, a.entity_id, a.summary, a.details
  FROM activity_log a LEFT JOIN users u ON u.id = a.user_id`;

export function listActivity(ctx: Ctx, q: ActivityQuery): { rows: ActivityItem[]; total: number } {
  const { sql, params } = buildWhere(q);
  const total = ctx.db.value<number>(`SELECT COUNT(*) FROM activity_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${sql}`, params, 0);
  const rows = ctx.db.all<ActivityDbRow>(`${SELECT} WHERE ${sql} ORDER BY a.at DESC, a.id DESC LIMIT :limit OFFSET :offset`, {
    ...params,
    limit: q.limit ?? 100,
    offset: q.offset ?? 0,
  });
  return { rows: rows.map(toItem), total };
}

export function getActivity(ctx: Ctx, id: number): ActivityDetail {
  const r = ctx.db.get<ActivityDbRow>(`${SELECT} WHERE a.id = ?`, [id]);
  if (!r) throw fail.notFound('Activity entry');
  let details: unknown = null;
  if (r.details) {
    try {
      details = JSON.parse(r.details);
    } catch {
      details = r.details;
    }
  }
  return { ...toItem(r), details };
}

export const ACTIVITY_REPORT_LIMIT = 5000;

/** The filtered activity log as a report for Excel / CSV / PDF export and printing. */
export function activityReport(ctx: Ctx, q: ActivityQuery): ReportData {
  const { rows, total } = listActivity(ctx, { ...q, limit: ACTIVITY_REPORT_LIMIT, offset: 0 });
  const filters: string[] = [describeRange({ from: q.from, to: q.to })];
  if (q.userId) {
    const name = ctx.db.value<string | null>('SELECT full_name FROM users WHERE id = ?', [q.userId], null);
    if (name) filters.push(`User: ${name}`);
  }
  if (q.q?.trim()) filters.push(`Matching "${q.q.trim()}"`);
  const reportRows: ReportRow[] = rows.map((r) => ({
    cells: { at: r.at, user: r.userName, action: r.actionLabel, summary: r.summary },
    link: r.link ?? undefined,
  }));
  const notes: string[] = [];
  if (total > rows.length) {
    notes.push(`Showing the latest ${formatIndianNumber(rows.length, 0)} of ${formatIndianNumber(total, 0)} entries. Choose a shorter period to see the rest.`);
  }
  return {
    title: 'Activity log',
    subtitle: filters.join(' · '),
    columns: [
      { key: 'at', label: 'When', type: 'datetime', width: 18 },
      { key: 'user', label: 'User', width: 18 },
      { key: 'action', label: 'Action', width: 24 },
      { key: 'summary', label: 'Details', width: 70 },
    ],
    rows: reportRows,
    summary: [{ label: 'Entries', value: total, type: 'number' }],
    notes,
    landscape: true,
  };
}

/** Users who can be chosen in the activity-log filter. */
export function activityUsers(ctx: Ctx): Array<{ id: number; name: string; username: string; isActive: boolean }> {
  return ctx.db
    .all<{ id: number; full_name: string; username: string; is_active: number }>(
      'SELECT id, full_name, username, is_active FROM users ORDER BY is_active DESC, full_name COLLATE NOCASE',
    )
    .map((u) => ({ id: u.id, name: u.full_name, username: u.username, isActive: !!u.is_active }));
}

/* ------------------------------ Document revisions ------------------------------ */

/** Who may see the edit history of each kind of document (any one permission is enough). */
export const REVISION_ACCESS: Record<string, { label: string; perms: Permission[] }> = {
  bill: { label: 'bill', perms: ['billing.view', 'billing.create'] },
  credit_note: { label: 'sales return / credit note', perms: ['returns.create', 'returns.cancel', 'billing.view'] },
  receipt: { label: 'payment received', perms: ['customers.view', 'customers.receive'] },
  purchase: { label: 'purchase bill', perms: ['suppliers.view', 'purchases.manage'] },
  supplier_payment: { label: 'supplier payment', perms: ['suppliers.view', 'suppliers.pay'] },
  expense: { label: 'expense', perms: ['expenses.manage', 'accounts.view'] },
  journal: { label: 'journal voucher', perms: ['accounts.view', 'accounts.manage'] },
  salary: { label: 'salary slip', perms: ['employees.salary'] },
  advance: { label: 'employee advance', perms: ['employees.salary'] },
};

export interface RevisionItem extends RevisionRow {
  actionLabel: string;
}

const REVISION_ACTION_LABELS: Record<string, string> = { created: 'Created', edited: 'Edited', cancelled: 'Cancelled', restored: 'Restored' };

export function documentRevisions(ctx: Ctx, docType: string, docId: number): { docType: string; docId: number; revisions: RevisionItem[] } {
  requireSession(ctx);
  const rule = REVISION_ACCESS[docType];
  if (!rule) throw fail.validation(`Unknown document type "${docType}"`);
  const viaActivity = can(ctx, 'activity.view');
  if (!viaActivity && !rule.perms.some((p) => can(ctx, p))) {
    throw new AppError('FORBIDDEN', `You do not have permission to see the history of this ${rule.label}.`);
  }
  // Users who may only create bills see today's bills only (same rule as opening the bill).
  if (docType === 'bill' && !viaActivity && !can(ctx, 'billing.view')) {
    const date = ctx.db.value<string | null>('SELECT date FROM bills WHERE id = ?', [docId], null);
    if (date && date !== today(ctx)) throw new AppError('FORBIDDEN', "You can only open today's bills. Ask the owner for permission to view older bills.");
  }
  const revisions = listRevisions(ctx, docType, docId).map((r) => ({ ...r, actionLabel: REVISION_ACTION_LABELS[r.action] ?? r.action }));
  return { docType, docId, revisions };
}
