/**
 * Inputs for the billing counter that are safe for very fast typing.
 *
 * The shared inputs select their text in a setTimeout after focus (needed so
 * a mouse click does not undo the selection). A cashier who tabs into a box
 * and types immediately can beat that timeout, and the late select() then
 * swallows the digits already typed ("2.5" becomes ".5"). These inputs select
 * synchronously after the focus render and skip the late select once typing
 * has started.
 */
import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { formatIndianNumber, parseMoney } from '../../../shared/money';

function useSelectOnFocus() {
  const typed = useRef(false);
  return {
    focused(el: HTMLInputElement) {
      typed.current = false;
      setTimeout(() => {
        if (!typed.current && document.activeElement === el) el.select();
      }, 0);
    },
    typedNow() {
      typed.current = true;
    },
    get hasTyped() {
      return typed.current;
    },
  };
}

function setRef<T>(ref: React.ForwardedRef<T>, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

const toEdit = (p: number | null | undefined) => (p === null || p === undefined ? '' : Number.isInteger(p / 100) ? String(p / 100) : (p / 100).toFixed(2));

export interface FastMoneyInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: number | null | undefined;
  onChange: (paise: number | null) => void;
  symbol?: boolean;
}

/** Rupee amount in paise; shows Indian grouping when not focused. */
export const FastMoneyInput = forwardRef<HTMLInputElement, FastMoneyInputProps>(function FastMoneyInput(
  { value, onChange, symbol = true, className = '', onFocus, onBlur, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(toEdit(value));
  const el = useRef<HTMLInputElement | null>(null);
  const sel = useSelectOnFocus();
  useEffect(() => {
    if (!focused) setText(toEdit(value));
  }, [value, focused]);
  // The shown text changes on focus (1,234.00 -> 1234); select it before the next key press.
  useLayoutEffect(() => {
    if (focused && el.current && !sel.hasTyped) el.current.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);
  const display = focused ? text : value === null || value === undefined ? '' : formatIndianNumber(value / 100, 2);
  return (
    <div className={`input-adorn ${className}`}>
      {symbol && <span className="adorn">₹</span>}
      <input
        ref={(node) => {
          el.current = node;
          setRef(ref, node);
        }}
        className="input num"
        inputMode="decimal"
        value={display}
        onFocus={(e) => {
          setText(toEdit(value));
          setFocused(true);
          sel.focused(e.target);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        onChange={(e) => {
          sel.typedNow();
          const t = e.target.value;
          setText(t);
          const p = parseMoney(t);
          if (t.trim() === '') onChange(null);
          else if (p !== null && p >= 0) onChange(p);
        }}
        {...rest}
      />
    </div>
  );
});

/** Plain text box that selects its content on focus without eating fast keystrokes. */
export const FastTextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function FastTextInput({ onFocus, onChange, className = '', ...rest }, ref) {
  const sel = useSelectOnFocus();
  return (
    <input
      ref={ref}
      className={`input ${className}`}
      onFocus={(e) => {
        sel.focused(e.target);
        onFocus?.(e);
      }}
      onChange={(e) => {
        sel.typedNow();
        onChange?.(e);
      }}
      {...rest}
    />
  );
});

/** Number box (quantity, percent) that keeps up with +/- changes while focused. */
export function FastNumberInput({
  value,
  onChange,
  decimals = 3,
  max,
  inputRef,
  className = '',
  onFocus,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'max'> & {
  value: number | null;
  onChange: (v: number | null) => void;
  decimals?: number;
  max?: number;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const sel = useSelectOnFocus();
  useEffect(() => {
    const shown = text === '' || text === '.' ? null : Number(text);
    if (shown !== value) setText(value === null ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const re = new RegExp(`^\\d*${decimals > 0 ? `(\\.\\d{0,${decimals}})?` : ''}$`);
  return (
    <input
      ref={inputRef}
      className={`input num ${className}`}
      inputMode="decimal"
      value={text}
      onFocus={(e) => {
        sel.focused(e.target);
        onFocus?.(e);
      }}
      onChange={(e) => {
        sel.typedNow();
        const t = e.target.value.replace(/,/g, '');
        if (!re.test(t)) return;
        let n = t === '' || t === '.' ? null : Number(t);
        if (n !== null && max !== undefined && n > max) n = max;
        setText(n !== null && max !== undefined && Number(t) > max ? String(max) : t);
        onChange(n);
      }}
      {...rest}
    />
  );
}
