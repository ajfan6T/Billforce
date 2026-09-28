/**
 * Employee ledger: advances given and recovered (Employee Advances) and salary
 * earned and paid (Salary Payable), with running balances of both. Built
 * straight from the journal so it always agrees with the accounts.
 */
import type { Ctx } from '../../context';
import { addDays, describeRange, monthLabel } from '../../../shared/dates';
import { formatINR } from '../../../shared/money';
import { PAYMENT_MODE_LABELS, type SettlementMode } from '../../../shared/constants';
import type { ReportData, ReportRow } from '../../../shared/report';
import { partyBalance, systemAccountId } from '../../accounting/ledger';
import { entrySourceLink } from '../../accounting/links';
import { getEmployeeRow } from './service';

interface LedgerEntry {
  id: number;
  date: string;
  voucher_type: string;
  voucher_no: string | null;
  source_type: string | null;
  source_id: number | null;
  narration: string | null;
  adv_dr: number;
  adv_cr: number;
  pay_dr: number;
  pay_cr: number;
}

const TYPE_LABELS: Record<string, string> = {
  advance: 'Advance',
  salary: 'Salary slip',
  salary_payment: 'Salary paid',
  opening: 'Opening balance',
};

function describe(ctx: Ctx, e: LedgerEntry): { type: string; number: string; particulars: string } {
  const type = (e.source_type && TYPE_LABELS[e.source_type]) || (e.voucher_type === 'journal' ? 'Journal' : TYPE_LABELS[e.voucher_type] ?? e.voucher_type);
  let number = e.voucher_no ?? '';
  let particulars = e.narration ?? '';
  const id = e.source_id ?? 0;
  switch (e.source_type) {
    case 'advance': {
      const a = ctx.db.get<{ advance_no: string; mode: SettlementMode; remarks: string | null }>('SELECT advance_no, mode, remarks FROM employee_advances WHERE id = ?', [id]);
      if (a) {
        number = a.advance_no;
        particulars = `given by ${PAYMENT_MODE_LABELS[a.mode]}${a.remarks ? ` · ${a.remarks}` : ''}`;
      }
      break;
    }
    case 'salary': {
      const s = ctx.db.get<{ salary_no: string; month: string; paid_days: number; gross: number; bonus: number; deductions: number }>(
        'SELECT salary_no, month, paid_days, gross, bonus, deductions FROM salaries WHERE id = ?',
        [id],
      );
      if (s) {
        number = s.salary_no;
        const extra = [s.bonus ? `bonus ${formatINR(s.bonus)}` : '', s.deductions ? `deductions ${formatINR(s.deductions)}` : ''].filter(Boolean).join(', ');
        particulars = `${monthLabel(s.month, true)} · ${s.paid_days} paid days · gross ${formatINR(s.gross)}${extra ? ` · ${extra}` : ''}`;
      }
      break;
    }
    case 'salary_payment': {
      const p = ctx.db.get<{ mode: SettlementMode; remarks: string | null; salary_no: string; month: string }>(
        'SELECT p.mode, p.remarks, s.salary_no, s.month FROM salary_payments p JOIN salaries s ON s.id = p.salary_id WHERE p.id = ?',
        [id],
      );
      if (p) {
        number = p.salary_no;
        particulars = `${PAYMENT_MODE_LABELS[p.mode]} for ${monthLabel(p.month, true)}${p.remarks ? ` · ${p.remarks}` : ''}`;
      }
      break;
    }
    case 'opening':
      particulars = 'advance given before you started using Billforce';
      break;
  }
  return { type, number, particulars: particulars ? `${type}: ${particulars}` : type };
}

export function employeeLedger(ctx: Ctx, employeeId: number, from: string, to: string): ReportData {
  const emp = getEmployeeRow(ctx, employeeId);
  const before = addDays(from, -1);
  const advOpening = partyBalance(ctx, 'employee', emp.id, { account: 'EMP_ADV', to: before });
  const dueOpening = 0 - partyBalance(ctx, 'employee', emp.id, { account: 'SALARY_PAYABLE', to: before });
  const advId = systemAccountId(ctx, 'EMP_ADV');
  const payId = systemAccountId(ctx, 'SALARY_PAYABLE');
  const entries = ctx.db.all<LedgerEntry>(
    `SELECT e.id, e.date, e.voucher_type, e.voucher_no, e.source_type, e.source_id, e.narration,
            SUM(CASE WHEN l.account_id = :adv THEN l.debit ELSE 0 END) AS adv_dr,
            SUM(CASE WHEN l.account_id = :adv THEN l.credit ELSE 0 END) AS adv_cr,
            SUM(CASE WHEN l.account_id = :pay THEN l.debit ELSE 0 END) AS pay_dr,
            SUM(CASE WHEN l.account_id = :pay THEN l.credit ELSE 0 END) AS pay_cr
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.party_type = 'employee' AND l.party_id = :emp AND l.account_id IN (:adv, :pay)
        AND e.is_void = 0 AND e.date >= :from AND e.date <= :to
      GROUP BY e.id
      ORDER BY e.date, e.id`,
    { adv: advId, pay: payId, emp: emp.id, from, to },
  );

  const rows: ReportRow[] = [
    {
      cells: { date: from, number: '', particulars: 'Balance brought forward', given: null, recovered: null, advBalance: advOpening, earned: null, paid: null, due: dueOpening },
      style: 'subtotal',
    },
  ];
  let adv = advOpening;
  let due = dueOpening;
  const t = { given: 0, recovered: 0, earned: 0, paid: 0 };
  for (const e of entries) {
    adv += e.adv_dr - e.adv_cr;
    due += e.pay_cr - e.pay_dr;
    t.given += e.adv_dr;
    t.recovered += e.adv_cr;
    t.earned += e.pay_cr;
    t.paid += e.pay_dr;
    const info = describe(ctx, e);
    rows.push({
      cells: {
        date: e.date,
        number: info.number,
        particulars: info.particulars,
        given: e.adv_dr || null,
        recovered: e.adv_cr || null,
        advBalance: adv,
        earned: e.pay_cr || null,
        paid: e.pay_dr || null,
        due,
      },
      link: entrySourceLink(ctx, e),
    });
  }
  rows.push({
    cells: { date: to, number: '', particulars: 'Closing balance', given: t.given, recovered: t.recovered, advBalance: adv, earned: t.earned, paid: t.paid, due },
    style: 'total',
  });

  return {
    title: `Employee ledger - ${emp.name}`,
    subtitle: describeRange({ from, to }),
    landscape: true,
    columns: [
      { key: 'date', label: 'Date', type: 'date', width: 11 },
      { key: 'number', label: 'Number', width: 15 },
      { key: 'particulars', label: 'Particulars', width: 44 },
      { key: 'given', label: 'Advance given', type: 'money', width: 13 },
      { key: 'recovered', label: 'Recovered', type: 'money', width: 13 },
      { key: 'advBalance', label: 'Advance left', type: 'money', width: 13 },
      { key: 'earned', label: 'Salary earned', type: 'money', width: 13 },
      { key: 'paid', label: 'Salary paid', type: 'money', width: 13 },
      { key: 'due', label: 'Salary due', type: 'money', width: 13 },
    ],
    rows,
    summary: [
      { label: 'Advance outstanding', value: adv, type: 'money' },
      { label: 'Salary due', value: due, type: 'money' },
      { label: 'Salary earned (net)', value: t.earned, type: 'money' },
      { label: 'Salary paid', value: t.paid, type: 'money' },
      { label: 'Advances given', value: t.given, type: 'money' },
      { label: 'Recovered from salary', value: t.recovered, type: 'money' },
    ],
    notes: [
      `Employee: ${emp.name}${emp.designation ? ` (${emp.designation})` : ''}${emp.phone ? `, Ph: ${emp.phone}` : ''}`,
      'Advance left = advances given and not yet recovered. Salary due = salary processed but not yet paid. Salary earned is the net salary after bonus, deductions and advance recovery.',
    ],
  };
}
