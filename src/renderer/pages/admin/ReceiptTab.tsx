import { useEffect, useMemo, useState } from 'react';
import { Printer, Save } from 'lucide-react';
import { Alert, Button, Card } from '../../components/ui';
import { Checkbox, Field, FormGrid, SegmentedControl, Select, Switch, TextArea } from '../../components/forms';
import { ReceiptPreview } from '../../components/pickers';
import { useDebounced, useHotkeys, useQuery } from '../../hooks';
import { useToast } from '../../feedback';
import { call } from '../../api';
import type { AppSettings, BusinessSettings, GstSettings, ReceiptSettings } from '../../../shared/settings';
import { useSectionForm } from './useSectionForm';
import { BoxField, SwitchRow } from './common';

const MAX_TEXT = 500;

function CharCount({ value }: { value: string }) {
  return <div className={`char-count${value.length > MAX_TEXT ? ' over' : ''}`}>{value.length} / {MAX_TEXT}</div>;
}

/** Live preview of a sample bill with the (unsaved) business and receipt values. */
export function LivePreview({
  business,
  receipt,
  gst,
  showDuplicateToggle = true,
}: {
  business?: Partial<BusinessSettings>;
  receipt?: Partial<ReceiptSettings>;
  gst?: Partial<GstSettings>;
  showDuplicateToggle?: boolean;
}) {
  const [duplicate, setDuplicate] = useState(false);
  const input = useDebounced(JSON.stringify({ business: business ?? null, receipt: receipt ?? null, gst: gst ?? null, duplicate }), 300);
  const q = useQuery('settings.receiptPreview', JSON.parse(input));
  const width = (receipt?.paperWidth ?? q.data?.paperWidth ?? 80) as 80 | 58;
  return (
    <Card
      title="Preview"
      actions={showDuplicateToggle ? <Checkbox checked={duplicate} onChange={setDuplicate} label="As a reprint" /> : undefined}
    >
      <div className={q.loading ? 'report is-loading' : ''}>
        {q.error ? <Alert tone="red">{q.error}</Alert> : <ReceiptPreview html={q.data?.html} widthMm={width} height={640} />}
      </div>
      <p className="field-hint mb-0">A sample bill, shown the way it will print on {width} mm paper.</p>
    </Card>
  );
}

export function ReceiptTab({ settings, onSaved, onDirty }: { settings: AppSettings; onSaved: (v: ReceiptSettings) => void; onDirty: (d: boolean) => void }) {
  const f = useSectionForm('receipt', settings.receipt, onSaved);
  const printers = useQuery('print.listPrinters', undefined);
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  useEffect(() => onDirty(f.dirty), [f.dirty, onDirty]);
  useHotkeys({ 'ctrl+s': () => void f.save('Receipt settings saved') }, [f.save]);

  const d = f.draft;
  const printerOptions = useMemo(() => {
    const list = printers.data ?? [];
    const opts = [{ value: '', label: 'Ask every time' }, ...list.map((p) => ({ value: p.name, label: `${p.displayName}${p.isDefault ? ' (default)' : ''}` }))];
    if (d?.printerName && !list.some((p) => p.name === d.printerName)) opts.push({ value: d.printerName, label: `${d.printerName} (not connected now)` });
    return opts;
  }, [printers.data, d?.printerName]);

  if (!d) return null;
  const tooLong = d.header.length > MAX_TEXT || d.footer.length > MAX_TEXT;
  const noUpi = !settings.business.upiId;

  const testPrint = async () => {
    setTesting(true);
    try {
      const res = await call('settings.testPrint', { printerName: d.printerName, receipt: d as unknown as Record<string, unknown> });
      if (res.printed) toast.success(res.message);
      else toast.warning(res.message);
    } catch (e) {
      toast.error(e);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings-layout">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void f.save('Receipt settings saved');
        }}
      >
        <Card title="Receipt text">
          <FormGrid>
            <Field label="Header" hint="Printed under your business name, address and phone (e.g. timings, tagline)" error={f.err('header')}>
              <TextArea rows={3} value={d.header} onChange={(e) => f.set('header', e.target.value)} placeholder={'e.g. Open 8 am - 10 pm\nFree home delivery'} />
              <CharCount value={d.header} />
            </Field>
            <Field label="Footer" hint="Printed at the end of every receipt" error={f.err('footer')}>
              <TextArea rows={3} value={d.footer} onChange={(e) => f.set('footer', e.target.value)} placeholder="e.g. Thank you! Visit again." />
              <CharCount value={d.footer} />
            </Field>
          </FormGrid>
        </Card>

        <Card title="Printer & paper">
          <div className="stack">
            <FormGrid>
              <Field label="Receipt printer" hint="Choose your thermal printer to print bills without a print window" error={f.err('printerName')}>
                <Select<string> value={d.printerName} onChange={(v) => f.set('printerName', v)} options={printerOptions} aria-label="Receipt printer" />
              </Field>
              <Field label="Copies of each bill" error={f.err('copies')}>
                <Select<number> value={d.copies} onChange={(v) => f.set('copies', v)} options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: n === 1 ? '1 copy' : `${n} copies` }))} aria-label="Copies" />
              </Field>
              <BoxField label="Paper width">
                <SegmentedControl<'80' | '58'>
                  value={String(d.paperWidth) as '80' | '58'}
                  onChange={(v) => f.set('paperWidth', Number(v) as 80 | 58)}
                  options={[
                    { value: '80', label: '80 mm (3 inch)' },
                    { value: '58', label: '58 mm (2 inch)' },
                  ]}
                />
              </BoxField>
              <BoxField label="Text size">
                <SegmentedControl<ReceiptSettings['fontSize']>
                  value={d.fontSize}
                  onChange={(v) => f.set('fontSize', v)}
                  options={[
                    { value: 'small', label: 'Small' },
                    { value: 'normal', label: 'Normal' },
                    { value: 'large', label: 'Large' },
                  ]}
                />
              </BoxField>
            </FormGrid>
            <div className="row">
              <Button icon={<Printer size={16} />} loading={testing} onClick={testPrint}>
                Test print
              </Button>
              <span className="field-hint">Prints the sample bill with the settings on this page (even before saving).</span>
            </div>
          </div>
        </Card>

        <Card title="What to print">
          <div className="switch-list">
            <SwitchRow title="Print automatically" hint="Print the receipt as soon as a bill is saved">
              <Switch checked={d.autoPrint} onChange={(v) => f.set('autoPrint', v)} />
            </SwitchRow>
            <SwitchRow title="Customer name and phone" hint="When the bill has a customer">
              <Switch checked={d.showCustomer} onChange={(v) => f.set('showCustomer', v)} />
            </SwitchRow>
            <SwitchRow title="Cashier name" hint="Who made the bill">
              <Switch checked={d.showCashier} onChange={(v) => f.set('showCashier', v)} />
            </SwitchRow>
            <SwitchRow title="Amount in words" hint="e.g. Rupees One Thousand Three Hundred Thirty Three Only">
              <Switch checked={d.showAmountInWords} onChange={(v) => f.set('showAmountInWords', v)} />
            </SwitchRow>
            <SwitchRow title='Mark reprints as "DUPLICATE"' hint="When an old bill is printed again">
              <Switch checked={d.markDuplicate} onChange={(v) => f.set('markDuplicate', v)} />
            </SwitchRow>
            <SwitchRow
              title="UPI QR code for payment"
              hint={noUpi ? 'Add your UPI ID in the Business tab first' : 'Customers scan it with any UPI app to pay the exact amount'}
            >
              <SegmentedControl<ReceiptSettings['upiQr']>
                size="sm"
                value={d.upiQr}
                onChange={(v) => f.set('upiQr', v)}
                options={[
                  { value: 'never', label: 'Never' },
                  { value: 'unpaid', label: 'When unpaid', title: 'Only when the bill has an amount on credit' },
                  { value: 'always', label: 'Always' },
                ]}
              />
            </SwitchRow>
          </div>
        </Card>

        {f.error && <Alert tone="red">{f.error}</Alert>}
        <div className="settings-save">
          {f.dirty && <span className="unsaved-dot">Unsaved changes</span>}
          {f.dirty && (
            <Button variant="ghost" onClick={f.reset}>
              Undo changes
            </Button>
          )}
          <Button type="submit" variant="primary" icon={<Save size={16} />} kbd="Ctrl+S" loading={f.saving} disabled={!f.dirty || tooLong}>
            Save
          </Button>
        </div>
      </form>
      <div className="preview-col">
        <LivePreview receipt={d} />
      </div>
    </div>
  );
}
