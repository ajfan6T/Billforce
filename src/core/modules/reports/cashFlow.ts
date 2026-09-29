/**
 * Cash flow statement, direct method, over all cash-in-hand and bank / UPI accounts.
 *
 * For every non-void entry in the period that moves cash or bank, the net cash
 * movement is attributed to the lines on the OTHER side of the entry (credits for
 * money in, debits for money out), in proportion to their amounts. Each of those
 * accounts belongs to one activity line (cash sales, paid to suppliers, loans
 * taken, ...); round off belongs to the line of the entry's main account (a
 * refund's round off is part of the refund). Transfers between cash and bank accounts have no other side and
 * are left out. Opening balance entries count towards the opening balance.
 *
 *   opening + money in - money out = closing   (always equal to the actual cash + bank balance)
 */
import type { Ctx } from '../../context';
import { formatDate } from '../../../shared/dates';
import type { ReportData, ReportRow } from '../../../shared/report';
import { accountsMeta, assertRange, rangeSubtitle, type AccountMeta } from './common';

export type Activity = 'operating' | 'investing' | 'financing';

interface FlowLine {
  key: string;
  label: string;
  activity: Activity;
}

/** Activity lines in display order. */
export const FLOW_LINES: FlowLine[] = [
  { key: 'sales', label: 'Cash sales (paid at billing)', activity: 'operating' },
  { key: 'customers', label: 'Payments from customers', activity: 'operating' },
  { key: 'refunds', label: 'Refunds to customers', activity: 'operating' },
  { key: 'suppliers', label: 'Payments to suppliers', activity: 'operating' },
  { key: 'purchases', label: 'Purchases paid at once', activity: 'operating' },
  { key: 'expenses', label: 'Expenses', activity: 'operating' },
  { key: 'salaries', label: 'Salaries & wages', activity: 'operating' },
  { key: 'emp_adv', label: 'Advances to employees', activity: 'operating' },
  { key: 'other_income', label: 'Other income', activity: 'operating' },
  { key: 'gst', label: 'GST collected less GST paid', activity: 'operating' },
  { key: 'other_current', label: 'Deposits & other current items', activity: 'operating' },
  { key: 'other', label: 'Other', activity: 'operating' },
  { key: 'fixed_assets', label: 'Fixed assets bought / sold', activity: 'investing' },
  { key: 'loans_given', label: 'Loans given / collected back', activity: 'investing' },
  { key: 'interest_received', label: 'Interest received', activity: 'investing' },
  { key: 'capital', label: 'Capital introduced', activity: 'financing' },
  { key: 'drawings', label: 'Drawings by owner', activity: 'financing' },
  { key: 'loans_taken', label: 'Loans taken / repaid', activity: 'financing' },
  { key: 'interest_paid', label: 'Interest paid', activity: 'financing' },
];

const ACTIVITY_LABELS: Record<Activity, string> = {
  operating: 'Operating activities',
  investing: 'Investing activities',
  financing: 'Financing activities',
};

/** Which activity line an account's cash movements belong to. */
export function flowLineOf(a: Pick<AccountMeta, 'groupCode' | 'systemKey'>): string {
  switch (a.systemKey) {
    case 'SALES_RETURNS':
      return 'refunds';
    // Round off and discounts only ever sit next to a bill's sales line.
    case 'ROUND_OFF':
    case 'DISCOUNT_ALLOWED':
      return 'sales';
    case 'AR':
      return 'customers';
    case 'AP':
      return 'suppliers';
    case 'SALARY':
    case 'SALARY_PAYABLE':
      return 'salaries';
    case 'EMP_ADV':
      return 'emp_adv';
    case 'INTEREST_INCOME':
      return 'interest_received';
    case 'INTEREST_EXPENSE':
      return 'interest_paid';
    case 'GST_OUT_CGST':
    case 'GST_OUT_SGST':
    case 'GST_OUT_IGST':
    case 'GST_IN_CGST':
    case 'GST_IN_SGST':
    case 'GST_IN_IGST':
    case 'COMPOSITION_TAX':
      return 'gst';
  }
  switch (a.groupCode) {
    case 'sales':
      return 'sales';
    case 'purchases':
      return 'purchases';
    case 'direct_expenses':
    case 'indirect_expenses':
      return 'expenses';
    case 'indirect_income':
      return 'other_income';
    case 'current_assets':
    case 'current_liabilities':
    case 'receivables':
    case 'payables':
      return 'other_current';
    case 'fixed_assets':
      return 'fixed_assets';
    case 'loans_advances':
      return 'loans_given';
    case 'capital':
      return 'capital';
    case 'drawings':
      return 'drawings';
    case 'loans':
      return 'loans_taken';
  }
  return 'other';
}

/**
 * Split `amount` in proportion to `weights` in whole paise; the paise left over by rounding
 * down all go to the biggest weight (so a small share never gets an odd paisa of its own).
 */
function allocateToLargest(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!total) return weights.map(() => 0);
  const out = weights.map((w) => Math.trunc((amount * w) / total));
  out[weights.indexOf(Math.max(...weights))] += amount - out.reduce((s, v) => s + v, 0);
  return out;
}

export interface CashFlowFigures {
  opening: number;
  inflow: number;
  outflow: number;
  netChange: number;
  closing: number;
  /** Cash + bank balance as per the ledger on the "to" date. */
  actualClosing: number;
  balanced: boolean;
  operating: number;
  investing: number;
  financing: number;
  /** Per line: money in and out. */
  lines: Record<string, { in: number; out: number }>;
}

interface LineRow {
  entry_id: number;
  account_id: number;
  debit: number;
  credit: number;
}

export function cashFlow(ctx: Ctx, input: { from: string; to: string }): { report: ReportData; figures: CashFlowFigures } {
  const { from, to } = input;
  assertRange(from, to);
  const accounts = accountsMeta(ctx);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const cashAccounts = accounts.filter((a) => a.groupCode === 'cash' || a.groupCode === 'bank');
  const cashIds = new Set(cashAccounts.map((a) => a.id));
  const ids = [...cashIds];
  const roundOffIds = new Set(accounts.filter((a) => a.systemKey === 'ROUND_OFF').map((a) => a.id));
  const inIds = ids.length ? ids.map(() => '?').join(', ') : 'NULL';

  const balanceBy = (where: string, params: unknown[]) =>
    new Map(
      ctx.db
        .all<{ account_id: number; bal: number }>(
          `SELECT l.account_id, SUM(l.debit - l.credit) AS bal FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
            WHERE e.is_void = 0 AND l.account_id IN (${inIds}) AND ${where} GROUP BY l.account_id`,
          [...ids, ...params],
        )
        .map((r) => [r.account_id, r.bal]),
    );
  // Opening = everything before the period, plus opening-balance entries dated inside it.
  const openingBy = balanceBy("(e.date < ? OR (e.voucher_type = 'opening' AND e.date <= ?))", [from, to]);
  const closingBy = balanceBy('e.date <= ?', [to]);
  const opening = [...openingBy.values()].reduce((s, v) => s + v, 0);
  const actualClosing = [...closingBy.values()].reduce((s, v) => s + v, 0);

  // Every line of every entry in the period that touches cash / bank.
  const lines = ctx.db.all<LineRow>(
    `SELECT l.entry_id, l.account_id, l.debit, l.credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.is_void = 0 AND e.voucher_type <> 'opening' AND e.date >= ? AND e.date <= ?
        AND l.entry_id IN (SELECT l2.entry_id FROM journal_lines l2 WHERE l2.account_id IN (${inIds}))
      ORDER BY l.entry_id, l.id`,
    [from, to, ...ids],
  );
  const flows: Record<string, { in: number; out: number }> = Object.fromEntries(FLOW_LINES.map((f) => [f.key, { in: 0, out: 0 }]));
  let i = 0;
  while (i < lines.length) {
    const entryId = lines[i].entry_id;
    const entryLines: LineRow[] = [];
    while (i < lines.length && lines[i].entry_id === entryId) entryLines.push(lines[i++]);
    const cashNet = entryLines.filter((l) => cashIds.has(l.account_id)).reduce((s, l) => s + l.debit - l.credit, 0);
    if (!cashNet) continue; // transfer between cash / bank accounts, or a net-zero entry
    // Money in is explained by the credit lines on the other side; money out by the debit lines.
    const others = entryLines.filter((l) => !cashIds.has(l.account_id) && (cashNet > 0 ? l.credit > 0 : l.debit > 0));
    const weight = (l: LineRow) => (cashNet > 0 ? l.credit : l.debit);
    // Round off only evens out a document's total, so it follows the entry's main line: a ₹650 refund whose
    // round off is ₹0.17 is ₹650 of refunds, not ₹649.83 of refunds and ₹0.17 of cash sales.
    const main = others.filter((l) => !roundOffIds.has(l.account_id)).sort((a, b) => weight(b) - weight(a))[0];
    const keyOf = (l: LineRow) => {
      const acct = byId.get((roundOffIds.has(l.account_id) && main ? main : l).account_id);
      return acct ? flowLineOf(acct) : 'other';
    };
    // One share per activity line, so paise are never split off into a line of their own; the paise
    // left over by rounding go to the line with the biggest share.
    const byKey = new Map<string, number>();
    for (const l of others) byKey.set(keyOf(l), (byKey.get(keyOf(l)) ?? 0) + weight(l));
    const keys = [...byKey.keys()];
    const parts = allocateToLargest(cashNet, keys.map((k) => byKey.get(k)!));
    keys.forEach((key, k) => {
      if (parts[k] > 0) flows[key].in += parts[k];
      else if (parts[k] < 0) flows[key].out += -parts[k];
    });
  }

  const rows: ReportRow[] = [];
  rows.push({ cells: { particulars: `Opening cash & bank balance (${formatDate(from)})`, in: null, out: null, net: opening }, style: 'subtotal' });
  const activityNet: Record<Activity, number> = { operating: 0, investing: 0, financing: 0 };
  let inflow = 0;
  let outflow = 0;
  for (const activity of ['operating', 'investing', 'financing'] as Activity[]) {
    rows.push({ cells: { particulars: ACTIVITY_LABELS[activity] }, style: 'section' });
    let aIn = 0;
    let aOut = 0;
    let shown = 0;
    for (const f of FLOW_LINES.filter((x) => x.activity === activity)) {
      const v = flows[f.key];
      if (!v.in && !v.out) continue;
      rows.push({ cells: { particulars: f.label, in: v.in || null, out: v.out || null, net: v.in - v.out }, indent: 1 });
      aIn += v.in;
      aOut += v.out;
      shown++;
    }
    if (!shown) rows.push({ cells: { particulars: 'No cash movement' }, style: 'muted', indent: 1 });
    activityNet[activity] = aIn - aOut;
    inflow += aIn;
    outflow += aOut;
    rows.push({ cells: { particulars: `Net cash from ${ACTIVITY_LABELS[activity].toLowerCase()}`, in: aIn, out: aOut, net: aIn - aOut }, style: 'subtotal' });
  }
  const netChange = inflow - outflow;
  const closing = opening + netChange;
  rows.push({ cells: { particulars: netChange >= 0 ? 'Net increase in cash & bank' : 'Net decrease in cash & bank', in: inflow, out: outflow, net: netChange }, style: 'subtotal' });
  rows.push({ cells: { particulars: `Closing cash & bank balance (${formatDate(to)})`, in: null, out: null, net: closing }, style: 'total' });
  for (const a of cashAccounts) {
    const bal = closingBy.get(a.id) ?? 0;
    if (!bal && !a.isActive) continue;
    if (!bal && !openingBy.get(a.id)) continue;
    rows.push({ cells: { particulars: a.name, in: null, out: null, net: bal }, style: 'muted', indent: 1, link: { kind: 'account', id: a.id } });
  }
  const balanced = closing === actualClosing;
  const notes = [
    'Money moved between your own cash, bank and UPI accounts (transfers, deposits, withdrawals) is not counted as money in or out.',
    'Sales on credit, purchases on credit and salary not yet paid appear only when the money actually moves.',
  ];
  if (!balanced) {
    rows.push({ cells: { particulars: 'Difference from the actual cash & bank balance', net: actualClosing - closing }, style: 'total' });
    notes.unshift(`Warning: the closing balance per the books is ${(actualClosing / 100).toFixed(2)}. Please contact support.`);
  }

  const figures: CashFlowFigures = {
    opening,
    inflow,
    outflow,
    netChange,
    closing,
    actualClosing,
    balanced,
    operating: activityNet.operating,
    investing: activityNet.investing,
    financing: activityNet.financing,
    lines: flows,
  };
  return {
    figures,
    report: {
      title: 'Cash Flow',
      subtitle: rangeSubtitle(from, to),
      columns: [
        { key: 'particulars', label: 'Particulars', width: 44 },
        { key: 'in', label: 'Money in', type: 'money', width: 16 },
        { key: 'out', label: 'Money out', type: 'money', width: 16 },
        { key: 'net', label: 'Net', type: 'money', width: 16 },
      ],
      rows,
      summary: [
        { label: 'Opening balance', value: opening, type: 'money' },
        { label: 'Money in', value: inflow, type: 'money' },
        { label: 'Money out', value: outflow, type: 'money' },
        { label: 'Closing balance', value: closing, type: 'money' },
      ],
      notes,
    },
  };
}
