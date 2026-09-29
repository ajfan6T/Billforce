import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { DATE_PRESET_LABELS, isValidISODate, presetRange, todayISO, type DatePreset, type DateRange } from '../shared/dates';

/** Same shape as `RangeValue` of components/report (not imported, so this file stays free of DOM code for the core tests). */
type RangeValue = DateRange & { preset: DatePreset };

export interface AppLink {
  kind: string;
  id: number | string;
}

/**
 * The period a drill-down carries to the page it opens, as `?from=&to=` (and `&preset=` when it
 * came from a preset such as "This month", so the target page shows the same words). Pages that
 * show a period read it with `useLinkedRange` / `useLinkedPeriod`, so a figure clicked on a
 * report or the dashboard opens on the same dates and shows the same number.
 */
export interface LinkPeriod {
  from: string;
  to: string;
  preset?: DatePreset;
}

/** Record pages that show a period of entries: ledgers and customer / supplier / employee accounts. */
const PERIOD_KINDS = new Set(['account', 'customer', 'supplier', 'employee', 'stock_item']);

const PERIOD_PARAMS = ['from', 'to', 'preset'] as const;

/** Add a period to an app path: `/accounts/ledger?account=3` -> `/accounts/ledger?account=3&from=…&to=…`. */
export function withPeriod(path: string, period?: LinkPeriod | null): string {
  if (!period) return path;
  const [base, query = ''] = path.split('?');
  const p = new URLSearchParams(query);
  p.set('from', period.from);
  p.set('to', period.to);
  if (period.preset && period.preset !== 'custom') p.set('preset', period.preset);
  else p.delete('preset');
  return `${base}?${p.toString()}`;
}

/** App path for a document / record link (used by report rows, activity log, journal view). With a period, ledgers and party accounts open on it. */
export function linkPath(link: AppLink, period?: LinkPeriod | null): string {
  const path = basePath(link);
  return period && PERIOD_KINDS.has(link.kind) ? withPeriod(path, period) : path;
}

function basePath(link: AppLink): string {
  switch (link.kind) {
    case 'bill':
      return `/sales/bills/${link.id}`;
    case 'credit_note':
      return `/sales/returns/${link.id}`;
    case 'receipt':
      return `/customers/receipts/${link.id}`;
    case 'purchase':
      return `/purchases/${link.id}`;
    case 'supplier_payment':
      return `/purchases/payments/${link.id}`;
    case 'expense':
      return `/accounts/expenses/${link.id}`;
    case 'journal':
      return `/accounts/journals/${link.id}`;
    case 'salary':
      return `/employees/salary/${link.id}`;
    case 'advance':
      return `/employees/advances?id=${link.id}`;
    case 'customer':
      return `/customers/${link.id}`;
    case 'supplier':
      return `/suppliers/${link.id}`;
    case 'employee':
      return `/employees/${link.id}`;
    case 'account':
      return `/accounts/ledger?account=${link.id}`;
    case 'loan':
      return `/accounts/loans/${link.id}`;
    case 'stock_adjustment':
      return `/stock/adjustments/${link.id}`;
    case 'stock_item':
      return `/stock/items/${link.id}`;
    default:
      return '/';
  }
}

/**
 * Returns a function that opens a link (e.g. <ReportView onLink={useOpenLink()} />).
 * Pass the report's period so ledgers and party accounts open on the same dates.
 */
export function useOpenLink(period?: LinkPeriod | null): (link: AppLink) => void {
  const navigate = useNavigate();
  return (link) => navigate(linkPath(link, period));
}

/**
 * The period in a page address (`?from=&to=`, optionally `&preset=`, or `?preset=` alone), or null.
 * A preset is kept only while it still gives the same dates; otherwise the dates are shown as a custom range.
 */
export function periodFromParams(params: URLSearchParams, today: string = todayISO()): RangeValue | null {
  const from = params.get('from');
  const to = params.get('to');
  const p = params.get('preset');
  const preset = p && p !== 'custom' && Object.prototype.hasOwnProperty.call(DATE_PRESET_LABELS, p) ? (p as DatePreset) : null;
  if (from && to && isValidISODate(from) && isValidISODate(to) && from <= to) {
    if (preset) {
      const r = presetRange(preset, today);
      if (r.from === from && r.to === to) return { preset, from, to };
    }
    return { preset: 'custom', from, to };
  }
  if (preset && !from && !to) return { preset, ...presetRange(preset, today) };
  return null;
}

/** The period passed in the address by a drill-down link, if any (read once, e.g. as a page's starting range). */
export function useLinkedPeriod(): RangeValue | null {
  const [params] = useSearchParams();
  return periodFromParams(params);
}

/**
 * A page's remembered period, overridden by the period in the address while a drill-down link put
 * one there. Choosing another period takes it out of the address and remembers the new one as usual.
 */
export function useLinkedRange(value: RangeValue, set: (v: RangeValue) => void): [RangeValue, (v: RangeValue) => void] {
  const [params, setParams] = useSearchParams();
  const linked = periodFromParams(params);
  const change = useCallback(
    (v: RangeValue) => {
      if (PERIOD_PARAMS.some((k) => params.has(k))) {
        const next = new URLSearchParams(params);
        for (const k of PERIOD_PARAMS) next.delete(k);
        setParams(next, { replace: true });
      }
      set(v);
    },
    [params, setParams, set],
  );
  return [linked ?? value, change];
}

/** Copy the period of the current address into new search params (so switching account in a ledger keeps the dates). */
export function keepPeriod(from: URLSearchParams, into: URLSearchParams): URLSearchParams {
  for (const k of PERIOD_PARAMS) {
    const v = from.get(k);
    if (v) into.set(k, v);
  }
  return into;
}
