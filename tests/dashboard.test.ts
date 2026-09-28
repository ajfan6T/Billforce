import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, systemBalance } from './helpers';
import { Books } from './reports-fixtures';
import { updateSection } from '../src/core/settings';
import { profitLossFigures } from '../src/core/modules/reports/profitLoss';

const R = (rupees: number) => Math.round(rupees * 100);

/** Today is 28-09-2026. */
async function shop() {
  const t = await createTestApp({ openingCash: R(10000) });
  const b = new Books(t);
  const anita = b.customer('Anita Desai', { creditLimit: R(1000) });
  const ramesh = b.customer('Ramesh Kumar', { creditLimit: R(5000) });
  const gupta = b.supplier('Gupta Traders');
  // Last month (August): 1-28 Aug = 600, rest of August = 400.
  b.bill({ date: '2026-08-10', lines: [{ item: 'Tea', qty: 40, rate: R(15) }], payments: [{ mode: 'cash', amount: R(600) }] });
  b.bill({ date: '2026-08-30', lines: [{ item: 'Tea', qty: 20, rate: R(20) }], payments: [{ mode: 'upi', amount: R(400) }] });
  // This month.
  b.bill({ date: '2026-09-05', customerId: anita, lines: [{ item: 'Oil', qty: 10, rate: R(180) }], payments: [] }); // Anita owes 1800 > limit 1000
  b.bill({ date: '2026-09-12', customerId: ramesh, lines: [{ item: 'Rice', qty: 10, rate: R(50) }], payments: [{ mode: 'bank', amount: R(200) }] });
  b.bill({ date: '2026-09-20', lines: [{ item: 'Samosa', qty: 50, rate: R(20) }], payments: [{ mode: 'cash', amount: R(1000) }] });
  // Today.
  b.bill({ date: '2026-09-28', lines: [{ item: 'Tea', qty: 10, rate: R(15) }], payments: [{ mode: 'cash', amount: R(150) }] });
  const split = b.bill({
    date: '2026-09-28',
    customerId: ramesh,
    lines: [{ item: 'Oil', qty: 2, rate: R(180) }],
    payments: [
      { mode: 'cash', amount: R(100) },
      { mode: 'upi', amount: R(200) },
    ],
  });
  b.bill({ date: '2026-09-28', lines: [{ item: 'Samosa', qty: 1, rate: R(20) }], payments: [{ mode: 'cash', amount: R(20) }], cancel: true });
  b.creditNote({ date: '2026-09-28', billId: split.id, lines: [{ item: 'Oil', qty: 1, rate: R(180) }], refund: 'credit' });
  b.purchase('2026-09-15', gupta, R(3000), R(1000), 'cash');
  b.expense('2026-09-18', 'Electricity', R(700), 'cash');
  b.expense('2026-08-18', 'Rent', R(2000), 'cash');
  return { t, b, anita, ramesh };
}

describe('dashboard summary', () => {
  it('gives the owner every figure', async () => {
    const { t } = await shop();
    const d = await t.call('dashboard.summary');
    expect(d.today).toBe('2026-09-28');
    expect(d.fyName).toBe('2026-27');
    expect(d.user).toEqual({ name: 'Ravi Sharma', role: 'owner' });
    // Today: 150 + 360 (cancelled bill left out), return of 180 against the split bill.
    expect(d.todaySales).toEqual({ bills: 2, billed: R(510), returns: R(180), netSales: R(330), byMode: { cash: R(250), upi: R(200), bank: 0, credit: R(60) } });
    expect(d.month).toEqual({ thisMonth: R(1800 + 500 + 1000 + 510 - 180), bills: 5, lastMonth: R(1000), lastMonthToDate: R(600), changePct: Math.round(((3630 - 600) / 600) * 1000) / 10 });
    expect(d.balances).toEqual({ cash: systemBalance(t.app, 'CASH'), bank: systemBalance(t.app, 'BANK') + systemBalance(t.app, 'UPI') });
    expect(d.dues).toEqual({ receivables: R(1800 + 300 + 60 - 180), receivableCustomers: 2, payables: R(2000), payableSuppliers: 1 });
    expect(d.expensesThisMonth).toBe(R(700));
    const ctx = t.app.ctx();
    expect(d.profit).toEqual({ thisMonth: profitLossFigures(ctx, '2026-09-01', '2026-09-28').netProfit, thisFy: profitLossFigures(ctx, '2026-04-01', '2026-09-28').netProfit });
    expect(d.trend?.dates).toHaveLength(30);
    expect(d.trend?.dates[0]).toBe('2026-08-30');
    expect(d.trend?.dates[29]).toBe('2026-09-28');
    expect(d.trend?.values[0]).toBe(R(400));
    expect(d.trend?.values[29]).toBe(R(330));
    expect(d.topItems?.map((i) => i.name)).toEqual(['Oil', 'Samosa', 'Rice', 'Tea']);
    expect(d.topItems?.[0]).toMatchObject({ qty: 11, amount: R(1800 + 360 - 180) });
    expect(d.recentBills?.todayOnly).toBe(false);
    expect(d.recentBills?.bills).toHaveLength(8);
    expect(d.recentBills?.bills[0].status).toBe('cancelled'); // latest first, cancelled bills shown as such
    expect(d.recentBills?.bills[0].date).toBe('2026-09-28');
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('warns about backups and customers over their credit limit', async () => {
    const { t, anita } = await shop();
    let d = await t.call('dashboard.summary');
    const backup = d.alerts.find((a) => a.kind === 'backup');
    expect(backup).toMatchObject({ title: 'No backup yet', path: '/settings/backup' });
    const credit = d.alerts.find((a) => a.kind === 'credit_limit')!;
    expect(credit.title).toBe('1 customer is over their credit limit');
    expect(credit.message).toContain('Anita Desai (owes ₹1,800.00, limit ₹1,000.00)');
    expect(credit.path).toBe(`/customers/${anita}`);

    updateSection(t.app.ctx(), 'backup', { lastBackupAt: '2026-09-27 21:00:00' });
    d = await t.call('dashboard.summary');
    expect(d.alerts.find((a) => a.kind === 'backup')).toBeUndefined();
    updateSection(t.app.ctx(), 'backup', { lastBackupAt: '2026-09-25 21:00:00' });
    d = await t.call('dashboard.summary');
    expect(d.alerts.find((a) => a.kind === 'backup')).toMatchObject({ title: 'Last backup was 3 days ago', tone: 'amber' });
    updateSection(t.app.ctx(), 'backup', { lastBackupAt: '2026-09-01 21:00:00' });
    d = await t.call('dashboard.summary');
    expect(d.alerts.find((a) => a.kind === 'backup')?.tone).toBe('red');
  });

  it('shows a cashier only today\'s sales and today\'s bills', async () => {
    const { t } = await shop();
    await t.loginAs('cashier');
    const d = await t.call('dashboard.summary');
    expect(d.user.role).toBe('cashier');
    expect(d.todaySales?.netSales).toBe(R(330));
    expect(d.recentBills?.todayOnly).toBe(true);
    expect(d.recentBills?.bills.map((b) => b.date)).toEqual(['2026-09-28', '2026-09-28', '2026-09-28']);
    expect(d.month).toBeNull();
    expect(d.balances).toBeNull();
    expect(d.dues).toBeNull();
    expect(d.expensesThisMonth).toBeNull();
    expect(d.profit).toBeNull();
    expect(d.trend).toBeNull();
    expect(d.topItems).toBeNull();
    // No backup permission: no backup alert. Customers & balances permission: credit alert.
    expect(d.alerts.map((a) => a.kind)).toEqual(['credit_limit']);
  });

  it('shows a manager figures but respects removed permissions', async () => {
    const { t } = await shop();
    await t.loginAs('manager');
    let d = await t.call('dashboard.summary');
    expect(d.profit).not.toBeNull();
    expect(d.balances).not.toBeNull();
    expect(d.alerts.map((a) => a.kind).sort()).toEqual(['backup', 'credit_limit']);
    // The owner takes away financial reports and books from managers.
    t.app.db.run("DELETE FROM role_permissions WHERE role = 'manager' AND permission IN ('reports.financial', 'accounts.view', 'reports.sales')");
    await t.loginAs('manager');
    d = await t.call('dashboard.summary');
    expect(d.profit).toBeNull();
    expect(d.balances).toBeNull();
    expect(d.dues).toBeNull();
    expect(d.trend).toBeNull();
    expect(d.todaySales).not.toBeNull();
    expect(d.recentBills?.todayOnly).toBe(false);
  });

  it('works for a brand-new business', async () => {
    const t = await createTestApp();
    const d = await t.call('dashboard.summary');
    expect(d.todaySales).toEqual({ bills: 0, billed: 0, returns: 0, netSales: 0, byMode: { cash: 0, upi: 0, bank: 0, credit: 0 } });
    expect(d.month?.changePct).toBeNull();
    expect(d.topItems).toEqual([]);
    expect(d.recentBills?.bills).toEqual([]);
    expect(d.trend?.values.every((v) => v === 0)).toBe(true);
    expect(d.profit).toEqual({ thisMonth: 0, thisFy: 0 });
  });
});
