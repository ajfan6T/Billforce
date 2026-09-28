/**
 * Statement of account for a customer (Sundry Debtors) or supplier (Sundry
 * Creditors): opening balance, every non-void ledger line in date order with a
 * running balance, and the closing balance. Built straight from the ledger so
 * it always agrees with the party's balance.
 */
import type { Ctx } from '../../context';
import { addDays, describeRange } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import { VOUCHER_TYPE_LABELS, type VoucherType } from '../../../shared/constants';
import type { ReportData, ReportRow } from '../../../shared/report';
import { partyBalance, systemAccountId } from '../../accounting/ledger';
import { entrySourceLink } from '../../accounting/links';
import { balanceText, itemsSummary, modeText } from './common';

type StatementParty = 'customer' | 'supplier';

interface StatementEntry {
  id: number;
  date: string;
  voucher_type: VoucherType;
  voucher_no: string | null;
  source_type: string | null;
  source_id: number | null;
  narration: string | null;
  debit: number;
  credit: number;
}

const SOURCE_LABELS: Record<string, string> = {
  bill: 'Sales bill',
  credit_note: 'Return / credit note',
  receipt: 'Payment received',
  purchase: 'Purchase bill',
  supplier_payment: 'Payment made',
  expense: 'Expense',
  opening: 'Opening balance',
};

interface SourceInfo {
  type: string;
  number: string | null;
  particulars: string;
}

function lineItems(ctx: Ctx, sql: string, id: number) {
  return ctx.db.all<{ name: string; qty: number; unit: string | null }>(sql, [id]);
}

/** Document type, number and a short description of what the entry was for. */
export function describeEntrySource(ctx: Ctx, e: Pick<StatementEntry, 'voucher_type' | 'voucher_no' | 'source_type' | 'source_id' | 'narration'>): SourceInfo {
  const type = (e.source_type && SOURCE_LABELS[e.source_type]) || VOUCHER_TYPE_LABELS[e.voucher_type] || e.voucher_type;
  const id = e.source_id ?? 0;
  let number = e.voucher_no;
  let particulars = e.narration ?? '';
  switch (e.source_type) {
    case 'bill': {
      const b = ctx.db.get<{ bill_no: string; total: number; paid: number; credit: number; remarks: string | null }>(
        'SELECT bill_no, total, paid, credit, remarks FROM bills WHERE id = ?',
        [id],
      );
      if (b) {
        number = number ?? b.bill_no;
        const items = itemsSummary(lineItems(ctx, 'SELECT item_name AS name, qty, unit FROM bill_items WHERE bill_id = ? ORDER BY line_no', id));
        const paidNote = b.paid > 0 ? ` (bill ${formatINR(b.total)}, paid ${formatINR(b.paid)})` : '';
        particulars = (items || 'Sale') + paidNote;
      }
      break;
    }
    case 'credit_note': {
      const cn = ctx.db.get<{ cn_no: string; kind: string; reason: string | null; bill_no: string | null }>(
        'SELECT cn.cn_no, cn.kind, cn.reason, b.bill_no FROM credit_notes cn LEFT JOIN bills b ON b.id = cn.bill_id WHERE cn.id = ?',
        [id],
      );
      if (cn) {
        number = number ?? cn.cn_no;
        if (cn.kind === 'return') {
          const items = itemsSummary(lineItems(ctx, 'SELECT item_name AS name, qty, unit FROM credit_note_items WHERE credit_note_id = ? ORDER BY line_no', id));
          particulars = `Goods returned${cn.bill_no ? ` against ${cn.bill_no}` : ''}${items ? `: ${items}` : ''}`;
        } else {
          particulars = `Credit note${cn.reason ? `: ${cn.reason}` : ''}`;
        }
      }
      break;
    }
    case 'receipt': {
      const r = ctx.db.get<{ receipt_no: string; mode: string; reference: string | null; discount: number; remarks: string | null }>(
        'SELECT receipt_no, mode, reference, discount, remarks FROM customer_receipts WHERE id = ?',
        [id],
      );
      if (r) {
        number = number ?? r.receipt_no;
        particulars = modeText(r.mode, r.reference) + (r.discount ? ` · incl. discount ${formatINR(r.discount)}` : '') + (r.remarks ? ` · ${r.remarks}` : '');
      }
      break;
    }
    case 'purchase': {
      const p = ctx.db.get<{ purchase_no: string; supplier_bill_no: string | null; total: number; paid: number }>(
        'SELECT purchase_no, supplier_bill_no, total, paid FROM purchases WHERE id = ?',
        [id],
      );
      if (p) {
        number = number ?? p.purchase_no;
        const items = itemsSummary(lineItems(ctx, 'SELECT description AS name, qty, unit FROM purchase_items WHERE purchase_id = ? ORDER BY line_no', id));
        const bill = p.supplier_bill_no ? `Bill ${p.supplier_bill_no}: ` : '';
        const paidNote = p.paid > 0 ? ` (bill ${formatINR(p.total)}, paid ${formatINR(p.paid)})` : '';
        particulars = bill + (items || 'Purchase') + paidNote;
      }
      break;
    }
    case 'supplier_payment': {
      const r = ctx.db.get<{ payment_no: string; mode: string; reference: string | null; discount: number; remarks: string | null }>(
        'SELECT payment_no, mode, reference, discount, remarks FROM supplier_payments WHERE id = ?',
        [id],
      );
      if (r) {
        number = number ?? r.payment_no;
        particulars = modeText(r.mode, r.reference) + (r.discount ? ` · incl. discount ${formatINR(r.discount)}` : '') + (r.remarks ? ` · ${r.remarks}` : '');
      }
      break;
    }
    case 'expense': {
      const x = ctx.db.get<{ expense_no: string; account: string; remarks: string | null }>(
        'SELECT x.expense_no, a.name AS account, x.remarks FROM expenses x JOIN accounts a ON a.id = x.account_id WHERE x.id = ?',
        [id],
      );
      if (x) {
        number = number ?? x.expense_no;
        particulars = x.account + (x.remarks ? ` · ${x.remarks}` : '');
      }
      break;
    }
    case 'opening':
      particulars = 'Opening balance';
      break;
  }
  return { type, number, particulars: particulars || type };
}

export interface StatementOptions {
  partyType: StatementParty;
  partyId: number;
  partyName: string;
  partyPhone?: string | null;
  from: string;
  to: string;
}

export function partyStatement(ctx: Ctx, opts: StatementOptions): ReportData {
  const { partyType, partyId, from, to } = opts;
  const account = partyType === 'customer' ? 'AR' : 'AP';
  const opening = partyBalance(ctx, partyType, partyId, { account, to: addDays(from, -1) });
  const entries = ctx.db.all<StatementEntry>(
    `SELECT e.id, e.date, e.voucher_type, e.voucher_no, e.source_type, e.source_id, e.narration,
            SUM(l.debit) AS debit, SUM(l.credit) AS credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.party_type = ? AND l.party_id = ? AND l.account_id = ? AND e.is_void = 0 AND e.date >= ? AND e.date <= ?
      GROUP BY e.id
      ORDER BY e.date, e.id`,
    [partyType, partyId, systemAccountId(ctx, account), from, to],
  );

  const rows: ReportRow[] = [
    { cells: { date: from, type: '', number: '', particulars: 'Opening balance', debit: null, credit: null, balance: opening }, style: 'subtotal' },
  ];
  let running = opening;
  let totalDr = 0;
  let totalCr = 0;
  for (const e of entries) {
    running += e.debit - e.credit;
    totalDr += e.debit;
    totalCr += e.credit;
    const info = describeEntrySource(ctx, e);
    rows.push({
      cells: {
        date: e.date,
        type: info.type,
        number: info.number ?? '',
        particulars: info.particulars,
        debit: e.debit || null,
        credit: e.credit || null,
        balance: running,
      },
      link: entrySourceLink(ctx, e),
    });
  }
  rows.push({
    cells: { date: to, type: '', number: '', particulars: 'Closing balance', debit: totalDr, credit: totalCr, balance: running },
    style: 'total',
  });

  const isCustomer = partyType === 'customer';
  return {
    title: `Statement of account - ${opts.partyName}`,
    subtitle: [opts.partyPhone ? `Ph: ${opts.partyPhone}` : '', describeRange({ from, to })].filter(Boolean).join(' · '),
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 11 },
      { key: 'type', label: 'Type', width: 16 },
      { key: 'number', label: 'Number', width: 16 },
      { key: 'particulars', label: 'Particulars', width: 40 },
      { key: 'debit', label: isCustomer ? 'Debit (billed)' : 'Debit (paid)', type: 'money', width: 14 },
      { key: 'credit', label: isCustomer ? 'Credit (received)' : 'Credit (billed)', type: 'money', width: 14 },
      { key: 'balance', label: 'Balance', type: 'drcr', width: 16 },
    ],
    rows,
    summary: [
      { label: 'Opening balance', value: opening, type: 'drcr' },
      { label: isCustomer ? 'Bills & charges' : 'Payments & returns', value: totalDr, type: 'money' },
      { label: isCustomer ? 'Payments & returns' : 'Purchases & charges', value: totalCr, type: 'money' },
      { label: 'Closing balance', value: running, type: 'drcr' },
      { label: 'Status', value: balanceText(running, partyType), type: 'text' },
    ],
    notes: [
      isCustomer
        ? 'Dr = amount the customer owes you. Cr = advance paid by the customer.'
        : 'Cr = amount you owe the supplier. Dr = advance paid to the supplier.',
    ],
  };
}
