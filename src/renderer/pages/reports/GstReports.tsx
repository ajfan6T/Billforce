import { useSearchParams } from 'react-router';
import { DateRangePicker } from '../../components/report';
import { SegmentedControl, Select } from '../../components/forms';
import { useQuery } from '../../hooks';
import { useFeatures } from '../../auth';
import { InfoStatus, ReportLayout, useReportRange } from './common';

type Tab = 'summary' | 'sales' | 'hsn' | 'purchases' | 'composition';
const REGULAR_TABS: Array<{ value: Tab; label: string }> = [
  { value: 'summary', label: 'GST summary' },
  { value: 'sales', label: 'Sales register' },
  { value: 'hsn', label: 'HSN summary' },
  { value: 'purchases', label: 'Purchase register' },
];
const COMPOSITION_TAB = { value: 'composition' as Tab, label: 'Composition' };

const TITLES: Record<Tab, string> = {
  summary: 'GST summary',
  sales: 'GST sales register',
  hsn: 'HSN summary',
  purchases: 'GST purchase register',
  composition: 'Composition scheme',
};

const HINTS: Record<Tab, string> = {
  summary: 'Tax collected, input tax credit and the difference, for your GSTR-3B. Export to Excel for your accountant.',
  sales: 'Every tax invoice and credit note, B2B (customers with GSTIN) and B2C, for your GSTR-1.',
  hsn: 'Sales by HSN code and rate, net of returns, for the HSN table of GSTR-1.',
  purchases: 'Purchases with GST and the credit claimed. Check it against GSTR-2B on the GST portal.',
  composition: 'Turnover and the composition tax on it, for your CMP-08 each quarter.',
};

/** GST summaries for filing: regular GST and / or composition, as the business is (or was) registered. */
export function GstReportsPage() {
  const features = useFeatures();
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useReportRange('gst.range', 'last_month');
  const tabs = [...(features.gstRegular ? REGULAR_TABS : []), ...(features.gstComposition ? [COMPOSITION_TAB] : [])];
  const tabParam = params.get('tab') as Tab | null;
  const preferred: Tab = features.gst === 'composition' || !features.gstRegular ? 'composition' : 'summary';
  const tab: Tab = tabs.some((t) => t.value === tabParam) ? tabParam! : tabs.some((t) => t.value === preferred) ? preferred : (tabs[0]?.value ?? 'summary');
  const kind = (params.get('kind') as 'all' | 'b2b' | 'b2c' | null) ?? 'all';
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };
  const period = { from: range.from, to: range.to };
  const on = tabs.length > 0;
  const summary = useQuery('gst.summary', on && tab === 'summary' ? period : null);
  const sales = useQuery('gst.salesRegister', on && tab === 'sales' ? { ...period, kind } : null);
  const hsn = useQuery('gst.hsnSummary', on && tab === 'hsn' ? period : null);
  const purchases = useQuery('gst.purchaseRegister', on && tab === 'purchases' ? period : null);
  const comp = useQuery('gst.compositionSummary', on && tab === 'composition' ? period : null);
  const q = tab === 'composition' ? comp : tab === 'summary' ? summary : tab === 'sales' ? sales : tab === 'hsn' ? hsn : purchases;

  if (!on) {
    return (
      <ReportLayout
        title="GST reports"
        subtitle="Your business is not registered for GST"
        report={undefined}
        loading={false}
        error="Turn GST on in Settings > Business settings > GST to see GST reports."
        onRetry={() => undefined}
        filters={null}
      />
    );
  }
  return (
    <ReportLayout
      title={TITLES[tab]}
      report={q.data ?? undefined}
      loading={q.loading}
      error={q.error}
      onRetry={q.reload}
      wide={tab === 'sales' || tab === 'hsn' || tab === 'purchases'}
      filters={
        <>
          {tabs.length > 1 && <SegmentedControl<Tab> size="sm" value={tab} onChange={(v) => setParam('tab', v)} options={tabs} />}
          <DateRangePicker
            value={range}
            onChange={setRange}
            presets={['this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_fy', 'last_fy', 'custom']}
          />
          {tab === 'sales' && (
            <Select<'all' | 'b2b' | 'b2c'>
              value={kind}
              onChange={(v) => setParam('kind', v)}
              aria-label="B2B or B2C"
              options={[
                { value: 'all', label: 'All sales' },
                { value: 'b2b', label: 'B2B (with GSTIN)' },
                { value: 'b2c', label: 'B2C (others)' },
              ]}
              style={{ width: 'auto' }}
            />
          )}
        </>
      }
      status={<InfoStatus>{HINTS[tab]}</InfoStatus>}
      linkPeriod={range}
    />
  );
}
