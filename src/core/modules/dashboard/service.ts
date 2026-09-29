/**
 * The home screen: key figures for today and this month, balances, a 30-day
 * sales trend, top items, recent bills and alerts. Every part is included only
 * when the user may see it, so a cashier gets today's sales and recent bills but
 * never profit or balances.
 */
import type { Ctx } from '../../context';
import { can, requireSession, today } from '../../context';
import { getSection } from '../../settings';
import { addDays, addMonths, diffDays, endOfMonth, formatDate, fyOf, startOfMonth } from '../../../shared/dates';
import type { PaymentMode, Role } from '../../../shared/constants';
import { formatINR, formatQty } from '../../../shared/money';
import { accountNets, accountsMeta, partyNets, systemId } from '../reports/common';
import { profitLossFigures } from '../reports/profitLoss';
import { dailyNetSales, itemSales, salesSummary } from '../reports/sales';
import { lowStockItems } from '../stock/service';

export interface DashboardAlert {
  kind: 'backup' | 'credit_limit' | 'negative_balance' | 'low_stock';
  tone: 'amber' | 'red';
  title: string;
  message: string;
  /** App path the alert's button opens. */
  path: string;
  action: string;
}

export interface DashboardBill {
  id: number;
  billNo: string;
  date: string;
  createdAt: string;
  customerName: string | null;
  total: number;
  /** Amount left on the customer's account. */
  credit: number;
  paymentMode: string;
  status: 'active' | 'cancelled';
}

export interface DashboardSummary {
  today: string;
  fyName: string;
  user: { name: string; role: Role };
  /** Today's sales (users who make or view bills). */
  todaySales: { bills: number; netSales: number; billed: number; returns: number; byMode: Record<PaymentMode, number> } | null;
  /** This month vs last month (sales reports). */
  month: { thisMonth: number; bills: number; lastMonth: number; lastMonthToDate: number; changePct: number | null } | null;
  /** Cash and bank / UPI balances (books or financial reports). */
  balances: { cash: number; bank: number } | null;
  /** Customers owe you / you owe suppliers. */
  dues: { receivables: number; receivableCustomers: number; payables: number; payableSuppliers: number } | null;
  /**
   * Expenses entered this month: the same total as the Expenses page ("Total expenses") for this month.
   * Purchases, salaries, discounts and round off are not in it; the Profit & loss shows every cost.
   */
  expensesThisMonth: number | null;
  /** Net profit (financial reports only). */
  profit: { thisMonth: number; thisFy: number } | null;
  /** Net sales after discounts (bill totals less returns) per day for the last 30 days. */
  trend: { dates: string[]; values: number[] } | null;
  topItems: Array<{ name: string; itemId: number | null; qty: number; unit: string | null; amount: number }> | null;
  recentBills: { bills: DashboardBill[]; todayOnly: boolean } | null;
  alerts: DashboardAlert[];
}

/** Balance of every cash and bank / UPI account as on a date. */
function cashAccountBalances(ctx: Ctx, asOf: string): Array<{ id: number; name: string; groupCode: 'cash' | 'bank'; balance: number }> {
  const nets = accountNets(ctx, { to: asOf, types: ['asset'] });
  return accountsMeta(ctx)
    .filter((a) => a.groupCode === 'cash' || a.groupCode === 'bank')
    .map((a) => ({ id: a.id, name: a.name, groupCode: a.groupCode as 'cash' | 'bank', balance: nets.get(a.id) ?? 0 }));
}

function balancesFor(accounts: ReturnType<typeof cashAccountBalances>) {
  let cash = 0;
  let bank = 0;
  for (const a of accounts) {
    if (a.groupCode === 'cash') cash += a.balance;
    else bank += a.balance;
  }
  return { cash, bank };
}

/** "Cash in Hand is below zero": money was paid out that the books say was not there. */
function negativeBalanceAlert(ctx: Ctx, accounts: ReturnType<typeof cashAccountBalances>): DashboardAlert | null {
  const below = accounts.filter((a) => a.balance < 0).sort((a, b) => a.balance - b.balance);
  if (!below.length) return null;
  const worst = below[0];
  const book = worst.groupCode === 'cash' ? '/accounts/cash-book' : '/accounts/bank-book';
  const canOpenBook = can(ctx, 'accounts.view');
  const list = below.map((a) => `${a.name} ${formatINR(a.balance)}`).join(', ');
  return {
    kind: 'negative_balance',
    tone: 'red',
    title: below.length === 1 ? `${worst.name} is below zero` : `${below.length} cash / bank accounts are below zero`,
    message: `${list}. More money was paid out than the books show came in: check for a sale, payment received or deposit that was not entered, or a payment entered twice.`,
    path: canOpenBook ? `${book}?account=${worst.id}` : '/reports/balance-sheet',
    action: canOpenBook ? (worst.groupCode === 'cash' ? 'Open cash book' : 'Open bank book') : 'Open balance sheet',
  };
}

function duesFor(ctx: Ctx, asOf: string) {
  let receivables = 0;
  let receivableCustomers = 0;
  for (const bal of partyNets(ctx, systemId(ctx, 'AR'), { to: asOf }).values()) {
    if (bal > 0) {
      receivables += bal;
      receivableCustomers++;
    }
  }
  let payables = 0;
  let payableSuppliers = 0;
  for (const bal of partyNets(ctx, systemId(ctx, 'AP'), { to: asOf }).values()) {
    if (bal < 0) {
      payables += -bal;
      payableSuppliers++;
    }
  }
  return { receivables, receivableCustomers, payables, payableSuppliers };
}

/** Expense vouchers (not cancelled) dated in the period: the Expenses page's "Total expenses". */
function expensesBetween(ctx: Ctx, from: string, to: string): number {
  return ctx.db.value<number>("SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE status = 'active' AND date >= ? AND date <= ?", [from, to], 0);
}

function recentBills(ctx: Ctx, todayOnly: boolean, t: string): DashboardBill[] {
  return ctx.db
    .all<{ id: number; bill_no: string; date: string; created_at: string; customer_name: string | null; total: number; credit: number; payment_mode: string; status: 'active' | 'cancelled' }>(
      `SELECT id, bill_no, date, created_at, customer_name, total, credit, payment_mode, status FROM bills
        ${todayOnly ? 'WHERE date = ?' : ''} ORDER BY date DESC, id DESC LIMIT 8`,
      todayOnly ? [t] : [],
    )
    .map((b) => ({
      id: b.id,
      billNo: b.bill_no,
      date: b.date,
      createdAt: b.created_at,
      customerName: b.customer_name,
      total: b.total,
      credit: b.credit,
      paymentMode: b.payment_mode,
      status: b.status,
    }));
}

function alertsFor(ctx: Ctx, t: string, cashAccounts: ReturnType<typeof cashAccountBalances> | null): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  const negative = cashAccounts ? negativeBalanceAlert(ctx, cashAccounts) : null;
  if (negative) alerts.push(negative);
  if (can(ctx, 'data.backup')) {
    const last = getSection(ctx, 'backup').lastBackupAt;
    const days = last ? diffDays(last.slice(0, 10), t) : null;
    if (days === null) {
      alerts.push({
        kind: 'backup',
        tone: 'amber',
        title: 'No backup yet',
        message: 'Your data has never been backed up. Take a backup now and keep a copy on a pen drive.',
        path: '/settings/backup',
        action: 'Back up now',
      });
    } else if (days > 2) {
      alerts.push({
        kind: 'backup',
        tone: days > 7 ? 'red' : 'amber',
        title: `Last backup was ${days} days ago`,
        message: `The last backup was taken on ${formatDate(last!.slice(0, 10))}. Take a backup so you do not lose recent bills.`,
        path: '/settings/backup',
        action: 'Back up now',
      });
    }
  }
  // Stock tracking: items running low or out of stock (for those who buy or look after items).
  if (can(ctx, 'stock.manage') || can(ctx, 'items.manage') || can(ctx, 'purchases.manage')) {
    const low = lowStockItems(ctx);
    if (low.length) {
      const out = low.filter((i) => i.status !== 'low');
      const names = low
        .slice(0, 3)
        .map((i) => `${i.name} (${formatQty(i.qty)} ${i.unit})`)
        .join(', ');
      alerts.push({
        kind: 'low_stock',
        tone: out.length ? 'red' : 'amber',
        title: out.length
          ? `${out.length} item${out.length === 1 ? ' is' : 's are'} out of stock${low.length > out.length ? `, ${low.length - out.length} running low` : ''}`
          : `${low.length} item${low.length === 1 ? ' is' : 's are'} running low`,
        message: `${names}${low.length > 3 ? ` and ${low.length - 3} more` : ''}. Order more, or do a stock count if the shelf does not match.`,
        path: '/stock?filter=low',
        action: 'See stock',
      });
    }
  }
  if (can(ctx, 'customers.view')) {
    const limits = ctx.db.all<{ id: number; name: string; credit_limit: number }>(
      'SELECT id, name, credit_limit FROM customers WHERE credit_limit IS NOT NULL AND credit_limit > 0',
    );
    if (limits.length) {
      const bal = partyNets(ctx, systemId(ctx, 'AR'), { to: t });
      const over = limits
        .map((c) => ({ ...c, balance: bal.get(c.id) ?? 0 }))
        .filter((c) => c.balance > c.credit_limit)
        .sort((a, b) => b.balance - b.credit_limit - (a.balance - a.credit_limit));
      if (over.length) {
        const names = over
          .slice(0, 3)
          .map((c) => `${c.name} (owes ${formatINR(c.balance)}, limit ${formatINR(c.credit_limit)})`)
          .join(', ');
        alerts.push({
          kind: 'credit_limit',
          tone: 'amber',
          title: over.length === 1 ? '1 customer is over their credit limit' : `${over.length} customers are over their credit limit`,
          message: `${names}${over.length > 3 ? ` and ${over.length - 3} more` : ''}.`,
          path: over.length === 1 ? `/customers/${over[0].id}` : '/customers/outstanding',
          action: over.length === 1 ? 'Open customer' : 'See outstanding',
        });
      }
    }
  }
  return alerts;
}

export function dashboardSummary(ctx: Ctx): DashboardSummary {
  const session = requireSession(ctx);
  const t = today(ctx);
  const fy = fyOf(t);
  const monthStart = startOfMonth(t);
  const seesBills = can(ctx, 'billing.create') || can(ctx, 'billing.view');
  const sales = can(ctx, 'reports.sales');
  const books = can(ctx, 'reports.financial') || can(ctx, 'accounts.view');
  const financial = can(ctx, 'reports.financial');

  let todaySales: DashboardSummary['todaySales'] = null;
  if (seesBills || sales) {
    const s = salesSummary(ctx, { from: t, to: t });
    todaySales = { bills: s.bills, netSales: s.netSales, billed: s.billed, returns: s.returns, byMode: { ...s.byMode } };
  }

  let month: DashboardSummary['month'] = null;
  let trend: DashboardSummary['trend'] = null;
  let topItems: DashboardSummary['topItems'] = null;
  if (sales) {
    const cur = salesSummary(ctx, { from: monthStart, to: t });
    const lastStart = addMonths(monthStart, -1);
    const last = salesSummary(ctx, { from: lastStart, to: endOfMonth(lastStart) });
    const sameDay = addMonths(t, -1);
    const lastToDate = salesSummary(ctx, { from: lastStart, to: sameDay < lastStart ? lastStart : sameDay });
    month = {
      thisMonth: cur.netSales,
      bills: cur.bills,
      lastMonth: last.netSales,
      lastMonthToDate: lastToDate.netSales,
      changePct: lastToDate.netSales ? Math.round(((cur.netSales - lastToDate.netSales) / Math.abs(lastToDate.netSales)) * 1000) / 10 : null,
    };
    const daily = dailyNetSales(ctx, { from: addDays(t, -29), to: t });
    trend = { dates: [...daily.keys()], values: [...daily.values()].map((a) => a.billed - a.returns) };
    topItems = itemSales(ctx, { from: monthStart, to: t })
      .filter((i) => i.amount > 0)
      .slice(0, 5)
      .map((i) => ({ name: i.name, itemId: i.itemId, qty: Math.round((i.qtySold - i.qtyReturned) * 1000) / 1000, unit: i.unit, amount: i.amount }));
  }

  const profit = financial
    ? { thisMonth: profitLossFigures(ctx, monthStart, t).netProfit, thisFy: profitLossFigures(ctx, fy.start, t).netProfit }
    : null;

  // Cash and bank balances (and the alert when one is below zero) for users who may see the books.
  const cashAccounts = books ? cashAccountBalances(ctx, t) : null;

  return {
    today: t,
    fyName: fy.name,
    user: { name: session.fullName, role: session.role },
    todaySales,
    month,
    balances: cashAccounts ? balancesFor(cashAccounts) : null,
    dues: books ? duesFor(ctx, t) : null,
    expensesThisMonth: books ? expensesBetween(ctx, monthStart, t) : null,
    profit,
    trend,
    topItems,
    recentBills: seesBills ? { bills: recentBills(ctx, !can(ctx, 'billing.view'), t), todayOnly: !can(ctx, 'billing.view') } : null,
    alerts: alertsFor(ctx, t, cashAccounts),
  };
}
