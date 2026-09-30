import { AsOnPicker } from '../../components/report';
import { Button } from '../../components/ui';
import { ChartHeader, ORDINAL_RAMP, ShareBar } from '../../components/charts';
import { useQuery } from '../../hooks';
import { formatINR } from '../../../shared/money';
import { fyOf, todayISO } from '../../../shared/dates';
import { ReportLayout, useAsOnDate } from './common';

const BUCKETS = [
  { key: 'b0', label: '0-30 days' },
  { key: 'b31', label: '31-60 days' },
  { key: 'b61', label: '61-90 days' },
  { key: 'b90', label: 'Over 90 days' },
] as const;

function AgeingPage({ kind }: { kind: 'receivables' | 'payables' }) {
  const [asOf, setAsOf] = useAsOnDate(`${kind}Ageing.asOf`);
  const q = useQuery(kind === 'receivables' ? 'reports.receivablesAgeing' : 'reports.payablesAgeing', { asOf });
  const totals = q.data?.totals;
  const today = todayISO();
  const who = kind === 'receivables' ? 'customers' : 'suppliers';
  // A row opens the party's account up to this date, so its closing balance is the balance shown.
  // (Shown as "This financial year" when the date is today.)
  const linkPeriod = { from: fyOf(asOf).start, to: asOf, preset: 'this_fy' as const };
  return (
    <ReportLayout
      title={kind === 'receivables' ? 'Receivables ageing' : 'Payables ageing'}
      subtitle={kind === 'receivables' ? 'Who owes you money, and for how long' : 'Whom you owe money, and for how long'}
      report={q.data?.report}
      loading={q.loading}
      error={q.error}
      onRetry={q.reload}
      linkPeriod={linkPeriod}
      wide
      filters={
        <>
          <AsOnPicker value={asOf} onChange={setAsOf} />
          <Button size="sm" variant={asOf === today ? 'primary' : 'secondary'} onClick={() => setAsOf(today)}>
            Today
          </Button>
        </>
      }
      emptyMessage={kind === 'receivables' ? 'No customer owes you anything on this date.' : 'You do not owe any supplier on this date.'}
    >
      {totals && totals.balance > 0 && (
        <div className="rp-chart">
          <ChartHeader
            title={`${kind === 'receivables' ? 'To collect' : 'To pay'}: ${formatINR(totals.balance)} from ${totals.parties} ${totals.parties === 1 ? who.slice(0, -1) : who}`}
            note="Older dues are darker"
          />
          <ShareBar
            legendColumns={4}
            loading={q.loading}
            items={BUCKETS.map((b, i) => ({ key: b.key, label: b.label, value: totals.buckets[b.key], color: ORDINAL_RAMP[i] }))}
          />
        </div>
      )}
    </ReportLayout>
  );
}

export function ReceivablesAgeingPage() {
  return <AgeingPage kind="receivables" />;
}

export function PayablesAgeingPage() {
  return <AgeingPage kind="payables" />;
}
