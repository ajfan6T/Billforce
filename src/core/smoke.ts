import path from 'node:path';
import fs from 'node:fs';
import { BillforceApp } from './app';
import type { Platform } from './platform';
import { todayISO } from '../shared/dates';

export interface SmokeResult {
  ok: boolean;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
  versions: Record<string, string | undefined>;
}

/**
 * End-to-end self test of the running build: open a fresh database, set up a
 * business, record a bill, check the books balance, back up and re-open the
 * backup. Used by CI on Windows (`Billforce.exe --smoke-test=result.json`).
 */
export async function runSmokeTest(dir: string, platform: Platform, version: string): Promise<SmokeResult> {
  const steps: SmokeResult['steps'] = [];
  const app = new BillforceApp({ dataDir: dir, platform, version });
  let ok = true;
  const step = async (name: string, fn: () => Promise<unknown> | unknown) => {
    try {
      const detail = await fn();
      steps.push({ step: name, ok: true, detail: detail === undefined ? undefined : JSON.stringify(detail).slice(0, 300) });
    } catch (e) {
      ok = false;
      steps.push({ step: name, ok: false, detail: String((e as Error)?.message ?? e) });
    }
  };
  const call = async (name: string, input?: unknown) => {
    const r = await app.invoke(name, input);
    if (!r.ok) throw new Error(`${name}: ${r.error.message}`);
    return r.data as any;
  };
  const today = todayISO();

  await step('setup', () =>
    call('setup.complete', {
      business: { name: 'Smoke Test Traders', address: 'MG Road, Pune', phone: '9800000000' },
      owner: { fullName: 'Smoke Owner', username: 'owner', password: 'smoke-test' },
      booksStartDate: today,
      openingCash: 500000,
    }).then(() => 'ok'),
  );
  await step('status', () => call('app.status'));
  await step('bill', async () => {
    const bill = await call('sales.create', {
      date: today,
      items: [
        { itemName: 'Tea', qty: 2, rate: 1500 },
        { itemName: 'Samosa', qty: 3, rate: 2000 },
      ],
      payments: [{ mode: 'cash', amount: 9000 }],
    });
    return bill?.billNo ?? bill?.id;
  });
  await step('ledger balances', () => {
    const unbalanced = app.db.value<number>(
      `SELECT COUNT(*) FROM (SELECT entry_id, SUM(debit) - SUM(credit) AS d FROM journal_lines GROUP BY entry_id HAVING d <> 0)`,
      undefined,
      0,
    );
    if (unbalanced) throw new Error(`${unbalanced} unbalanced journal entries`);
    return app.db.value<number>('SELECT COUNT(*) FROM journal_entries');
  });
  await step('trial balance', async () => {
    const tb = await call('reports.trialBalance', { to: today });
    return tb?.title ?? 'ok';
  });
  await step('backup + reopen', () => {
    const file = path.join(dir, 'smoke-backup.db');
    app.db.vacuumInto(file);
    const copy = BillforceApp.openDatabase(file, new Date());
    const n = copy.value<number>('SELECT COUNT(*) FROM users');
    copy.close();
    fs.rmSync(file, { force: true });
    if (n !== 1) throw new Error('backup copy is missing data');
    return 'ok';
  });
  await step('sqlite', () => app.db.value<string>('SELECT sqlite_version()'));
  app.close();
  return {
    ok,
    steps,
    versions: { app: version, node: process.versions.node, electron: process.versions.electron, chrome: process.versions.chrome },
  };
}
