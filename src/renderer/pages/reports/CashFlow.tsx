import { DateRangePicker } from '../../components/report';
import { useQuery } from '../../hooks';
import { formatINR } from '../../../shared/money';
import { BalanceStatus, ReportLayout, useReportRange } from './common';

export function CashFlowPage() {
  const [range, setRange] = useReportRange('cashFlow.range', 'this_month');
  const q = useQuery('reports.cashFlow', { from: range.from, to: range.to });
  const f = q.data?.figures;
  return (
    <ReportLayout
      title="Cash flow"
      report={q.data?.report}
      loading={q.loading}
      error={q.error}
      onRetry={q.reload}
      filters={<DateRangePicker value={range} onChange={setRange} />}
      status={
        f && (
          <BalanceStatus
            ok={f.balanced}
            okText={
              <>
                Cash & bank went {f.netChange >= 0 ? 'up' : 'down'} by <b>{formatINR(Math.abs(f.netChange))}</b>, from {formatINR(f.opening)} to {formatINR(f.closing)}. This
                matches your cash and bank accounts.
              </>
            }
            badText={
              <>
                The statement ends at {formatINR(f.closing)} but your cash and bank accounts show {formatINR(f.actualClosing)}. Please contact support.
              </>
            }
          />
        )
      }
    />
  );
}
