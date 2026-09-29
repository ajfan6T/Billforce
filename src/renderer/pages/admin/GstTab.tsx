import { useEffect } from 'react';
import { Alert, Card } from '../../components/ui';
import { Field, FormGrid, SegmentedControl, Select, Switch, TextInput } from '../../components/forms';
import { useHotkeys } from '../../hooks';
import { useAuth } from '../../auth';
import type { AppSettings, GstSettings } from '../../../shared/settings';
import { COMPOSITION_RATES, GST_RATES, formatRate, gstinProblem, gstinState, normalizeGstin, stateLabel, type GstRegistration } from '../../../shared/gst';
import { useSectionForm } from './useSectionForm';
import { LivePreview } from './ReceiptTab';
import { SaveBar, SwitchRow } from './common';

const REGISTRATION_OPTIONS: Array<{ value: GstRegistration; label: string }> = [
  { value: 'unregistered', label: 'Not registered' },
  { value: 'regular', label: 'Registered (regular)' },
  { value: 'composition', label: 'Composition scheme' },
];

const COMPOSITION_HINTS: Record<number, string> = {
  1: '1% — shops, traders and manufacturers',
  5: '5% — restaurants (no alcohol)',
  6: '6% — other services',
};

export function GstTab({ settings, onSaved, onDirty }: { settings: AppSettings; onSaved: (v: GstSettings) => void; onDirty: (d: boolean) => void }) {
  const { refresh } = useAuth();
  const f = useSectionForm('gst', settings.gst, onSaved);
  useEffect(() => onDirty(f.dirty), [f.dirty, onDirty]);
  const save = async () => {
    // The menu shows the GST pages only for registered businesses.
    if (await f.save('GST settings saved')) await refresh();
  };
  useHotkeys({ 'ctrl+s': () => void save() }, [f.save]);
  const d = f.draft;
  if (!d) return null;
  const registered = d.registration !== 'unregistered';
  const gstin = normalizeGstin(d.gstin);
  const gstinError = registered ? (!gstin ? 'Enter the GSTIN of the business' : gstinProblem(gstin)) : null;
  const state = gstinState(gstin);
  const changedMode = d.registration !== settings.gst.registration;
  return (
    <div className="settings-layout">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!gstinError) void save();
        }}
      >
        <Card title="GST registration">
          <div className="stack">
            <SegmentedControl<GstRegistration> value={d.registration} onChange={(v) => f.set('registration', v)} options={REGISTRATION_OPTIONS} />
            <p className="muted mt-0 mb-0">
              {d.registration === 'unregistered'
                ? 'Bills are made without GST, exactly as now. Nothing about GST is shown anywhere.'
                : d.registration === 'regular'
                  ? 'Bills become tax invoices with CGST and SGST (or IGST for customers in another state). Purchases record the GST you paid, so it can be set off against the GST you collect.'
                  : 'Bills become "bills of supply" without tax. You pay a small tax on your turnover from your own money every quarter.'}
            </p>
            {registered && (
              <FormGrid>
                <Field label="GSTIN of the business" required hint={state ? `State: ${stateLabel(state)}` : '15 characters, e.g. 27AAPFU0939F1ZV'} error={f.err('gstin') ?? gstinError}>
                  <TextInput value={d.gstin} maxLength={20} onChange={(e) => f.set('gstin', e.target.value.toUpperCase())} placeholder="27AAPFU0939F1ZV" autoFocus />
                </Field>
              </FormGrid>
            )}
            {changedMode && (
              <Alert tone="blue">
                Bills, returns and purchases already saved keep the GST treatment they were made with. Only new ones follow this setting.
              </Alert>
            )}
          </div>
        </Card>
        {d.registration === 'regular' && (
          <Card title="Tax on your items">
            <div className="switch-list">
              <SwitchRow
                title="My rates include GST"
                hint={
                  d.ratesIncludeGst
                    ? 'The rate on the bill is what the customer pays; the GST inside it is shown separately. An item at ₹118 with 18% GST is ₹100 + ₹18 GST.'
                    : 'GST is added on top of the rate. An item at ₹100 with 18% GST comes to ₹118.'
                }
              >
                <Switch checked={d.ratesIncludeGst} onChange={(v) => f.set('ratesIncludeGst', v)} />
              </SwitchRow>
              <SwitchRow title="Usual GST rate" hint="Used for items without their own rate and for one-time lines. Set each item's rate and HSN code in Sales > Items.">
                <Select<number> value={d.defaultRate} onChange={(v) => f.set('defaultRate', v)} options={GST_RATES.map((r) => ({ value: r, label: formatRate(r) }))} aria-label="Usual GST rate" />
              </SwitchRow>
            </div>
          </Card>
        )}
        {d.registration === 'composition' && (
          <Card title="Composition tax">
            <div className="switch-list">
              <SwitchRow title="Tax rate on turnover" hint="See your GST registration certificate. Half is central tax (CGST), half state tax (SGST).">
                <Select<number>
                  value={d.compositionRate}
                  onChange={(v) => f.set('compositionRate', v)}
                  options={COMPOSITION_RATES.map((r) => ({ value: r, label: COMPOSITION_HINTS[r] ?? formatRate(r) }))}
                  aria-label="Composition tax rate"
                />
              </SwitchRow>
            </div>
          </Card>
        )}
        {f.error && <Alert tone="red">{f.error}</Alert>}
        <SaveBar dirty={f.dirty} saving={f.saving} onUndo={f.reset} disabled={!!gstinError} />
      </form>
      <div className="preview-col">
        <LivePreview gst={d} showDuplicateToggle={false} />
      </div>
    </div>
  );
}
