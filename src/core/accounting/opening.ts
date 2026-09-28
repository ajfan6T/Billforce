import type { Ctx } from '../context';
import { getSection } from '../settings';
import { postEntry, replaceEntry, voidEntry, getEntry } from './ledger';
import type { SystemKey } from './chart';

type OpeningParty = 'customer' | 'supplier' | 'employee';

const CONTROL: Record<OpeningParty, SystemKey> = { customer: 'AR', supplier: 'AP', employee: 'EMP_ADV' };

/**
 * Create, change or remove the opening balance of a customer / supplier /
 * employee (advance) as a journal entry dated the books start date, balanced
 * against "Opening Balance Adjustment".
 *
 * debitBalance: the balance on the party's control account in paise.
 *   customer: + = customer owes you,          - = advance received from customer
 *   supplier: - = you owe the supplier,       + = advance paid to supplier
 *   employee: + = advance given to employee
 * Returns the journal entry id (null if the balance is zero and no entry exists).
 */
export function setPartyOpeningBalance(
  ctx: Ctx,
  partyType: OpeningParty,
  partyId: number,
  partyName: string,
  debitBalance: number,
  existingEntryId: number | null,
): number | null {
  const date = getSection(ctx, 'accounts').booksStartDate;
  const control = CONTROL[partyType];
  const narration = `Opening balance - ${partyName}`;
  const lines =
    debitBalance > 0
      ? [
          { account: control, debit: debitBalance, partyType, partyId },
          { account: 'OPENING_EQUITY' as const, credit: debitBalance },
        ]
      : [
          { account: 'OPENING_EQUITY' as const, debit: -debitBalance },
          { account: control, credit: -debitBalance, partyType, partyId },
        ];
  if (existingEntryId) {
    const existing = getEntry(ctx, existingEntryId);
    if (debitBalance === 0) {
      if (!existing.is_void) voidEntry(ctx, existingEntryId, 'Opening balance removed');
      return existingEntryId;
    }
    replaceEntry(ctx, existingEntryId, {
      date: existing.date,
      voucherType: 'opening',
      sourceType: 'opening',
      sourceId: partyId,
      narration,
      lines,
    });
    return existingEntryId;
  }
  if (debitBalance === 0) return null;
  return postEntry(ctx, { date, voucherType: 'opening', sourceType: 'opening', sourceId: partyId, narration, lines });
}
