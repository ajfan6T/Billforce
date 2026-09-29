import { Link } from 'react-router';
import { useQuery } from '../../hooks';
import { InfoStatus, ReportLayout } from '../reports/common';

/** Recipe cost, margin and food cost % of every dish. */
export function MenuCostingPage() {
  const q = useQuery('menu.costing', undefined);
  return (
    <ReportLayout
      title="Menu costing"
      report={q.data}
      loading={q.loading}
      error={q.error}
      onRetry={q.reload}
      wide
      filters={
        <span className="small muted">
          Costs change as you buy ingredients at new prices. <Link to="/menu">Change recipes</Link>
        </span>
      }
      status={<InfoStatus>A food cost of 25–35% of the price is usual for restaurants; dishes much above that earn little.</InfoStatus>}
      emptyMessage="No dishes on the menu yet."
    />
  );
}
