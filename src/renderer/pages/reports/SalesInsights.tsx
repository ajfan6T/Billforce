import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { BadgePercent, IndianRupee, ReceiptText, RotateCcw, ShoppingBag } from 'lucide-react';
import { Card, Page, PageHeader, Stat, StatGrid, Tabs } from '../../components/ui';
import { DateRangePicker, ExportButtons, ReportView } from '../../components/report';
import { BarList, ChartHeader, ColumnChart, MODE_COLORS, ShareBar, TrendChart } from '../../components/charts';
import { useQuery, useStoredState } from '../../hooks';
import { useOpenLink } from '../../links';
import { formatINR, formatQty } from '../../../shared/money';
import { datesBetween, describeRange, formatDate, monthLabel, monthsBetween, weekdayShort } from '../../../shared/dates';
import type { ReportRow } from '../../../shared/report';
import { useReportRange } from './common';

type Tab = 'day' | 'month' | 'item' | 'customer' | 'mode';

const TABS: Array<{ key: Tab; label: string; route: 'reports.salesByDay' | 'reports.salesByMonth' | 'reports.salesByItem' | 'reports.salesByCustomer' | 'reports.salesByPaymentMode' }> = [
  { key: 'day', label: 'Day', route: 'reports.salesByDay' },
  { key: 'month', label: 'Month', route: 'reports.salesByMonth' },
  { key: 'item', label: 'Item', route: 'reports.salesByItem' },
  { key: 'customer', label: 'Customer', route: 'reports.salesByCustomer' },
  { key: 'mode', label: 'Payment mode', route: 'reports.salesByPaymentMode' },
];

/** Report row label -> chart legend label, per payment mode. */
const MODE_ROWS: Array<{ key: keyof typeof MODE_COLORS; row: string; label: string }> = [
  { key: 'cash', row: 'Cash', label: 'Cash' },
  { key: 'upi', row: 'UPI', label: 'UPI' },
  { key: 'bank', row: 'Bank', label: 'Bank' },
  { key: 'credit', row: 'Credit (on account)', label: 'Credit' },
];

/** Label of the headline figure: bill totals less returns. It differs from the P&L's "Net sales" (sales less returns), hence the longer name. */
const NET_LABEL = 'Net sales after discounts';
const NET_TIP =
  'Bill totals after item and bill discounts and round off, less returns and credit notes. The Profit & loss "Net sales" is sales less returns only; it shows discounts and round off under indirect expenses.';

/** Tabs whose report summary only repeats the headline cards (the export keeps it). */
const HIDE_SUMMARY: Tab[] = ['day', 'month', 'customer', 'mode'];

const dataRows = (rows: ReportRow[] | undefined) => (rows ?? []).filter((r) => r.style !== 'total' && r.style !== 'section' && r.style !== 'subtotal');

export function SalesInsightsPage() {
  // Month-wise sales run through the financial year, so the Month tab keeps its own period (This financial year
  // until the user picks another); the other tabs share one (This month).
  const dayRange = useReportRange('sales.range', 'this_month');
  const monthRange = useReportRange('sales.monthRange', 'this_fy');
  const [storedTab, setStoredTab] = useStoredState<Tab>('reports.sales.tab', 'day');
  const [params, setParams] = useSearchParams();
  const urlTab = params.get('tab') as Tab | null;
  const tab: Tab = TABS.some((t) => t.key === urlTab) ? urlTab! : storedTab;
  const [range, setRange] = tab === 'month' ? monthRange : dayRange;
  const def = TABS.find((t) => t.key === tab)!;
  // Customer rows open the customer's account on the same period.
  const openLink = useOpenLink(range);
  const input = { from: range.from, to: range.to };
  const summary = useQuery('reports.salesSummary', input);
  const q = useQuery(def.route as 'reports.salesByDay', input);
  const s = summary.data;
  const days = useMemo(() => datesBetween(range.from, range.to), [range.from, range.to]);

  const pick = (t: string) => {
    setStoredTab(t as Tab);
    const next = new URLSearchParams(params);
    next.set('tab', t);
    // A period in the address (a dashboard drill-down) belongs to the tab it opened: the Month tab keeps its own
    // period (the financial year) and the other tabs share one, so moving between the two drops the linked period.
    if ((t === 'month') !== (tab === 'month')) for (const k of ['from', 'to', 'preset']) next.delete(k);
    setParams(next, { replace: true });
  };

  const chart = (() => {
    const data = q.data;
    if (!data) return <div className="rp-chart-placeholder" />;
    const values = data.chart.series[0]?.values ?? [];
    const labels = data.chart.labels;
    const empty = 'No sales in this period';
    switch (tab) {
      case 'day': {
        const titles = days.map((d) => `${weekdayShort(d)}, ${formatDate(d)}`);
        return (
          <>
            <ChartHeader title={`${NET_LABEL} by day`} note={values.length > 62 ? 'Point at the line to see a day' : 'Point at a column to see the day'} />
            {values.length > 62 ? (
              <TrendChart labels={labels} values={values} seriesName={NET_LABEL} tooltipTitles={titles} emptyMessage={empty} loading={q.loading} />
            ) : (
              <ColumnChart labels={labels} values={values} seriesName={NET_LABEL} tooltipTitles={titles} emptyMessage={empty} loading={q.loading} />
            )}
          </>
        );
      }
      case 'month': {
        const months = monthsBetween(range.from, range.to);
        return (
          <>
            <ChartHeader title={`${NET_LABEL} by month`} />
            <ColumnChart
              labels={labels.map((l) => l.replace(/ (\d{2})(\d{2})$/, " '$2"))}
              values={values}
              seriesName={NET_LABEL}
              tooltipTitles={months.map((m) => monthLabel(m, true))}
              emptyMessage={empty}
              loading={q.loading}
            />
          </>
        );
      }
      case 'item': {
        const rows = dataRows(data.report.rows).slice(0, 10);
        return (
          <>
            <ChartHeader title="Top items by amount" note={rows.length ? `Top ${rows.length}` : undefined} />
            <BarList
              loading={q.loading}
              emptyMessage={empty}
              total={dataRows(data.report.rows).reduce((sum, r) => sum + ((r.cells.amount as number) ?? 0), 0)}
              items={rows.map((r, i) => ({
                key: i,
                label: String(r.cells.item),
                value: (r.cells.amount as number) ?? 0,
                sub: `${formatQty((r.cells.netQty as number) ?? 0)} ${r.cells.unit ?? ''} · ${r.cells.bills ?? 0} bill${r.cells.bills === 1 ? '' : 's'}`,
              }))}
            />
          </>
        );
      }
      case 'customer': {
        const rows = dataRows(data.report.rows).slice(0, 10);
        return (
          <>
            <ChartHeader title="Top customers by net sales after discounts" note={rows.length ? 'Click a customer to open their account' : undefined} />
            <BarList
              loading={q.loading}
              emptyMessage={empty}
              total={s?.netSales}
              items={rows.map((r, i) => ({
                key: i,
                label: String(r.cells.customer),
                value: (r.cells.net as number) ?? 0,
                sub: `${r.cells.bills ?? 0} bill${r.cells.bills === 1 ? '' : 's'}${r.cells.credit ? ` · ${formatINR(r.cells.credit as number)} on credit` : ''}`,
                onClick: r.link ? () => openLink(r.link!) : undefined,
              }))}
            />
          </>
        );
      }
      case 'mode': {
        const byLabel = new Map(data.report.rows.map((r) => [r.cells.mode, r]));
        return (
          <>
            <ChartHeader title="How customers paid at billing" note={values.length ? `${labels.length} modes` : undefined} />
            <ShareBar
              legendColumns={4}
              loading={q.loading}
              emptyMessage={empty}
              items={MODE_ROWS.map((m) => ({ key: m.key, label: m.label, value: (byLabel.get(m.row)?.cells.amount as number) ?? 0, color: MODE_COLORS[m.key] }))}
            />
          </>
        );
      }
    }
  })();

  return (
    <Page wide>
      <PageHeader title="Sales insights" subtitle={`Sales ${describeRange(range)}`} back="/reports" actions={<ExportButtons report={q.data?.report} />} />
      <div className="rp-filterbar">
        <DateRangePicker value={range} onChange={setRange} />
        {s && s.cancelledBills > 0 && (
          <span className="small muted">
            {s.cancelledBills} cancelled bill{s.cancelledBills === 1 ? '' : 's'} ({formatINR(s.cancelledAmount)}) not counted
          </span>
        )}
      </div>
      <div className={summary.loading && s ? 'rp-dim' : ''}>
        <StatGrid>
          <Stat
            label={
              <span title={NET_TIP} className="rp-defined">
                {NET_LABEL}
              </span>
            }
            value={s ? formatINR(s.netSales) : '…'}
            icon={<IndianRupee size={16} />}
            tone="blue"
            hint={s ? `Gross ${formatINR(s.grossSales)}` : undefined}
          />
          <Stat label="Bills" value={s ? s.bills.toLocaleString('en-IN') : '…'} icon={<ReceiptText size={16} />} hint={s ? `${s.customers} named customer${s.customers === 1 ? '' : 's'}` : undefined} />
          <Stat label="Average bill" value={s ? formatINR(s.averageBill) : '…'} icon={<ShoppingBag size={16} />} />
          <Stat label="Discounts" value={s ? formatINR(s.discounts) : '…'} icon={<BadgePercent size={16} />} hint={s && s.grossSales ? `${((s.discounts / s.grossSales) * 100).toFixed(1)}% of gross` : undefined} />
          <Stat label="Returns" value={s ? formatINR(s.returns) : '…'} icon={<RotateCcw size={16} />} hint={s ? `${s.returnCount} return${s.returnCount === 1 ? '' : 's'} / credit note${s.returnCount === 1 ? '' : 's'}` : undefined} />
        </StatGrid>
      </div>
      <Card padded={false} className="rp-card">
        <div className="rp-tabs">
          <Tabs tabs={TABS.map((t) => ({ key: t.key, label: t.label }))} value={tab} onChange={pick} />
        </div>
        <div className="rp-chart">{chart}</div>
        <ReportView report={q.data && HIDE_SUMMARY.includes(tab) ? { ...q.data.report, summary: undefined } : q.data?.report} loading={q.loading} error={q.error} onRetry={q.reload} onLink={openLink} hideTitle emptyMessage="No sales in this period." maxHeight="60vh" />
      </Card>
    </Page>
  );
}
