import { type KeyboardEvent, type ReactNode } from 'react';
import { Minus, Plus, ScanLine, Trash2 } from 'lucide-react';
import type { BillCalc } from '../../../shared/billing';
import { formatINR } from '../../../shared/money';
import { parseDiscountText } from './common';
import { FastMoneyInput, FastNumberInput, FastTextInput } from './inputs';

export interface PosLine {
  key: string;
  itemId: number | null;
  itemName: string;
  unit: string | null;
  qty: number | null;
  /** Paise; null until typed (free-text lines). */
  rate: number | null;
  /** "10%" or "25" (rupees). */
  discText: string;
  /** Current list rate of the item, to offer "use list rate". */
  defaultRate: number | null;
}

export type CellField = 'qty' | 'rate' | 'disc';

export function PosLines({
  lines,
  calc,
  canDiscount,
  flashKey,
  badKeys,
  onChange,
  onStep,
  onRemove,
  registerCell,
  onCellEnter,
  onFocusLine,
  empty,
}: {
  lines: PosLine[];
  calc: BillCalc;
  canDiscount: boolean;
  flashKey: string | null;
  /** Lines with a problem (missing rate, bad discount...). */
  badKeys: Set<string>;
  onChange: (key: string, patch: Partial<PosLine>) => void;
  /** Add delta to the quantity (never below the smallest quantity). */
  onStep: (key: string, delta: number) => void;
  onRemove: (key: string) => void;
  registerCell: (key: string, field: CellField, el: HTMLInputElement | null) => void;
  onCellEnter: (key: string, field: CellField) => void;
  onFocusLine: (key: string | null) => void;
  empty: ReactNode;
}) {
  const step = (l: PosLine, delta: number) => onStep(l.key, delta);
  const keys = (l: PosLine, field: CellField) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onCellEnter(l.key, field);
    } else if (field === 'qty' && (e.key === '+' || e.key === '=' || e.key === 'ArrowUp')) {
      e.preventDefault();
      step(l, 1);
    } else if (field === 'qty' && (e.key === '-' || e.key === 'ArrowDown')) {
      e.preventDefault();
      step(l, -1);
    }
  };

  if (!lines.length) {
    return (
      <div className="pos-lines-scroll">
        <div className="pos-empty">
          <ScanLine size={34} className="pe-icon" />
          {empty}
        </div>
      </div>
    );
  }

  return (
    <div className="pos-lines-scroll">
      <table className="sl-lines-table">
        <thead>
          <tr>
            <th className="r">#</th>
            <th>Item</th>
            <th style={{ textAlign: 'center' }}>Qty</th>
            <th>Unit</th>
            <th className="r">Rate</th>
            {canDiscount && <th className="r">Discount</th>}
            <th className="r">Amount</th>
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const c = calc.lines[i];
            const disc = parseDiscountText(l.discText);
            const discBad = !disc.valid || calc.problems.some((p) => p.line === i);
            const bad = badKeys.has(l.key) || discBad;
            return (
              <tr key={l.key} className={`${flashKey === l.key ? 'flash' : ''}${bad ? ' has-problem' : ''}`}>
                <td className="sl-ln-no">{i + 1}</td>
                <td className="sl-ln-name">
                  {l.itemName}
                  {!l.itemId && <span className="sl-ln-free">one-time</span>}
                </td>
                <td>
                  <div className="sl-qty-cell">
                    <button type="button" className="sl-qty-btn" tabIndex={-1} aria-label={`Less ${l.itemName}`} onClick={() => step(l, -1)}>
                      <Minus size={14} />
                    </button>
                    <FastNumberInput
                      aria-label={`Quantity of ${l.itemName}`}
                      value={l.qty}
                      onChange={(qty) => onChange(l.key, { qty })}
                      onKeyDown={keys(l, 'qty')}
                      inputRef={(el) => registerCell(l.key, 'qty', el)}
                      onFocus={() => onFocusLine(l.key)}
                    />
                    <button type="button" className="sl-qty-btn" tabIndex={-1} aria-label={`More ${l.itemName}`} onClick={() => step(l, 1)}>
                      <Plus size={14} />
                    </button>
                  </div>
                </td>
                <td className="sl-ln-unit">{l.unit || '—'}</td>
                <td className="sl-ln-rate">
                  <FastMoneyInput
                    ref={(el) => registerCell(l.key, 'rate', el)}
                    aria-label={`Rate of ${l.itemName}`}
                    value={l.rate}
                    onChange={(rate) => onChange(l.key, { rate })}
                    onKeyDown={keys(l, 'rate')}
                    onFocus={() => onFocusLine(l.key)}
                    placeholder="Rate"
                  />
                  {l.defaultRate !== null && l.rate !== null && l.defaultRate !== l.rate && (
                    <button type="button" className="sl-rate-hint" tabIndex={-1} title="Use the rate from the item list" onClick={() => onChange(l.key, { rate: l.defaultRate })}>
                      List rate {formatINR(l.defaultRate)}
                    </button>
                  )}
                </td>
                {canDiscount && (
                  <td className={`sl-ln-disc${discBad ? ' bad' : ''}`}>
                    <FastTextInput
                      ref={(el) => registerCell(l.key, 'disc', el)}
                      aria-label={`Discount on ${l.itemName}`}
                      title={discBad ? 'Discount is more than the amount, or not a valid number' : 'Type 10% for a percentage or 25 for ₹25'}
                      placeholder="₹ or %"
                      value={l.discText}
                      onFocus={() => onFocusLine(l.key)}
                      onKeyDown={keys(l, 'disc')}
                      onChange={(e) => onChange(l.key, { discText: e.target.value.replace(/[^0-9.%]/g, '') })}
                    />
                  </td>
                )}
                <td className="sl-ln-amount r">
                  {formatINR(c?.amount ?? 0)}
                  {c && c.discount > 0 && <span className="sl-ln-sub">−{formatINR(c.discount)} off</span>}
                </td>
                <td className="sl-ln-del">
                  <button type="button" className="icon-btn danger" tabIndex={-1} aria-label={`Remove ${l.itemName}`} title="Remove line (Ctrl+Delete)" onClick={() => onRemove(l.key)}>
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
