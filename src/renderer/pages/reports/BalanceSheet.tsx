import { AsOnPicker } from '../../components/report';
import { Button } from '../../components/ui';
import { useQuery } from '../../hooks';
import { formatINR } from '../../../shared/money';
import { addDays, fyOf, todayISO } from '../../../shared/dates';
import { BalanceStatus, ReportLayout, useAsOnDate } from './common';

export function BalanceSheetPage() {
  const [asOf, setAsOf] = useAsOnDate('balanceSheet.asOf');
  const q = useQuery('reports.balanceSheet', { asOf });
  const totals = q.data?.totals;
  const today = todayISO();
  const lastFyEnd = addDays(fyOf(today).start, -1);
  return (
    <ReportLayout
      title="Balance sheet"
      report={q.data?.report}
      loading={q.loading}
      error={q.error}
      onRetry={q.reload}
      filters={
        <>
          <AsOnPicker value={asOf} onChange={setAsOf} />
          <Button size="sm" variant={asOf === today ? 'primary' : 'secondary'} onClick={() => setAsOf(today)}>
            Today
          </Button>
          <Button size="sm" variant={asOf === lastFyEnd ? 'primary' : 'secondary'} onClick={() => setAsOf(lastFyEnd)}>
            End of last year ({fyOf(lastFyEnd).name})
          </Button>
        </>
      }
      status={
        totals && (
          <BalanceStatus
            ok={totals.balanced}
            okText={
              <>
                <b>Balanced.</b> Assets {formatINR(totals.assets)} = Capital & liabilities {formatINR(totals.liabilities)}
              </>
            }
            badText={
              <>
                <b>Does not balance</b>: assets and capital & liabilities differ by {formatINR(Math.abs(totals.difference))}. Take a backup and contact support
                before closing the year.
              </>
            }
          />
        )
      }
    />
  );
}
