import { Field, Select, TextInput } from './forms';
import { GST_STATES, gstinProblem, gstinState, normalizeGstin, stateLabel } from '../../shared/gst';

const STATE_OPTIONS = [
  { value: '', label: 'Same state as my business' },
  ...Object.entries(GST_STATES)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => ({ value: code, label: `${name} (${code})` })),
];

/** Problem with a typed GSTIN (empty is fine). */
export function gstinError(gstin: string): string | null {
  const g = normalizeGstin(gstin);
  return g ? gstinProblem(g) : null;
}

/**
 * GSTIN and state of a customer or supplier (only for businesses registered for GST). With a GSTIN the
 * state comes from its first two digits; without one, the state decides between CGST + SGST and IGST.
 */
export function PartyGstFields({
  gstin,
  stateCode,
  onChange,
  errors,
  who,
}: {
  gstin: string;
  stateCode: string;
  onChange: (v: { gstin: string; stateCode: string }) => void;
  errors?: Record<string, string>;
  who: 'customer' | 'supplier';
}) {
  const fromGstin = gstinState(gstin);
  const problem = gstinError(gstin);
  return (
    <>
      <Field
        label="GSTIN"
        hint={fromGstin && !problem ? stateLabel(fromGstin) : who === 'customer' ? 'For businesses buying from you (B2B)' : "From the supplier's bill, to claim the GST you pay"}
        error={errors?.gstin ?? problem}
      >
        <TextInput value={gstin} maxLength={20} onChange={(e) => onChange({ gstin: e.target.value.toUpperCase(), stateCode })} placeholder="15 characters" />
      </Field>
      <Field label="State" hint={fromGstin ? 'From the GSTIN' : 'Another state means IGST instead of CGST + SGST'} error={errors?.stateCode}>
        <Select<string> value={fromGstin ?? stateCode} disabled={!!fromGstin} onChange={(v) => onChange({ gstin, stateCode: v })} options={STATE_OPTIONS} aria-label="State" />
      </Field>
    </>
  );
}
