/**
 * The double-entry posting engine. Every module records money movements by
 * calling postEntry / replaceEntry / voidEntry; nothing else writes to
 * journal_entries or journal_lines. The engine guarantees that:
 *   - every entry balances (total debit = total credit, > 0)
 *   - each line is either a debit or a credit, in whole paise
 *   - lines on control accounts (debtors, creditors, employee accounts) name a party
 *   - nothing is posted into a closed financial year or before the books start
 */
import type { Ctx } from '../context';
import { now, currentUserId } from '../context';
import { AppError } from '../errors';
import type { PartyType, SettlementMode, VoucherType } from '../../shared/constants';
import { PAYMENT_MODE_LABELS } from '../../shared/constants';
import { SYSTEM_KEYS, type SystemKey } from './chart';
import { assertDateOpen, ensureFinancialYear } from './periods';
import { getSection } from '../settings';

export interface EntryLineInput {
  /** Account id, or the system key of a built-in account ("CASH", "SALES", ...). */
  account: number | SystemKey;
  debit?: number;
  credit?: number;
  partyType?: PartyType | null;
  partyId?: number | null;
  memo?: string | null;
}

export interface EntryInput {
  date: string;
  voucherType: VoucherType;
  voucherNo?: string | null;
  sourceType?: string | null;
  sourceId?: number | null;
  narration?: string | null;
  lines: EntryLineInput[];
}

export interface PostOptions {
  /** Allow posting into a closed year (only the year-end closing itself uses this). */
  allowClosedPeriod?: boolean;
}

export interface AccountRow {
  id: number;
  code: string | null;
  name: string;
  group_code: string;
  system_key: SystemKey | null;
  party_type: PartyType | null;
  is_active: number;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
}

export interface JournalEntryRow {
  id: number;
  date: string;
  voucher_type: VoucherType;
  voucher_no: string | null;
  source_type: string | null;
  source_id: number | null;
  narration: string | null;
  is_void: number;
  void_reason: string | null;
  created_by: number | null;
  created_at: string;
  updated_by: number | null;
  updated_at: string | null;
}

export interface JournalLineRow {
  id: number;
  entry_id: number;
  line_no: number;
  account_id: number;
  account_name: string;
  account_code: string | null;
  debit: number;
  credit: number;
  party_type: PartyType | null;
  party_id: number | null;
  party_name: string | null;
  memo: string | null;
}

const ACCOUNT_SELECT = `SELECT a.id, a.code, a.name, a.group_code, a.system_key, a.party_type, a.is_active, g.type
  FROM accounts a JOIN account_groups g ON g.code = a.group_code`;

export function getAccount(ctx: Ctx, id: number): AccountRow {
  const row = ctx.db.get<AccountRow>(`${ACCOUNT_SELECT} WHERE a.id = ?`, [id]);
  if (!row) throw new AppError('NOT_FOUND', `Account #${id} not found`);
  return row;
}

export function systemAccountId(ctx: Ctx, key: SystemKey): number {
  const id = ctx.db.value<number | null>('SELECT id FROM accounts WHERE system_key = ?', [key], null);
  if (!id) throw new AppError('INTERNAL', `System account ${key} is missing`);
  return id;
}

function resolveAccount(ctx: Ctx, account: number | SystemKey): AccountRow {
  if (typeof account === 'number') return getAccount(ctx, account);
  if (!(SYSTEM_KEYS as readonly string[]).includes(account)) throw new AppError('INTERNAL', `Unknown system account ${account}`);
  return getAccount(ctx, systemAccountId(ctx, account));
}

const PARTY_TABLE: Record<PartyType, string> = { customer: 'customers', supplier: 'suppliers', employee: 'employees' };

function validateAndNormalize(ctx: Ctx, input: EntryInput): Array<Required<Omit<EntryLineInput, 'account'>> & { accountId: number }> {
  if (!input.lines?.length) throw new AppError('VALIDATION', 'A journal entry needs at least two lines');
  const lines = [];
  for (const l of input.lines) {
    const debit = l.debit ?? 0;
    const credit = l.credit ?? 0;
    if (!Number.isInteger(debit) || !Number.isInteger(credit)) throw new AppError('INTERNAL', 'Amounts must be whole paise');
    if (debit < 0 || credit < 0) throw new AppError('VALIDATION', 'Amounts cannot be negative');
    if (debit > 0 && credit > 0) throw new AppError('VALIDATION', 'A line cannot have both a debit and a credit');
    if (debit === 0 && credit === 0) continue;
    const acct = resolveAccount(ctx, l.account);
    const partyType = l.partyType ?? null;
    const partyId = l.partyId ?? null;
    if (acct.party_type) {
      if (partyType !== acct.party_type || !partyId) {
        throw new AppError('VALIDATION', `Choose a ${acct.party_type} for the "${acct.name}" line`);
      }
      const exists = ctx.db.value<number>(`SELECT COUNT(*) FROM ${PARTY_TABLE[partyType]} WHERE id = ?`, [partyId], 0);
      if (!exists) throw new AppError('VALIDATION', `The ${partyType} for the "${acct.name}" line was not found`);
    } else if (partyType || partyId) {
      throw new AppError('VALIDATION', `"${acct.name}" is not a ${partyType ?? 'party'} account`);
    }
    lines.push({ accountId: acct.id, debit, credit, partyType, partyId, memo: l.memo ?? null });
  }
  const totalDr = lines.reduce((s, l) => s + l.debit, 0);
  const totalCr = lines.reduce((s, l) => s + l.credit, 0);
  if (lines.length < 2 || totalDr === 0) throw new AppError('VALIDATION', 'A journal entry needs at least one debit and one credit');
  if (totalDr !== totalCr) {
    throw new AppError('VALIDATION', `Debits (${(totalDr / 100).toFixed(2)}) and credits (${(totalCr / 100).toFixed(2)}) must be equal`);
  }
  return lines;
}

function insertLines(ctx: Ctx, entryId: number, lines: ReturnType<typeof validateAndNormalize>): void {
  lines.forEach((l, i) => {
    ctx.db.insert('journal_lines', {
      entry_id: entryId,
      line_no: i + 1,
      account_id: l.accountId,
      debit: l.debit,
      credit: l.credit,
      party_type: l.partyType,
      party_id: l.partyId,
      memo: l.memo,
    });
  });
}

/** Post a balanced entry and return its id. */
export function postEntry(ctx: Ctx, input: EntryInput, opts: PostOptions = {}): number {
  return ctx.db.tx(() => {
    if (!opts.allowClosedPeriod) assertDateOpen(ctx, input.date);
    ensureFinancialYear(ctx, input.date);
    const lines = validateAndNormalize(ctx, input);
    const id = ctx.db.insert('journal_entries', {
      date: input.date,
      voucher_type: input.voucherType,
      voucher_no: input.voucherNo ?? null,
      source_type: input.sourceType ?? null,
      source_id: input.sourceId ?? null,
      narration: input.narration ?? null,
      created_by: currentUserId(ctx),
      created_at: now(ctx),
    });
    insertLines(ctx, id, lines);
    ctx.app.markDirty();
    return id;
  });
}

export function getEntry(ctx: Ctx, id: number): JournalEntryRow {
  const e = ctx.db.get<JournalEntryRow>('SELECT * FROM journal_entries WHERE id = ?', [id]);
  if (!e) throw new AppError('NOT_FOUND', `Journal entry #${id} not found`);
  return e;
}

/** Replace the date, header and lines of an existing entry (used when a document is edited). */
export function replaceEntry(ctx: Ctx, entryId: number, input: EntryInput): void {
  ctx.db.tx(() => {
    const existing = getEntry(ctx, entryId);
    if (existing.voucher_type === 'closing') throw new AppError('VALIDATION', 'Year-end closing entries cannot be edited');
    assertDateOpen(ctx, existing.date);
    assertDateOpen(ctx, input.date);
    ensureFinancialYear(ctx, input.date);
    const lines = validateAndNormalize(ctx, input);
    ctx.db.update('journal_entries', entryId, {
      date: input.date,
      voucher_type: input.voucherType,
      voucher_no: input.voucherNo ?? existing.voucher_no,
      source_type: input.sourceType ?? existing.source_type,
      source_id: input.sourceId ?? existing.source_id,
      narration: input.narration ?? null,
      is_void: 0,
      void_reason: null,
      updated_by: currentUserId(ctx),
      updated_at: now(ctx),
    });
    ctx.db.run('DELETE FROM journal_lines WHERE entry_id = ?', [entryId]);
    insertLines(ctx, entryId, lines);
    ctx.app.markDirty();
  });
}

/** Void an entry: it stays for the audit trail but no longer affects any balance or report. */
export function voidEntry(ctx: Ctx, entryId: number, reason: string, opts: PostOptions = {}): void {
  ctx.db.tx(() => {
    const e = getEntry(ctx, entryId);
    if (!opts.allowClosedPeriod) assertDateOpen(ctx, e.date);
    ctx.db.update('journal_entries', entryId, {
      is_void: 1,
      void_reason: reason,
      updated_by: currentUserId(ctx),
      updated_at: now(ctx),
    });
    ctx.app.markDirty();
  });
}

/** Un-void an entry (used when a cancelled document is restored). */
export function unvoidEntry(ctx: Ctx, entryId: number): void {
  ctx.db.tx(() => {
    const e = getEntry(ctx, entryId);
    assertDateOpen(ctx, e.date);
    ctx.db.update('journal_entries', entryId, { is_void: 0, void_reason: null, updated_by: currentUserId(ctx), updated_at: now(ctx) });
    ctx.app.markDirty();
  });
}

export function getEntryLines(ctx: Ctx, entryId: number): JournalLineRow[] {
  return ctx.db.all<JournalLineRow>(
    `SELECT l.id, l.entry_id, l.line_no, l.account_id, a.name AS account_name, a.code AS account_code,
            l.debit, l.credit, l.party_type, l.party_id, l.memo,
            CASE l.party_type
              WHEN 'customer' THEN (SELECT name FROM customers WHERE id = l.party_id)
              WHEN 'supplier' THEN (SELECT name FROM suppliers WHERE id = l.party_id)
              WHEN 'employee' THEN (SELECT name FROM employees WHERE id = l.party_id)
            END AS party_name
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id = ? ORDER BY l.line_no`,
    [entryId],
  );
}

export interface BalanceQuery {
  /** Include entries on or after this date. */
  from?: string;
  /** Include entries on or before this date. */
  to?: string;
  /** Leave out year-end closing entries (used by P&L style reports). */
  excludeClosing?: boolean;
}

function dateFilter(q: BalanceQuery, params: unknown[]): string {
  let sql = '';
  if (q.from) {
    sql += ' AND e.date >= ?';
    params.push(q.from);
  }
  if (q.to) {
    sql += ' AND e.date <= ?';
    params.push(q.to);
  }
  if (q.excludeClosing) sql += " AND e.voucher_type <> 'closing'";
  return sql;
}

/** Net balance (debit - credit) of an account. Positive = debit balance. */
export function accountBalance(ctx: Ctx, accountId: number, q: BalanceQuery = {}): number {
  const params: unknown[] = [accountId];
  const where = dateFilter(q, params);
  return ctx.db.value<number>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ? AND e.is_void = 0${where}`,
    params,
    0,
  );
}

/**
 * Net balance of a party on its control account (debit - credit).
 * Customers: positive = customer owes you. Suppliers: negative = you owe the supplier.
 * Employees: pass the account (EMP_ADV or SALARY_PAYABLE); omit to net both.
 */
export function partyBalance(ctx: Ctx, partyType: PartyType, partyId: number, q: BalanceQuery & { account?: SystemKey } = {}): number {
  const params: unknown[] = [partyType, partyId];
  let accountFilter = '';
  if (q.account) {
    accountFilter = ' AND l.account_id = ?';
    params.push(systemAccountId(ctx, q.account));
  }
  const where = dateFilter(q, params);
  return ctx.db.value<number>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.party_type = ? AND l.party_id = ? AND e.is_void = 0${accountFilter}${where}`,
    params,
    0,
  );
}

/** Balances of all parties of a type in one query: Map(partyId -> debit - credit). */
export function partyBalances(ctx: Ctx, partyType: PartyType, q: BalanceQuery & { account?: SystemKey } = {}): Map<number, number> {
  const params: unknown[] = [partyType];
  let accountFilter = '';
  if (q.account) {
    accountFilter = ' AND l.account_id = ?';
    params.push(systemAccountId(ctx, q.account));
  }
  const where = dateFilter(q, params);
  const rows = ctx.db.all<{ party_id: number; bal: number }>(
    `SELECT l.party_id, SUM(l.debit - l.credit) AS bal FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.party_type = ? AND e.is_void = 0${accountFilter}${where} GROUP BY l.party_id`,
    params,
  );
  return new Map(rows.map((r) => [r.party_id, r.bal]));
}

/**
 * The ledger account a payment mode posts to. Cash -> default cash account,
 * UPI / Bank -> the accounts chosen in settings (falling back to the built-in
 * "UPI Account" / "Bank Account"). An explicit accountId overrides the default
 * but must be a cash or bank account.
 */
export function paymentAccountId(ctx: Ctx, mode: SettlementMode, accountId?: number | null): number {
  if (accountId) {
    const acct = getAccount(ctx, accountId);
    if (acct.group_code !== 'cash' && acct.group_code !== 'bank') {
      throw new AppError('VALIDATION', `"${acct.name}" is not a cash or bank account`);
    }
    if (mode === 'cash' && acct.group_code !== 'cash') {
      throw new AppError('VALIDATION', `${PAYMENT_MODE_LABELS[mode]} payments must go to a cash account`);
    }
    if (mode !== 'cash' && acct.group_code !== 'bank') {
      throw new AppError('VALIDATION', `${PAYMENT_MODE_LABELS[mode]} payments must go to a bank / UPI account`);
    }
    return acct.id;
  }
  const s = getSection(ctx, 'accounts');
  const configured = mode === 'cash' ? s.cashAccountId : mode === 'upi' ? s.upiAccountId : s.bankAccountId;
  if (configured) {
    const ok = ctx.db.value<number>('SELECT COUNT(*) FROM accounts WHERE id = ? AND is_active = 1', [configured], 0);
    if (ok) return configured;
  }
  return systemAccountId(ctx, mode === 'cash' ? 'CASH' : mode === 'upi' ? 'UPI' : 'BANK');
}

/** Find the (non-void or void) entry produced by a document. */
export function entryForSource(ctx: Ctx, sourceType: string, sourceId: number): JournalEntryRow | undefined {
  return ctx.db.get<JournalEntryRow>(
    'SELECT * FROM journal_entries WHERE source_type = ? AND source_id = ? ORDER BY id DESC LIMIT 1',
    [sourceType, sourceId],
  );
}

/**
 * Warning text when paying `outflow` paise out of a cash / bank account would
 * take its balance (as on `date`, and as of today) below zero; null otherwise.
 * Payments are still allowed (the shop may have forgotten to record a receipt),
 * but the user should be told.
 */
export function negativeBalanceWarning(ctx: Ctx, accountId: number, outflow: number, date: string): string | null {
  if (outflow <= 0) return null;
  const acct = getAccount(ctx, accountId);
  if (acct.group_code !== 'cash' && acct.group_code !== 'bank') return null;
  const onDate = accountBalance(ctx, accountId, { to: date }) - outflow;
  const latest = accountBalance(ctx, accountId) - outflow;
  const worst = Math.min(onDate, latest);
  if (worst >= 0) return null;
  const rupees = (Math.abs(worst) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${acct.name} will be short by ₹${rupees} after this payment. Check that all money received has been entered.`;
}
