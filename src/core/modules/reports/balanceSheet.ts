/**
 * Balance sheet as on a date, in vertical form (capital & liabilities, then assets).
 *
 *  - Balance-sheet accounts use every non-void entry up to the date, except the
 *    year-end closing entry of the date's own financial year.
 *  - "Profit & loss (current year)" = income - expenses from the FY start to the
 *    date, closing entries left out.
 *  - "Profit & loss (previous years, not closed)" = income - expenses before the FY
 *    start, closing entries included (so closed years net to zero).
 *  - Customers / suppliers are split by the side of their balance: debit customers
 *    are Sundry debtors, credit customers are Advances from customers, and so on.
 * Because every figure comes from whole entries, the two sides always agree; the
 * check is still made and a difference is shown loudly instead of hidden.
 */
import type { Ctx } from '../../context';
import { addDays, formatDate, fyOf } from '../../../shared/dates';
import type { ReportData, ReportRow } from '../../../shared/report';
import { accountNets, accountsMeta, partyNets, type AccountMeta, type LedgerFilter } from './common';

export interface BalanceSheetTotals {
  assets: number;
  liabilities: number;
  /** assets - (capital + liabilities); zero when the books balance. */
  difference: number;
  balanced: boolean;
}

export interface BalanceSheetResult {
  report: ReportData;
  totals: BalanceSheetTotals;
  profit: { currentYear: number; previousYears: number };
  /** Key figures used by other screens. */
  figures: {
    capital: number;
    drawings: number;
    loans: number;
    currentLiabilities: number;
    creditors: number;
    customerAdvances: number;
    fixedAssets: number;
    cash: number;
    bank: number;
    debtors: number;
    supplierAdvances: number;
    loansAdvances: number;
    otherCurrentAssets: number;
  };
}

interface Line {
  label: string;
  amount: number;
  accountId?: number;
}

export function balanceSheet(ctx: Ctx, input: { asOf: string }): BalanceSheetResult {
  const asOf = input.asOf;
  const fy = fyOf(asOf);
  const accounts = accountsMeta(ctx);
  const bsFilter: LedgerFilter = { to: asOf, excludeClosingFrom: fy.start };
  const bsNets = accountNets(ctx, { ...bsFilter, types: ['asset', 'liability', 'equity'] });
  const curPl = accountNets(ctx, { from: fy.start, to: asOf, excludeClosing: true, types: ['income', 'expense'] });
  const prevPl = accountNets(ctx, { to: addDays(fy.start, -1), types: ['income', 'expense'] });
  const sumCredit = (m: Map<number, number>) => 0 - [...m.values()].reduce((s, v) => s + v, 0) || 0;
  const profitCurrent = sumCredit(curPl);
  const profitPrevious = sumCredit(prevPl);

  const net = (a: AccountMeta) => bsNets.get(a.id) ?? 0;
  const inGroup = (code: string) => accounts.filter((a) => a.groupCode === code);
  /** Credit-side amount of an account (liability / capital). */
  const cr = (a: AccountMeta) => -net(a);

  // Parties on control accounts, split by the side of their balance.
  const arId = accounts.find((a) => a.systemKey === 'AR')?.id;
  const apId = accounts.find((a) => a.systemKey === 'AP')?.id;
  const split = (accountId: number | undefined) => {
    let debit = 0;
    let credit = 0;
    let debitCount = 0;
    let creditCount = 0;
    if (accountId) {
      for (const bal of partyNets(ctx, accountId, bsFilter).values()) {
        if (bal > 0) {
          debit += bal;
          debitCount++;
        } else if (bal < 0) {
          credit += -bal;
          creditCount++;
        }
      }
    }
    return { debit, credit, debitCount, creditCount };
  };
  const ar = split(arId);
  const ap = split(apId);

  const accountLines = (list: AccountMeta[], sign: 1 | -1): Line[] =>
    list.map((a) => ({ label: a.name, amount: sign * net(a), accountId: a.id })).filter((l) => l.amount !== 0);

  // Capital & liabilities
  const capitalLines: Line[] = accountLines(inGroup('capital'), -1);
  const drawings = inGroup('drawings').reduce((s, a) => s + net(a), 0);
  for (const a of inGroup('drawings')) if (net(a)) capitalLines.push({ label: `Less: ${a.name}`, amount: -net(a), accountId: a.id });
  if (profitCurrent) capitalLines.push({ label: `Profit & loss (current year${profitCurrent < 0 ? ' - loss' : ''})`, amount: profitCurrent });
  if (profitPrevious) capitalLines.push({ label: `Profit & loss (previous years, not closed${profitPrevious < 0 ? ' - loss' : ''})`, amount: profitPrevious });
  const loanLines = accountLines(inGroup('loans'), -1);
  const clLines = accountLines(inGroup('current_liabilities'), -1);
  // Payables group: the AP control account is split by supplier; any other account there is listed as is.
  const otherPayables = accountLines(
    inGroup('payables').filter((a) => a.id !== apId),
    -1,
  );

  // Assets
  const faLines = accountLines(inGroup('fixed_assets'), 1);
  const cashLines = accountLines(inGroup('cash'), 1);
  const bankLines = accountLines(inGroup('bank'), 1);
  const otherReceivables = accountLines(
    inGroup('receivables').filter((a) => a.id !== arId),
    1,
  );
  const laLines = accountLines(inGroup('loans_advances'), 1);
  const ocaLines = accountLines(inGroup('current_assets'), 1);

  const total = (lines: Line[]) => lines.reduce((s, l) => s + l.amount, 0);
  const rows: ReportRow[] = [];
  const group = (label: string, lines: Line[], opts: { always?: boolean; singleLine?: boolean; link?: number } = {}) => {
    const t = total(lines);
    if (!lines.length && !opts.always) return 0;
    if (opts.singleLine) {
      rows.push({ cells: { particulars: label, amount: null, total: t }, ...(opts.link ? { link: { kind: 'account', id: opts.link } } : {}) });
      return t;
    }
    rows.push({ cells: { particulars: label, amount: null, total: t }, style: 'group' });
    for (const l of lines) rows.push({ cells: { particulars: l.label, amount: l.amount, total: null }, indent: 1, ...(l.accountId ? { link: { kind: 'account', id: l.accountId } } : {}) });
    return t;
  };
  const party = (label: string, amount: number, count: number, noun: string, accountId: number | undefined) => {
    if (!amount) return 0;
    rows.push({
      cells: { particulars: `${label} (${count} ${noun}${count === 1 ? '' : 's'})`, amount: null, total: amount },
      ...(accountId ? { link: { kind: 'account', id: accountId } } : {}),
    });
    return amount;
  };

  rows.push({ cells: { particulars: 'Capital & liabilities' }, style: 'section' });
  let liabilities = 0;
  liabilities += group('Capital account', capitalLines, { always: true });
  liabilities += group('Loans taken', loanLines);
  liabilities += group('Current liabilities', clLines);
  liabilities += party('Sundry creditors', ap.credit, ap.creditCount, 'supplier', apId);
  liabilities += group('Other payables', otherPayables);
  liabilities += party('Advances from customers', ar.credit, ar.creditCount, 'customer', arId);
  rows.push({ cells: { particulars: 'Total capital & liabilities', amount: null, total: liabilities }, style: 'total' });

  rows.push({ cells: { particulars: 'Assets' }, style: 'section' });
  let assets = 0;
  assets += group('Fixed assets', faLines);
  assets += group('Cash-in-hand', cashLines);
  assets += group('Bank & UPI accounts', bankLines);
  assets += party('Sundry debtors', ar.debit, ar.debitCount, 'customer', arId);
  assets += group('Other receivables', otherReceivables);
  assets += party('Advances to suppliers', ap.debit, ap.debitCount, 'supplier', apId);
  assets += group('Loans & advances', laLines);
  assets += group('Other current assets', ocaLines);
  rows.push({ cells: { particulars: 'Total assets', amount: null, total: assets }, style: 'total' });

  const difference = assets - liabilities;
  const balanced = difference === 0;
  const notes: string[] = [];
  if (!balanced) {
    rows.push({ cells: { particulars: 'Difference (the books do not balance)', amount: null, total: difference }, style: 'total' });
    notes.push(
      `Warning: assets and capital & liabilities differ by ${(Math.abs(difference) / 100).toFixed(2)}. Please take a backup and contact support; do not close the year until this is fixed.`,
    );
  }
  notes.push(
    `Profit & loss (current year) is the result from ${formatDate(fy.start)} to ${formatDate(asOf)}. Year-end closing entries of ${fy.name} are left out.`,
    'Stock is not tracked, so closing stock is not shown as an asset.',
  );
  if (profitPrevious) notes.push('Some earlier years have not been closed yet; their result is shown as "Profit & loss (previous years)". Close them from Accounts > Year-end closing.');

  const sumLines = (l: Line[]) => total(l);
  return {
    totals: { assets, liabilities, difference, balanced },
    profit: { currentYear: profitCurrent, previousYears: profitPrevious },
    figures: {
      capital: inGroup('capital').reduce((s, a) => s + cr(a), 0),
      drawings,
      loans: sumLines(loanLines),
      currentLiabilities: sumLines(clLines),
      creditors: ap.credit,
      customerAdvances: ar.credit,
      fixedAssets: sumLines(faLines),
      cash: sumLines(cashLines),
      bank: sumLines(bankLines),
      debtors: ar.debit,
      supplierAdvances: ap.debit,
      loansAdvances: sumLines(laLines),
      otherCurrentAssets: sumLines(ocaLines),
    },
    report: {
      title: 'Balance Sheet',
      subtitle: `As on ${formatDate(asOf)}`,
      columns: [
        { key: 'particulars', label: 'Particulars', width: 48 },
        { key: 'amount', label: 'Amount', type: 'money', width: 18 },
        { key: 'total', label: 'Total', type: 'money', width: 18 },
      ],
      rows,
      summary: [
        { label: 'Total assets', value: assets, type: 'money' },
        { label: 'Total capital & liabilities', value: liabilities, type: 'money' },
        // A loss is shown as a positive amount next to the word "Loss", in red (as the dashboard's "FY loss").
        { label: profitCurrent >= 0 ? 'Profit this year' : 'Loss this year', value: Math.abs(profitCurrent), type: 'money', ...(profitCurrent < 0 ? { tone: 'bad' as const } : {}) },
        { label: 'Status', value: balanced ? 'Balanced' : `Difference ${(difference / 100).toFixed(2)}`, type: 'text' },
      ],
      notes,
    },
  };
}
