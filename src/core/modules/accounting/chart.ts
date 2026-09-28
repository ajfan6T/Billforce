/**
 * Chart of accounts management: groups, account details, adding / editing /
 * deactivating / deleting accounts, account opening balances and the
 * accounts used by the Cash / UPI / Bank payment modes.
 */
import type { Ctx } from '../../context';
import { now } from '../../context';
import { fail } from '../../errors';
import { logActivity } from '../../audit';
import { getSection, updateSection } from '../../settings';
import { ACCOUNT_GROUPS } from '../../accounting/chart';
import { accountBalance, getAccount, paymentAccountId, postEntry, replaceEntry, voidEntry, type AccountRow } from '../../accounting/ledger';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPES, type AccountType, type PartyType, type SettlementMode } from '../../../shared/constants';
import { formatDrCr } from '../../../shared/money';
import { listAccounts } from './accounts';
import { openingLockedReason } from './common';

export interface GroupInfo {
  code: string;
  name: string;
  type: AccountType;
  typeLabel: string;
  allowUserAccounts: boolean;
  description: string | null;
  /** Code the next account in this group would get. */
  nextCode: string;
}

interface GroupRow {
  code: string;
  name: string;
  type: AccountType;
  sort_order: number;
  allow_user_accounts: number;
  description: string | null;
}

function groupRow(ctx: Ctx, code: string): GroupRow {
  const g = ctx.db.get<GroupRow>('SELECT * FROM account_groups WHERE code = ?', [code]);
  if (!g) throw fail.validation('Choose the group this account belongs to', { groupCode: 'Choose a group' });
  return g;
}

/** Next unused numeric code, counting up from the group's first code. */
export function nextAccountCode(ctx: Ctx, groupCode: string): string {
  const seed = ACCOUNT_GROUPS.find((g) => g.code === groupCode);
  let n = seed?.codeBase ?? 9001;
  const used = new Set(ctx.db.all<{ code: string }>('SELECT code FROM accounts WHERE code IS NOT NULL').map((r) => r.code));
  while (used.has(String(n))) n++;
  return String(n);
}

export function listGroups(ctx: Ctx): GroupInfo[] {
  return ctx.db.all<GroupRow>('SELECT * FROM account_groups ORDER BY sort_order').map((g) => ({
    code: g.code,
    name: g.name,
    type: g.type,
    typeLabel: ACCOUNT_TYPE_LABELS[g.type],
    allowUserAccounts: !!g.allow_user_accounts,
    description: g.description,
    nextCode: nextAccountCode(ctx, g.code),
  }));
}

/* ------------------------------ Lookups ------------------------------ */

function entryCount(ctx: Ctx, accountId: number): number {
  return ctx.db.value<number>('SELECT COUNT(DISTINCT entry_id) FROM journal_lines WHERE account_id = ?', [accountId], 0);
}

function loanFor(ctx: Ctx, accountId: number): { id: number; name: string } | null {
  return ctx.db.get<{ id: number; name: string }>('SELECT id, name FROM loans WHERE account_id = ?', [accountId]) ?? null;
}

/** Payment modes that post to this account by default. */
function defaultModesFor(ctx: Ctx, accountId: number): SettlementMode[] {
  return (['cash', 'upi', 'bank'] as const).filter((m) => paymentAccountId(ctx, m) === accountId);
}

const MODE_NAMES: Record<SettlementMode, string> = { cash: 'Cash', upi: 'UPI', bank: 'Bank' };

/** The opening-balance entry of a (non-party) account, if any. */
export function accountOpeningEntry(ctx: Ctx, accountId: number): { id: number; is_void: number; narration: string | null; amount: number } | null {
  const row = ctx.db.get<{ id: number; is_void: number; narration: string | null }>(
    `SELECT e.id, e.is_void, e.narration FROM journal_entries e
      WHERE e.voucher_type = 'opening' AND e.source_type = 'opening' AND (e.source_id = ? OR e.source_id IS NULL)
        AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id AND +l.account_id = ? AND +l.party_type IS NULL)
      ORDER BY e.is_void, e.id LIMIT 1`,
    [accountId, accountId],
  );
  if (!row) return null;
  const amount = row.is_void
    ? 0
    : ctx.db.value<number>('SELECT COALESCE(SUM(debit - credit), 0) FROM journal_lines WHERE entry_id = ? AND account_id = ?', [row.id, accountId], 0);
  return { ...row, amount };
}

function openingProblem(acct: Pick<AccountRow, 'party_type' | 'system_key' | 'type'>): string | null {
  if (acct.party_type) return 'Opening balances of customers, suppliers and employees are entered on their own pages.';
  if (acct.system_key === 'OPENING_EQUITY') return 'This account holds the balancing figure of all opening balances.';
  if (acct.type === 'income' || acct.type === 'expense') return 'Income and expense accounts start every year at zero, so they have no opening balance.';
  return null;
}

/**
 * Set the balance an account had on the books start date, posted against
 * "Opening Balance Adjustment". debitBalance > 0 = debit balance.
 */
export function setAccountOpening(ctx: Ctx, acct: AccountRow, debitBalance: number): number | null {
  const problem = openingProblem(acct);
  if (problem && debitBalance !== 0) throw fail.validation(problem, { openingBalance: problem });
  const date = getSection(ctx, 'accounts').booksStartDate;
  const existing = accountOpeningEntry(ctx, acct.id);
  const locked = openingLockedReason(ctx);
  if (locked) {
    // The first year is closed: the opening entry is final (a rename keeps its old narration).
    if (debitBalance !== (existing?.amount ?? 0)) throw fail.validation(locked, { openingBalance: locked });
    return existing?.id ?? null;
  }
  const narration = `Opening balance - ${acct.name}`;
  const lines =
    debitBalance > 0
      ? [
          { account: acct.id, debit: debitBalance },
          { account: 'OPENING_EQUITY' as const, credit: debitBalance },
        ]
      : [
          { account: 'OPENING_EQUITY' as const, debit: -debitBalance },
          { account: acct.id, credit: -debitBalance },
        ];
  if (existing) {
    if (existing.amount === debitBalance && (existing.is_void || existing.narration === narration)) return existing.id;
    // Other lines in a shared opening entry (should not happen) would be lost: only replace single-account entries.
    const others = ctx.db.value<number>(
      `SELECT COUNT(*) FROM journal_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.entry_id = ? AND l.account_id <> ? AND COALESCE(a.system_key, '') <> 'OPENING_EQUITY'`,
      [existing.id, acct.id],
      0,
    );
    if (others) throw fail.validation('This opening balance is part of a larger journal entry. Change it from Journal entries.');
    if (debitBalance === 0) {
      if (!existing.is_void) voidEntry(ctx, existing.id, 'Opening balance removed');
      return existing.id;
    }
    replaceEntry(ctx, existing.id, { date, voucherType: 'opening', sourceType: 'opening', sourceId: acct.id, narration, lines });
    return existing.id;
  }
  if (debitBalance === 0) return null;
  return postEntry(ctx, { date, voucherType: 'opening', sourceType: 'opening', sourceId: acct.id, narration, lines });
}

/* ------------------------------ Chart tree ------------------------------ */

export interface ChartAccount {
  id: number;
  code: string | null;
  name: string;
  groupCode: string;
  systemKey: string | null;
  isSystem: boolean;
  partyType: PartyType | null;
  isActive: boolean;
  description: string | null;
  balance: number;
  entryCount: number;
  loanId: number | null;
  defaultFor: SettlementMode[];
}

export interface ChartGroup {
  code: string;
  name: string;
  description: string | null;
  allowUserAccounts: boolean;
  balance: number;
  accounts: ChartAccount[];
}

export interface ChartType {
  type: AccountType;
  label: string;
  balance: number;
  groups: ChartGroup[];
}

export function chartTree(
  ctx: Ctx,
  opts: { includeInactive?: boolean; asOf?: string } = {},
): { types: ChartType[]; totalDebit: number; totalCredit: number; booksStartDate: string; openingLockedReason: string | null } {
  // Inactive accounts that still have a balance (e.g. an expense head no longer used this year) always show, so the totals agree.
  const accounts = listAccounts(ctx, { includeInactive: true, withBalances: true, asOf: opts.asOf }).filter((a) => opts.includeInactive || a.isActive || a.balance);
  const counts = new Map(
    ctx.db.all<{ account_id: number; n: number }>('SELECT account_id, COUNT(DISTINCT entry_id) AS n FROM journal_lines GROUP BY account_id').map((r) => [r.account_id, r.n]),
  );
  const loans = new Map(ctx.db.all<{ id: number; account_id: number }>('SELECT id, account_id FROM loans').map((r) => [r.account_id, r.id]));
  const defaults = { cash: paymentAccountId(ctx, 'cash'), upi: paymentAccountId(ctx, 'upi'), bank: paymentAccountId(ctx, 'bank') };
  const groups = ctx.db.all<GroupRow>('SELECT * FROM account_groups ORDER BY sort_order');
  let totalDebit = 0;
  let totalCredit = 0;
  const types: ChartType[] = ACCOUNT_TYPES.map((type) => {
    const tGroups: ChartGroup[] = groups
      .filter((g) => g.type === type)
      .map((g) => {
        const list: ChartAccount[] = accounts
          .filter((a) => a.groupCode === g.code)
          .map((a) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            groupCode: a.groupCode,
            systemKey: a.systemKey,
            isSystem: !!a.systemKey,
            partyType: a.partyType,
            isActive: a.isActive,
            description: a.description,
            balance: a.balance ?? 0,
            entryCount: counts.get(a.id) ?? 0,
            loanId: loans.get(a.id) ?? null,
            defaultFor: (['cash', 'upi', 'bank'] as const).filter((m) => defaults[m] === a.id),
          }));
        const balance = list.reduce((s, a) => s + a.balance, 0);
        return { code: g.code, name: g.name, description: g.description, allowUserAccounts: !!g.allow_user_accounts, balance, accounts: list };
      });
    const balance = tGroups.reduce((s, g) => s + g.balance, 0);
    return { type, label: ACCOUNT_TYPE_LABELS[type], balance, groups: tGroups };
  });
  for (const a of accounts) {
    if ((a.balance ?? 0) > 0) totalDebit += a.balance!;
    else totalCredit -= a.balance ?? 0;
  }
  return { types, totalDebit, totalCredit, booksStartDate: getSection(ctx, 'accounts').booksStartDate, openingLockedReason: openingLockedReason(ctx) };
}

/* ------------------------------ Account detail ------------------------------ */

export interface AccountDetail {
  id: number;
  code: string | null;
  name: string;
  groupCode: string;
  groupName: string;
  type: AccountType;
  typeLabel: string;
  systemKey: string | null;
  isSystem: boolean;
  partyType: PartyType | null;
  isActive: boolean;
  description: string | null;
  /** Current balance (debit - credit). */
  balance: number;
  entryCount: number;
  /** Opening balance on the books start date (debit - credit); null when the account cannot have one. */
  openingBalance: number | null;
  openingBlockedReason: string | null;
  /** Set when the first financial year is closed: the opening balance is shown but can no longer be changed. */
  openingLockedReason: string | null;
  booksStartDate: string;
  loan: { id: number; name: string } | null;
  defaultFor: SettlementMode[];
  canDelete: boolean;
  deleteBlockedReason: string | null;
  canDeactivate: boolean;
  deactivateBlockedReason: string | null;
  canChangeGroup: boolean;
  groupChangeBlockedReason: string | null;
  createdAt: string;
}

function deleteProblem(ctx: Ctx, a: AccountRow, entries: number, loan: { name: string } | null, defaults: SettlementMode[]): string | null {
  if (a.system_key) return 'Built-in accounts are used automatically by Billforce and cannot be deleted.';
  if (loan) return `This is the account of the loan "${loan.name}". Manage it from Accounts > Loans.`;
  if (entries) {
    const when = a.type === 'income' || a.type === 'expense' ? '' : ' once its balance is zero';
    return `This account has ${entries} ${entries === 1 ? 'entry' : 'entries'}, so it cannot be deleted. You can deactivate it instead${when}.`;
  }
  if (defaults.length) return `This account is used for ${defaults.map((m) => MODE_NAMES[m]).join(' / ')} payments. Choose another account under "Payment accounts" first.`;
  const used =
    ctx.db.value<number>('SELECT COUNT(*) FROM expenses WHERE account_id = ? OR pay_account_id = ?', [a.id, a.id], 0) +
    ctx.db.value<number>('SELECT COUNT(*) FROM purchases WHERE expense_account_id = ?', [a.id], 0);
  if (used) return 'This account is used by saved documents, so it cannot be deleted. You can deactivate it instead.';
  return null;
}

function deactivateProblem(ctx: Ctx, a: AccountRow, loan: { name: string } | null, defaults: SettlementMode[]): string | null {
  if (a.system_key) return 'Built-in accounts are used automatically by Billforce and cannot be deactivated.';
  if (loan) return `This is the account of the loan "${loan.name}". Close the loan from Accounts > Loans instead.`;
  if (defaults.length) return `This account is used for ${defaults.map((m) => MODE_NAMES[m]).join(' / ')} payments. Choose another account under "Payment accounts" first.`;
  // Income and expense heads just leave the pickers; their figures stay in the reports.
  if (a.type === 'income' || a.type === 'expense') return null;
  const bal = accountBalance(ctx, a.id);
  if (bal !== 0) return `This account has a balance of ${formatDrCr(bal)}. Move the balance to another account with a journal entry first.`;
  return null;
}

export function getAccountDetail(ctx: Ctx, id: number): AccountDetail {
  const a = getAccount(ctx, id);
  const row = ctx.db.get<{ description: string | null; created_at: string; group_name: string }>(
    'SELECT a.description, a.created_at, g.name AS group_name FROM accounts a JOIN account_groups g ON g.code = a.group_code WHERE a.id = ?',
    [id],
  )!;
  const entries = entryCount(ctx, id);
  const loan = loanFor(ctx, id);
  const defaults = defaultModesFor(ctx, id);
  const del = deleteProblem(ctx, a, entries, loan, defaults);
  const deact = a.is_active ? deactivateProblem(ctx, a, loan, defaults) : null;
  const groupChange = a.system_key
    ? 'Built-in accounts always stay in their group.'
    : loan
      ? 'Loan accounts always stay in their group.'
      : entries
        ? 'The group can only be changed before the account has any entries.'
        : null;
  const openingBlocked = openingProblem(a);
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    groupCode: a.group_code,
    groupName: row.group_name,
    type: a.type,
    typeLabel: ACCOUNT_TYPE_LABELS[a.type],
    systemKey: a.system_key,
    isSystem: !!a.system_key,
    partyType: a.party_type,
    isActive: !!a.is_active,
    description: row.description,
    balance: accountBalance(ctx, id),
    entryCount: entries,
    openingBalance: openingBlocked ? null : (accountOpeningEntry(ctx, id)?.amount ?? 0),
    openingBlockedReason: openingBlocked,
    openingLockedReason: openingBlocked ? null : openingLockedReason(ctx),
    booksStartDate: getSection(ctx, 'accounts').booksStartDate,
    loan,
    defaultFor: defaults,
    canDelete: !del,
    deleteBlockedReason: del,
    canDeactivate: !!a.is_active && !deact,
    deactivateBlockedReason: deact,
    canChangeGroup: !groupChange,
    groupChangeBlockedReason: groupChange,
    createdAt: row.created_at,
  };
}

/* ------------------------------ Create / update ------------------------------ */

export interface OpeningInput {
  amount: number;
  side: 'debit' | 'credit';
}

export interface AccountInput {
  name: string;
  groupCode: string;
  code?: string | null;
  description?: string | null;
  openingBalance?: OpeningInput | null;
}

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/;

function checkName(ctx: Ctx, name: string, exceptId = 0): void {
  if (!name.trim()) throw fail.validation('Enter the account name', { name: 'Enter the account name' });
  const clash = ctx.db.get<{ id: number; name: string }>('SELECT id, name FROM accounts WHERE name = ? AND id <> ?', [name.trim(), exceptId]);
  if (clash) throw fail.validation(`An account named "${clash.name}" already exists. Use a different name.`, { name: 'Name already used' });
}

function checkCode(ctx: Ctx, code: string, exceptId = 0): void {
  if (!CODE_RE.test(code)) throw fail.validation('Account code can have only letters, numbers and dashes (up to 20)', { code: 'Invalid code' });
  const clash = ctx.db.get<{ name: string }>('SELECT name FROM accounts WHERE code = ? AND id <> ?', [code, exceptId]);
  if (clash) throw fail.validation(`Code ${code} is already used by "${clash.name}"`, { code: 'Code already used' });
}

function groupAllowsAccounts(g: GroupRow): void {
  if (!g.allow_user_accounts) {
    const hint =
      g.code === 'receivables'
        ? 'Customers are added from the Customers page; each customer has its own balance.'
        : g.code === 'payables'
          ? 'Suppliers are added from the Suppliers page; each supplier has its own balance.'
          : '';
    throw fail.validation(`You cannot add accounts under "${g.name}". ${hint}`.trim(), { groupCode: 'Choose another group' });
  }
}

function openingDebit(o: OpeningInput | null | undefined): number {
  if (!o || !o.amount) return 0;
  return o.side === 'debit' ? o.amount : -o.amount;
}

export function createAccount(ctx: Ctx, input: AccountInput): AccountDetail {
  const g = groupRow(ctx, input.groupCode);
  groupAllowsAccounts(g);
  const name = input.name.trim();
  checkName(ctx, name);
  const code = input.code?.trim() || nextAccountCode(ctx, g.code);
  checkCode(ctx, code);
  const id = ctx.db.insert('accounts', {
    code,
    name,
    group_code: g.code,
    description: input.description?.trim() || null,
    created_at: now(ctx),
  });
  const opening = openingDebit(input.openingBalance);
  if (opening) setAccountOpening(ctx, getAccount(ctx, id), opening);
  logActivity(
    ctx,
    'account.create',
    `Added account "${name}" (${code}) under ${g.name}${opening ? ` with opening balance ${formatDrCr(opening)}` : ''}`,
    { entityType: 'account', entityId: id, details: { ...input, code } },
  );
  return getAccountDetail(ctx, id);
}

export interface AccountUpdate {
  name: string;
  code?: string | null;
  description?: string | null;
  groupCode?: string | null;
  /** undefined = leave unchanged; null / 0 = remove. */
  openingBalance?: OpeningInput | null;
}

export function updateAccount(ctx: Ctx, id: number, input: AccountUpdate): AccountDetail {
  const before = getAccountDetail(ctx, id);
  const name = input.name.trim();
  checkName(ctx, name, id);
  const code = input.code === undefined ? before.code : input.code?.trim() || null;
  const patch: Record<string, unknown> = { name, description: input.description === undefined ? before.description : input.description?.trim() || null, updated_at: now(ctx) };
  const changes: string[] = [];
  if (before.name !== name) changes.push(`renamed from "${before.name}"`);
  if (input.groupCode && input.groupCode !== before.groupCode) {
    if (!before.canChangeGroup) throw fail.validation(before.groupChangeBlockedReason!, { groupCode: before.groupChangeBlockedReason! });
    const g = groupRow(ctx, input.groupCode);
    groupAllowsAccounts(g);
    patch.group_code = g.code;
    changes.push(`moved from ${before.groupName} to ${g.name}`);
  }
  const finalCode = code || nextAccountCode(ctx, (patch.group_code as string) ?? before.groupCode);
  if (finalCode !== before.code) {
    checkCode(ctx, finalCode, id);
    changes.push(`code ${before.code ?? '-'} → ${finalCode}`);
  }
  patch.code = finalCode;
  ctx.db.update('accounts', id, patch);
  const current = before.openingBalance ?? 0;
  const next = input.openingBalance !== undefined ? openingDebit(input.openingBalance) : current;
  if (before.openingBalance === null) {
    // Control accounts, income / expense accounts and Opening Balance Adjustment have no opening balance.
    if (next !== 0) throw fail.validation(before.openingBlockedReason!, { openingBalance: before.openingBlockedReason! });
  } else if (next !== current || (before.name !== name && current !== 0)) {
    // Also re-writes the entry's narration ("Opening balance - <name>") after a rename.
    setAccountOpening(ctx, getAccount(ctx, id), next);
    if (next !== current) changes.push(`opening balance ${formatDrCr(current)} → ${formatDrCr(next)}`);
  }
  if (before.description !== patch.description && changes.length === 0) changes.push('description changed');
  logActivity(ctx, 'account.update', `Updated account "${name}"${changes.length ? ': ' + changes.join(', ') : ''}`, {
    entityType: 'account',
    entityId: id,
    details: { before, after: input },
  });
  return getAccountDetail(ctx, id);
}

export function setAccountActive(ctx: Ctx, id: number, active: boolean): AccountDetail {
  const d = getAccountDetail(ctx, id);
  if (d.isActive === active) return d;
  if (!active && !d.canDeactivate) throw fail.validation(d.deactivateBlockedReason ?? 'This account cannot be deactivated');
  ctx.db.update('accounts', id, { is_active: active ? 1 : 0, updated_at: now(ctx) });
  logActivity(ctx, active ? 'account.activate' : 'account.deactivate', `${active ? 'Re-activated' : 'Deactivated'} account "${d.name}"`, {
    entityType: 'account',
    entityId: id,
  });
  return getAccountDetail(ctx, id);
}

export function removeAccount(ctx: Ctx, id: number): { deleted: true } {
  const d = getAccountDetail(ctx, id);
  if (!d.canDelete) throw fail.validation(d.deleteBlockedReason ?? 'This account cannot be deleted');
  try {
    ctx.db.run('DELETE FROM accounts WHERE id = ?', [id]);
  } catch (e) {
    if (/FOREIGN KEY/i.test((e as Error).message)) {
      throw fail.validation('This account is used by saved records, so it cannot be deleted. You can deactivate it instead.');
    }
    throw e;
  }
  logActivity(ctx, 'account.delete', `Deleted account "${d.name}" (${d.code ?? 'no code'}) from ${d.groupName}`, { entityType: 'account', entityId: id, details: d });
  return { deleted: true };
}

/* ------------------------------ Payment accounts ------------------------------ */

export function setPaymentDefaults(
  ctx: Ctx,
  input: { cashAccountId: number; upiAccountId: number; bankAccountId: number },
): { cash: number; upi: number; bank: number } {
  const check = (id: number, group: 'cash' | 'bank', mode: string) => {
    let a: AccountRow;
    try {
      a = getAccount(ctx, id);
    } catch {
      throw fail.validation(`Choose the account for ${mode} payments`);
    }
    if (a.group_code !== group) {
      throw fail.validation(
        group === 'cash' ? `"${a.name}" is not a cash account. Cash payments must go to a Cash-in-Hand account.` : `"${a.name}" is not a bank / UPI account.`,
        { [`${mode.toLowerCase()}AccountId`]: 'Wrong kind of account' },
      );
    }
    if (!a.is_active) throw fail.validation(`"${a.name}" is inactive. Re-activate it first.`);
    return a;
  };
  const cash = check(input.cashAccountId, 'cash', 'Cash');
  const upi = check(input.upiAccountId, 'bank', 'UPI');
  const bank = check(input.bankAccountId, 'bank', 'Bank');
  const before = { cash: paymentAccountId(ctx, 'cash'), upi: paymentAccountId(ctx, 'upi'), bank: paymentAccountId(ctx, 'bank') };
  updateSection(ctx, 'accounts', { cashAccountId: cash.id, upiAccountId: upi.id, bankAccountId: bank.id });
  logActivity(ctx, 'account.payment_defaults', `Payment accounts: Cash → ${cash.name}, UPI → ${upi.name}, Bank → ${bank.name}`, {
    entityType: 'settings',
    details: { before, after: input },
  });
  return { cash: cash.id, upi: upi.id, bank: bank.id };
}
