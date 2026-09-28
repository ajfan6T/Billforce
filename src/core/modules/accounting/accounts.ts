import type { Ctx } from '../../context';
import type { AccountType, PartyType } from '../../../shared/constants';
import { getSection } from '../../settings';
import { paymentAccountId } from '../../accounting/ledger';

/*
 * CONTRACT functions used by other modules and the shared UI pickers.
 * The accounting module owner extends this module but must keep these signatures.
 */

export interface AccountListItem {
  id: number;
  code: string | null;
  name: string;
  groupCode: string;
  groupName: string;
  type: AccountType;
  systemKey: string | null;
  partyType: PartyType | null;
  isActive: boolean;
  description: string | null;
  /** Net balance (debit - credit) in paise, only when withBalances is set. */
  balance?: number;
}

export interface ListAccountsOptions {
  groups?: string[];
  types?: AccountType[];
  includeInactive?: boolean;
  withBalances?: boolean;
  /** Balance as on this date (inclusive). */
  asOf?: string;
}

export function listAccounts(ctx: Ctx, opts: ListAccountsOptions = {}): AccountListItem[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeInactive) where.push('a.is_active = 1');
  if (opts.groups?.length) {
    where.push(`a.group_code IN (${opts.groups.map(() => '?').join(', ')})`);
    params.push(...opts.groups);
  }
  if (opts.types?.length) {
    where.push(`g.type IN (${opts.types.map(() => '?').join(', ')})`);
    params.push(...opts.types);
  }
  const rows = ctx.db.all<any>(
    `SELECT a.id, a.code, a.name, a.group_code, g.name AS group_name, g.type, a.system_key, a.party_type, a.is_active, a.description
       FROM accounts a JOIN account_groups g ON g.code = a.group_code
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY g.sort_order, a.code, a.name COLLATE NOCASE`,
    params,
  );
  let balances: Map<number, number> | null = null;
  if (opts.withBalances) {
    const bp: unknown[] = [];
    let dateFilter = '';
    if (opts.asOf) {
      dateFilter = ' AND e.date <= ?';
      bp.push(opts.asOf);
    }
    balances = new Map(
      ctx.db
        .all<{ account_id: number; bal: number }>(
          `SELECT l.account_id, SUM(l.debit - l.credit) AS bal FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
            WHERE e.is_void = 0${dateFilter} GROUP BY l.account_id`,
          bp,
        )
        .map((r) => [r.account_id, r.bal]),
    );
  }
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    groupCode: r.group_code,
    groupName: r.group_name,
    type: r.type,
    systemKey: r.system_key,
    partyType: r.party_type,
    isActive: !!r.is_active,
    description: r.description,
    ...(balances ? { balance: balances.get(r.id) ?? 0 } : {}),
  }));
}

export interface PaymentAccounts {
  cash: Array<{ id: number; name: string }>;
  bank: Array<{ id: number; name: string }>;
  /** Accounts used when a payment mode is chosen without picking an account. */
  defaults: { cash: number; upi: number; bank: number };
}

/** Cash and bank/UPI accounts for payment pickers, with the default for each mode. */
export function paymentAccounts(ctx: Ctx): PaymentAccounts {
  const all = listAccounts(ctx, { groups: ['cash', 'bank'] });
  void getSection;
  return {
    cash: all.filter((a) => a.groupCode === 'cash').map((a) => ({ id: a.id, name: a.name })),
    bank: all.filter((a) => a.groupCode === 'bank').map((a) => ({ id: a.id, name: a.name })),
    defaults: { cash: paymentAccountId(ctx, 'cash'), upi: paymentAccountId(ctx, 'upi'), bank: paymentAccountId(ctx, 'bank') },
  };
}
