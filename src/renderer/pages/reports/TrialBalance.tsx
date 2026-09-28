import { DateRangePicker } from '../../components/report';
import { Checkbox } from '../../components/forms';
import { useQuery, useStoredState } from '../../hooks';
import { formatINR } from '../../../shared/money';
import { BalanceStatus, ReportLayout, useReportRange } from './common';

export function TrialBalancePage() {
  const [range, setRange] = useReportRange('trialBalance.range', 'this_fy');
  const [detail, setDetail] = useStoredState<boolean>('reports.trialBalance.detail', false);
  const q = useQuery('reports.trialBalance', { from: range.from, to: range.to, partyDetail: detail });
  const summary = q.data?.summary;
  const dr = summary?.find((s) => s.label.startsWith('Total debit'))?.value as number | undefined;
  const cr = summary?.find((s) => s.label.startsWith('Total credit'))?.value as number | undefined;
  return (
    <ReportLayout
      title="Trial balance"
      report={q.data}
      loading={q.loading}
      error={q.error}
      onRetry={q.reload}
      linkPeriod={range}
      wide
      filters={
        <>
          <DateRangePicker value={range} onChange={setRange} />
          <Checkbox checked={detail} onChange={setDetail} label="Show each customer, supplier and employee" />
        </>
      }
      status={
        dr !== undefined &&
        cr !== undefined && (
          <BalanceStatus
            ok={dr === cr}
            okText={
              <>
                <b>Balanced.</b> Debit and credit totals are both {formatINR(dr)}.
              </>
            }
            badText={
              <>
                <b>Does not balance</b>: debit {formatINR(dr)}, credit {formatINR(cr)}. Take a backup and contact support.
              </>
            }
          />
        )
      }
    />
  );
}
