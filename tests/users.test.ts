import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems, OWNER, type TestApp } from './helpers';
import { seedReferenceData } from '../src/core/seed';
import { activityLabel, describeActivityDetails } from '../src/shared/activity';
import { DEFAULT_ROLE_PERMISSIONS } from '../src/shared/permissions';

async function addUser(t: TestApp, role: 'owner' | 'manager' | 'cashier', username: string, opts: { mustChangePassword?: boolean } = {}) {
  return t.call('users.create', { username, fullName: `${role} ${username}`, role, password: 'pass1234', mustChangePassword: opts.mustChangePassword ?? false });
}

async function login(t: TestApp, username: string, password = 'pass1234') {
  return t.call('auth.login', { username, password });
}

describe('users', () => {
  it('lists users without password hashes', async () => {
    const t = await createTestApp();
    await addUser(t, 'cashier', 'priya');
    await t.loginOwner();
    const list = await t.call('users.list');
    expect(list.map((u) => u.username).sort()).toEqual(['owner', 'priya']);
    const raw = JSON.stringify(list);
    expect(raw).not.toMatch(/scrypt|password_hash|passwordHash/);
    const me = list.find((u) => u.username === 'owner')!;
    expect(me).toMatchObject({ role: 'owner', isActive: true, isSelf: true, fullName: 'Ravi Sharma' });
    expect(me.lastLoginAt).toBeTruthy();
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('creates users with validation and logs it', async () => {
    const t = await createTestApp();
    const u = await t.call('users.create', { username: 'Priya', fullName: '  Priya   Patil ', role: 'cashier', password: '4321' });
    expect(u).toMatchObject({ username: 'Priya', fullName: 'Priya Patil', role: 'cashier', mustChangePassword: true, isActive: true });
    // Usernames are unique regardless of case.
    const dup = await t.fails('users.create', { username: 'priya', fullName: 'Other', role: 'cashier', password: '4321' });
    expect(dup.code).toBe('VALIDATION');
    expect(dup.message).toMatch(/already used by Priya Patil/);
    expect((await t.fails('users.create', { username: 'x y', fullName: 'A', role: 'cashier', password: '4321' })).message).toMatch(/letters, numbers/);
    expect((await t.fails('users.create', { username: 'abc', fullName: 'A', role: 'cashier', password: '12' })).message).toMatch(/at least 4/);
    expect((await t.fails('users.create', { username: 'abc', fullName: '', role: 'cashier', password: '1234' })).message).toMatch(/full name/);
    const log = t.app.db.get<{ summary: string; entity_id: number }>("SELECT summary, entity_id FROM activity_log WHERE action = 'user.create'");
    expect(log?.summary).toBe('Added Cashier login "Priya" for Priya Patil');
    expect(log?.entity_id).toBe(u.id);
  });

  it('only the owner may create another owner', async () => {
    const t = await createTestApp();
    // Give managers the right to manage users, then act as a manager.
    await t.call('roles.update', { role: 'manager', permissions: [...DEFAULT_ROLE_PERMISSIONS.manager, 'users.manage'] });
    await addUser(t, 'manager', 'mohan');
    await login(t, 'mohan');
    const err = await t.fails('users.create', { username: 'boss2', fullName: 'Boss', role: 'owner', password: '1234' });
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toMatch(/Only the owner/);
    // Managers can still add cashiers ...
    await t.call('users.create', { username: 'cash2', fullName: 'Cash Two', role: 'cashier', password: '1234' });
    // ... but cannot touch the owner's login.
    const owner = (await t.call('users.list')).find((u) => u.role === 'owner')!;
    expect((await t.fails('users.resetPassword', { id: owner.id, newPassword: 'hacked' })).code).toBe('FORBIDDEN');
    expect((await t.fails('users.update', { id: owner.id, fullName: 'X', role: 'owner', isActive: false })).code).toBe('FORBIDDEN');
    const cashier = (await t.call('users.list')).find((u) => u.username === 'cash2')!;
    expect((await t.fails('users.update', { id: cashier.id, fullName: 'Cash Two', role: 'owner', isActive: true })).message).toMatch(/Only the owner can make someone an owner/);
    // The owner can.
    await t.loginOwner();
    const o2 = await t.call('users.create', { username: 'boss2', fullName: 'Second Owner', role: 'owner', password: '1234' });
    expect(o2.role).toBe('owner');
  });

  it('never allows deactivating yourself or changing your own role', async () => {
    const t = await createTestApp();
    const me = (await t.call('users.list'))[0];
    expect((await t.fails('users.update', { id: me.id, fullName: me.fullName, role: 'owner', isActive: false })).message).toMatch(/cannot deactivate your own/);
    expect((await t.fails('users.update', { id: me.id, fullName: me.fullName, role: 'manager', isActive: true })).message).toMatch(/cannot change your own role/);
    // Changing your own name is fine.
    const renamed = await t.call('users.update', { id: me.id, fullName: 'Ravi K Sharma', role: 'owner', isActive: true });
    expect(renamed.fullName).toBe('Ravi K Sharma');
  });

  it('lets one owner demote or deactivate another while an active owner remains', async () => {
    const t = await createTestApp();
    const me = (await t.call('users.list'))[0];
    const partner = await addUser(t, 'owner', 'partner');
    await t.call('users.update', { id: partner.id, fullName: partner.fullName, role: 'manager', isActive: true });
    await t.call('users.update', { id: partner.id, fullName: partner.fullName, role: 'owner', isActive: true });
    await login(t, 'partner');
    await t.call('users.update', { id: me.id, fullName: me.fullName, role: 'owner', isActive: false });
    expect((await t.fails('auth.login', OWNER)).code).toBe('UNAUTHENTICATED');
    await login(t, 'partner');
    await t.call('users.update', { id: me.id, fullName: me.fullName, role: 'owner', isActive: true });
    await t.loginOwner();
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM users WHERE role = 'owner' AND is_active = 1")).toBe(2);
    const actions = t.app.db.all<{ action: string }>("SELECT action FROM activity_log WHERE action LIKE 'user.%' AND action NOT LIKE 'user.log%' ORDER BY id").map((r) => r.action);
    expect(actions).toEqual(['user.create', 'user.update', 'user.update', 'user.deactivate', 'user.activate']);
  });

  it('refuses to demote the only active owner even when asked by an owner', async () => {
    const t = await createTestApp();
    const me = (await t.call('users.list'))[0];
    const o2 = await addUser(t, 'owner', 'partner');
    // Deactivate partner so "owner" is the only active owner, then re-check the rule from partner's point of view
    // by making partner active but checking the count excluding the target.
    await t.call('users.update', { id: o2.id, fullName: o2.fullName, role: 'owner', isActive: false });
    // Simulate a second owner session (partner) that was logged in before being deactivated: rule still protects "owner".
    t.app.session = { userId: o2.id, username: 'partner', fullName: o2.fullName, role: 'owner', permissions: [], loginAt: '2026-09-28 10:00:00' };
    const err = await t.fails('users.update', { id: me.id, fullName: me.fullName, role: 'manager', isActive: true });
    expect(err.message).toMatch(/only active owner/);
    const err2 = await t.fails('users.update', { id: me.id, fullName: me.fullName, role: 'owner', isActive: false });
    expect(err2.message).toMatch(/only active owner/);
  });

  it('resets a password and forces a change at next login', async () => {
    const t = await createTestApp();
    const u = await addUser(t, 'cashier', 'priya');
    const reset = await t.call('users.resetPassword', { id: u.id, newPassword: 'temp1' });
    expect(reset.mustChangePassword).toBe(true);
    expect((await t.fails('users.resetPassword', { id: u.id, newPassword: 'ab' })).message).toMatch(/at least 4/);
    const me = (await t.call('users.list')).find((x) => x.isSelf)!;
    expect((await t.fails('users.resetPassword', { id: me.id, newPassword: 'abcd' })).message).toMatch(/Change password/);
    // Old password no longer works; the new one does and the session says a change is needed.
    expect((await t.fails('auth.login', { username: 'priya', password: 'pass1234' })).code).toBe('UNAUTHENTICATED');
    const s = await login(t, 'priya', 'temp1');
    expect(s.mustChangePassword).toBe(true);
    expect((await t.call('app.status')).session?.mustChangePassword).toBe(true);
    await t.call('auth.changePassword', { currentPassword: 'temp1', newPassword: 'mine99' });
    expect((await t.call('auth.me'))?.mustChangePassword).toBe(false);
    await login(t, 'priya', 'mine99');
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action = 'user.reset_password' AND entity_id = ?", [u.id])).toBe(1);
  });

  it('unlocks a locked user on reset and blocks inactive users from logging in', async () => {
    const t = await createTestApp();
    const u = await addUser(t, 'cashier', 'priya');
    await t.call('auth.logout');
    for (let i = 0; i < 5; i++) await t.fails('auth.login', { username: 'priya', password: 'wrong' });
    await t.loginOwner();
    expect((await t.call('users.list')).find((x) => x.id === u.id)?.isLocked).toBe(true);
    await t.call('users.resetPassword', { id: u.id, newPassword: 'fresh1' });
    expect((await t.call('users.list')).find((x) => x.id === u.id)?.isLocked).toBe(false);
    await t.call('users.update', { id: u.id, fullName: u.fullName, role: 'cashier', isActive: false });
    expect((await t.fails('auth.login', { username: 'priya', password: 'fresh1' })).message).toMatch(/Wrong username or password/);
    await t.loginOwner();
    await t.call('users.update', { id: u.id, fullName: u.fullName, role: 'cashier', isActive: true, username: 'priya.p' });
    await login(t, 'priya.p', 'fresh1');
  });

  it('denies user management without permission', async () => {
    const t = await createTestApp();
    await t.loginAs('cashier');
    expect((await t.fails('users.list')).code).toBe('FORBIDDEN');
    expect((await t.fails('users.create', { username: 'x1', fullName: 'X', role: 'cashier', password: '1234' })).code).toBe('FORBIDDEN');
    expect((await t.fails('roles.get')).code).toBe('FORBIDDEN');
    expect((await t.fails('activity.list', { from: '2026-09-01', to: '2026-09-30' })).code).toBe('FORBIDDEN');
    await t.loginAs('manager');
    // Managers can see the activity log by default but not manage users.
    await t.call('activity.list', { from: '2026-09-01', to: '2026-09-30' });
    expect((await t.fails('users.list')).code).toBe('FORBIDDEN');
  });
});

describe('roles & permissions', () => {
  it('shows the permission catalogue grouped, with owner fixed to everything', async () => {
    const t = await createTestApp();
    const r = await t.call('roles.get');
    expect(r.canEdit).toBe(true);
    expect(r.groups.map((g) => g.group)).toEqual(['Sales & billing', 'Customers', 'Suppliers & purchases', 'Accounting', 'Reports', 'Employees', 'Administration']);
    expect(r.roles.owner.length).toBe(r.groups.reduce((s, g) => s + g.permissions.length, 0));
    expect(r.roles.cashier).toEqual(expect.arrayContaining(DEFAULT_ROLE_PERMISSIONS.cashier));
    expect(r.userCounts.owner).toBe(1);
  });

  it('applies role changes on the next call and keeps an empty role empty', async () => {
    const t = await createTestApp();
    await t.loginAs('cashier');
    expect((await t.fails('reports.trialBalance', { to: '2026-09-28' })).code).toBe('FORBIDDEN');
    // The owner changes the cashier role while the cashier is "logged in": done through the service with an owner context.
    const cashierSession = t.app.session;
    await t.loginOwner();
    const updated = await t.call('roles.update', { role: 'cashier', permissions: ['billing.create', 'reports.financial'] });
    expect(updated.roles.cashier).toEqual(['billing.create', 'reports.financial']);
    // Back to the cashier's session (stale permission list) - the next status call refreshes it.
    t.app.session = cashierSession;
    const status = await t.call('app.status');
    expect(status.session?.permissions).toEqual(['billing.create', 'reports.financial']);
    await t.call('reports.trialBalance', { to: '2026-09-28' });
    expect((await t.fails('customers.list', {})).code).toBe('FORBIDDEN');

    // Removing everything is kept after a restart (start-up seeding must not bring defaults back).
    await t.loginOwner();
    await t.call('roles.update', { role: 'cashier', permissions: [] });
    seedReferenceData(t.app.db, '2026-09-28 10:00:00');
    expect((await t.call('roles.get')).roles.cashier).toEqual([]);
    const log = t.app.db.all<{ summary: string }>("SELECT summary FROM activity_log WHERE action = 'role.update' ORDER BY id");
    expect(log).toHaveLength(2);
    expect(log[0].summary).toMatch(/^Changed Cashier permissions: allowed Financial reports/);
    expect(log[0].summary).toMatch(/removed .*Give discounts/);
  });

  it('only the owner can change role permissions', async () => {
    const t = await createTestApp();
    await t.call('roles.update', { role: 'manager', permissions: [...DEFAULT_ROLE_PERMISSIONS.manager, 'users.manage'] });
    await t.loginAs('manager');
    const r = await t.call('roles.get');
    expect(r.canEdit).toBe(false);
    expect((await t.fails('roles.update', { role: 'cashier', permissions: [] })).code).toBe('FORBIDDEN');
    await t.loginOwner();
    expect((await t.fails('roles.update', { role: 'owner', permissions: [] })).code).toBe('VALIDATION');
    expect((await t.fails('roles.update', { role: 'cashier', permissions: ['billing.fly'] })).message).toMatch(/Unknown permission/);
    // No change = no log entry.
    const before = t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action = 'role.update'");
    await t.call('roles.update', { role: 'cashier', permissions: [...DEFAULT_ROLE_PERMISSIONS.cashier] });
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action = 'role.update'")).toBe(before);
  });
});

describe('activity log', () => {
  async function seedLog(t: TestApp) {
    t.setToday('2026-09-20');
    await t.call('customers.create', { name: 'Anita Desai', phone: '98200 11111' });
    t.setToday('2026-09-25');
    await t.call('items.create', { name: 'Tea', unit: 'cup', rate: 1500 });
    await addUser(t, 'cashier', 'priya');
    await login(t, 'priya');
    t.setToday('2026-09-27');
    const bill = await t.call('sales.create', { items: [{ itemName: 'Tea', qty: 2, rate: 1500 }], payments: [{ mode: 'cash', amount: 3000 }] });
    await t.loginOwner();
    return { bill };
  }

  it('filters by date, user, action, entity and text, with paging', async () => {
    const t = await createTestApp();
    const { bill } = await seedLog(t);
    const all = await t.call('activity.list', { from: '2026-09-01', to: '2026-09-30' });
    expect(all.total).toBe(all.rows.length);
    expect(all.rows[0].at >= all.rows[all.rows.length - 1].at).toBe(true);

    const early = await t.call('activity.list', { from: '2026-09-20', to: '2026-09-20' });
    expect(early.rows.map((r) => r.action)).toEqual(['customer.create']);
    expect(early.rows[0]).toMatchObject({ actionLabel: 'Added customer', userName: 'Ravi Sharma', link: { kind: 'customer' } });

    const priya = t.app.db.value<number>("SELECT id FROM users WHERE username = 'priya'");
    const byPriya = await t.call('activity.list', { from: '2026-09-01', to: '2026-09-30', userId: priya });
    expect(byPriya.rows.map((r) => r.action).sort()).toEqual(['bill.create', 'user.login']);

    const bills = await t.call('activity.list', { from: '2026-09-01', to: '2026-09-30', action: 'bill.' });
    expect(bills.rows).toHaveLength(1);
    expect(bills.rows[0]).toMatchObject({ action: 'bill.create', actionLabel: 'Created bill', link: { kind: 'bill', id: bill.id }, entityType: 'bill' });

    const multi = await t.call('activity.list', { from: '2026-09-01', to: '2026-09-30', action: ['item.', 'customer.'] });
    expect(multi.rows.map((r) => r.action).sort()).toEqual(['customer.create', 'item.create']);

    const users = await t.call('activity.list', { from: '2026-09-01', to: '2026-09-30', entityType: 'user' });
    expect(users.rows.every((r) => r.entityType === 'user')).toBe(true);
    expect(users.rows.some((r) => r.action === 'user.create')).toBe(true);

    const text = await t.call('activity.list', { from: '2026-09-01', to: '2026-09-30', q: 'anita' });
    expect(text.rows.map((r) => r.action)).toEqual(['customer.create']);
    // LIKE wildcards in the search box are treated as plain text.
    expect((await t.call('activity.list', { from: '2026-09-01', to: '2026-09-30', q: '%' })).total).toBe(0);

    const page1 = await t.call('activity.list', { from: '2026-09-01', to: '2026-09-30', limit: 2, offset: 0 });
    const page2 = await t.call('activity.list', { from: '2026-09-01', to: '2026-09-30', limit: 2, offset: 2 });
    expect(page1.total).toBe(all.total);
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows[0].id).toBe(all.rows[2].id);

    expect((await t.fails('activity.list', { from: '2026-09-30', to: '2026-09-01' })).message).toMatch(/on or before/);
    expect(ledgerProblems(t.app)).toEqual([]);
  });

  it('exports the filtered log as a report and shows details', async () => {
    const t = await createTestApp();
    await seedLog(t);
    const rep = await t.call('activity.report', { filters: { from: '2026-09-01', to: '2026-09-30', action: 'customer.' } });
    expect(rep.title).toBe('Activity log');
    expect(rep.subtitle).toContain('01-09-2026 to 30-09-2026');
    expect(rep.columns.map((c) => c.key)).toEqual(['at', 'user', 'action', 'summary']);
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0].cells).toMatchObject({ user: 'Ravi Sharma', action: 'Added customer', summary: 'Added customer "Anita Desai"' });
    expect(rep.rows[0].link?.kind).toBe('customer');
    const entry = (await t.call('activity.list', { from: '2026-09-01', to: '2026-09-30', action: 'customer.' })).rows[0];
    const detail = await t.call('activity.get', { id: entry.id });
    expect(detail.details).toMatchObject({ name: 'Anita Desai' });
    const users = await t.call('activity.users');
    expect(users.map((u) => u.username)).toContain('priya');
  });

  it('shows details in plain words: rupees not paise, DD-MM-YYYY dates, no internal fields', async () => {
    const t = await createTestApp();
    const last = async (action: string) => {
      const id = t.app.db.value<number>('SELECT MAX(id) FROM activity_log WHERE action = ?', [action]);
      return t.call('activity.get', { id });
    };
    const cust = await t.call('customers.create', { name: 'Anita Desai', phone: '98200 11111' });
    const r = await t.call('receipts.create', { customerId: cust.id, amount: 5000, mode: 'cash' });
    await t.call('receipts.update', { id: r.id, customerId: cust.id, amount: 7500, mode: 'upi', date: '2026-09-27', reason: 'Typed wrong' });
    const edit = await last('receipt.update');
    expect(edit.view.changes).toEqual(
      expect.arrayContaining([
        { label: 'Amount', before: '₹50.00', after: '₹75.00' },
        { label: 'Paid by', before: 'Cash', after: 'UPI' },
        { label: 'Date', before: '28-09-2026', after: '27-09-2026' },
      ]),
    );
    expect(edit.view.facts).toContainEqual({ label: 'Reason', value: 'Typed wrong' });
    const shown = JSON.stringify(edit.view);
    expect(shown).not.toMatch(/\b5000\b|\b7500\b/); // never raw paise
    expect(shown).not.toMatch(/Revision|Updated at|Journal|Print count|ID"/); // internal bookkeeping stays hidden
    expect(edit.view.changes).toContainEqual({ label: 'Account', before: 'Cash in Hand', after: 'UPI Account' });
    expect(edit.details).toMatchObject({ before: { amount: 5000 }, after: { amount: 7500 } }); // raw data kept for "Technical details"

    const bill = await t.call('sales.create', { items: [{ itemName: 'Tea', qty: 1, rate: 10100 }], payments: [{ mode: 'cash', amount: 10100 }] });
    expect((await last('bill.create')).view.facts).toEqual(expect.arrayContaining([{ label: 'Total', value: '₹101.00' }, { label: 'Paid by', value: 'Cash' }, { label: 'Lines', value: '1' }]));
    await t.call('sales.cancel', { id: bill.id, reason: 'Wrong items entered' });
    expect((await last('bill.cancel')).view).toEqual({ changes: [], facts: [{ label: 'Reason', value: 'Wrong items entered' }, { label: 'Total', value: '₹101.00' }] });

    const item = await t.call('items.create', { name: 'Sugar', unit: 'kg', rate: 4500 });
    await t.call('items.setRate', { id: item.id, rate: 4800 });
    expect((await last('item.update')).view).toEqual({ changes: [{ label: 'Rate', before: '₹45.00', after: '₹48.00' }], facts: [] });
    await t.call('items.update', { id: item.id, name: 'Sugar 1 kg', unit: 'kg', rate: 123456750 });
    const itemEdit = (await last('item.update')).view;
    expect(itemEdit.changes).toEqual(
      expect.arrayContaining([
        { label: 'Name', before: 'Sugar', after: 'Sugar 1 kg' },
        { label: 'Rate', before: '₹48.00', after: '₹12,34,567.50' },
      ]),
    );
    expect(JSON.stringify(itemEdit)).not.toMatch(/Created at|Usage|"Id"/);

    // Role changes read as permission names, not codes.
    await t.call('roles.update', { role: 'cashier', permissions: DEFAULT_ROLE_PERMISSIONS.cashier.filter((p) => p !== 'billing.reprint') });
    const role = (await last('role.update')).view;
    expect(role.facts).toEqual(expect.arrayContaining([{ label: 'Role', value: 'Cashier' }, { label: 'No longer allowed', value: 'Reprint bills' }]));
  });

  it('formats unknown details generically without leaking paise or codes', () => {
    expect(describeActivityDetails('salary.process', { employeeId: 3, month: '2026-09', paidDays: 26, gross: 1500000, advanceRecovery: 50000, net: 1450000, payNow: null })).toEqual({
      changes: [],
      facts: [
        { label: 'Month', value: 'September 2026' },
        { label: 'Paid days', value: '26' },
        { label: 'Gross', value: '₹15,000.00' },
        { label: 'Advance recovered', value: '₹500.00' },
        { label: 'Net', value: '₹14,500.00' },
      ],
    });
    expect(describeActivityDetails('customer.update', { before: { openingBalance: { amount: 100000, direction: 'receivable' }, creditLimit: null }, after: { openingBalance: { amount: 250000, direction: 'receivable' }, creditLimit: 500000 } }).changes).toEqual([
      { label: 'Opening balance', before: '₹1,000.00 (receivable)', after: '₹2,500.00 (receivable)' },
      { label: 'Credit limit', before: '—', after: '₹5,000.00' },
    ]);
    expect(describeActivityDetails('loan.create', { name: 'HDFC', principal: 1000000, interestRate: 10.5, startDate: '2026-04-01' }).facts).toEqual([
      { label: 'Name', value: 'HDFC' },
      { label: 'Principal', value: '₹10,000.00' },
      { label: 'Interest rate', value: '10.5%' },
      { label: 'Start date', value: '01-04-2026' },
    ]);
    expect(describeActivityDetails('attendance.mark', { date: '2026-09-28', from: 'P', to: 'A' }).facts.map((f) => f.value)).toEqual(['28-09-2026', 'Present', 'Absent']);
    expect(describeActivityDetails('backup.create', { path: '/b/Shop_manual.bfbackup', sizeBytes: 2_200_000 }).facts).toEqual([
      { label: 'File', value: '/b/Shop_manual.bfbackup' },
      { label: 'Size', value: '2.1 MB' },
    ]);
    expect(describeActivityDetails('bill.print', { printCount: 3 }).facts).toEqual([{ label: 'Times printed', value: '3' }]);
    expect(describeActivityDetails('settings.update', { section: 'billing', before: { prefixes: { bill: 'INV', receipt: 'RCT' } }, after: { prefixes: { bill: 'B', receipt: 'RCT' } } })).toEqual({
      changes: [{ label: 'Prefixes: Bill', before: 'INV', after: 'B' }],
      facts: [{ label: 'Section', value: 'Billing' }],
    });
    expect(describeActivityDetails('x.y', null)).toEqual({ changes: [], facts: [] });
  });

  it('labels actions in plain English, with a readable fallback', () => {
    expect(activityLabel('bill.create')).toBe('Created bill');
    expect(activityLabel('supplier_payment.cancel')).toBe('Cancelled supplier payment');
    expect(activityLabel('stock_item.merge')).toBe('Stock item: merge');
    expect(activityLabel('gadget.create')).toBe('Added gadget');
    expect(activityLabel('weird')).toBe('Weird');
  });
});

describe('document revisions', () => {
  it('returns every version of a bill with snapshots, with permission checks per document type', async () => {
    const t = await createTestApp();
    const bill = await t.call('sales.create', { items: [{ itemName: 'Tea', qty: 2, rate: 1500 }], payments: [{ mode: 'cash', amount: 3000 }] });
    await t.call('sales.cancel', { id: bill.id, reason: 'Wrong item' });
    const r = await t.call('audit.revisions', { docType: 'bill', docId: bill.id });
    expect(r.revisions.map((v) => v.action)).toEqual(['created', 'cancelled']);
    expect(r.revisions[1]).toMatchObject({ reason: 'Wrong item', actionLabel: 'Cancelled', username: OWNER.username });
    expect(r.revisions[0].snapshot).toBeTruthy();
    expect(t.app.db.value<number>("SELECT COUNT(*) FROM activity_log WHERE action IN ('bill.create', 'bill.cancel')")).toBe(2);

    // A cashier (billing.create) may see today's bills, but not purchases.
    await t.loginAs('cashier');
    expect((await t.call('audit.revisions', { docType: 'bill', docId: bill.id })).revisions).toHaveLength(2);
    expect((await t.fails('audit.revisions', { docType: 'purchase', docId: 1 })).code).toBe('FORBIDDEN');
    t.setToday('2026-09-29');
    expect((await t.fails('audit.revisions', { docType: 'bill', docId: bill.id })).message).toMatch(/today's bills/);
    expect((await t.fails('audit.revisions', { docType: 'rocket', docId: 1 })).code).toBe('VALIDATION');
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});
