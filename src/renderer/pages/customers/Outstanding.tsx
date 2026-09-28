import { useState } from 'react';
import { Card, Page, PageHeader } from '../../components/ui';
import { AsOnPicker, ExportButtons, ReportView } from '../../components/report';
import { useQuery } from '../../hooks';
import { useOpenLink } from '../../links';
import { todayISO } from '../../../shared/dates';

/** Customers with dues or advances as on a date. */
export function OutstandingPage() {
  const [asOf, setAsOf] = useState(todayISO());
  const report = useQuery('customers.outstanding', { asOf });
  const openLink = useOpenLink();
  return (
    <Page>
      <PageHeader title="Customer outstanding" subtitle="Who owes you money, and how long since they last paid" />
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
          emptyMessage="No customer owes you anything on this date."
        />
      </Card>
    </Page>
  );
}
