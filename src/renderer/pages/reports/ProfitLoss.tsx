import { DateRangePicker } from '../../components/report';
import { SegmentedControl } from '../../components/forms';
import { useQuery, useStoredState } from '../../hooks';
import { formatINR } from '../../../shared/money';
import { BalanceStatus, InfoStatus, ReportLayout, useReportRange } from './common';

type Compare = 'none' | 'previous_period' | 'previous_year';

export function ProfitLossPage() {
  const [range, setRange] = useReportRange('profitLoss.range', 'this_fy');
  const [compare, setCompare] = useStoredState<Compare>('reports.profitLoss.compare', 'none');
  const q = useQuery('reports.profitLoss', { from: range.from, to: range.to, compare });
  const f = q.data?.figures;
  return (
    <ReportLayout
      title="Profit & loss"
      report={q.data?.report}
      loading={q.loading}
      error={q.error}
      onRetry={q.reload}
      linkPeriod={range}
      wide={compare !== 'none'}
      filters={
        <>
          <DateRangePicker value={range} onChange={setRange} />
          <span className="rp-label">Compare with</span>
          <SegmentedControl<Compare>
            size="sm"
            value={compare}
            onChange={setCompare}
            options={[
              { value: 'none', label: 'None' },
              { value: 'previous_period', label: 'Previous period' },
              { value: 'previous_year', label: 'Same period last year' },
            ]}
          />
        </>
      }
      status={
        f &&
        (!f.netSales && !f.totalExpenses && !f.otherIncome ? (
          <InfoStatus>No sales, income or expenses were recorded in this period.</InfoStatus>
        ) : (
          <BalanceStatus
            ok={f.netProfit >= 0}
            badTone="warn"
            okText={
              <>
                You made a <b>profit of {formatINR(f.netProfit)}</b> in this period{f.netMargin !== null ? ` (${f.netMargin.toFixed(1)}% of net sales)` : ''}.
              </>
            }
            badText={
              <>
                Expenses were more than income: a <b>loss of {formatINR(-f.netProfit)}</b> in this period.
              </>
            }
          />
        ))
      }
      emptyMessage="No income or expenses in this period."
    />
  );
}
