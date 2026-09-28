/**
 * Receivables and payables ageing (FIFO).
 *
 * Payments are assumed to settle the oldest dues first. So for a customer who
 * owes B on the "as on" date, B is made up of their MOST RECENT debits (bills on
 * credit, opening balance, refunds paid out) going backwards until B is covered.
 * Each part is aged by its own date into 0-30, 31-60, 61-90 and over 90 days.
 * Customers with a credit balance have paid in advance and are listed separately.
 * Suppliers work the same way with credits (purchases on credit) on the payables side.
 */
import type { Ctx } from '../../context';
import { diffDays, formatDate } from '../../../shared/dates';
import type { ReportData, ReportRow } from '../../../shared/report';
import { systemId } from './common';

export const AGE_BUCKETS = [
  { key: 'b0', label: '0-30 days', max: 30 },
  { key: 'b31', label: '31-60 days', max: 60 },
  { key: 'b61', label: '61-90 days', max: 90 },
  { key: 'b90', label: 'Over 90 days', max: Infinity },
] as const;
export type BucketKey = (typeof AGE_BUCKETS)[number]['key'];

export interface AgeingParty {
  id: number;
  name: string;
  phone: string | null;
  /** Amount due (customer owes you / you owe the supplier). */
  balance: number;
  buckets: Record<BucketKey, number>;
  /** Date of the oldest unpaid part. */
  oldestDate: string | null;
  oldestDays: number | null;
}

export interface AgeingTotals {
  balance: number;
  buckets: Record<BucketKey, number>;
  parties: number;
  advances: number;
  advanceParties: number;
}

export interface AgeingResult {
  report: ReportData;
  parties: AgeingParty[];
  advances: Array<{ id: number; name: string; phone: string | null; amount: number }>;
  totals: AgeingTotals;
}

const emptyBuckets = (): Record<BucketKey, number> => ({ b0: 0, b31: 0, b61: 0, b90: 0 });

function bucketOf(days: number): BucketKey {
  for (const b of AGE_BUCKETS) if (days <= b.max) return b.key;
  return 'b90';
}

interface Kind {
  party: 'customer' | 'supplier';
  account: 'AR' | 'AP';
  table: 'customers' | 'suppliers';
  /** +1 when a debit increases what is due (customers), -1 when a credit does (suppliers). */
  sign: 1 | -1;
  title: string;
  dueLabel: string;
  partyLabel: string;
  advanceTitle: string;
  advanceNote: string;
}

const KINDS: Record<'receivables' | 'payables', Kind> = {
  receivables: {
    party: 'customer',
    account: 'AR',
    table: 'customers',
    sign: 1,
    title: 'Receivables Ageing',
    dueLabel: 'To collect',
    partyLabel: 'Customer',
    advanceTitle: 'Advances received from customers',
    advanceNote: 'Customers with a credit balance have paid you in advance; it is adjusted against their next bills.',
  },
  payables: {
    party: 'supplier',
    account: 'AP',
    table: 'suppliers',
    sign: -1,
    title: 'Payables Ageing',
    dueLabel: 'To pay',
    partyLabel: 'Supplier',
    advanceTitle: 'Advances paid to suppliers',
    advanceNote: 'Suppliers with a debit balance have been paid in advance; it is adjusted against their next bills.',
  },
};

function ageing(ctx: Ctx, which: 'receivables' | 'payables', asOf: string): AgeingResult {
  const k = KINDS[which];
  const accountId = systemId(ctx, k.account);
  const lines = ctx.db.all<{ party_id: number; date: string; debit: number; credit: number }>(
    `SELECT l.party_id, e.date, l.debit, l.credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.is_void = 0 AND l.account_id = ? AND l.party_type = ? AND e.date <= ?
      ORDER BY l.party_id, e.date DESC, e.id DESC, l.id DESC`,
    [accountId, k.party, asOf],
  );
  const byParty = new Map<number, Array<{ date: string; amount: number }>>();
  const balances = new Map<number, number>();
  for (const l of lines) {
    // "Due" direction: a customer's debits, a supplier's credits.
    const due = k.sign === 1 ? l.debit - l.credit : l.credit - l.debit;
    balances.set(l.party_id, (balances.get(l.party_id) ?? 0) + due);
    if (due > 0) {
      const list = byParty.get(l.party_id) ?? [];
      list.push({ date: l.date, amount: due });
      byParty.set(l.party_id, list);
    }
  }
  const ids = [...balances.keys()];
  const info = new Map(
    ids.length
      ? ctx.db
          .all<{ id: number; name: string; phone: string | null }>(`SELECT id, name, phone FROM ${k.table} WHERE id IN (${ids.map(() => '?').join(', ')})`, ids)
          .map((p) => [p.id, p])
      : [],
  );

  const parties: AgeingParty[] = [];
  const advances: AgeingResult['advances'] = [];
  for (const [id, balance] of balances) {
    const p = info.get(id);
    const name = p?.name ?? `${k.partyLabel} #${id}`;
    const phone = p?.phone ?? null;
    if (balance < 0) {
      advances.push({ id, name, phone, amount: -balance });
      continue;
    }
    if (balance === 0) continue;
    const buckets = emptyBuckets();
    let left = balance;
    let oldest: string | null = null;
    // Most recent dues first; whatever is left of the balance is the unpaid part.
    for (const d of byParty.get(id) ?? []) {
      if (left <= 0) break;
      const part = Math.min(left, d.amount);
      buckets[bucketOf(Math.max(0, diffDays(d.date, asOf)))] += part;
      left -= part;
      oldest = d.date;
    }
    // Cannot happen with a consistent ledger (the balance is made of dues), but never lose money.
    if (left > 0) buckets.b90 += left;
    parties.push({ id, name, phone, balance, buckets, oldestDate: oldest, oldestDays: oldest ? Math.max(0, diffDays(oldest, asOf)) : null });
  }
  parties.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  advances.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));

  const totals: AgeingTotals = {
    balance: parties.reduce((s, p) => s + p.balance, 0),
    buckets: emptyBuckets(),
    parties: parties.length,
    advances: advances.reduce((s, a) => s + a.amount, 0),
    advanceParties: advances.length,
  };
  for (const p of parties) for (const b of AGE_BUCKETS) totals.buckets[b.key] += p.buckets[b.key];

  const rows: ReportRow[] = parties.map((p) => ({
    cells: {
      party: p.name,
      phone: p.phone,
      balance: p.balance,
      b0: p.buckets.b0 || null,
      b31: p.buckets.b31 || null,
      b61: p.buckets.b61 || null,
      b90: p.buckets.b90 || null,
      oldest: p.oldestDate,
      days: p.oldestDays,
    },
    link: { kind: k.party, id: p.id },
  }));
  if (parties.length) {
    rows.push({
      cells: {
        party: `Total (${parties.length} ${k.party}${parties.length === 1 ? '' : 's'})`,
        phone: null,
        balance: totals.balance,
        b0: totals.buckets.b0,
        b31: totals.buckets.b31,
        b61: totals.buckets.b61,
        b90: totals.buckets.b90,
        oldest: null,
        days: null,
      },
      style: 'total',
    });
  }
  if (advances.length) {
    rows.push({ cells: { party: k.advanceTitle }, style: 'section' });
    for (const a of advances) rows.push({ cells: { party: a.name, phone: a.phone, balance: -a.amount }, style: 'muted', indent: 1, link: { kind: k.party, id: a.id } });
    rows.push({ cells: { party: 'Total advances', balance: -totals.advances }, style: 'subtotal' });
  }

  const share = (v: number) => (totals.balance ? `${Math.round((v / totals.balance) * 100)}%` : '0%');
  return {
    parties,
    advances,
    totals,
    report: {
      title: k.title,
      subtitle: `As on ${formatDate(asOf)}`,
      columns: [
        { key: 'party', label: k.partyLabel, width: 28 },
        { key: 'phone', label: 'Phone', width: 13 },
        { key: 'balance', label: k.dueLabel, type: 'money', width: 15 },
        ...AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label, type: 'money' as const, width: 14 })),
        { key: 'oldest', label: 'Oldest due since', type: 'date', width: 13 },
        { key: 'days', label: 'Days', type: 'number', width: 7 },
      ],
      rows,
      summary: [
        { label: k.dueLabel, value: totals.balance, type: 'money' },
        { label: '0-30 days', value: totals.buckets.b0, type: 'money' },
        { label: '31-90 days', value: totals.buckets.b31 + totals.buckets.b61, type: 'money' },
        { label: `Over 90 days (${share(totals.buckets.b90)})`, value: totals.buckets.b90, type: 'money' },
        { label: which === 'receivables' ? 'Advances received' : 'Advances paid', value: totals.advances, type: 'money' },
      ],
      notes: [
        'Payments are taken against the oldest dues first, so what is still due is made up of the most recent bills.',
        `Days are counted up to ${formatDate(asOf)}. ${k.advanceNote}`,
      ],
      landscape: true,
    },
  };
}

export function receivablesAgeing(ctx: Ctx, input: { asOf: string }): AgeingResult {
  return ageing(ctx, 'receivables', input.asOf);
}

export function payablesAgeing(ctx: Ctx, input: { asOf: string }): AgeingResult {
  return ageing(ctx, 'payables', input.asOf);
}
