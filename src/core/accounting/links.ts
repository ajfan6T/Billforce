import type { Ctx } from '../context';

export type LinkKind =
  | 'bill'
  | 'credit_note'
  | 'receipt'
  | 'purchase'
  | 'supplier_payment'
  | 'expense'
  | 'journal'
  | 'salary'
  | 'advance'
  | 'customer'
  | 'supplier'
  | 'employee'
  | 'account'
  | 'loan'
  | 'stock_adjustment'
  | 'stock_item';

export interface DocLink {
  kind: LinkKind;
  id: number;
}

/**
 * Where a journal entry came from, as a link the UI can open.
 * Falls back to the journal entry itself for manual / opening / closing entries.
 */
export function entrySourceLink(ctx: Ctx, entry: { id: number; source_type: string | null; source_id: number | null }): DocLink {
  const sid = entry.source_id;
  switch (entry.source_type) {
    case 'bill':
    case 'credit_note':
    case 'receipt':
    case 'purchase':
    case 'supplier_payment':
    case 'expense':
    case 'salary':
    case 'advance':
    case 'loan':
      if (sid) return { kind: entry.source_type, id: sid };
      break;
    case 'salary_payment': {
      const salaryId = sid ? ctx.db.value<number | null>('SELECT salary_id FROM salary_payments WHERE id = ?', [sid], null) : null;
      if (salaryId) return { kind: 'salary', id: salaryId };
      break;
    }
  }
  return { kind: 'journal', id: entry.id };
}
