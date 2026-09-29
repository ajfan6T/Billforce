import { useEffect, useRef, useState, type Ref } from 'react';
import { call } from '../../api';
import { useDebounced, useQuery } from '../../hooks';
import type { ApiOutput } from '../../api';
import { formatINR } from '../../../shared/money';
import { formatDate } from '../../../shared/dates';

export type DescriptionSuggestion = ApiOutput<'purchases.descriptions'>[number];

/**
 * Item description with suggestions from past purchases (last unit and rate).
 * Unlike a type-ahead that grabs the first match, Enter only picks a suggestion
 * the user highlighted with the arrow keys; otherwise it moves on, so new
 * descriptions can be typed freely.
 */
export function DescriptionInput({
  value,
  onChange,
  onPick,
  onExactMatch,
  onEnter,
  supplierId,
  inputRef,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  /** A suggestion was chosen: fill unit and rate. */
  onPick: (s: DescriptionSuggestion) => void;
  /** The typed text matches a past description exactly. */
  onExactMatch: (s: DescriptionSuggestion) => void;
  onEnter: () => void;
  supplierId: number | null;
  inputRef: Ref<HTMLInputElement>;
  placeholder?: string;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const dq = useDebounced(value.trim(), 150);
  const q = useQuery('purchases.descriptions', open && dq ? { q: dq, supplierId, limit: 8 } : null);
  const lastMatched = useRef('');
  const options = open && dq ? (q.data ?? []).filter((o) => o.description.toLowerCase() !== value.trim().toLowerCase()) : [];

  /** When leaving the box, look up the exact description in past purchases. */
  const checkExact = async () => {
    const text = value.trim();
    if (!text || lastMatched.current === text.toLowerCase()) return;
    try {
      const res = await call('purchases.descriptions', { q: text, supplierId, limit: 5 });
      const hit = res.find((o) => o.description.toLowerCase() === text.toLowerCase()) ?? null;
      if (hit) {
        lastMatched.current = hit.description.toLowerCase();
        onExactMatch(hit);
      }
    } catch {
      /* suggestions are optional */
    }
  };

  useEffect(() => setActive(-1), [dq]);

  const pick = (o: DescriptionSuggestion) => {
    lastMatched.current = o.description.toLowerCase();
    onPick(o);
    setOpen(false);
    setActive(-1);
  };

  return (
    <div className="combobox">
      <input
        ref={inputRef}
        className="input"
        value={value}
        maxLength={200}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          void checkExact();
        }}
        onChange={(e) => {
          setOpen(true);
          // A highlight belongs to the suggestions for the old text: typing drops it at once, so a
          // fast Enter never picks a stale suggestion over what was typed.
          setActive(-1);
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && options.length) {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === 'ArrowUp' && options.length) {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, -1));
          } else if (e.key === 'Escape' && options.length) {
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === 'Enter' && !e.ctrlKey) {
            e.preventDefault();
            if (active >= 0 && options[active]) pick(options[active]);
            setOpen(false);
            onEnter();
          }
        }}
      />
      {options.length > 0 && (
        <ul className="combo-list" role="listbox">
          {options.map((o, i) => (
            <li
              key={o.description}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o);
              }}
            >
              <div className="combo-option">
                <span>{o.description}</span>
                <span className="sub">
                  {o.itemId && <span className="badge badge-green">stock item</span>} {o.rate ? `${formatINR(o.rate)}${o.unit ? `/${o.unit}` : ''}` : o.unit ?? ''}
                  {o.lastDate ? ` · ${formatDate(o.lastDate)}` : ''}
                </span>
              </div>
            </li>
          ))}
          <li className="combo-footer small muted">↑ ↓ to choose · Enter to use</li>
        </ul>
      )}
    </div>
  );
}
