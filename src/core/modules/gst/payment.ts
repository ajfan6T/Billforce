/**
 * "Pay GST": one voucher (type gst_payment, from the Accounts pages) that
 *  - regular: sets off the input tax credit against the tax collected, in the order the law
 *    lays down (IGST credit first: IGST, then CGST / SGST; CGST credit: CGST, then IGST;
 *    SGST credit: SGST, then IGST; CGST and SGST never pay for each other), and pays what is
 *    left from a cash / bank account:
 *      Dr Output CGST / SGST / IGST     Cr Input CGST / SGST / IGST (set-off)
 *      Dr Output CGST / SGST / IGST     Cr cash / bank (paid)
 *  - composition: pays the tax on turnover:  Dr Composition Tax   Cr cash / bank
 * Amounts come from the GST accounts up to the end of the tax period, plus every GST payment
 * already made (so paying the same period twice finds nothing left to pay).
 */
import type { Ctx } from '../../context';
import { today } from '../../context';
import { fail } from '../../errors';
import { paymentAccountId, systemAccountId, type EntryLineInput } from '../../accounting/ledger';
import type { SystemKey } from '../../accounting/chart';
import { formatINR } from '../../../shared/money';
import { formatDate, isValidISODate } from '../../../shared/dates';
import type { SettlementMode } from '../../../shared/constants';
import { getEntryDetail, postManualVoucher, type SavedEntry } from '../accounting/journals';
import { resolveVoucherDate } from '../accounting/common';
import { gstConfig, useGstAccounts } from './common';
import { compositionTotals, periodText, type CompositionTotals } from './reports';

export type Head = 'cgst' | 'sgst' | 'igst';
export type Heads = Record<Head, number>;

const HEADS: Head[] = ['cgst', 'sgst', 'igst'];
const OUT: Record<Head, SystemKey> = { cgst: 'GST_OUT_CGST', sgst: 'GST_OUT_SGST', igst: 'GST_OUT_IGST' };
const IN: Record<Head, SystemKey> = { cgst: 'GST_IN_CGST', sgst: 'GST_IN_SGST', igst: 'GST_IN_IGST' };
const LABEL: Record<Head, string> = { cgst: 'CGST', sgst: 'SGST', igst: 'IGST' };

const zeroHeads = (): Heads => ({ cgst: 0, sgst: 0, igst: 0 });

export interface SetOff {
  /** Credit used ... */
  from: Head;
  /** ... to pay this tax. */
  to: Head;
  amount: number;
}

export interface RegularDue {
  mode: 'regular';
  upTo: string;
  /** Tax collected still to be paid, by head. */
  liability: Heads;
  /** Input tax credit available, by head. */
  credit: Heads;
  setOff: SetOff[];
  /** To pay from cash / bank, by head. */
  cash: Heads;
  cashTotal: number;
  /** Credit carried forward after the set-off. */
  creditLeft: Heads;
}

export interface CompositionDue extends CompositionTotals {
  mode: 'composition';
  from: string;
  to: string;
  /** GST payments already recorded that mention this period. */
  paidBefore: Array<{ entryId: number; voucherNo: string | null; date: string; amount: number }>;
}

/**
 * Set off credit against liability in the legal order (sections 49 / 49A, rule 88A): IGST credit is
 * used up first (IGST, then whichever of CGST / SGST its own credit cannot cover), then CGST credit
 * (CGST, then IGST) and SGST credit (SGST, then IGST).
 */
export function setOffCredit(liability: Heads, credit: Heads): { setOff: SetOff[]; cash: Heads; creditLeft: Heads } {
  const due = { ...liability };
  const left = { ...credit };
  const setOff: SetOff[] = [];
  const use = (from: Head, to: Head, max = Infinity) => {
    const amount = Math.min(left[from], due[to], max);
    if (amount <= 0) return;
    left[from] -= amount;
    due[to] -= amount;
    const same = setOff.find((s) => s.from === from && s.to === to);
    if (same) same.amount += amount;
    else setOff.push({ from, to, amount });
  };
  use('igst', 'igst');
  // IGST credit next goes where CGST / SGST credit falls short, then to the rest of CGST and SGST.
  use('igst', 'cgst', Math.max(0, due.cgst - left.cgst));
  use('igst', 'sgst', Math.max(0, due.sgst - left.sgst));
  use('igst', 'cgst');
  use('igst', 'sgst');
  use('cgst', 'cgst');
  use('cgst', 'igst');
  use('sgst', 'sgst');
  use('sgst', 'igst');
  return { setOff, cash: due, creditLeft: left };
}

/** Balance (debit - credit) of each GST account for the period up to `upTo`, counting every GST payment made. */
function gstBalances(ctx: Ctx, keys: Record<Head, SystemKey>, upTo: string, excludeEntryId?: number | null): Heads {
  const out = zeroHeads();
  for (const h of HEADS) {
    const id = ctx.db.value<number | null>('SELECT id FROM accounts WHERE system_key = ?', [keys[h]], null);
    if (!id) continue;
    out[h] = ctx.db.value<number>(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = ? AND e.is_void = 0 AND (e.date <= ? OR e.voucher_type = 'gst_payment') AND e.id <> ?`,
      [id, upTo, excludeEntryId ?? 0],
      0,
    );
  }
  return out;
}

function checkDate(d: string, what: string): void {
  if (!isValidISODate(d)) throw fail.validation(`Enter a valid ${what}`, { [what === 'period end' ? 'upTo' : 'date']: 'Enter a valid date' });
}

export function regularDue(ctx: Ctx, upTo: string): RegularDue {
  checkDate(upTo, 'period end');
  const out = gstBalances(ctx, OUT, upTo);
  const inp = gstBalances(ctx, IN, upTo);
  // Output accounts have credit balances (tax owed); input accounts debit balances (credit available).
  const liability = { cgst: Math.max(0, -out.cgst), sgst: Math.max(0, -out.sgst), igst: Math.max(0, -out.igst) };
  const credit = { cgst: Math.max(0, inp.cgst), sgst: Math.max(0, inp.sgst), igst: Math.max(0, inp.igst) };
  const s = setOffCredit(liability, credit);
  return { mode: 'regular', upTo, liability, credit, setOff: s.setOff, cash: s.cash, cashTotal: s.cash.cgst + s.cash.sgst + s.cash.igst, creditLeft: s.creditLeft };
}

export function compositionDue(ctx: Ctx, from: string, to: string): CompositionDue {
  checkDate(from, 'date');
  checkDate(to, 'period end');
  if (from > to) throw fail.validation('The period must start on or before its end.', { from: 'After the end date' });
  const text = periodText({ from, to });
  const paidBefore = ctx.db
    .all<{ id: number; voucher_no: string | null; date: string; amount: number }>(
      `SELECT e.id, e.voucher_no, e.date, (SELECT COALESCE(SUM(l.debit), 0) FROM journal_lines l WHERE l.entry_id = e.id) AS amount
         FROM journal_entries e WHERE e.voucher_type = 'gst_payment' AND e.is_void = 0 AND e.narration LIKE ? ORDER BY e.date, e.id`,
      [`%${text}%`],
    )
    .map((r) => ({ entryId: r.id, voucherNo: r.voucher_no, date: r.date, amount: r.amount }));
  return { mode: 'composition', from, to, ...compositionTotals(ctx, { from, to }), paidBefore };
}

export function gstDue(ctx: Ctx, input: { upTo: string; from?: string | null }): RegularDue | CompositionDue {
  const cfg = gstConfig(ctx);
  if (cfg.mode === 'none') throw fail.validation('The business is not registered for GST. Turn GST on in Settings > GST first.');
  if (cfg.mode === 'composition') return compositionDue(ctx, input.from || input.upTo.slice(0, 8) + '01', input.upTo);
  return regularDue(ctx, input.upTo);
}

export interface PayGstInput {
  /** End of the tax period (regular: tax up to this date; composition: with `from`). */
  upTo: string;
  from?: string | null;
  /** Payment date (default today). */
  date?: string | null;
  mode: SettlementMode;
  accountId?: number | null;
  /** Challan / reference number. */
  reference?: string | null;
}

export function payGst(ctx: Ctx, input: PayGstInput): SavedEntry {
  const cfg = gstConfig(ctx);
  if (cfg.mode === 'none') throw fail.validation('The business is not registered for GST. Turn GST on in Settings > GST first.');
  useGstAccounts(ctx);
  const date = resolveVoucherDate(ctx, input.date || today(ctx), 'A GST payment');
  if (date < input.upTo) {
    throw fail.validation(`The payment date must be on or after the end of the tax period (${formatDate(input.upTo)}).`, { date: 'Before the period end' });
  }
  const account = paymentAccountId(ctx, input.mode, input.accountId);
  const ref = input.reference?.trim() || null;
  const lines: EntryLineInput[] = [];
  let narration: string;
  let summary: string;

  if (cfg.mode === 'composition') {
    const due = compositionDue(ctx, input.from || input.upTo.slice(0, 8) + '01', input.upTo);
    if (due.tax <= 0) throw fail.validation(`There is no composition tax to pay for ${periodText(due)}.`);
    if (due.paidBefore.length) {
      throw fail.validation(`GST for ${periodText(due)} was already paid (${due.paidBefore.map((p) => p.voucherNo ?? `#${p.entryId}`).join(', ')}). Cancel that payment first to pay it again.`);
    }
    lines.push({ account: 'COMPOSITION_TAX', debit: due.tax, memo: `CGST ${formatINR(due.cgst)} + SGST ${formatINR(due.sgst)}` });
    lines.push({ account, credit: due.tax, memo: ref ? `Challan ${ref}` : null });
    narration = `Composition GST for ${periodText(due)} (${due.rate}% of turnover ${formatINR(due.turnover)})`;
    summary = `Paid composition GST of ${formatINR(due.tax)} for ${periodText(due)}`;
  } else {
    const due = regularDue(ctx, input.upTo);
    const setOffTotal = due.setOff.reduce((s, x) => s + x.amount, 0);
    if (!due.cashTotal && !setOffTotal) throw fail.validation(`No GST is due up to ${formatDate(input.upTo)}.`);
    const debit = zeroHeads();
    for (const s of due.setOff) debit[s.to] += s.amount;
    for (const h of HEADS) debit[h] += due.cash[h];
    for (const h of HEADS) if (debit[h]) lines.push({ account: OUT[h], debit: debit[h] });
    const creditUsed = zeroHeads();
    for (const s of due.setOff) creditUsed[s.from] += s.amount;
    for (const h of HEADS) {
      if (creditUsed[h]) lines.push({ account: IN[h], credit: creditUsed[h], memo: `${LABEL[h]} credit used` });
    }
    if (due.cashTotal) {
      const paid = HEADS.filter((h) => due.cash[h]).map((h) => `${LABEL[h]} ${formatINR(due.cash[h])}`).join(' + ');
      lines.push({ account, credit: due.cashTotal, memo: `${paid}${ref ? `, challan ${ref}` : ''}` });
    }
    narration = `GST up to ${formatDate(input.upTo)}: ${formatINR(setOffTotal)} set off from input credit${due.cashTotal ? `, ${formatINR(due.cashTotal)} paid` : ''}`;
    summary = `Recorded GST up to ${formatDate(input.upTo)}: ${formatINR(due.cashTotal)} paid, ${formatINR(setOffTotal)} set off from input credit`;
  }
  // Make sure the accounts the voucher needs exist (system keys resolve through the ledger).
  for (const l of lines) if (typeof l.account === 'string') systemAccountId(ctx, l.account);
  const { id, warnings } = postManualVoucher(ctx, { date, voucherType: 'gst_payment', narration, lines }, { action: 'gst.pay', summary: (no) => `${summary} (${no})` });
  return { ...getEntryDetail(ctx, id), warnings };
}

/** GST payments recorded (for the Pay GST page). */
export function gstPayments(ctx: Ctx, limit = 20) {
  return ctx.db
    .all<{ id: number; date: string; voucher_no: string | null; narration: string | null; is_void: number; amount: number }>(
      `SELECT e.id, e.date, e.voucher_no, e.narration, e.is_void,
              (SELECT COALESCE(SUM(l.debit), 0) FROM journal_lines l WHERE l.entry_id = e.id) AS amount
         FROM journal_entries e WHERE e.voucher_type = 'gst_payment' ORDER BY e.date DESC, e.id DESC LIMIT ?`,
      [limit],
    )
    .map((r) => ({ entryId: r.id, date: r.date, voucherNo: r.voucher_no, narration: r.narration, cancelled: !!r.is_void, amount: r.amount }));
}
