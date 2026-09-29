/**
 * Profit & loss, trading style:
 *   Sales (gross) - Sales returns                      = Net sales
 *   Net sales - Purchases - Direct expenses            = Gross profit
 *   Gross profit + Other income - Indirect expenses    = Net profit / loss
 * Computed from the ledger (non-void entries, year-end closing entries left out).
 * Without stock tracking, purchases are expensed when made. With stock tracking (Settings > Stock) the
 * trading part is: Net sales - (Opening stock + Purchases + Direct expenses - Closing stock), stock valued
 * at the average purchase cost (modules/stock/accounting.ts).
 * Discounts allowed and round off are indirect expenses here, so this "Net sales" is before discounts;
 * Sales insights and the dashboard show bill totals as "Net sales after discounts" (a note says so).
 */
import type { Ctx } from '../../context';
import type { ReportColumn, ReportData, ReportRow } from '../../../shared/report';
import { accountNets, accountsMeta, assertRange, comparePeriod, pct, periodLabel, rangeSubtitle, type AccountMeta } from './common';
import { periodStock } from '../stock/accounting';

export type CompareKind = 'none' | 'previous_period' | 'previous_year';

export interface ProfitLossFigures {
  from: string;
  to: string;
  /** Gross sales (all sales accounts except Sales Returns). */
  sales: number;
  salesReturns: number;
  netSales: number;
  purchases: number;
  directExpenses: number;
  /** Stock tracking only: stock at the start and end of the period (else 0). */
  openingStock: number;
  closingStock: number;
  /** Opening stock + purchases + direct expenses - closing stock. */
  costOfGoodsSold: number;
  grossProfit: number;
  otherIncome: number;
  indirectExpenses: number;
  /** Purchases + direct + indirect expenses. */
  totalExpenses: number;
  netProfit: number;
  /** Net profit as % of net sales (null when there were no sales). */
  netMargin: number | null;
}

interface PeriodAmounts {
  figures: ProfitLossFigures;
  /** Account id -> amount in its natural direction (income: credit - debit, expense: debit - credit). */
  byAccount: Map<number, number>;
}

function periodAmounts(ctx: Ctx, accounts: AccountMeta[], from: string, to: string, salesReturnsId: number | null): PeriodAmounts {
  const stock = periodStock(ctx, from, to);
  const openingStock = stock?.opening ?? 0;
  const closingStock = stock?.closing ?? 0;
  const nets = accountNets(ctx, { from, to, excludeClosing: true, types: ['income', 'expense'] });
  const byAccount = new Map<number, number>();
  let sales = 0;
  let salesReturns = 0;
  let purchases = 0;
  let directExpenses = 0;
  let otherIncome = 0;
  let indirectExpenses = 0;
  for (const a of accounts) {
    const net = nets.get(a.id) ?? 0;
    if (!net) continue;
    if (a.id === salesReturnsId) {
      salesReturns += net; // debit balance
      byAccount.set(a.id, net);
      continue;
    }
    switch (a.groupCode) {
      case 'sales':
        sales += -net;
        byAccount.set(a.id, -net);
        break;
      case 'indirect_income':
        otherIncome += -net;
        byAccount.set(a.id, -net);
        break;
      case 'purchases':
        purchases += net;
        byAccount.set(a.id, net);
        break;
      case 'direct_expenses':
        directExpenses += net;
        byAccount.set(a.id, net);
        break;
      case 'indirect_expenses':
        indirectExpenses += net;
        byAccount.set(a.id, net);
        break;
      default:
        // Any other income / expense group (none exist today) is treated as other income / indirect expense.
        if (a.type === 'income') {
          otherIncome += -net;
          byAccount.set(a.id, -net);
        } else if (a.type === 'expense') {
          indirectExpenses += net;
          byAccount.set(a.id, net);
        }
    }
  }
  const netSales = sales - salesReturns;
  const costOfGoodsSold = openingStock + purchases + directExpenses - closingStock;
  const grossProfit = netSales - costOfGoodsSold;
  const netProfit = grossProfit + otherIncome - indirectExpenses;
  return {
    byAccount,
    figures: {
      from,
      to,
      sales,
      salesReturns,
      netSales,
      purchases,
      directExpenses,
      openingStock,
      closingStock,
      costOfGoodsSold,
      grossProfit,
      otherIncome,
      indirectExpenses,
      totalExpenses: purchases + directExpenses + indirectExpenses,
      netProfit,
      netMargin: pct(netProfit, netSales),
    },
  };
}

/** Figures only (used by the dashboard, balance sheet checks and tests). */
export function profitLossFigures(ctx: Ctx, from: string, to: string): ProfitLossFigures {
  const accounts = accountsMeta(ctx);
  const sr = accounts.find((a) => a.systemKey === 'SALES_RETURNS')?.id ?? null;
  return periodAmounts(ctx, accounts, from, to, sr).figures;
}

export interface ProfitLossResult {
  report: ReportData;
  figures: ProfitLossFigures;
  /** Figures of the comparison period, when asked for. */
  compare: ProfitLossFigures | null;
}

export function profitLoss(ctx: Ctx, input: { from: string; to: string; compare?: CompareKind }): ProfitLossResult {
  const { from, to } = input;
  assertRange(from, to);
  const compareKind = input.compare ?? 'none';
  const accounts = accountsMeta(ctx);
  const salesReturnsId = accounts.find((a) => a.systemKey === 'SALES_RETURNS')?.id ?? null;
  const cur = periodAmounts(ctx, accounts, from, to, salesReturnsId);
  const cmpRange = compareKind === 'none' ? null : comparePeriod(from, to, compareKind);
  const cmp = cmpRange ? periodAmounts(ctx, accounts, cmpRange.from, cmpRange.to, salesReturnsId) : null;

  const columns: ReportColumn[] = [{ key: 'particulars', label: 'Particulars', width: 42 }];
  columns.push({ key: 'amount', label: cmp ? periodLabel(from, to) : 'Amount', type: 'money', width: 18 });
  if (cmp && cmpRange) {
    columns.push({ key: 'compare', label: periodLabel(cmpRange.from, cmpRange.to), type: 'money', width: 18 });
    columns.push({ key: 'change', label: 'Change', type: 'money', width: 16 });
    columns.push({ key: 'changePct', label: 'Change %', type: 'percent', width: 10 });
  }

  const rows: ReportRow[] = [];
  const line = (label: string, curValue: number, cmpValue: number | null, style?: ReportRow['style'], indent?: number, accountId?: number) => {
    const cells: ReportRow['cells'] = { particulars: label, amount: curValue };
    if (cmp) {
      const c = cmpValue ?? 0;
      cells.compare = c;
      cells.change = curValue - c;
      cells.changePct = c ? Math.round(((curValue - c) / Math.abs(c)) * 1000) / 10 : null;
    }
    rows.push({ cells, style, indent, ...(accountId ? { link: { kind: 'account', id: accountId } } : {}) });
  };
  const header = (label: string, style: ReportRow['style'] = 'group') => rows.push({ cells: { particulars: label }, style });

  /** Accounts of the groups with a non-zero amount in either period, largest first when asked. */
  const accountsIn = (pred: (a: AccountMeta) => boolean, largestFirst = false) => {
    const list = accounts.filter((a) => pred(a) && ((cur.byAccount.get(a.id) ?? 0) !== 0 || (cmp?.byAccount.get(a.id) ?? 0) !== 0));
    if (largestFirst) list.sort((a, b) => (cur.byAccount.get(b.id) ?? 0) - (cur.byAccount.get(a.id) ?? 0) || a.name.localeCompare(b.name));
    return list;
  };
  const accountLine = (a: AccountMeta, indent = 1, label = a.name) => line(label, cur.byAccount.get(a.id) ?? 0, cmp ? (cmp.byAccount.get(a.id) ?? 0) : null, undefined, indent, a.id);
  const cf = cmp?.figures ?? null;
  const signLabel = (value: number, profit: string, loss: string) => (cmp ? `${profit} / (${loss.toLowerCase()})` : value >= 0 ? profit : loss);

  // Trading part
  header('Trading account', 'section');
  const salesAccounts = accountsIn((a) => a.groupCode === 'sales' && a.id !== salesReturnsId);
  if (!salesAccounts.length) line('Sales', 0, cf ? 0 : null, undefined, 0);
  for (const a of salesAccounts) accountLine(a, 0, salesAccounts.length === 1 ? 'Sales' : a.name);
  const sr = accounts.find((a) => a.id === salesReturnsId);
  if (sr && ((cur.byAccount.get(sr.id) ?? 0) !== 0 || (cmp?.byAccount.get(sr.id) ?? 0) !== 0)) accountLine(sr, 0, 'Less: Sales returns');
  line('Net sales', cur.figures.netSales, cf ? cf.netSales : null, 'subtotal');

  const costAccounts = accountsIn((a) => a.groupCode === 'purchases' || a.groupCode === 'direct_expenses');
  const withStock = periodStock(ctx, from, to) !== null;
  if (withStock) {
    // Cost of goods sold = opening stock + purchases + direct expenses - closing stock.
    header('Less: Cost of goods sold');
    line('Opening stock', cur.figures.openingStock, cf ? cf.openingStock : null, undefined, 1);
    for (const a of costAccounts) accountLine(a);
    line('Less: Closing stock', -cur.figures.closingStock, cf ? -cf.closingStock : null, undefined, 1);
    line('Cost of goods sold', cur.figures.costOfGoodsSold, cf ? cf.costOfGoodsSold : null, 'subtotal');
  } else if (costAccounts.length) {
    header('Less: Purchases & direct expenses');
    for (const a of costAccounts) accountLine(a);
    line(
      'Total purchases & direct expenses',
      cur.figures.purchases + cur.figures.directExpenses,
      cf ? cf.purchases + cf.directExpenses : null,
      'subtotal',
    );
  }
  line(signLabel(cur.figures.grossProfit, 'Gross profit', 'Gross loss'), cmp ? cur.figures.grossProfit : Math.abs(cur.figures.grossProfit), cf ? cf.grossProfit : null, 'subtotal');

  // Profit & loss part
  header('Profit & loss account', 'section');
  const incomeAccounts = accountsIn((a) => a.type === 'income' && a.groupCode !== 'sales', true);
  if (incomeAccounts.length) {
    header('Add: Other income');
    for (const a of incomeAccounts) accountLine(a);
    line('Total other income', cur.figures.otherIncome, cf ? cf.otherIncome : null, 'subtotal');
  }
  const indirect = accountsIn((a) => a.type === 'expense' && a.groupCode !== 'purchases' && a.groupCode !== 'direct_expenses', true);
  if (indirect.length) {
    header('Less: Indirect expenses');
    for (const a of indirect) accountLine(a);
    line('Total indirect expenses', cur.figures.indirectExpenses, cf ? cf.indirectExpenses : null, 'subtotal');
  }
  line(signLabel(cur.figures.netProfit, 'Net profit', 'Net loss'), cmp ? cur.figures.netProfit : Math.abs(cur.figures.netProfit), cf ? cf.netProfit : null, 'total');

  const f = cur.figures;
  const notes = [
    withStock
      ? 'Stock is valued at the average purchase cost (Stock > Stock levels). Cost of goods sold = opening stock + purchases + direct expenses - closing stock.'
      : 'Stock is not tracked; purchases are treated as expenses when made.',
    'Year-end closing entries are left out. Cancelled bills and vouchers are not included.',
  ];
  const billingAdjustments = accounts.filter((a) => a.systemKey === 'DISCOUNT_ALLOWED' || a.systemKey === 'ROUND_OFF').some((a) => (cur.byAccount.get(a.id) ?? 0) !== 0);
  if (billingAdjustments) {
    notes.push(
      'Net sales = sales - sales returns. Discount allowed and round off on bills are shown under indirect expenses, so Sales insights and the dashboard, which take them off the bills ("Net sales after discounts"), show a different figure.',
    );
  }
  if (cmp && cmpRange) notes.push(`Compared with ${periodLabel(cmpRange.from, cmpRange.to)} (${rangeSubtitle(cmpRange.from, cmpRange.to).toLowerCase()}). Change % is shown against the earlier period.`);
  if (!cmp && (f.grossProfit < 0 || f.netProfit < 0)) notes.push('Losses are shown as positive amounts next to the words "Gross loss" / "Net loss".');

  return {
    figures: f,
    compare: cf,
    report: {
      title: 'Profit & Loss',
      subtitle: rangeSubtitle(from, to),
      columns,
      rows,
      summary: [
        { label: 'Net sales', value: f.netSales, type: 'money' },
        // A loss is shown as a positive amount next to the word "loss", in red, as in the statement.
        { label: f.grossProfit >= 0 ? 'Gross profit' : 'Gross loss', value: Math.abs(f.grossProfit), type: 'money', ...(f.grossProfit < 0 ? { tone: 'bad' as const } : {}) },
        { label: 'Purchases & expenses', value: f.totalExpenses, type: 'money' },
        { label: f.netProfit >= 0 ? 'Net profit' : 'Net loss', value: Math.abs(f.netProfit), type: 'money', ...(f.netProfit < 0 ? { tone: 'bad' as const } : {}) },
        { label: 'Net margin', value: f.netMargin ?? '-', type: f.netMargin === null ? 'text' : 'percent' },
      ],
      notes,
      landscape: !!cmp,
    },
  };
}
