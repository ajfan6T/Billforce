import { useState } from 'react';
import { Card, Page, PageHeader } from '../../components/ui';
import { AsOnPicker, ExportButtons, ReportView } from '../../components/report';
import { useQuery } from '../../hooks';
import { useOpenLink } from '../../links';
import { todayISO } from '../../../shared/dates';

/** What you owe each supplier as on a date. */
export function PayablesPage() {
  const [asOf, setAsOf] = useState(todayISO());
  const report = useQuery('suppliers.payables', { asOf });
  const openLink = useOpenLink();
  return (
    <Page>
      <PageHeader title="Supplier payables" subtitle="What you owe each supplier, and how long since you last paid" />
      <Card padded={false}>
        <div className="tab-toolbar">
          <AsOnPicker value={asOf} onChange={setAsOf} />
          <ExportButtons report={report.data} />
        </div>
        <ReportView
          report={report.data}
          loading={report.loading}
          error={report.error}
          onRetry={report.reload}
          onLink={openLink}
          hideTitle
          emptyMessage="Nothing is payable to any supplier on this date."
        />
      </Card>
    </Page>
  );
}
