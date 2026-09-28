/**
 * Trial balance: for every account, the opening balance (as on the day before
 * "from"), the debits and credits of the period and the closing balance.
 *
 *  - "from" defaults to the start of the financial year of "to".
 *  - Balance-sheet accounts carry their balance forward. Income and expense
 *    accounts start at zero each financial year: earlier years' result is one
 *    "Profit & loss (previous years)" line (zero for years that were closed,
 *    because the closing entry moved it to capital).
 *  - The year-end closing entry of "to"'s own year is left out, so the income and
 *    expense accounts still show the year's figures.
 * Debit and credit totals always agree; a Difference row is shown if they ever don't.
 */
import type { Ctx } from '../../context';
import { addDays, formatDate, fyOf } from '../../../shared/dates';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPES, type AccountType, type PartyType } from '../../../shared/constants';
import type { ReportData, ReportRow } from '../../../shared/report';
import { accountSums, accountsMeta, assertRange, partyNames, partySums, type LedgerFilter, type Sums } from './common';

export interface TrialBalanceInput {
  from?: string | null;
  to: string;
  /** List each customer / supplier / employee under its control account. */
  partyDetail?: boolean;
}

export interface TrialBalanceTotals {
  openingDebit: number;
  openingCredit: number;
  debit: number;
  credit: number;
  closingDebit: number;
  closingCredit: number;
  /** closingDebit - closingCredit; zero when the books balance. */
  difference: number;
}

const PL_TYPES: AccountType[] = ['income', 'expense'];

function drcr(net: number): { dr: number | null; cr: number | null } {
  return { dr: net > 0 ? net : null, cr: net < 0 ? -net : null };
}

export function trialBalanceData(ctx: Ctx, input: TrialBalanceInput): { report: ReportData; totals: TrialBalanceTotals } {
  const to = input.to;
  const fyTo = fyOf(to);
  const from = input.from || fyTo.start;
  assertRange(from, to);
  const fyFrom = fyOf(from);
  const accounts = accountsMeta(ctx);
  const excludeClosingFrom = fyTo.start;

  // Opening: balance-sheet accounts carry forward; P&L accounts only from the start of from's year.
  // Opening-balance vouchers (dated the books start) are opening, not movement, as in the cash flow and cash book.
  const bsOpeningFilter: LedgerFilter = { before: from, openingThrough: to, excludeClosingFrom, types: ['asset', 'liability', 'equity'] };
  const plOpeningFilter: LedgerFilter = { from: fyFrom.start, before: from, excludeClosingFrom, types: PL_TYPES };
  const moveFilter: LedgerFilter = { from, to, excludeClosingFrom, excludeOpeningThrough: to };
  const bsOpening = accountSums(ctx, bsOpeningFilter);
  const plOpening = accountSums(ctx, plOpeningFilter);
  const movement = accountSums(ctx, moveFilter);
  const prevYears = accountSums(ctx, { before: fyFrom.start, excludeClosingFrom, types: PL_TYPES });
  const prevYearsNet = [...prevYears.values()].reduce((s, v) => s + v.debit - v.credit, 0);

  const openingOf = (id: number, type: AccountType): number => {
    const s = (PL_TYPES.includes(type) ? plOpening : bsOpening).get(id);
    return s ? s.debit - s.credit : 0;
  };

  const rows: ReportRow[] = [];
  const totals: TrialBalanceTotals = { openingDebit: 0, openingCredit: 0, debit: 0, credit: 0, closingDebit: 0, closingCredit: 0, difference: 0 };
  const cellsFor = (label: string, opening: number, move: Sums | undefined) => {
    const o = drcr(opening);
    const closing = opening + (move?.debit ?? 0) - (move?.credit ?? 0);
    const c = drcr(closing);
    return {
      closing,
      cells: {
        account: label,
        openingDr: o.dr,
        openingCr: o.cr,
        debit: move?.debit || null,
        credit: move?.credit || null,
        closingDr: c.dr,
        closingCr: c.cr,
      },
    };
  };
  const addTotals = (opening: number, move: Sums | undefined, closing: number) => {
    if (opening > 0) totals.openingDebit += opening;
    else totals.openingCredit += -opening;
    totals.debit += move?.debit ?? 0;
    totals.credit += move?.credit ?? 0;
    if (closing > 0) totals.closingDebit += closing;
    else totals.closingCredit += -closing;
  };

  const partyRows = (accountId: number, partyType: PartyType) => {
    // Control accounts are balance-sheet accounts, so party balances carry forward.
    const pOpen = new Map<number, number>();
    for (const [pid, s] of partySums(ctx, accountId, bsOpeningFilter)) pOpen.set(pid, s.debit - s.credit);
    const pMove = partySums(ctx, accountId, moveFilter);
    const ids = [...new Set([...pOpen.keys(), ...pMove.keys()])];
    const names = partyNames(ctx, partyType, ids);
    ids.sort((a, b) => (names.get(a) ?? '').localeCompare(names.get(b) ?? '', 'en-IN', { sensitivity: 'base' }));
    for (const pid of ids) {
      const o = pOpen.get(pid) ?? 0;
      const m = pMove.get(pid);
      const { cells, closing } = cellsFor(names.get(pid) ?? `#${pid}`, o, m);
      if (!o && !m?.debit && !m?.credit && !closing) continue;
      rows.push({ cells, style: 'muted', indent: 3, link: { kind: partyType, id: pid } });
    }
  };

  for (const type of ACCOUNT_TYPES) {
    const ofType = accounts.filter((a) => a.type === type);
    const before = rows.length;
    let lastGroup = '';
    for (const a of ofType) {
      const opening = openingOf(a.id, type);
      const move = movement.get(a.id);
      const { cells, closing } = cellsFor(a.name, opening, move);
      if (!opening && !move?.debit && !move?.credit && !closing) continue;
      if (a.groupCode !== lastGroup) {
        rows.push({ cells: { account: a.groupName }, style: 'group', indent: 1 });
        lastGroup = a.groupCode;
      }
      rows.push({ cells, indent: 2, link: { kind: 'account', id: a.id } });
      addTotals(opening, move, closing);
      if (input.partyDetail && a.partyType) partyRows(a.id, a.partyType);
    }
    if (type === 'equity' && prevYearsNet) {
      rows.push({ cells: { account: 'Profit & Loss Account' }, style: 'group', indent: 1 });
      const { cells, closing } = cellsFor('Profit & loss (previous years)', prevYearsNet, undefined);
      rows.push({ cells, indent: 2 });
      addTotals(prevYearsNet, undefined, closing);
    }
    if (rows.length > before) rows.splice(before, 0, { cells: { account: ACCOUNT_TYPE_LABELS[type] }, style: 'section' });
  }

  totals.difference = totals.closingDebit - totals.closingCredit;
  rows.push({
    cells: {
      account: 'Total',
      openingDr: totals.openingDebit,
      openingCr: totals.openingCredit,
      debit: totals.debit,
      credit: totals.credit,
      closingDr: totals.closingDebit,
      closingCr: totals.closingCredit,
    },
    style: 'total',
  });
  const notes = [
    `Opening balances are as on ${formatDate(addDays(from, -1))}. Income and expense accounts start from zero on ${formatDate(fyFrom.start)}.`,
    `Year-end closing entries of ${fyTo.name} are left out.`,
  ];
  if (totals.difference) {
    const d = drcr(totals.difference);
    rows.push({ cells: { account: 'Difference (the books do not balance)', closingDr: d.cr, closingCr: d.dr }, style: 'total' });
    notes.unshift(`Warning: debit and credit totals differ by ${(Math.abs(totals.difference) / 100).toFixed(2)}. Please take a backup and contact support.`);
  }
  if (prevYearsNet) notes.push('"Profit & loss (previous years)" is the result of earlier years that have not been closed yet.');

  return {
    totals,
    report: {
      title: 'Trial Balance',
      subtitle: from === fyTo.start ? `For ${formatDate(from)} to ${formatDate(to)} (FY ${fyTo.name})` : `For ${formatDate(from)} to ${formatDate(to)}`,
      columns: [
        { key: 'account', label: 'Account', width: 36 },
        { key: 'openingDr', label: 'Opening Dr', type: 'money', width: 15 },
        { key: 'openingCr', label: 'Opening Cr', type: 'money', width: 15 },
        { key: 'debit', label: 'Debit', type: 'money', width: 15 },
        { key: 'credit', label: 'Credit', type: 'money', width: 15 },
        { key: 'closingDr', label: 'Closing Dr', type: 'money', width: 15 },
        { key: 'closingCr', label: 'Closing Cr', type: 'money', width: 15 },
      ],
      rows,
      summary: [
        { label: 'Total debit (closing)', value: totals.closingDebit, type: 'money' },
        { label: 'Total credit (closing)', value: totals.closingCredit, type: 'money' },
        { label: 'Status', value: totals.difference ? `Difference ${(Math.abs(totals.difference) / 100).toFixed(2)}` : 'Balanced', type: 'text' },
      ],
      notes,
      landscape: true,
    },
  };
}

/** CONTRACT route output: the trial balance as ReportData. */
export function trialBalance(ctx: Ctx, input: TrialBalanceInput): ReportData {
  return trialBalanceData(ctx, input).report;
}
