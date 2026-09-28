/**
 * Owner's capital and drawings, and transfers between cash / bank / UPI
 * accounts. All are "manual" vouchers numbered in the journal series and
 * cancelled through journals.cancel.
 *
 *   Capital introduced   Dr cash / bank          Cr CAPITAL (or another capital account)
 *   Drawings (money)     Dr DRAWINGS             Cr cash / bank
 *   Drawings (goods)     Dr DRAWINGS             Cr PURCHASES
 *   Transfer             Dr to-account           Cr from-account
 */
import type { Ctx } from '../../context';
import { fail } from '../../errors';
import { paymentAccountId, systemAccountId } from '../../accounting/ledger';
import { entrySourceLink } from '../../accounting/links';
import { getSection } from '../../settings';
import { formatINR } from '../../../shared/money';
import { describeRange, formatDate, fyOf } from '../../../shared/dates';
import { PAYMENT_MODE_LABELS, type SettlementMode, type VoucherType } from '../../../shared/constants';
import type { ReportData, ReportRow } from '../../../shared/report';
import { activeAccount, inList, joinNames, resolveVoucherDate, userName, voucherLabel } from './common';
import { getEntryDetail, postManualVoucher, type EntryDetail, type SavedEntry } from './journals';

function settlementAccount(ctx: Ctx, mode: SettlementMode, accountId?: number | null) {
  const id = paymentAccountId(ctx, mode, accountId);
  return activeAccount(ctx, id, `${PAYMENT_MODE_LABELS[mode]} account`);
}

/* ------------------------------ Capital ------------------------------ */

export interface CapitalInput {
  date?: string | null;
  amount: number;
  mode: SettlementMode;
  accountId?: number | null;
  capitalAccountId?: number | null;
  narration?: string | null;
}

export function addCapital(ctx: Ctx, input: CapitalInput): SavedEntry {
  const date = resolveVoucherDate(ctx, input.date, 'Capital');
  const pay = settlementAccount(ctx, input.mode, input.accountId);
  const capital = activeAccount(ctx, input.capitalAccountId ?? systemAccountId(ctx, 'CAPITAL'), 'capital account');
  if (capital.group_code !== 'capital') throw fail.validation(`"${capital.name}" is not a capital account`, { capitalAccountId: 'Choose a capital account' });
  if (capital.system_key === 'OPENING_EQUITY') {
    throw fail.validation('"Opening Balance Adjustment" is only for opening balances. Choose Owner\'s Capital.', { capitalAccountId: 'Choose another account' });
  }
  const narration = input.narration?.trim() || `Capital introduced by owner (${PAYMENT_MODE_LABELS[input.mode]})`;
  const { id, warnings } = postManualVoucher(
    ctx,
    {
      date,
      voucherType: 'capital',
      narration,
      lines: [
        { account: pay.id, debit: input.amount },
        { account: capital.id, credit: input.amount },
      ],
    },
    { action: 'capital.add', summary: (no) => `Recorded capital of ${formatINR(input.amount)} into ${pay.name} (${no})` },
  );
  return { ...getEntryDetail(ctx, id), warnings };
}

/* ------------------------------ Drawings ------------------------------ */

export interface DrawingsInput {
  date?: string | null;
  amount: number;
  mode?: SettlementMode | null;
  accountId?: number | null;
  narration?: string | null;
  /** Goods taken from the shop for personal use (credited to Purchases). */
  goods?: boolean;
}

/** Owner takes money (or goods) out; warns when the cash / bank account would go below zero. */
export function recordDrawings(ctx: Ctx, input: DrawingsInput): SavedEntry {
  const date = resolveVoucherDate(ctx, input.date, 'Drawings');
  let credit: number;
  let what: string;
  if (input.goods) {
    credit = systemAccountId(ctx, 'PURCHASES');
    what = 'goods';
  } else {
    if (!input.mode) throw fail.validation('Choose how the money was taken: Cash, UPI or Bank', { mode: 'Choose a payment mode' });
    const pay = settlementAccount(ctx, input.mode, input.accountId);
    credit = pay.id;
    what = `from ${pay.name}`;
  }
  const narration =
    input.narration?.trim() || (input.goods ? 'Goods taken by owner for personal use' : `Money taken by owner for personal use (${PAYMENT_MODE_LABELS[input.mode!]})`);
  const { id, warnings } = postManualVoucher(
    ctx,
    {
      date,
      voucherType: 'drawings',
      narration,
      lines: [
        { account: 'DRAWINGS', debit: input.amount },
        { account: credit, credit: input.amount },
      ],
    },
    { action: 'drawings.add', summary: (no) => `Recorded drawings of ${formatINR(input.amount)} ${what} (${no})` },
  );
  return { ...getEntryDetail(ctx, id), warnings };
}

/* ------------------------------ Transfers ------------------------------ */

export interface TransferInput {
  date?: string | null;
  fromAccountId: number;
  toAccountId: number;
  amount: number;
  narration?: string | null;
}

function transferNarration(from: { name: string; group_code: string }, to: { name: string; group_code: string }): string {
  if (from.group_code === 'cash' && to.group_code === 'bank') return `Cash deposited in ${to.name}`;
  if (from.group_code === 'bank' && to.group_code === 'cash') return `Cash withdrawn from ${from.name}`;
  return `Transfer from ${from.name} to ${to.name}`;
}

export function transfer(ctx: Ctx, input: TransferInput): { entry: EntryDetail; warnings: string[] } {
  const date = resolveVoucherDate(ctx, input.date, 'A transfer');
  if (input.fromAccountId === input.toAccountId) {
    throw fail.validation('Choose two different accounts to transfer between', { toAccountId: 'Must be different from the "from" account' });
  }
  const from = activeAccount(ctx, input.fromAccountId, '"from" account');
  const to = activeAccount(ctx, input.toAccountId, '"to" account');
  for (const [a, field] of [
    [from, 'fromAccountId'],
    [to, 'toAccountId'],
  ] as const) {
    if (a.group_code !== 'cash' && a.group_code !== 'bank') {
      throw fail.validation(`"${a.name}" is not a cash, bank or UPI account. Use a journal entry for other transfers.`, { [field]: 'Choose a cash or bank account' });
    }
  }
  const narration = input.narration?.trim() || transferNarration(from, to);
  const { id, warnings } = postManualVoucher(
    ctx,
    {
      date,
      voucherType: 'contra',
      narration,
      lines: [
        { account: to.id, debit: input.amount },
        { account: from.id, credit: input.amount },
      ],
    },
    { action: 'transfer.create', summary: (no) => `Transferred ${formatINR(input.amount)} from ${from.name} to ${to.name} (${no})` },
  );
  return { entry: getEntryDetail(ctx, id), warnings };
}

export interface TransferRow {
  id: number;
  date: string;
  voucherNo: string | null;
  fromAccount: string;
  toAccount: string;
  amount: number;
  narration: string | null;
  isVoid: boolean;
  createdBy: string | null;
}

export function listTransfers(ctx: Ctx, range: { from: string; to: string }): { rows: TransferRow[]; total: number } {
  const entries = ctx.db.all<{ id: number; date: string; voucher_no: string | null; narration: string | null; is_void: number; created_by: number | null }>(
    `SELECT id, date, voucher_no, narration, is_void, created_by FROM journal_entries
      WHERE voucher_type = 'contra' AND date >= ? AND date <= ? ORDER BY date DESC, id DESC`,
    [range.from, range.to],
  );
  const rows = entries.map((e) => {
    const lines = ctx.db.all<{ name: string; debit: number; credit: number }>(
      'SELECT a.name, l.debit, l.credit FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ? ORDER BY l.line_no',
      [e.id],
    );
    return {
      id: e.id,
      date: e.date,
      voucherNo: e.voucher_no,
      fromAccount: joinNames(lines.filter((l) => l.credit > 0).map((l) => l.name)),
      toAccount: joinNames(lines.filter((l) => l.debit > 0).map((l) => l.name)),
      amount: lines.reduce((s, l) => s + l.debit, 0),
      narration: e.narration,
      isVoid: !!e.is_void,
      createdBy: userName(ctx, e.created_by),
    };
  });
  return { rows, total: rows.filter((r) => !r.isVoid).reduce((s, r) => s + r.amount, 0) };
}

/* ------------------------------ Capital summary ------------------------------ */

export interface CapitalSummary {
  /** Owner's funds (capital + drawings accounts, credit = positive) before the period. */
  opening: number;
  capitalAdded: number;
  openingBalances: number;
  profitTransferred: number;
  drawings: number;
  other: number;
  closing: number;
  /** Profit (income - expenses) of financial years not yet closed, up to the end of the period. */
  unclosedProfit: number;
  entries: Array<{ id: number; date: string; voucherType: VoucherType; voucherLabel: string; voucherNo: string | null; narration: string | null; amount: number; isVoid: false; link: { kind: string; id: number } }>;
  report: ReportData;
}

export function capitalSummary(ctx: Ctx, range: { from: string; to: string }): CapitalSummary {
  const capitalIds = ctx.db.all<{ id: number }>("SELECT id FROM accounts WHERE group_code = 'capital'").map((r) => r.id);
  const drawingIds = new Set(ctx.db.all<{ id: number }>("SELECT id FROM accounts WHERE group_code = 'drawings'").map((r) => r.id));
  const all = [...capitalIds, ...drawingIds];
  const sumBefore = (date: string) =>
    0 - ctx.db.value<number>(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.is_void = 0 AND e.date < ? AND l.account_id IN (${inList(all.length)})`,
      [date, ...all],
      0,
    );
  const opening = sumBefore(range.from);
  const lines = ctx.db.all<{
    entry_id: number;
    date: string;
    voucher_type: VoucherType;
    voucher_no: string | null;
    narration: string | null;
    source_type: string | null;
    source_id: number | null;
    account_id: number;
    debit: number;
    credit: number;
  }>(
    `SELECT l.entry_id, e.date, e.voucher_type, e.voucher_no, e.narration, e.source_type, e.source_id, l.account_id, l.debit, l.credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.is_void = 0 AND e.date >= ? AND e.date <= ? AND l.account_id IN (${inList(all.length)})
      ORDER BY e.date, e.id, l.line_no`,
    [range.from, range.to, ...all],
  );
  let capitalAdded = 0;
  let openingBalances = 0;
  let profitTransferred = 0;
  let drawings = 0;
  let other = 0;
  const byEntry = new Map<number, { e: (typeof lines)[number]; net: number }>();
  for (const l of lines) {
    const net = l.credit - l.debit;
    if (l.voucher_type === 'closing') profitTransferred += net;
    else if (drawingIds.has(l.account_id)) drawings -= net;
    else if (l.voucher_type === 'capital') capitalAdded += net;
    else if (l.voucher_type === 'opening') openingBalances += net;
    else other += net;
    const cur = byEntry.get(l.entry_id) ?? { e: l, net: 0 };
    cur.net += net;
    byEntry.set(l.entry_id, cur);
  }
  const closing = opening + capitalAdded + openingBalances + profitTransferred - drawings + other;

  // Profit of open years up to the end of the period.
  const booksStart = getSection(ctx, 'accounts').booksStartDate;
  const firstOpen = ctx.db.value<string | null>(
    'SELECT MIN(start_date) FROM financial_years WHERE is_closed = 0 AND start_date >= ?',
    [fyOf(booksStart).start],
    null,
  );
  const unclosedProfit = firstOpen && firstOpen <= range.to
    ? 0 - ctx.db.value<number>(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          JOIN accounts a ON a.id = l.account_id JOIN account_groups g ON g.code = a.group_code
          WHERE e.is_void = 0 AND e.voucher_type <> 'closing' AND g.type IN ('income', 'expense') AND e.date >= ? AND e.date <= ?`,
        [firstOpen, range.to],
        0,
      )
    : 0;

  const entries = [...byEntry.values()]
    .filter((x) => x.net !== 0 || x.e.voucher_type === 'closing')
    .map(({ e, net }) => ({
      id: e.entry_id,
      date: e.date,
      voucherType: e.voucher_type,
      voucherLabel: voucherLabel(e.voucher_type),
      voucherNo: e.voucher_no,
      narration: e.narration,
      amount: net,
      isVoid: false as const,
      link: entrySourceLink(ctx, { id: e.entry_id, source_type: e.source_type, source_id: e.source_id }),
    }));

  const rows: ReportRow[] = [{ cells: { date: range.from, particulars: 'Opening balance', no: null, added: null, withdrawn: null, balance: opening }, style: 'group' }];
  let running = opening;
  for (const e of entries) {
    running += e.amount;
    rows.push({
      cells: {
        date: e.date,
        particulars: e.narration ? `${e.voucherLabel}: ${e.narration}` : e.voucherLabel,
        no: e.voucherNo,
        added: e.amount > 0 ? e.amount : null,
        withdrawn: e.amount < 0 ? -e.amount : null,
        balance: running,
      },
      link: e.link,
    });
  }
  rows.push({
    cells: {
      date: range.to,
      particulars: 'Closing balance',
      no: null,
      added: entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0),
      withdrawn: entries.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0),
      balance: closing,
    },
    style: 'total',
  });
  const notes = [
    "Owner's funds = capital accounts (including opening balance adjustment) less drawings. Profit is added when a financial year is closed.",
  ];
  if (unclosedProfit) {
    notes.push(`${unclosedProfit > 0 ? 'Profit' : 'Loss'} of ${formatINR(Math.abs(unclosedProfit))} of years not yet closed (up to ${formatDate(range.to)}) will be added at year-end closing.`);
  }
  const report: ReportData = {
    title: "Owner's capital",
    subtitle: describeRange(range),
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 11 },
      { key: 'particulars', label: 'Particulars', width: 44 },
      { key: 'no', label: 'Voucher no', width: 16, nowrap: true },
      { key: 'added', label: 'Added', type: 'money', width: 14 },
      { key: 'withdrawn', label: 'Withdrawn', type: 'money', width: 14 },
      { key: 'balance', label: 'Balance', type: 'money', width: 15 },
    ],
    rows,
    summary: [
      { label: 'Opening', value: opening, type: 'money' },
      { label: 'Capital added', value: capitalAdded + openingBalances, type: 'money' },
      { label: 'Profit transferred', value: profitTransferred, type: 'money' },
      { label: 'Drawings', value: drawings, type: 'money' },
      { label: 'Closing', value: closing, type: 'money' },
    ],
    notes,
  };
  return { opening, capitalAdded, openingBalances, profitTransferred, drawings, other, closing, unclosedProfit, entries, report };
}

