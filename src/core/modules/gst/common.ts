/**
 * GST building blocks used by sales, returns, purchases, items and parties:
 * the business's GST registration, party GSTIN / state fields and the GST
 * accounts (created when the business registers).
 */
import type { Ctx } from '../../context';
import { now } from '../../context';
import { fail } from '../../errors';
import { getSection } from '../../settings';
import { ensureGstAccounts } from '../../seed';
import { formatRate, gstinProblem, gstinState, isStateCode, normalizeGstin, type GstMode } from '../../../shared/gst';
import { taxByRate } from '../../../shared/billing';
import { formatAmount } from '../../../shared/money';
import type { ReceiptDoc } from '../../print/receipt';

export interface GstConfig {
  /** GST treatment of new documents. */
  mode: GstMode;
  gstin: string | null;
  /** State of the business (from its GSTIN). */
  stateCode: string | null;
  inclusive: boolean;
  defaultRate: number;
  compositionRate: number;
}

/** The business's current GST registration, as new bills and purchases use it. */
export function gstConfig(ctx: Ctx): GstConfig {
  const g = getSection(ctx, 'gst');
  const mode: GstMode = g.registration === 'regular' ? 'regular' : g.registration === 'composition' ? 'composition' : 'none';
  const gstin = mode === 'none' ? null : normalizeGstin(g.gstin) || null;
  return {
    mode,
    gstin,
    stateCode: gstinState(gstin),
    inclusive: g.ratesIncludeGst !== false,
    defaultRate: typeof g.defaultRate === 'number' ? g.defaultRate : 18,
    compositionRate: typeof g.compositionRate === 'number' ? g.compositionRate : 1,
  };
}

/** Make sure the GST accounts exist before posting tax to them. */
export function useGstAccounts(ctx: Ctx): void {
  ensureGstAccounts(ctx.db, now(ctx));
}

export interface PartyGstInput {
  /** undefined = unchanged; null / '' = none. */
  gstin?: string | null;
  /** State code for parties without a GSTIN (place of supply). undefined = unchanged. */
  stateCode?: string | null;
}

/** Validated gstin / state_code columns of a customer or supplier (only the fields given). */
export function partyGstColumns(input: PartyGstInput, current?: { gstin: string | null; state_code: string | null }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.gstin === undefined && input.stateCode === undefined) return out;
  const gstin = input.gstin === undefined ? (current?.gstin ?? null) : normalizeGstin(input.gstin) || null;
  if (gstin) {
    const problem = gstinProblem(gstin);
    if (problem) throw fail.validation(problem, { gstin: problem });
  }
  let state = input.stateCode === undefined ? (current?.state_code ?? null) : input.stateCode || null;
  if (gstin) state = gstinState(gstin);
  else if (state && !isStateCode(state)) throw fail.validation('Choose the state from the list', { stateCode: 'Choose a state' });
  out.gstin = gstin;
  out.state_code = state;
  return out;
}

/** Place of supply (state code) for a party: their state, else the business's own state. */
export function placeOfSupply(cfg: GstConfig, party: { gstin?: string | null; state_code?: string | null } | null): string | null {
  return gstinState(party?.gstin) ?? party?.state_code ?? cfg.stateCode;
}

/** GST by rate for a tax invoice: GST% | Taxable | CGST | SGST (or IGST). */
export function gstTable(items: Array<{ gstRate: number | null; taxable: number | null; cgst: number; sgst: number; igst: number }>, interState: boolean): ReceiptDoc['table'] {
  const rows = taxByRate(items).map((r) =>
    interState ? [formatRate(r.rate), formatAmount(r.taxable), formatAmount(r.igst)] : [formatRate(r.rate), formatAmount(r.taxable), formatAmount(r.cgst), formatAmount(r.sgst)],
  );
  return { head: interState ? ['GST', 'Taxable', 'IGST'] : ['GST', 'Taxable', 'CGST', 'SGST'], rows };
}
