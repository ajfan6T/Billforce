import { describe, expect, it } from 'vitest';
import { createTestApp, ledgerProblems } from './helpers';
import { keepsOnOneLine, reportToHtml } from '../src/core/export/html';
import type { ReportData } from '../src/shared/report';
import { salaryRuleText, type SalaryCalc } from '../src/core/modules/employees/salary';

/** The <td> class of every cell of a column in the printed HTML, by column label. */
function cellClasses(html: string, label: string): string[] {
  const heads = [...html.matchAll(/<th class="([^"]*)"[^>]*>([^<]*)<\/th>/g)].map((m) => m[2]);
  const col = heads.indexOf(label);
  expect(col, `column "${label}" in ${heads.join(', ')}`).toBeGreaterThanOrEqual(0);
  const body = html.slice(html.indexOf('<tbody>'));
  return [...body.matchAll(/<tr class="[^"]*">(.*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<td class="([^"]*)"/g)][col]?.[1] ?? '');
}

describe('PDF / print layout', () => {
  it('keeps dates and short code columns on one line and lets long text wrap', () => {
    const report: ReportData = {
      title: 'Cash book',
      columns: [
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'at', label: 'When', type: 'datetime' },
        { key: 'no', label: 'No', nowrap: true },
        { key: 'particulars', label: 'Particulars' },
        { key: 'amount', label: 'Amount', type: 'money' },
        { key: 'free', label: 'Free date', type: 'date', nowrap: false },
      ],
      rows: [{ cells: { date: '2026-09-28', at: '2026-09-28 14:05:00', no: 'INV/26-27/0001', particulars: 'Sales - Bill INV/26-27/0001', amount: 14500, free: '2026-09-28' } }],
    };
    const html = reportToHtml(report);
    expect(html).toContain('<td class="left nowrap">28-09-2026</td>');
    expect(html).toContain('<td class="left nowrap">INV/26-27/0001</td>');
    expect(html).toContain('<td class="left">Sales - Bill INV/26-27/0001</td>');
    expect(html).toContain('<td class="right">145.00</td>');
    expect(html).toMatch(/<td class="left nowrap">28-09-2026 02:05 PM<\/td>/);
    expect(cellClasses(html, 'Free date')).toEqual(['left']);
    expect(html).toContain('<th class="left nowrap" style="text-align:left">Date</th>');
    expect(html).toMatch(/td\.nowrap \{ white-space: nowrap; \}/);
    expect(keepsOnOneLine({ key: 'x', label: 'X' })).toBe(false);
    expect(keepsOnOneLine({ key: 'x', label: 'X', type: 'date' })).toBe(true);
  });

  it('the books, statements and document lists mark their numbers, and the flag survives files.printReport / exportReport', async () => {
    const t = await createTestApp({ openingCash: 500000 });
    const c = await t.call('customers.create', { name: 'Ramesh Kumar', phone: '98765 43210' });
    await t.call('sales.create', { items: [{ itemName: 'Toor Dal', qty: 1, rate: 14500 }], payments: [{ mode: 'cash', amount: 14500 }] });
    await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Sugar', qty: 2, rate: 4800 }], payments: [] });
    await t.call('receipts.create', { customerId: c.id, amount: 5000, mode: 'cash' });
    const range = { from: '2026-04-01', to: '2026-09-28' };
    const reports = {
      cash: (await t.call('books.cashBook', { ...range, all: true })).report,
      day: (await t.call('books.dayBook', { ...range, all: true })).report,
      statement: await t.call('customers.statement', { customerId: c.id, ...range }),
    };
    const numberCol: Record<string, string> = { cash: 'No', day: 'No', statement: 'Number' };
    for (const [name, label] of Object.entries(numberCol)) {
      const report = (reports as any)[name] as ReportData;
      expect(report.columns.find((col) => col.label === label)?.nowrap, `${name}: ${label}`).toBe(true);
      // Reports reach the export routes from the screen; the zod schema must keep the flag.
      await t.call('files.printReport', { report });
      const html = t.platform.printed[t.platform.printed.length - 1].html;
      const noCells = cellClasses(html, label);
      expect(noCells.length).toBeGreaterThan(1);
      expect(noCells.every((cls) => cls.includes('nowrap')), `${name}: ${noCells.join(' | ')}`).toBe(true);
      expect(cellClasses(html, 'Date').every((cls) => cls.includes('nowrap'))).toBe(true);
      expect(cellClasses(html, 'Particulars').some((cls) => cls.includes('nowrap'))).toBe(false);
      expect(html).toMatch(/<td class="left nowrap">(INV|RCT)\/26-27\/\d{4}<\/td>/);
      await t.call('files.exportReport', { report, format: 'pdf' });
    }
    expect(ledgerProblems(t.app)).toEqual([]);
  });
});

describe('counts in report words', () => {
  it('says "1 item", "1 customer" and "1 paid day" for one', async () => {
    const t = await createTestApp();
    const c = await t.call('customers.create', { name: 'Ramesh Kumar' });
    await t.call('sales.create', { customerId: c.id, items: [{ itemName: 'Tea', qty: 1, rate: 1500 }], payments: [] });
    const range = { from: '2026-09-01', to: '2026-09-28' };
    const items = (await t.call('reports.salesByItem', range)).report;
    expect(items.rows[items.rows.length - 1].cells.item).toBe('Total (1 item)');
    const customers = (await t.call('reports.salesByCustomer', range)).report;
    expect(customers.rows[customers.rows.length - 1].cells.customer).toBe('Total (1 customer)');
    await t.call('sales.create', { items: [{ itemName: 'Sugar', qty: 1, rate: 4800 }], payments: [{ mode: 'cash', amount: 4800 }] });
    const both = (await t.call('reports.salesByItem', range)).report;
    expect(both.rows[both.rows.length - 1].cells.item).toBe('Total (2 items)');
    const calc = { salaryType: 'monthly', rate: 3000000, daysInMonth: 30, paidDays: 1, gross: 100000 } as SalaryCalc;
    expect(salaryRuleText(calc).working).toBe('₹30,000.00 × 1 paid day ÷ 30 days in the month = ₹1,000.00');
    expect(salaryRuleText({ ...calc, salaryType: 'daily', rate: 50000, paidDays: 1, gross: 50000 }).working).toBe('₹500.00 × 1 paid day = ₹500.00');
    expect(salaryRuleText({ ...calc, paidDays: 2, gross: 200000 }).working).toMatch(/× 2 paid days ÷/);
  });
});
