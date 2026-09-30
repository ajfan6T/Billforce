/**
 * Small dependency-free SVG / HTML charts for dashboards and reports.
 *
 * Design rules (see the data-viz method this follows):
 *  - Form by job: columns for magnitude over a few periods, a line / area for long
 *    trends, horizontal bars for ranked lists, a share bar for part-to-whole.
 *  - Colour by job: one series = slot 1 blue; payment modes = categorical slots 1-4
 *    in a FIXED order (colour follows the mode, never its rank); ordered buckets
 *    (ageing) = one-hue ramp light -> dark. All palettes were run through the
 *    validator against the white card surface.
 *  - Thin marks: bars <= 24px with a 4px rounded data end, 2px lines, >= 8px dots
 *    with a 2px surface ring, 2px surface gaps between touching segments, solid
 *    hairline grid. Text is always in text colours, never the series colour.
 *  - Selective direct labels (the peak and the latest value), a hover / keyboard
 *    tooltip on every mark, and the report table next to each chart as the
 *    accessible table view.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { formatINR } from '../../shared/money';
import './charts.css';

/* ------------------------------ Palette ------------------------------ */

/** Categorical slots 1-4 (validated on #ffffff: CVD ΔE >= 9.1, normal-vision ΔE >= 22.9). */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'] as const;
/** Fixed colour per payment mode, so a mode keeps its colour on every screen. */
export const MODE_COLORS: Record<'cash' | 'upi' | 'bank' | 'credit', string> = {
  cash: SERIES_COLORS[0],
  upi: SERIES_COLORS[1],
  bank: SERIES_COLORS[2],
  credit: SERIES_COLORS[3],
};
/** Ordinal ramp (one hue, light -> dark) for ordered buckets such as ageing. */
export const ORDINAL_RAMP = ['#8fdccd', '#34b5a0', '#0b8574', '#07504a'] as const;
/** Single-series charts use the app's teal accent. */
const ACCENT = '#0f9d8a';
const ACCENT_HOVER = '#0b6e61';
const GRID = '#e1ece9';
const BASELINE = '#c9ddd8';

/* ------------------------------ Formatting ------------------------------ */

function trimNum(v: number): string {
  const r = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return String(r).replace(/\.0$/, '');
}

/** Short Indian money for axes and labels: ₹950, ₹12.5K, ₹1.2L, ₹3.4Cr (input in paise). */
export function shortINR(paise: number): string {
  const r = paise / 100;
  const a = Math.abs(r);
  const sign = r < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}₹${trimNum(a / 1e7)}Cr`;
  if (a >= 1e5) return `${sign}₹${trimNum(a / 1e5)}L`;
  if (a >= 1e3) return `${sign}₹${trimNum(a / 1e3)}K`;
  return `${sign}₹${Math.round(a)}`;
}

function niceStep(range: number, count: number): number {
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const f = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return Math.max(100, f * mag); // never finer than ₹1
}

/** Clean axis ticks covering [min, max] (paise). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (lo === hi) return [0, 100000];
  const step = niceStep(hi - lo, count);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 2 && out.length < 12; v += step) out.push(Math.round(v));
  return out;
}

/* ------------------------------ Layout helpers ------------------------------ */

/** Width of an element, kept up to date as it resizes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Rect with a rounded data end (top for positive values, bottom for negative), square at the baseline. */
function barPath(x: number, y0: number, w: number, y1: number): string {
  const up = y1 < y0;
  const h = Math.abs(y0 - y1);
  const r = Math.min(4, w / 2, h);
  if (up) {
    return `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z`;
  }
  return `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 - r} V${y0} Z`;
}

const M = { top: 22, right: 12, bottom: 26, left: 58 };

interface TipState {
  x: number;
  title: ReactNode;
  rows: Array<{ color: string; label: string; value: string }>;
}

function Tooltip({ tip, width }: { tip: TipState | null; width: number }) {
  if (!tip) return null;
  const w = 184;
  // Beside the hovered mark (right of it, or left near the right edge) so the mark stays visible.
  const left = tip.x + 14 + w <= width ? tip.x + 14 : Math.max(0, tip.x - 14 - w);
  return (
    <div className="chart-tip" style={{ left, top: M.top - 6, width: w }} role="status" aria-live="polite">
      {tip.rows.map((r, i) => (
        <div className="chart-tip-row" key={i}>
          <span className="chart-tip-key" style={{ background: r.color }} aria-hidden />
          <span className="chart-tip-value">{r.value}</span>
          <span className="chart-tip-label">{r.label}</span>
        </div>
      ))}
      <div className="chart-tip-title">{tip.title}</div>
    </div>
  );
}

function ChartEmpty({ height, message }: { height: number; message: ReactNode }) {
  return (
    <div className="chart-empty" style={{ height }}>
      {message}
    </div>
  );
}

/** Index of the largest value (first one on ties); -1 when all are zero. */
function peakIndex(values: number[]): number {
  let best = -1;
  values.forEach((v, i) => {
    if (v > 0 && (best < 0 || v > values[best])) best = i;
  });
  return best;
}

function lastNonZero(values: number[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i]) return i;
  return -1;
}

function useKeyboardIndex(n: number, hover: number | null, setHover: (i: number | null) => void, onSelect?: (i: number) => void) {
  return (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      setHover(hover === null ? 0 : Math.min(n - 1, hover + 1));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHover(hover === null ? n - 1 : Math.max(0, hover - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHover(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHover(n - 1);
    } else if (e.key === 'Enter' && hover !== null && onSelect) {
      onSelect(hover);
    } else if (e.key === 'Escape') {
      setHover(null);
    }
  };
}

/* ------------------------------ Column chart ------------------------------ */

export interface ColumnChartProps {
  /** Axis labels, one per column. */
  labels: string[];
  /** Values in paise. */
  values: number[];
  /** What the values are, e.g. "Net sales" (shown in the tooltip and to screen readers). */
  seriesName: string;
  /** Longer label per column for the tooltip (e.g. "Mon, 28-09-2026"). */
  tooltipTitles?: string[];
  /** Plot height in px (axis labels are added below). */
  height?: number;
  format?: (paise: number) => string;
  emptyMessage?: ReactNode;
  /** Click / Enter on a column. */
  onSelect?: (index: number) => void;
  /** Dim the chart while new data loads (the previous picture stays). */
  loading?: boolean;
}

/** Vertical columns with a y-axis, hairline grid, selective value labels and a hover tooltip. */
export function ColumnChart({ labels, values, seriesName, tooltipTitles, height = 200, format = formatINR, emptyMessage = 'Nothing to show for this period', onSelect, loading }: ColumnChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  const total = height + M.top + M.bottom;
  const allZero = values.every((v) => !v);
  const geo = useMemo(() => {
    const ticks = niceTicks(Math.min(...values, 0), Math.max(...values, 0));
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const plotW = Math.max(10, width - M.left - M.right);
    const y = (v: number) => M.top + height - ((v - lo) / (hi - lo)) * height;
    const band = plotW / Math.max(1, n);
    const barW = Math.max(1, Math.min(24, band * 0.68));
    const every = Math.max(1, Math.ceil((n * 52) / plotW));
    return { ticks, y, band, barW, every, plotW };
  }, [values, width, height, n]);
  useEffect(() => setHover(null), [n]);
  const onKey = useKeyboardIndex(n, hover, setHover, onSelect);
  if (allZero) return <ChartEmpty height={total} message={emptyMessage} />;
  const { ticks, y, band, barW, every } = geo;
  const zeroY = y(0);
  const peak = peakIndex(values);
  const last = lastNonZero(values);
  const cx = (i: number) => M.left + i * band + band / 2;
  // Label the peak and the latest column, but never let a label sit on a neighbouring column
  // (the value is still in the tooltip and the table).
  const labelY = (i: number) => (values[i] >= 0 ? y(values[i]) - 6 : y(values[i]) + 14);
  const fits = (i: number) => {
    const half = (shortINR(values[i]).length * 6.6) / 2;
    return values.every((v, j) => {
      if (j === i || !v || Math.abs(cx(j) - cx(i)) >= half + barW / 2) return true;
      return values[i] >= 0 ? y(v) > labelY(i) + 3 : y(v) < labelY(i) - 12;
    });
  };
  const labelled = new Set([peak, last].filter((i) => i >= 0 && fits(i)));
  if (labelled.has(peak) && labelled.has(last) && peak !== last && Math.abs(peak - last) * band < 56) labelled.delete(last);
  const tip: TipState | null =
    hover !== null && hover < n
      ? { x: cx(hover), title: tooltipTitles?.[hover] ?? labels[hover], rows: [{ color: ACCENT, label: seriesName, value: format(values[hover]) }] }
      : null;
  const summary = `${seriesName} by ${n} periods. Highest ${peak >= 0 ? `${format(values[peak])} on ${tooltipTitles?.[peak] ?? labels[peak]}` : 'none'}.`;
  return (
    <div className={`chart${loading ? ' is-loading' : ''}`} ref={ref} style={{ height: total }}>
      {width > 0 && (
        <svg
          width={width}
          height={total}
          role="img"
          aria-label={summary}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          onPointerLeave={() => setHover(null)}
          className="chart-svg"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? BASELINE : GRID} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="chart-tick">
                {shortINR(t)}
              </text>
            </g>
          ))}
          {values.map((v, i) => {
            const x = M.left + i * band + (band - barW) / 2;
            return v ? <path key={i} d={barPath(x, zeroY, barW, y(v))} fill={hover === i ? ACCENT_HOVER : ACCENT} /> : null;
          })}
          {[...labelled].map((i) => (
            <text key={`v${i}`} x={cx(i)} y={labelY(i)} textAnchor="middle" className="chart-value">
              {shortINR(values[i])}
            </text>
          ))}
          {labels.map((l, i) =>
            // Counted back from the latest column so "today" / the current month is always labelled.
            (n - 1 - i) % every === 0 ? (
              <text key={`x${i}`} x={cx(i)} y={M.top + height + 18} textAnchor="middle" className="chart-xlabel">
                {l}
              </text>
            ) : null,
          )}
          {values.map((_, i) => (
            <rect
              key={`h${i}`}
              x={M.left + i * band}
              y={M.top - 16}
              width={band}
              height={height + 16}
              fill="transparent"
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onPointerEnter={() => setHover(i)}
              onPointerMove={() => hover !== i && setHover(i)}
              onClick={() => onSelect?.(i)}
            />
          ))}
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/* ------------------------------ Trend (line / area) ------------------------------ */

export interface TrendChartProps {
  labels: string[];
  values: number[];
  seriesName: string;
  tooltipTitles?: string[];
  height?: number;
  format?: (paise: number) => string;
  emptyMessage?: ReactNode;
  loading?: boolean;
}

/** One series over time: 2px line with a soft area wash, crosshair tooltip and the latest value labelled. */
export function TrendChart({ labels, values, seriesName, tooltipTitles, height = 200, format = formatINR, emptyMessage = 'Nothing to show for this period', loading }: TrendChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  const total = height + M.top + M.bottom;
  const onKey = useKeyboardIndex(n, hover, setHover);
  const geo = useMemo(() => {
    const ticks = niceTicks(Math.min(...values, 0), Math.max(...values, 0));
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const plotW = Math.max(10, width - M.left - M.right - 36);
    const y = (v: number) => M.top + height - ((v - lo) / (hi - lo)) * height;
    const x = (i: number) => M.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const every = Math.max(1, Math.ceil((n * 56) / plotW));
    return { ticks, y, x, every, plotW };
  }, [values, width, height, n]);
  if (values.every((v) => !v)) return <ChartEmpty height={total} message={emptyMessage} />;
  const { ticks, y, x, every, plotW } = geo;
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const last = n - 1;
  const peak = peakIndex(values);
  const nearest = (clientX: number, svg: SVGSVGElement) => {
    const rect = svg.getBoundingClientRect();
    const px = clientX - rect.left - M.left;
    return Math.max(0, Math.min(n - 1, Math.round(n <= 1 ? 0 : (px / plotW) * (n - 1))));
  };
  const tip: TipState | null =
    hover !== null && hover < n ? { x: x(hover), title: tooltipTitles?.[hover] ?? labels[hover], rows: [{ color: ACCENT, label: seriesName, value: format(values[hover]) }] } : null;
  return (
    <div className={`chart${loading ? ' is-loading' : ''}`} ref={ref} style={{ height: total }}>
      {width > 0 && (
        <svg
          width={width}
          height={total}
          role="img"
          aria-label={`${seriesName} over ${n} periods. Latest ${format(values[last])}${peak >= 0 ? `, highest ${format(values[peak])}` : ''}.`}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          className="chart-svg"
          onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget))}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? BASELINE : GRID} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="chart-tick">
                {shortINR(t)}
              </text>
            </g>
          ))}
          <path d={area} fill={ACCENT} fillOpacity={0.1} />
          <path d={line} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {labels.map((l, i) =>
            (n - 1 - i) % every === 0 ? (
              <text key={`x${i}`} x={x(i)} y={M.top + height + 18} textAnchor={i === 0 ? 'start' : 'middle'} className="chart-xlabel">
                {l}
              </text>
            ) : null,
          )}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={M.top - 4} y2={M.top + height} stroke={BASELINE} strokeWidth={1} shapeRendering="crispEdges" />}
          <circle cx={x(last)} cy={y(values[last])} r={4} fill={ACCENT} stroke="#fff" strokeWidth={2} />
          <text x={x(last) + 8} y={y(values[last])} dy="0.32em" className="chart-value">
            {shortINR(values[last])}
          </text>
          {hover !== null && hover !== last && <circle cx={x(hover)} cy={y(values[hover])} r={4} fill={ACCENT} stroke="#fff" strokeWidth={2} />}
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/* ------------------------------ Horizontal bar list ------------------------------ */

export interface BarListItem {
  key: string | number;
  label: string;
  /** Paise. */
  value: number;
  /** Small text under the label (e.g. "12 bills"). */
  sub?: string;
  onClick?: () => void;
}

/** Ranked list with a thin bar per row and the value at the bar's end (top items, top customers). */
export function BarList({ items, format = formatINR, emptyMessage = 'Nothing to show for this period', loading, total }: { items: BarListItem[]; format?: (paise: number) => string; emptyMessage?: ReactNode; loading?: boolean; total?: number }) {
  const [hover, setHover] = useState<string | number | null>(null);
  const max = Math.max(0, ...items.map((i) => i.value));
  if (!items.length || max <= 0) return <ChartEmpty height={120} message={emptyMessage} />;
  const sum = total ?? items.reduce((s, i) => s + Math.max(0, i.value), 0);
  return (
    <ul className={`barlist${loading ? ' is-loading' : ''}`} aria-label="Ranked list">
      {items.map((it) => {
        const pctW = Math.max(0, (it.value / max) * 100);
        const share = sum > 0 ? Math.round((it.value / sum) * 1000) / 10 : 0;
        const content = (
          <>
            <div className="barlist-line">
              <span className="barlist-label" title={it.label}>
                {it.label}
              </span>
              {it.sub && <span className="barlist-sub">{it.sub}</span>}
              <span className="barlist-value">{format(it.value)}</span>
            </div>
            <div className="barlist-track">
              <span className="barlist-bar" style={{ width: `${pctW}%`, background: hover === it.key ? ACCENT_HOVER : ACCENT }} />
            </div>
            {hover === it.key && (
              <span className="barlist-tip" role="status">
                {share.toFixed(1)}% of total
              </span>
            )}
          </>
        );
        return (
          <li key={it.key} onPointerEnter={() => setHover(it.key)} onPointerLeave={() => setHover(null)}>
            {it.onClick ? (
              <button type="button" className="barlist-row" onClick={it.onClick} onFocus={() => setHover(it.key)} onBlur={() => setHover(null)}>
                {content}
              </button>
            ) : (
              <div className="barlist-row">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------ Share bar ------------------------------ */

export interface ShareItem {
  key: string;
  label: string;
  /** Paise. */
  value: number;
  color: string;
}

/** Part-to-whole in one horizontal bar (2px gaps between segments) with a legend that carries every value. */
export function ShareBar({ items, format = formatINR, emptyMessage = 'Nothing to show for this period', legendColumns = 2, loading }: { items: ShareItem[]; format?: (paise: number) => string; emptyMessage?: ReactNode; legendColumns?: 1 | 2 | 4; loading?: boolean }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0);
  if (total <= 0) return <ChartEmpty height={84} message={emptyMessage} />;
  const pctOf = (v: number) => (Math.round((Math.max(0, v) / total) * 1000) / 10).toFixed(1);
  const shown = items.filter((i) => i.value > 0);
  const hovered = items.find((i) => i.key === hover);
  return (
    <div className={`sharebar${loading ? ' is-loading' : ''}`}>
      <div className="sharebar-track" role="img" aria-label={shown.map((i) => `${i.label} ${pctOf(i.value)}%`).join(', ')}>
        {shown.map((i) => (
          <span
            key={i.key}
            className={`sharebar-seg${hover === i.key ? ' hover' : ''}`}
            style={{ flexGrow: i.value, background: i.color }}
            onPointerEnter={() => setHover(i.key)}
            onPointerLeave={() => setHover(null)}
          />
        ))}
      </div>
      <div className="sharebar-tipline" aria-live="polite">
        {hovered ? (
          <>
            <b>{format(hovered.value)}</b> {hovered.label} · {pctOf(hovered.value)}%
          </>
        ) : (
          <span className="muted">Total {format(total)}</span>
        )}
      </div>
      <ul className={`sharebar-legend cols-${legendColumns}`}>
        {items.map((i) => (
          <li key={i.key} className={i.value > 0 ? '' : 'zero'} onPointerEnter={() => setHover(i.key)} onPointerLeave={() => setHover(null)}>
            <span className="sharebar-swatch" style={{ background: i.color }} aria-hidden />
            <span className="sharebar-name">{i.label}</span>
            <span className="sharebar-val">{format(i.value)}</span>
            <span className="sharebar-pct">{pctOf(i.value)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Heading row above a chart: title on the left, optional note / control on the right. */
export function ChartHeader({ title, note }: { title: ReactNode; note?: ReactNode }) {
  return (
    <div className="chart-header">
      <div className="chart-title">{title}</div>
      {note && <div className="chart-note">{note}</div>}
    </div>
  );
}
