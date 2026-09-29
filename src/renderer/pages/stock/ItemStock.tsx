import { useParams } from 'react-router';
import { SlidersHorizontal } from 'lucide-react';
import { DateRangePicker } from '../../components/report';
import { LinkButton } from '../../components/ui';
import { useQuery } from '../../hooks';
import { useAuth } from '../../auth';
import { formatINR, formatQty } from '../../../shared/money';
import { InfoStatus, ReportLayout, useReportRange } from '../reports/common';
import { StockStatusBadge } from './StockLevels';
import './stock.css';

/** Stock history of one item: every movement in the period with the running balance. */
export function ItemStockPage() {
  const id = Number(useParams().id);
  const { can } = useAuth();
  const [range, setRange] = useReportRange('stock.item.range', 'this_month');
  const q = useQuery('stock.itemLedger', Number.isInteger(id) && id > 0 ? { itemId: id, from: range.from, to: range.to } : null);
  const d = q.data;
  return (
    <ReportLayout
      title={d ? `Stock of ${d.item.name}` : 'Item stock'}
      report={d?.report}
      loading={q.loading}
      error={q.error}
      onRetry={q.reload}
      filters={
        <>
          <DateRangePicker value={range} onChange={setRange} />
          {can('stock.manage') && d?.item.trackStock && (
            <LinkButton to={`/stock/adjustments/new?item=${id}`} size="sm" icon={<SlidersHorizontal size={15} />}>
              Adjust stock
            </LinkButton>
          )}
        </>
      }
      status={
        d?.stockNow && (
          <InfoStatus>
            {d.item.trackStock ? (
              <>
                In stock on {range.to.split('-').reverse().join('-')}: <b>{`${formatQty(d.stockNow.qty)} ${d.item.unit}`}</b>
                {d.stockNow.costKnown ? ` · average cost ${formatINR(Math.round(d.stockNow.avgCost))} · value ${formatINR(d.stockNow.value)}` : ' · no cost yet'}{' '}
                <StockStatusBadge status={d.stockNow.status} />
              </>
            ) : (
              'Stock is not tracked for this item.'
            )}
          </InfoStatus>
        )
      }
      linkPeriod={range}
    />
  );
}
