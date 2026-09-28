import { type Ctx, now } from './context';

export interface ActivityOptions {
  entityType?: string;
  entityId?: number | null;
  details?: unknown;
}

/**
 * Record who did what. Call inside the same transaction as the change so the
 * log can never disagree with the data.
 * action: dotted verb such as "bill.create", "bill.cancel", "user.login".
 */
export function logActivity(ctx: Ctx, action: string, summary: string, opts: ActivityOptions = {}): void {
  ctx.db.insert('activity_log', {
    at: now(ctx),
    user_id: ctx.session?.userId ?? null,
    username: ctx.session?.username ?? null,
    action,
    entity_type: opts.entityType ?? null,
    entity_id: opts.entityId ?? null,
    summary,
    details: opts.details === undefined ? null : JSON.stringify(opts.details),
  });
}

export type RevisionAction = 'created' | 'edited' | 'cancelled' | 'restored';

/**
 * Store a full snapshot of a document after a change. Revision numbers start at 1
 * (created) and increase with every edit / cancel, giving a complete audit trail.
 */
export function recordRevision(
  ctx: Ctx,
  docType: string,
  docId: number,
  action: RevisionAction,
  snapshot: unknown,
  reason?: string | null,
): number {
  const revision =
    ctx.db.value<number>('SELECT MAX(revision) FROM document_revisions WHERE doc_type = ? AND doc_id = ?', [docType, docId], 0) + 1;
  ctx.db.insert('document_revisions', {
    doc_type: docType,
    doc_id: docId,
    revision,
    action,
    snapshot: JSON.stringify(snapshot),
    reason: reason ?? null,
    user_id: ctx.session?.userId ?? null,
    username: ctx.session?.username ?? null,
    at: now(ctx),
  });
  return revision;
}

export interface RevisionRow {
  id: number;
  revision: number;
  action: RevisionAction;
  snapshot: unknown;
  reason: string | null;
  username: string | null;
  at: string;
}

export function listRevisions(ctx: Ctx, docType: string, docId: number): RevisionRow[] {
  return ctx.db
    .all<any>(
      'SELECT id, revision, action, snapshot, reason, username, at FROM document_revisions WHERE doc_type = ? AND doc_id = ? ORDER BY revision',
      [docType, docId],
    )
    .map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot) }));
}
