import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance, type TestApp } from './helpers';
import { Books, cashAndBank } from './reports-fixtures';
import { partyBalance, voidEntry } from '../src/core/accounting/ledger';
import { balanceSheet } from '../src/core/modules/reports/balanceSheet';
import { profitLoss, profitLossFigures } from '../src/core/modules/reports/profitLoss';
import { trialBalanceData } from '../src/core/modules/reports/trialBalance';
import { cashFlow } from '../src/core/modules/reports/cashFlow';
import { allocate, comparePeriod } from '../src/core/modules/reports/common';
import { cellText } from '../src/core/export/format';
import { formatDate } from '../src/shared/dates';
import { linkPath, periodFromParams, withPeriod } from '../src/renderer/links';
import type { ReportData } from '../src/shared/report';

const R = (rupees: number) => Math.round(rupees * 100);

/** Find a row by its first-column text (figure rows before group / section headings of the same name). */
function row(report: ReportData, label: string | RegExp) {
  const key = report.columns[0].key;
  const matches = report.rows.filter((x) => (typeof label === 'string' ? x.cells[key] === label : label.test(String(x.cells[key] ?? ''))));
  const r = matches.find((x) => x.style !== 'group' && x.style !== 'section') ?? matches[0];
  if (!r) throw new Error(`Row "${label}" not found in ${report.title}: ${report.rows.map((x) => x.cells[key]).join(' | ')}`);
  return r;
}
const rep0 = (r: { report: ReportData }) => r.report;
const hasRow = (report: ReportData, label: string | RegExp) => {
  try {
    row(report, label);
    return true;
  } catch {
    return false;
  }
};

/**
 * A small shop over two financial years:
 *  FY 2025-26 (closed): opening cash, customer / supplier opening balances, capital,
 *                       sales, a credit purchase, rent, a supplier payment.
 *  FY 2026-27 (current): loan taken and repaid with interest, furniture, cash-to-bank transfer,
 *                       cash / UPI / bank / credit / split bills with item and bill discounts and
 *                       round off, a cancelled bill, returns (refund and adjust), receipts with
 *                       discount, purchases (part paid), supplier payment with discount, supplier
 *                       advance, direct and indirect expenses (one on credit, one cancelled),
 *                       drawings, loan given and collected with interest, employee advance,
 *                       salary slip with recovery and part payment, capital, customer advance.
 */
async function dataset() {
  const t = await createTestApp({ booksStart: '2025-04-01', openingCash: R(50000) });
  const b = new Books(t);
  // ----- FY 2025-26 -----
  const anita = b.customer('Anita Desai', { phone: '98111 11111', opening: R(2000) });
  const ramesh = b.customer('Ramesh Kumar', { phone: '98222 22222', creditLimit: R(500) });
  const vikram = b.customer('Vikram Singh');
  const gupta = b.supplier('Gupta Traders', { opening: R(5000) });
  const mehta = b.supplier('Mehta Wholesale');
  const fixit = b.supplier('FixIt Services');
  b.capital('2025-04-05', R(100000), 'bank');
  b.bill({ date: '2025-06-10', lines: [{ item: 'Rice', qty: 20, rate: R(45) }, { item: 'Sugar', qty: 10, rate: R(40) }], payments: [{ mode: 'cash', amount: R(1300) }] });
  b.purchase('2025-08-15', gupta, R(20000), 0);
  b.expense('2025-09-01', 'Rent', R(5000), 'cash');
  b.bill({ date: '2026-01-20', customerId: anita, lines: [{ item: 'Oil', qty: 20, rate: R(150) }], payments: [] });
  b.payment('2026-03-10', gupta, R(10000), 'bank');
  const fy25 = profitLossFigures(t.app.ctx(), '2025-04-01', '2026-03-31');
  b.closeYear('2025-04-01');

  // ----- FY 2026-27 -----
  const hdfc = b.account('Loan - HDFC', 'loans', '2201');
  const suresh = b.account('Loan given - Suresh', 'loans_advances', '1402');
  const mohan = b.employee('Mohan');
  b.post('2026-04-02', 'loan', [{ account: 'BANK', debit: R(50000) }, { account: hdfc, credit: R(50000) }], 'Loan received');
  b.post('2026-04-03', 'purchase', [{ account: b.accountId('Furniture & Fixtures'), debit: R(15000) }, { account: 'BANK', credit: R(15000) }], 'Counter and shelves');
  b.transfer('2026-04-05', 'cash', 'bank', R(10000));
  const b1 = b.bill({
    date: '2026-05-10',
    lines: [
      { item: 'Rice', qty: 2, rate: R(52.5), unit: 'kg' },
      { item: 'Dal', qty: 1, rate: R(120), discount: R(5), unit: 'kg' },
    ],
    billDiscount: R(2.4),
    roundOff: true,
    payments: [{ mode: 'cash', amount: R(218) }],
  });
  const b2 = b.bill({
    date: '2026-06-15',
    customerId: anita,
    lines: [
      { item: 'Rice', qty: 10, rate: R(52.5), unit: 'kg' },
      { item: 'Oil', qty: 2, rate: R(180), unit: 'ltr' },
    ],
    billDiscount: R(10.7),
    roundOff: true,
    payments: [{ mode: 'upi', amount: R(500) }],
  });
  const b3 = b.bill({ date: '2026-07-20', customerId: ramesh, lines: [{ item: 'Oil', qty: 5, rate: R(180), unit: 'ltr' }], payments: [] });
  const b4 = b.bill({ date: '2026-08-05', lines: [{ item: 'Tea', qty: 20, rate: R(15) }], payments: [{ mode: 'bank', amount: R(300) }] });
  const b5 = b.bill({ date: '2026-09-28', lines: [{ item: 'Samosa', qty: 10, rate: R(20) }], payments: [{ mode: 'cash', amount: R(200) }] });
  const b6 = b.bill({
    date: '2026-09-28',
    customerId: anita,
    lines: [{ item: 'Tea', qty: 10, rate: R(15) }],
    payments: [
      { mode: 'cash', amount: R(100) },
      { mode: 'upi', amount: R(50) },
    ],
  });
  const b7 = b.bill({ date: '2026-09-10', lines: [{ item: 'Oil', qty: 1, rate: R(180) }], payments: [{ mode: 'cash', amount: R(180) }], cancel: true });
  const r1 = b.creditNote({ date: '2026-06-20', billId: b2.id, lines: [{ item: 'Oil', qty: 1, rate: R(180) }], refund: 'credit' });
  const r2 = b.creditNote({ date: '2026-09-28', billId: b5.id, lines: [{ item: 'Samosa', qty: 2, rate: R(20) }], refund: 'cash' });
  b.receipt('2026-07-01', anita, R(3000), 'cash', R(20));
  b.purchase('2026-05-01', gupta, R(8000), R(3000), 'cash');
  b.payment('2026-06-01', gupta, R(10000), 'bank', R(200));
  b.payment('2026-09-01', mehta, R(1000), 'cash'); // advance to a supplier
  b.expense('2026-05-01', 'Freight Inward', R(500), 'cash');
  b.expense('2026-06-05', 'Electricity', R(1200), 'upi');
  b.expense('2026-07-01', 'Rent', R(5000), 'bank');
  b.expense('2026-09-15', 'Tea & Refreshments', R(300), 'cash');
  b.expense('2026-08-10', 'Repairs & Maintenance', R(700), { supplierId: fixit });
  const cancelledExpense = b.expense('2026-08-12', 'Advertisement', R(2500), 'cash');
  voidEntry(t.app.ctx(), cancelledExpense, 'Entered twice');
  b.drawings('2026-08-01', R(2000), 'cash');
  b.post('2026-09-02', 'loan', [{ account: hdfc, debit: R(5000) }, { account: 'INTEREST_EXPENSE', debit: R(450) }, { account: 'BANK', credit: R(5450) }], 'EMI');
  b.post('2026-06-10', 'loan', [{ account: suresh, debit: R(3000) }, { account: 'CASH', credit: R(3000) }], 'Loan given');
  b.post('2026-09-05', 'loan', [{ account: 'CASH', debit: R(1050) }, { account: suresh, credit: R(1000) }, { account: 'INTEREST_INCOME', credit: R(50) }], 'Loan part repaid');
  b.post('2026-07-05', 'advance', [{ account: 'EMP_ADV', debit: R(1000), partyType: 'employee', partyId: mohan }, { account: 'CASH', credit: R(1000) }], 'Advance');
  b.post(
    '2026-08-31',
    'salary',
    [
      { account: 'SALARY', debit: R(10000) },
      { account: 'EMP_ADV', credit: R(500), partyType: 'employee', partyId: mohan },
      { account: 'SALARY_PAYABLE', credit: R(9500), partyType: 'employee', partyId: mohan },
    ],
    'Salary Aug 2026',
  );
  b.post('2026-09-01', 'salary_payment', [{ account: 'SALARY_PAYABLE', debit: R(6000), partyType: 'employee', partyId: mohan }, { account: 'CASH', credit: R(6000) }], 'Salary paid');
  b.capital('2026-09-20', R(5000), 'cash');
  b.post('2026-09-25', 'receipt', [{ account: 'UPI', debit: R(1500) }, { account: 'AR', credit: R(1500), partyType: 'customer', partyId: vikram }], 'Advance for order');
  return { t, b, anita, ramesh, vikram, gupta, mehta, fixit, hdfc, suresh, mohan, b1, b2, b3, b4, b5, b6, b7, r1, r2, fy25 };
}

describe('trial balance', () => {
  it('balances and follows the contract', async () => {
    const { t } = await dataset();
    const tb = await t.call('reports.trialBalance', { to: '2026-09-28' });
    expect(tb.title).toBe('Trial Balance');
    const total = row(tb, 'Total').cells;
    expect(total.closingDr).toBe(total.closingCr);
    expect(total.openingDr).toBe(total.openingCr);
    expect(total.debit).toBe(total.credit);
    expect(hasRow(tb, /Difference/)).toBe(false);
    // Balance-sheet accounts carry forward, P&L accounts start at zero on 1 April.
    const cash = row(tb, 'Cash in Hand').cells;
    expect((cash.closingDr as number) ?? 0).toBe(systemBalance(t.app, 'CASH', '2026-09-28'));
    const sales = row(tb, 'Sales').cells;
    expect(sales.openingCr).toBeNull();
    expect(sales.closingCr).toBe(R(225 + 885 + 900 + 300 + 200 + 150)); // gross of the active FY 2026-27 bills
    // The closed year's result went to capital: no "previous years" line.
    expect(hasRow(tb, 'Profit & loss (previous years)')).toBe(false);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('defaults "from" to the FY start, supports a mid-year start and party detail', async () => {
    const { t, anita } = await dataset();
    const full = trialBalanceData(t.app.ctx(), { to: '2026-09-28' });
    const mid = trialBalanceData(t.app.ctx(), { from: '2026-07-01', to: '2026-09-28', partyDetail: true });
    // Same closing whatever the start date.
    expect(mid.totals.closingDebit).toBe(full.totals.closingDebit);
    expect(mid.totals.difference).toBe(0);
    expect(mid.totals.openingDebit).toBe(mid.totals.openingCredit);
    // Sales opening on 1 July = sales of April - June.
    const salesOpen = row(mid.report, 'Sales').cells.openingCr as number;
    expect(salesOpen).toBe(R(225 + 885));
    // Party lines under Sundry Debtors, linked to the customer.
    const anitaRow = row(mid.report, 'Anita Desai');
    expect(anitaRow.link).toEqual({ kind: 'customer', id: anita });
    expect(anitaRow.cells.closingDr).toBe(partyBalance(t.app.ctx(), 'customer', anita, { to: '2026-09-28' }));
    expect(row(mid.report, 'Vikram Singh').cells.closingCr).toBe(R(1500));
  });

  it('shows the closed year before its closing entry, and unclosed years as one line', async () => {
    const { t, fy25 } = await dataset();
    const endOfYear = trialBalanceData(t.app.ctx(), { to: '2026-03-31' });
    expect(endOfYear.totals.difference).toBe(0);
    expect(row(endOfYear.report, 'Sales').cells.closingCr).toBe(R(1300 + 3000));
    expect(row(endOfYear.report, 'Rent').cells.closingDr).toBe(R(5000));
    expect(fy25.netProfit).toBe(R(4300 - 20000 - 5000));

    // A second business that never closed its first year.
    const u = await createTestApp({ booksStart: '2025-04-01', openingCash: R(1000) });
    const ub = new Books(u);
    ub.bill({ date: '2025-10-01', lines: [{ item: 'Tea', qty: 100, rate: R(10) }], payments: [{ mode: 'cash', amount: R(1000) }] });
    ub.bill({ date: '2026-05-01', lines: [{ item: 'Tea', qty: 10, rate: R(10) }], payments: [{ mode: 'cash', amount: R(100) }] });
    const tb = trialBalanceData(u.app.ctx(), { to: '2026-09-28' });
    expect(tb.totals.difference).toBe(0);
    expect(row(tb.report, 'Profit & loss (previous years)').cells.openingCr).toBe(R(1000));
    expect(row(tb.report, 'Sales').cells.closingCr).toBe(R(100));
    expect(ledgerProblems(u.app)).toEqual([]);
  });

  it('rejects a reversed range', async () => {
    const t = await createTestApp();
    const err = await t.fails('reports.trialBalance', { from: '2026-09-01', to: '2026-08-01' });
    expect(err.code).toBe('VALIDATION');
  });
});

describe('balance sheet', () => {
  it('balances on every date: before any entry, mid-year, FY end, after closing, today', async () => {
    const { t } = await dataset();
    for (const asOf of ['2025-03-31', '2025-04-01', '2025-09-30', '2026-03-31', '2026-04-01', '2026-06-30', '2026-09-28', '2027-03-31']) {
      const bs = balanceSheet(t.app.ctx(), { asOf });
      expect(bs.totals.difference, asOf).toBe(0);
      expect(bs.totals.balanced).toBe(true);
      expect(hasRow(bs.report, /Difference/)).toBe(false);
    }
    const before = balanceSheet(t.app.ctx(), { asOf: '2025-03-31' });
    expect(before.totals.assets).toBe(0);
  });

  it('agrees with the P&L and shows closed / unclosed years correctly', async () => {
    const { t, fy25 } = await dataset();
    const ctx = t.app.ctx();
    for (const asOf of ['2026-05-31', '2026-09-28']) {
      const bs = balanceSheet(ctx, { asOf });
      expect(bs.profit.currentYear).toBe(profitLossFigures(ctx, '2026-04-01', asOf).netProfit);
      expect(bs.profit.previousYears).toBe(0);
    }
    // On the last day of the closed year the closing entry is left out: the year's result is "current year".
    const fyEnd = balanceSheet(ctx, { asOf: '2026-03-31' });
    expect(fyEnd.profit.currentYear).toBe(fy25.netProfit);
    expect(row(fyEnd.report, /Profit & loss \(current year/).cells.amount).toBe(fy25.netProfit);
    // Next day the loss has moved into capital.
    const after = balanceSheet(ctx, { asOf: '2026-04-01' });
    expect(after.profit.currentYear).toBe(0);
    expect(after.figures.capital).toBe(R(50000 + 2000 - 5000) + R(100000) + fy25.netProfit);
  });

  it('splits parties by side, lists loans, advances and assets', async () => {
    const { t, ramesh, anita } = await dataset();
    const ctx = t.app.ctx();
    const bs = balanceSheet(ctx, { asOf: '2026-09-28' });
    const f = bs.figures;
    const anitaBal = partyBalance(ctx, 'customer', anita);
    const rameshBal = partyBalance(ctx, 'customer', ramesh);
    expect(f.debtors).toBe(anitaBal + rameshBal);
    expect(f.customerAdvances).toBe(R(1500));
    expect(f.supplierAdvances).toBe(R(1000));
    // Gupta: opening 5000 + 20000 - 10000 + 5000 - 10200 = 9800; FixIt 700.
    expect(f.creditors).toBe(R(9800 + 700));
    expect(f.loans).toBe(R(45000));
    expect(f.fixedAssets).toBe(R(15000));
    expect(f.cash).toBe(systemBalance(t.app, 'CASH'));
    expect(f.bank).toBe(systemBalance(t.app, 'BANK') + systemBalance(t.app, 'UPI'));
    expect(f.loansAdvances).toBe(R(2000 + 500)); // Suresh 2000 + Mohan's advance 500
    expect(f.currentLiabilities).toBe(R(3500)); // salary still payable
    expect(f.drawings).toBe(R(2000));
    expect(row(bs.report, /^Sundry debtors \(2 customers\)/).cells.total).toBe(f.debtors);
    expect(row(bs.report, /^Advances from customers \(1 customer\)/).cells.total).toBe(R(1500));
    expect(row(bs.report, 'Less: Drawings').cells.amount).toBe(-R(2000));
    expect(bs.report.summary?.find((s) => s.label === 'Status')?.value).toBe('Balanced');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('shows earlier unclosed years as their own capital line', async () => {
    const t = await createTestApp({ booksStart: '2025-04-01' });
    const b = new Books(t);
    b.capital('2025-04-01', R(10000), 'cash');
    b.bill({ date: '2025-12-01', lines: [{ item: 'Tea', qty: 100, rate: R(10) }], payments: [{ mode: 'cash', amount: R(1000) }] });
    b.expense('2026-05-01', 'Rent', R(300), 'cash');
    const before = balanceSheet(t.app.ctx(), { asOf: '2026-06-30' });
    expect(before.totals.balanced).toBe(true);
    expect(before.profit.previousYears).toBe(R(1000));
    expect(before.profit.currentYear).toBe(-R(300));
    expect(row(before.report, /previous years, not closed/).cells.amount).toBe(R(1000));
    b.closeYear('2025-04-01');
    const after = balanceSheet(t.app.ctx(), { asOf: '2026-06-30' });
    expect(after.totals.balanced).toBe(true);
    expect(after.profit.previousYears).toBe(0);
    expect(after.figures.capital).toBe(R(11000));
    expect(after.totals.assets).toBe(before.totals.assets);
  });
});

describe('profit & loss', () => {
  it('builds the trading and P&L account from the ledger', async () => {
    const { t } = await dataset();
    const res = await t.call('reports.profitLoss', { from: '2026-04-01', to: '2026-09-28' });
    const f = res.figures;
    expect(f.sales).toBe(R(225 + 885 + 900 + 300 + 200 + 150));
    expect(f.salesReturns).toBe(R(180 + 40));
    expect(f.netSales).toBe(f.sales - f.salesReturns);
    expect(f.purchases).toBe(R(8000));
    expect(f.directExpenses).toBe(R(500));
    expect(f.grossProfit).toBe(f.netSales - R(8500));
    expect(f.otherIncome).toBe(R(200 + 50));
    // discount allowed 7.40 + 10.70 + 20 ; round off 0.30 - 0.40 (net credit) ; electricity, rent, tea, repairs, salary, interest
    expect(f.indirectExpenses).toBe(R(7.4 + 10.7 + 20) - R(0.1) + R(1200 + 5000 + 300 + 700 + 10000 + 450));
    expect(row(rep0(res), 'Round Off').cells.amount).toBe(-R(0.1));
    expect(f.netProfit).toBe(f.grossProfit + f.otherIncome - f.indirectExpenses);
    expect(f.totalExpenses).toBe(f.purchases + f.directExpenses + f.indirectExpenses);
    const rep = rep0(res);
    expect(row(rep, 'Less: Sales returns').cells.amount).toBe(R(220));
    expect(row(rep, 'Freight Inward').cells.amount).toBe(R(500));
    // The cancelled advertisement expense is ignored; zero accounts are hidden.
    expect(hasRow(rep, 'Advertisement')).toBe(false);
    expect(hasRow(rep, 'Telephone & Internet')).toBe(false);
    // Indirect expenses largest first.
    const start = rep.rows.findIndex((r) => r.cells.particulars === 'Less: Indirect expenses');
    const amounts = rep.rows.slice(start + 1).filter((r) => r.indent === 1).map((r) => r.cells.amount as number);
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    expect(row(rep, f.netProfit >= 0 ? 'Net profit' : 'Net loss').cells.amount).toBe(Math.abs(f.netProfit));
    expect(rep.notes?.[0]).toMatch(/Stock is not tracked/);
    // "Purchases & expenses": this total includes purchases, unlike the Expenses page's "Total expenses".
    expect(rep.summary?.map((s) => s.label)).toEqual(['Net sales', f.grossProfit >= 0 ? 'Gross profit' : 'Gross loss', 'Purchases & expenses', f.netProfit >= 0 ? 'Net profit' : 'Net loss', 'Net margin']);
  });

  it('excludes closing entries and compares with the previous period / year', async () => {
    const { t, fy25 } = await dataset();
    const ctx = t.app.ctx();
    // Closing entry is dated 31-03-2026; the P&L of FY 2025-26 still shows the year's figures.
    expect(profitLossFigures(ctx, '2025-04-01', '2026-03-31').netProfit).toBe(fy25.netProfit);
    const sep = profitLoss(ctx, { from: '2026-09-01', to: '2026-09-30', compare: 'previous_period' });
    const aug = profitLossFigures(ctx, '2026-08-01', '2026-08-31');
    expect(sep.compare?.netProfit).toBe(aug.netProfit);
    expect(sep.report.columns.map((c) => c.label)).toEqual(['Particulars', 'Sep 2026', 'Aug 2026', 'Change', 'Change %']);
    const net = row(sep.report, 'Net profit / (net loss)').cells;
    expect(net.amount).toBe(sep.figures.netProfit);
    expect(net.compare).toBe(aug.netProfit);
    expect(net.change).toBe(sep.figures.netProfit - aug.netProfit);
    const yoy = profitLoss(ctx, { from: '2026-04-01', to: '2026-09-28', compare: 'previous_year' });
    expect(yoy.compare?.from).toBe('2025-04-01');
    expect(yoy.compare?.to).toBe('2025-09-28');
    expect(yoy.compare?.sales).toBe(R(1300));
  });

  it('works out comparison periods', () => {
    expect(comparePeriod('2026-09-01', '2026-09-28', 'previous_period')).toEqual({ from: '2026-08-01', to: '2026-08-28' });
    expect(comparePeriod('2026-09-01', '2026-09-30', 'previous_period')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(comparePeriod('2026-07-01', '2026-09-30', 'previous_period')).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(comparePeriod('2026-09-10', '2026-09-19', 'previous_period')).toEqual({ from: '2026-08-31', to: '2026-09-09' });
    expect(comparePeriod('2024-02-01', '2024-02-29', 'previous_year')).toEqual({ from: '2023-02-01', to: '2023-02-28' });
    expect(comparePeriod('2026-04-01', '2027-03-31', 'previous_year')).toEqual({ from: '2025-04-01', to: '2026-03-31' });
  });

  it('handles an empty period', async () => {
    const t = await createTestApp();
    const res = await t.call('reports.profitLoss', { from: '2026-04-01', to: '2026-04-30' });
    expect(res.figures.netProfit).toBe(0);
    expect(res.figures.netMargin).toBeNull();
    expect(row(res.report, 'Net profit').cells.amount).toBe(0);
  });
});

describe('cash flow', () => {
  it('classifies every movement and ends at the actual cash + bank balance', async () => {
    const { t } = await dataset();
    const { figures: f, report } = cashFlow(t.app.ctx(), { from: '2026-04-01', to: '2026-09-28' });
    expect(f.opening).toBe(cashAndBank(t, '2026-03-31'));
    expect(f.closing).toBe(cashAndBank(t, '2026-09-28'));
    expect(f.balanced).toBe(true);
    const L = f.lines;
    expect(L.sales).toEqual({ in: R(218 + 500 + 300 + 200 + 150), out: 0 });
    expect(L.customers).toEqual({ in: R(3000 + 1500), out: 0 });
    expect(L.refunds).toEqual({ in: 0, out: R(40) });
    expect(L.suppliers).toEqual({ in: 0, out: R(10000 + 1000) });
    expect(L.purchases).toEqual({ in: 0, out: R(3000) });
    expect(L.expenses).toEqual({ in: 0, out: R(500 + 1200 + 5000 + 300) });
    expect(L.salaries).toEqual({ in: 0, out: R(6000) });
    expect(L.emp_adv).toEqual({ in: 0, out: R(1000) });
    expect(L.fixed_assets).toEqual({ in: 0, out: R(15000) });
    expect(L.loans_given).toEqual({ in: R(1000), out: R(3000) });
    expect(L.interest_received).toEqual({ in: R(50), out: 0 });
    expect(L.capital).toEqual({ in: R(5000), out: 0 });
    expect(L.drawings).toEqual({ in: 0, out: R(2000) });
    expect(L.loans_taken).toEqual({ in: R(50000), out: R(5000) });
    expect(L.interest_paid).toEqual({ in: 0, out: R(450) });
    expect(L.other).toEqual({ in: 0, out: 0 });
    expect(f.operating + f.investing + f.financing).toBe(f.netChange);
    expect(f.financing).toBe(R(50000 - 5000 - 450 + 5000 - 2000));
    // The cash-to-bank transfer is not money in or out.
    expect(f.inflow - f.outflow).toBe(f.closing - f.opening);
    expect(row(report, /^Closing cash & bank balance/).cells.net).toBe(f.closing);
    expect(row(report, 'Cash in Hand').cells.net).toBe(systemBalance(t.app, 'CASH', '2026-09-28'));
  });

  it('counts opening balances as opening, and agrees on any range', async () => {
    const { t } = await dataset();
    const first = cashFlow(t.app.ctx(), { from: '2025-04-01', to: '2026-03-31' });
    expect(first.figures.opening).toBe(R(50000)); // opening cash entry dated the books start
    expect(first.figures.lines.capital.in).toBe(R(100000));
    expect(first.figures.closing).toBe(cashAndBank(t, '2026-03-31'));
    for (const [from, to] of [
      ['2026-06-01', '2026-06-30'],
      ['2026-09-28', '2026-09-28'],
      ['2025-01-01', '2027-03-31'],
    ]) {
      const cf = cashFlow(t.app.ctx(), { from, to });
      expect(cf.figures.balanced, `${from}..${to}`).toBe(true);
      expect(cf.figures.closing).toBe(cashAndBank(t, to));
    }
  });

  it('splits one payment across several other-side accounts exactly', () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocate(-545000, [500000, 45000])).toEqual([-500000, -45000]);
    expect(allocate(101, [50, 50]).reduce((s, v) => s + v, 0)).toBe(101);
    expect(allocate(0, [0])).toEqual([0]);
  });
});

describe('sales insights', () => {
  it('reconciles with the bills: cancelled excluded, returns netted, round off and discounts', async () => {
    const { t } = await dataset();
    const s = await t.call('reports.salesSummary', { from: '2026-04-01', to: '2026-09-28' });
    expect(s.bills).toBe(6);
    expect(s.grossSales).toBe(R(225 + 885 + 900 + 300 + 200 + 150));
    expect(s.discounts).toBe(R(7.4 + 10.7));
    expect(s.roundOff).toBe(R(0.4 - 0.3));
    expect(s.billed).toBe(R(218 + 874 + 900 + 300 + 200 + 150));
    expect(s.returns).toBe(R(220));
    expect(s.netSales).toBe(s.billed - s.returns);
    expect(s.averageBill).toBe(Math.round(s.billed / 6));
    expect(s.cancelledBills).toBe(1);
    expect(s.cancelledAmount).toBe(R(180));
    // Same as the ledger: sales - returns - discounts + round off.
    const pl = profitLossFigures(t.app.ctx(), '2026-04-01', '2026-09-28');
    expect(s.netSales).toBe(pl.netSales - R(7.4 + 10.7) + R(0.1));
  });

  it('splits by payment mode', async () => {
    const { t } = await dataset();
    const res = await t.call('reports.salesByPaymentMode', { from: '2026-04-01', to: '2026-09-28' });
    const cells = (label: string) => row(res.report, label).cells;
    expect(cells('Cash')).toMatchObject({ amount: R(218 + 200 + 100), bills: 3, refunds: R(40) });
    expect(cells('UPI')).toMatchObject({ amount: R(500 + 50), bills: 2 });
    expect(cells('Bank')).toMatchObject({ amount: R(300), bills: 1 });
    expect(cells('Credit (on account)')).toMatchObject({ amount: R(374 + 900), bills: 2, refunds: R(180) });
    const total = cells('Total');
    expect(total.amount).toBe(R(218 + 874 + 900 + 300 + 200 + 150));
    expect(total.bills).toBe(6);
    expect(total.share).toBe(100);
    expect(res.chart.labels).toEqual(['Cash', 'UPI', 'Bank', 'Credit']);
    expect(res.chart.series[0].values.reduce((a, v) => a + v, 0)).toBe(total.amount);
  });

  it('groups by day and month with date filters', async () => {
    const { t } = await dataset();
    const day = await t.call('reports.salesByDay', { from: '2026-09-01', to: '2026-09-30' });
    expect(day.report.rows.length).toBe(31); // 30 days + total
    expect(day.chart.labels[27]).toBe('28 Sep');
    const d28 = day.report.rows.find((r) => r.cells.date === '2026-09-28')!.cells;
    expect(d28).toMatchObject({ bills: 2, gross: R(350), returns: R(40), net: R(310), day: 'Mon' });
    // 10 September only had a cancelled bill.
    expect(day.report.rows.find((r) => r.cells.date === '2026-09-10')!.cells.bills).toBe(0);
    expect(row(day.report, 'Total').cells.net).toBe(R(310));
    const one = await t.call('reports.salesByDay', { from: '2026-09-28', to: '2026-09-28' });
    expect(one.chart.series[0].values).toEqual([R(310)]);

    const month = await t.call('reports.salesByMonth', { from: '2026-04-01', to: '2026-09-28' });
    expect(month.chart.labels).toEqual(['Apr 2026', 'May 2026', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026']);
    expect(month.chart.series[0].values).toEqual([0, R(218), R(874 - 180), R(900), R(300), R(310)]);
    expect(row(month.report, 'Total').cells.net).toBe(R(218 + 694 + 900 + 300 + 310));
    expect(row(month.report, 'July 2026').cells.change).toBeCloseTo(((900 - 694) / 694) * 100, 0);
    const err = await t.fails('reports.salesByDay', { from: '2020-01-01', to: '2026-09-28' });
    expect(err.message).toMatch(/month-wise/);
  });

  it('groups by item (with returns and typed-in items) and by customer (walk-ins together)', async () => {
    const { t, anita, ramesh } = await dataset();
    const b = new Books(t);
    b.bill({ date: '2026-09-27', lines: [{ item: 'Loose Biscuits', qty: 2, rate: R(10), adHoc: true }], payments: [{ mode: 'cash', amount: R(20) }] });
    b.bill({ date: '2026-09-27', lines: [{ item: 'loose biscuits ', qty: 1, rate: R(10), adHoc: true }], payments: [{ mode: 'cash', amount: R(10) }] });
    const items = await t.call('reports.salesByItem', { from: '2026-04-01', to: '2026-09-28' });
    const oil = row(items.report, 'Oil').cells;
    expect(oil).toMatchObject({ qtySold: 7, qtyReturned: 1, netQty: 6, amount: R(1260 - 180), bills: 2 });
    expect(row(items.report, 'Rice').cells).toMatchObject({ qtySold: 12, amount: R(630) });
    expect(row(items.report, 'Dal').cells.amount).toBe(R(115)); // after item discount
    expect(row(items.report, 'Loose Biscuits').cells).toMatchObject({ qtySold: 3, amount: R(30) });
    expect(items.chart.labels[0]).toBe('Oil'); // largest first
    const totalRow = row(items.report, /^Total \(/).cells;
    expect(totalRow.amount).toBe(R(1080 + 630 + 115 + 450 + 160 + 30));
    const shares = items.report.rows.filter((r) => r.style !== 'total').reduce((s, r) => s + (r.cells.share as number), 0);
    expect(shares).toBeGreaterThan(99.5);

    const cust = await t.call('reports.salesByCustomer', { from: '2026-04-01', to: '2026-09-28' });
    const a = row(cust.report, 'Anita Desai');
    expect(a.link).toEqual({ kind: 'customer', id: anita });
    expect(a.cells).toMatchObject({ bills: 2, returns: R(180), net: R(874 + 150 - 180), credit: R(374) });
    expect(row(cust.report, 'Ramesh Kumar').cells).toMatchObject({ net: R(900), credit: R(900) });
    expect(row(cust.report, 'Walk-in customers').cells).toMatchObject({ bills: 5, returns: R(40), net: R(218 + 300 + 200 + 30 - 40) });
    expect(row(cust.report, /^Total/).cells.net).toBe(R(874 + 150 - 180 + 900 + 218 + 300 + 200 + 30 - 40));
    expect(cust.chart.labels).toContain('Walk-in customers');
    void ramesh;
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('leaves out cancelled returns', async () => {
    const t = await createTestApp();
    const b = new Books(t);
    const bill = b.bill({ date: '2026-09-01', lines: [{ item: 'Tea', qty: 10, rate: R(10) }], payments: [{ mode: 'cash', amount: R(100) }] });
    b.creditNote({ date: '2026-09-02', billId: bill.id, lines: [{ item: 'Tea', qty: 2, rate: R(10) }], refund: 'cash', cancel: true });
    const s = await t.call('reports.salesSummary', { from: '2026-09-01', to: '2026-09-30' });
    // A period with nothing in it has no rows (the screen shows "No sales in this period").
    expect((await t.call('reports.salesByDay', { from: '2026-08-01', to: '2026-08-31' })).report.rows).toEqual([]);
    expect((await t.call('reports.salesByMonth', { from: '2026-06-01', to: '2026-08-31' })).report.rows).toEqual([]);
    expect(s.returns).toBe(0);
    expect(s.netSales).toBe(R(100));
    expect(profitLossFigures(t.app.ctx(), '2026-09-01', '2026-09-30').salesReturns).toBe(0);
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('same words, same figures', () => {
  it('prints the Sales by day total row as "Total" on screen, in CSV, PDF and print (not "undefined-undefined-Total")', async () => {
    const { t } = await dataset();
    const range = { from: '2026-09-01', to: '2026-09-28' };
    const day = (await t.call('reports.salesByDay', range)).report;
    const total = day.rows[day.rows.length - 1];
    expect(total.style).toBe('total');
    const dateCol = day.columns.find((c) => c.key === 'date')!;
    // The screen (formatCell -> formatDate) and CSV / PDF / print (cellText) show the label as it is.
    expect(formatDate(total.cells.date as string)).toBe('Total');
    expect(cellText(dateCol, total.cells.date ?? null)).toBe('Total');
    expect(formatDate('2026-09-28')).toBe('28-09-2026');
    expect(formatDate('2026-09-28 14:05:00')).toBe('28-09-2026');
    for (const format of ['csv', 'pdf'] as const) await t.call('files.exportReport', { report: day, format });
    await t.call('files.printReport', { report: day });
    const csv = String(t.platform.saved.find((f) => f.name.endsWith('.csv'))!.data);
    const pdf = t.platform.saved.find((f) => f.name.endsWith('.pdf'))!.data;
    const printed = t.platform.printed[t.platform.printed.length - 1].html;
    expect(csv).toMatch(/\nTotal,/);
    for (const text of [csv, typeof pdf === 'string' ? pdf : Buffer.from(pdf).toString('latin1'), printed]) expect(text).not.toContain('undefined');
    expect(printed).toContain('>Total<');
  });

  it('calls bill totals less returns "Net sales after discounts" and explains how the P&L "Net sales" differs', async () => {
    const { t } = await dataset();
    const range = { from: '2026-04-01', to: '2026-09-28' };
    const pl = await t.call('reports.profitLoss', range);
    const s = await t.call('reports.salesSummary', range);
    // Same data, two different figures: they must not share a name.
    expect(pl.figures.netSales).not.toBe(s.netSales);
    expect(pl.report.summary?.[0]).toMatchObject({ label: 'Net sales', value: pl.figures.netSales });
    expect(pl.report.notes?.some((n) => /Net sales = sales - sales returns/.test(n) && /Net sales after discounts/.test(n))).toBe(true);
    for (const route of ['reports.salesByDay', 'reports.salesByMonth', 'reports.salesByCustomer'] as const) {
      const r = await t.call(route, range);
      expect(r.report.summary?.[0], route).toMatchObject({ label: 'Net sales after discounts', value: s.netSales });
      expect(r.report.columns.find((c) => c.key === 'net')?.label, route).toBe('Net sales after discounts');
      expect(r.report.columns.some((c) => c.label === 'Net sales'), route).toBe(false);
      expect(r.report.notes?.[0], route).toMatch(/Profit & loss "Net sales" is sales less returns/);
      expect(r.chart.series[0].name, route).toBe('Net sales after discounts');
    }
    const items = await t.call('reports.salesByItem', range);
    expect(items.report.summary?.map((x) => x.label)).toContain('Net sales after discounts (all bills)');
    // No discounts or round off in the period: no need for the note.
    const plain = await createTestApp();
    new Books(plain).bill({ date: '2026-09-01', lines: [{ item: 'Tea', qty: 10, rate: R(10) }], payments: [{ mode: 'cash', amount: R(100) }] });
    const plainPl = await plain.call('reports.profitLoss', { from: '2026-09-01', to: '2026-09-30' });
    expect(plainPl.report.notes?.some((n) => /Net sales after discounts/.test(n))).toBe(false);
    expect(plainPl.figures.netSales).toBe((await plain.call('reports.salesSummary', { from: '2026-09-01', to: '2026-09-30' })).netSales);
  });

  it('drill-down links carry the report period to ledgers and party accounts, and pages read it back', () => {
    const sep = { from: '2026-09-01', to: '2026-09-28', preset: 'this_month' as const };
    expect(linkPath({ kind: 'account', id: 7 }, sep)).toBe('/accounts/ledger?account=7&from=2026-09-01&to=2026-09-28&preset=this_month');
    expect(linkPath({ kind: 'customer', id: 3 }, { from: '2026-04-01', to: '2026-06-30' })).toBe('/customers/3?from=2026-04-01&to=2026-06-30');
    expect(linkPath({ kind: 'supplier', id: 4 }, sep)).toMatch(/^\/suppliers\/4\?from=2026-09-01&to=2026-09-28/);
    expect(linkPath({ kind: 'employee', id: 5 }, sep)).toMatch(/^\/employees\/5\?from=/);
    // Documents are not periods; links without a period are unchanged.
    expect(linkPath({ kind: 'bill', id: 9 }, sep)).toBe('/sales/bills/9');
    expect(linkPath({ kind: 'account', id: 7 })).toBe('/accounts/ledger?account=7');
    expect(withPeriod('/reports/sales?tab=day', { from: '2026-09-28', to: '2026-09-28', preset: 'today' })).toBe('/reports/sales?tab=day&from=2026-09-28&to=2026-09-28&preset=today');
    expect(withPeriod('/accounts/cash-book', { from: '2026-09-01', to: '2026-09-28', preset: 'custom' })).toBe('/accounts/cash-book?from=2026-09-01&to=2026-09-28');

    const read = (q: string) => periodFromParams(new URLSearchParams(q), '2026-09-28');
    // The preset is kept while it gives the same dates; otherwise the dates are a custom range.
    expect(read('account=7&from=2026-09-01&to=2026-09-28&preset=this_month')).toEqual({ preset: 'this_month', from: '2026-09-01', to: '2026-09-28' });
    expect(periodFromParams(new URLSearchParams('from=2026-09-01&to=2026-09-28&preset=this_month'), '2026-10-02')).toEqual({ preset: 'custom', from: '2026-09-01', to: '2026-09-28' });
    expect(read('from=2026-08-01&to=2026-08-31')).toEqual({ preset: 'custom', from: '2026-08-01', to: '2026-08-31' });
    expect(read('preset=this_fy')).toEqual({ preset: 'this_fy', from: '2026-04-01', to: '2026-09-28' });
    // Nothing (or nonsense) in the address: the page uses its remembered period.
    expect(read('account=7')).toBeNull();
    expect(read('from=2026-09-30&to=2026-09-01')).toBeNull();
    expect(read('from=2026-02-30&to=2026-03-01')).toBeNull();
    expect(read('from=yesterday&to=2026-09-01')).toBeNull();
    expect(read('preset=__proto__')).toBeNull();
    // Round trip: what a report row puts in the address is what the ledger reads.
    const path = linkPath({ kind: 'account', id: 7 }, { from: '2026-08-01', to: '2026-08-31', preset: 'last_month' });
    expect(read(path.split('?')[1])).toEqual({ preset: 'last_month', from: '2026-08-01', to: '2026-08-31' });
  });
});

describe('ageing', () => {
  async function ageingData(t: TestApp) {
    const b = new Books(t);
    const x = b.customer('Xavier', { opening: R(1000) }); // dated 01-04-2026
    b.bill({ date: '2026-05-15', customerId: x, lines: [{ item: 'Rice', qty: 1, rate: R(3000) }], payments: [] });
    b.bill({ date: '2026-07-10', customerId: x, lines: [{ item: 'Rice', qty: 1, rate: R(2000) }], payments: [] });
    b.receipt('2026-08-01', x, R(3500), 'cash');
    b.bill({ date: '2026-09-01', customerId: x, lines: [{ item: 'Rice', qty: 1, rate: R(1500) }], payments: [] });
    b.creditNote({ date: '2026-09-10', customerId: x, amount: R(500), refund: 'credit' });
    const y = b.customer('Yamini');
    b.bill({ date: '2026-06-01', customerId: y, lines: [{ item: 'Rice', qty: 1, rate: R(1000) }], payments: [] });
    b.receipt('2026-06-20', y, R(400), 'upi');
    const z = b.customer('Zoya');
    b.receipt('2026-09-01', z, R(800), 'cash'); // advance
    const cleared = b.customer('Cleared Customer');
    b.bill({ date: '2026-05-01', customerId: cleared, lines: [{ item: 'Rice', qty: 1, rate: R(100) }], payments: [] });
    b.receipt('2026-05-02', cleared, R(100), 'cash');
    // A cancelled bill and a future bill never count.
    b.bill({ date: '2026-09-20', customerId: y, lines: [{ item: 'Rice', qty: 1, rate: R(999) }], payments: [], cancel: true });
    b.bill({ date: '2026-10-05', customerId: y, lines: [{ item: 'Rice', qty: 1, rate: R(111) }], payments: [] });
    return { b, x, y, z };
  }

  it('ages receivables FIFO with partial payments and advances', async () => {
    const t = await createTestApp({ today: '2026-10-10' });
    const { x, y, z } = await ageingData(t);
    const res = await t.call('reports.receivablesAgeing', { asOf: '2026-09-28' });
    const px = res.parties.find((p) => p.id === x)!;
    expect(px.balance).toBe(R(3500));
    expect(px.buckets).toEqual({ b0: R(1500), b31: 0, b61: R(2000), b90: 0 });
    expect(px.oldestDate).toBe('2026-07-10');
    expect(px.oldestDays).toBe(80);
    const py = res.parties.find((p) => p.id === y)!;
    expect(py.buckets).toEqual({ b0: 0, b31: 0, b61: 0, b90: R(600) });
    expect(res.advances).toEqual([{ id: z, name: 'Zoya', phone: null, amount: R(800) }]);
    expect(res.parties.map((p) => p.name)).toEqual(['Xavier', 'Yamini']); // cleared customer left out, biggest first
    expect(res.totals).toMatchObject({ balance: R(4100), buckets: { b0: R(1500), b31: 0, b61: R(2000), b90: R(600) }, advances: R(800), parties: 2 });
    expect(row(res.report, 'Xavier').link).toEqual({ kind: 'customer', id: x });
    expect(row(res.report, 'Zoya').cells.balance).toBe(-R(800));
    expect(row(res.report, /^Total \(2 customers\)/).cells.b90).toBe(R(600));

    // Earlier date: the opening balance is still partly unpaid.
    const earlier = await t.call('reports.receivablesAgeing', { asOf: '2026-07-31' });
    const ex = earlier.parties.find((p) => p.id === x)!;
    expect(ex.balance).toBe(R(6000));
    expect(ex.buckets).toEqual({ b0: R(2000), b31: 0, b61: R(3000), b90: R(1000) });
    expect(ex.oldestDate).toBe('2026-04-01');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('ages payables FIFO and lists advances paid', async () => {
    const t = await createTestApp();
    const b = new Books(t);
    const s1 = b.supplier('Sai Traders', { opening: R(2000) });
    b.purchase('2026-06-01', s1, R(5000), R(1000));
    b.payment('2026-07-01', s1, R(3000), 'bank');
    b.purchase('2026-09-10', s1, R(1000), 0);
    const s2 = b.supplier('Om Distributors');
    b.payment('2026-09-05', s2, R(700), 'cash');
    const res = await t.call('reports.payablesAgeing', { asOf: '2026-09-28' });
    const p = res.parties.find((q) => q.id === s1)!;
    // Due: 2000 + 4000 - 3000 + 1000 = 4000 -> 1000 (10-09, 18 days) + 3000 of the 01-06 bill (119 days).
    expect(p.balance).toBe(R(4000));
    expect(p.buckets).toEqual({ b0: R(1000), b31: 0, b61: 0, b90: R(3000) });
    expect(res.advances).toEqual([{ id: s2, name: 'Om Distributors', phone: null, amount: R(700) }]);
    expect(row(res.report, 'Sai Traders').link).toEqual({ kind: 'supplier', id: s1 });
    expect(res.report.columns.find((c) => c.key === 'balance')?.label).toBe('To pay');
  });
});

describe('permissions', () => {
  it('keeps financial reports from cashiers and allows managers', async () => {
    const { t } = await dataset();
    await t.loginAs('cashier');
    for (const [name, input] of [
      ['reports.profitLoss', { from: '2026-04-01', to: '2026-09-28' }],
      ['reports.balanceSheet', { asOf: '2026-09-28' }],
      ['reports.trialBalance', { to: '2026-09-28' }],
      ['reports.cashFlow', { from: '2026-04-01', to: '2026-09-28' }],
      ['reports.salesByDay', { from: '2026-09-01', to: '2026-09-28' }],
      ['reports.salesSummary', { from: '2026-09-01', to: '2026-09-28' }],
      ['reports.payablesAgeing', { asOf: '2026-09-28' }],
    ] as const) {
      expect((await t.fails(name, input)).code, name).toBe('FORBIDDEN');
    }
    // Cashiers can see customers & balances, so receivables ageing is allowed.
    const rec = await t.call('reports.receivablesAgeing', { asOf: '2026-09-28' });
    expect(rec.totals.parties).toBeGreaterThan(0);
    await t.loginAs('manager');
    const pl = await t.call('reports.profitLoss', { from: '2026-04-01', to: '2026-09-28' });
    expect(pl.report.title).toBe('Profit & Loss');
    await t.call('reports.salesByItem', { from: '2026-04-01', to: '2026-09-28' });
    await t.call('reports.payablesAgeing', { asOf: '2026-09-28' });
  });

  it('requires a login', async () => {
    const t = await createTestApp();
    await t.call('auth.logout');
    expect((await t.fails('reports.salesByMonth', { from: '2026-04-01', to: '2026-09-28' })).code).toBe('UNAUTHENTICATED');
    expect((await t.fails('dashboard.summary')).code).toBe('UNAUTHENTICATED');
  });

  it('validates input', async () => {
    const t = await createTestApp();
    expect((await t.fails('reports.balanceSheet', { asOf: '28-09-2026' })).code).toBe('VALIDATION');
    expect((await t.fails('reports.cashFlow', { from: '2026-09-30', to: '2026-09-01' })).message).toMatch(/on or before/);
    expect((await t.fails('reports.profitLoss', { from: '2026-04-01', to: '2026-09-28', compare: 'last_decade' })).code).toBe('VALIDATION');
  });
});

describe('void entries', () => {
  it('ignores void entries everywhere and reports never change data', async () => {
    const { t, b7 } = await dataset();
    const ctx = t.app.ctx();
    const before = t.app.db.value<number>('SELECT COUNT(*) FROM activity_log');
    const tb = trialBalanceData(ctx, { to: '2026-09-28' });
    const cancelledEntry = t.app.db.get<{ is_void: number }>('SELECT is_void FROM journal_entries WHERE id = ?', [b7.entryId])!;
    expect(cancelledEntry.is_void).toBe(1);
    // Void bill of 180 is not in sales; void expense of 2500 is not anywhere.
    expect(row(tb.report, 'Sales').cells.closingCr).toBe(-systemBalance(t.app, 'SALES', '2026-09-28'));
    expect(row(tb.report, 'Sales').cells.closingCr).toBe(R(2660));
    expect(hasRow(tb.report, 'Advertisement')).toBe(false);
    balanceSheet(ctx, { asOf: '2026-09-28' });
    cashFlow(ctx, { from: '2026-04-01', to: '2026-09-28' });
    await t.call('reports.salesByDay', { from: '2026-09-01', to: '2026-09-28' });
    await t.call('dashboard.summary');
    expect(t.app.db.value<number>('SELECT COUNT(*) FROM activity_log')).toBe(before);
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('export', () => {
  it('exports every report to Excel, CSV and PDF through the generic export route', async () => {
    const { t } = await dataset();
    const range = { from: '2026-04-01', to: '2026-09-28' };
    const reports: ReportData[] = [
      (await t.call('reports.profitLoss', { ...range, compare: 'previous_year' })).report,
      (await t.call('reports.balanceSheet', { asOf: '2026-09-28' })).report,
      await t.call('reports.trialBalance', { to: '2026-09-28', partyDetail: true }),
      (await t.call('reports.cashFlow', range)).report,
      (await t.call('reports.salesByDay', range)).report,
      (await t.call('reports.salesByMonth', range)).report,
      (await t.call('reports.salesByItem', range)).report,
      (await t.call('reports.salesByCustomer', range)).report,
      (await t.call('reports.salesByPaymentMode', range)).report,
      (await t.call('reports.receivablesAgeing', { asOf: '2026-09-28' })).report,
      (await t.call('reports.payablesAgeing', { asOf: '2026-09-28' })).report,
    ];
    for (const report of reports) {
      for (const format of ['xlsx', 'csv', 'pdf'] as const) {
        const res = await t.call('files.exportReport', { report, format });
        expect(res.path, `${report.title} ${format}`).toBeTruthy();
      }
    }
    expect(t.platform.saved).toHaveLength(reports.length * 3);
    const bsCsv = String(t.platform.saved.find((s) => s.name.startsWith('Balance_Sheet') && s.name.endsWith('.csv'))!.data);
    const bs = await t.call('reports.balanceSheet', { asOf: '2026-09-28' });
    // CSV keeps plain numbers (so they stay numeric in Excel), in rupees with 2 decimals.
    expect(bsCsv).toContain(`Total assets,,${(bs.totals.assets / 100).toFixed(2)}`);
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action = 'report.export'")).toBe(reports.length * 3);
  });
});

describe('returned items and refunds in the reports', () => {
  /** Basmati ₹649.50 + Parle-G 3 x ₹10 + Soap 3 x ₹10 less ₹1, ₹10 off the bill, paid in cash (₹698.50 rounded to ₹699). */
  async function shopWithReturns() {
    const t = await createTestApp({ openingCash: R(5000) });
    const bill = await t.call('sales.create', {
      items: [
        { itemName: 'Basmati Rice 5kg', qty: 1, rate: R(649.5) },
        { itemName: 'Parle-G Biscuit', qty: 3, rate: R(10) },
        { itemName: 'Soap', qty: 3, rate: R(10), discount: R(1) },
      ],
      billDiscount: R(10),
      payments: [{ mode: 'cash', amount: R(699) }],
    });
    const [basmati, parle, soap] = bill.items;
    const back = (items: Array<{ billItemId: number; qty: number }>) => t.call('returns.create', { kind: 'return', billId: bill.id, items, refundMode: 'cash' });
    await back([{ billItemId: basmati.id, qty: 1 }]);
    await back([{ billItemId: parle.id, qty: 1 }]);
    for (let i = 0; i < 3; i++) await back([{ billItemId: soap.id, qty: 1 }]);
    return { t, bill };
  }

  it('values returned items like the sale, so an item returned in full nets to zero', async () => {
    const { t } = await shopWithReturns();
    const range = { from: '2026-09-01', to: '2026-09-28' };
    const items = await t.call('reports.salesByItem', range);
    expect(row(items.report, 'Basmati Rice 5kg').cells).toMatchObject({ qtySold: 1, qtyReturned: 1, netQty: 0, soldAmount: R(649.5), returnedAmount: R(649.5), amount: 0 });
    expect(row(items.report, 'Parle-G Biscuit').cells).toMatchObject({ qtySold: 3, qtyReturned: 1, netQty: 2, soldAmount: R(30), returnedAmount: R(10), amount: R(20) });
    // Three part returns of a line with an item discount add up to exactly the line amount.
    expect(row(items.report, 'Soap').cells).toMatchObject({ qtySold: 3, qtyReturned: 3, netQty: 0, soldAmount: R(29), returnedAmount: R(29), amount: 0 });
    expect(items.report.columns.map((c) => c.label)).toEqual(['Item', 'Unit', 'Bills', 'Qty sold', 'Qty returned', 'Net qty', 'Sold', 'Returned', 'Net amount', 'Share %']);
    expect(row(items.report, /^Total \(/).cells).toMatchObject({ soldAmount: R(649.5 + 30 + 29), returnedAmount: R(649.5 + 10 + 29), amount: R(20) });
    // The dashboard's top items use the same figures: no ₹20.63 for two biscuits.
    const d = await t.call('dashboard.summary');
    expect(d.topItems).toEqual([{ name: 'Parle-G Biscuit', itemId: null, qty: 2, unit: null, amount: R(20) }]);
  });

  it('puts the whole of a cash refund under refunds, including its round off', async () => {
    const { t } = await shopWithReturns();
    const refunds = t.app.db.value<number>("SELECT COALESCE(SUM(total), 0) FROM credit_notes WHERE status = 'active'");
    const roundOff = t.app.db.value<number>(
      "SELECT COUNT(*) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id WHERE e.source_type = 'credit_note' AND a.system_key = 'ROUND_OFF'",
    );
    expect(roundOff).toBeGreaterThan(0); // the refunds were rounded
    const { figures: f } = cashFlow(t.app.ctx(), { from: '2026-09-01', to: '2026-09-28' });
    expect(f.lines.refunds).toEqual({ in: 0, out: refunds });
    expect(f.lines.sales).toEqual({ in: R(699), out: 0 });
    expect(f.balanced).toBe(true);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('splits a payment across activity lines in whole shares, the odd paise going to the biggest', async () => {
    const t = await createTestApp({ openingCash: R(5000) });
    const b = new Books(t);
    // ₹100 out for ₹99.99 of refunds and ₹0.01 of round off, plus ₹50.01 of expenses: two lines, not three.
    b.post('2026-09-10', 'journal', [
      { account: 'SALES_RETURNS', debit: 9999 },
      { account: 'ROUND_OFF', debit: 1 },
      { account: b.accountId('Rent'), debit: 5001 },
      { account: 'CASH', credit: 15001 },
    ]);
    const { figures: f } = cashFlow(t.app.ctx(), { from: '2026-09-01', to: '2026-09-28' });
    expect(f.lines.refunds.out + f.lines.expenses.out).toBe(15001);
    expect(f.lines.refunds.out).toBe(10000);
    expect(f.lines.sales).toEqual({ in: 0, out: 0 });
  });

  it('shows a loss as a positive amount next to the word loss, in red, in the tiles as in the statement', async () => {
    const t = await createTestApp({ openingCash: R(50000) });
    const b = new Books(t);
    b.bill({ date: '2026-09-05', lines: [{ item: 'Tea', qty: 10, rate: R(10) }], payments: [{ mode: 'cash', amount: R(100) }] });
    b.expense('2026-09-06', 'Rent', R(13180), 'cash');
    const pl = await t.call('reports.profitLoss', { from: '2026-09-01', to: '2026-09-28' });
    expect(pl.figures.netProfit).toBe(-R(13080));
    expect(row(pl.report, 'Net loss').cells.amount).toBe(R(13080));
    expect(pl.report.summary?.find((s) => s.label === 'Net loss')).toEqual({ label: 'Net loss', value: R(13080), type: 'money', tone: 'bad' });
    expect(pl.report.summary?.find((s) => s.label === 'Gross profit')).toEqual({ label: 'Gross profit', value: R(100), type: 'money' });
    const bs = await t.call('reports.balanceSheet', { asOf: '2026-09-28' });
    expect(bs.report.summary?.find((s) => /this year/.test(s.label))).toEqual({ label: 'Loss this year', value: R(13080), type: 'money', tone: 'bad' });
    const d = await t.call('dashboard.summary');
    expect(d.profit?.thisFy).toBe(-R(13080));
  });
});
