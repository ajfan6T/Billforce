import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Search } from 'lucide-react';
import { formatIndianNumber, parseMoney } from '../../shared/money';

/* ------------------------------- Field ------------------------------- */

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className = '',
  inline,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
  inline?: boolean;
}) {
  return (
    <label className={`field${inline ? ' field-inline' : ''}${error ? ' has-error' : ''} ${className}`}>
      {label && (
        <span className="field-label">
          {label}
          {required && <span className="req">*</span>}
        </span>
      )}
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

/** Responsive grid for form fields. */
export function FormGrid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 | 4 }) {
  return <div className={`form-grid cols-${cols}`}>{children}</div>;
}

/* ------------------------------ Inputs ------------------------------- */

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className = '', ...rest }, ref) {
  return <input ref={ref} className={`input ${className}`} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className = '', rows = 3, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} className={`input ${className}`} {...rest} />;
});

export interface SelectOption<V extends string | number = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export function Select<V extends string | number = string>({
  value,
  onChange,
  options,
  placeholder,
  className = '',
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> & {
  value: V | null | undefined;
  onChange: (v: V) => void;
  options: Array<SelectOption<V>>;
  placeholder?: string;
}) {
  const numeric = options.length > 0 && typeof options[0].value === 'number';
  return (
    <select
      className={`input select ${className}`}
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => onChange((numeric ? Number(e.target.value) : e.target.value) as V)}
      {...rest}
    >
      {placeholder !== undefined && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <label className={`checkbox${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="field-hint block">{hint}</span>}
      </span>
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`switch${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden />
      {label && <span>{label}</span>}
    </label>
  );
}

export function SegmentedControl<V extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className = '',
}: {
  value: V;
  onChange: (v: V) => void;
  options: Array<{ value: V; label: ReactNode; icon?: ReactNode; title?: string; disabled?: boolean }>;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <div className={`segmented seg-${size} ${className}`} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          disabled={o.disabled}
          className={value === o.value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------ Money / quantity / date ------------------------ */

function assignRef<T>(ref: React.ForwardedRef<T>, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

/**
 * Select a number box's text on focus so that typing replaces it, without ever
 * swallowing or appending keystrokes. The select happens synchronously right
 * after the focus render: MoneyInput changes its text on focus ("2,100.00" ->
 * "2100"), which moves the caret to the end, and keys typed before a deferred
 * select() would be appended to the old value (a ₹2,100 rate typed as 2150.50
 * became ₹2,10,02,150.50). A deferred select() still runs after a mouse click
 * has placed the caret, but only while nothing has been typed.
 */
function useSelectOnFocus(focused: boolean) {
  const el = useRef<HTMLInputElement | null>(null);
  const typed = useRef(false);
  useLayoutEffect(() => {
    const node = el.current;
    if (focused && node && !typed.current && document.activeElement === node) node.select();
  }, [focused]);
  return {
    el,
    focused(node: HTMLInputElement) {
      typed.current = false;
      setTimeout(() => {
        if (!typed.current && document.activeElement === node) node.select();
      }, 0);
    },
    typedNow() {
      typed.current = true;
    },
  };
}

function paiseToEditText(p: number | null | undefined): string {
  if (p === null || p === undefined) return '';
  const r = p / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

export interface MoneyInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  /** Value in paise; null when empty. */
  value: number | null | undefined;
  onChange: (paise: number | null) => void;
  /** Show the ₹ adornment. Default true. */
  symbol?: boolean;
  allowNegative?: boolean;
}

/**
 * Rupee amount input. Accepts "1,23,456.50", "1500", "1.5k"; shows Indian
 * grouping when not focused. Value is always integer paise.
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onChange, symbol = true, allowNegative, className = '', onFocus, onBlur, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(paiseToEditText(value));
  const sel = useSelectOnFocus(focused);
  useEffect(() => {
    if (!focused) setText(paiseToEditText(value));
  }, [value, focused]);
  const display = focused ? text : value === null || value === undefined ? '' : formatIndianNumber(value / 100, 2);
  return (
    <div className={`input-adorn ${className}`}>
      {symbol && <span className="adorn">₹</span>}
      <input
        ref={(node) => {
          sel.el.current = node;
          assignRef(ref, node);
        }}
        className="input num"
        inputMode="decimal"
        value={display}
        onFocus={(e) => {
          setFocused(true);
          setText(paiseToEditText(value));
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
          else if (p !== null && (allowNegative || p >= 0)) onChange(p);
        }}
        {...rest}
      />
    </div>
  );
});

export interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  /** Maximum decimals allowed (quantity = 3). */
  decimals?: number;
}

/** Plain number input (quantities, days, percentages). */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onChange, decimals = 3, className = '', onFocus, onBlur, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  const sel = useSelectOnFocus(focused);
  useEffect(() => {
    if (!focused) setText(value === null || value === undefined ? '' : String(value));
  }, [value, focused]);
  return (
    <input
      ref={(node) => {
        sel.el.current = node;
        assignRef(ref, node);
      }}
      className={`input num ${className}`}
      inputMode="decimal"
      value={text}
      onFocus={(e) => {
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
        const t = e.target.value.replace(/,/g, '');
        const re = new RegExp(`^\\d*${decimals > 0 ? `(\\.\\d{0,${decimals}})?` : ''}$`);
        if (!re.test(t)) return;
        setText(t);
        if (t === '' || t === '.') onChange(null);
        else onChange(Number(t));
      }}
      {...rest}
    />
  );
});

/** Date input bound to "YYYY-MM-DD" strings (shown as DD-MM-YYYY on Indian-locale Windows). */
export const DateInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & { value: string | null | undefined; onChange: (v: string) => void }>(
  function DateInput({ value, onChange, className = '', ...rest }, ref) {
    return <input ref={ref} type="date" className={`input date ${className}`} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest} />;
  },
);

export function SearchInput({ value, onChange, placeholder = 'Search…', autoFocus, className = '' }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; className?: string }) {
  return (
    <div className={`input-adorn search ${className}`}>
      <span className="adorn">
        <Search size={16} />
      </span>
      <input className="input" type="search" value={value} autoFocus={autoFocus} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/* ------------------------------ Combobox ------------------------------ */

export interface ComboboxProps<T> {
  value: string;
  onInputChange: (text: string) => void;
  /** Load suggestions for the typed text (debounced). */
  loadOptions: (q: string) => Promise<T[]>;
  getKey: (t: T) => string | number;
  renderOption: (t: T) => ReactNode;
  onSelect: (t: T) => void;
  /** Enter pressed with no suggestion highlighted. */
  onEnterNoMatch?: (text: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Extra row at the bottom of the list, e.g. "+ Add new customer". */
  footer?: (close: () => void) => ReactNode;
  /** Show suggestions on focus even when empty. */
  openOnFocus?: boolean;
  className?: string;
  inputClassName?: string;
  'aria-label'?: string;
}

/** Type-ahead search with keyboard navigation (↑ ↓ Enter Esc). */
export const Combobox = forwardRef(function Combobox<T>(props: ComboboxProps<T>, ref: React.Ref<HTMLInputElement>) {
  const { value, onInputChange, loadOptions, getKey, renderOption, onSelect, onEnterNoMatch, placeholder, autoFocus, disabled, footer, openOnFocus, className = '', inputClassName = '' } = props;
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<T[]>([]);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const seq = useRef(0);
  const loaderRef = useRef(loadOptions);
  loaderRef.current = loadOptions;
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const my = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const res = await loaderRef.current(value);
        if (my === seq.current) {
          setOptions(res);
          setActive(res.length ? 0 : -1);
        }
      } catch {
        if (my === seq.current) setOptions([]);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [value, open]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const choose = (t: T) => {
    onSelect(t);
    setOpen(false);
    setActive(-1);
  };

  return (
    <div className={`combobox ${className}`} ref={wrapRef}>
      <input
        ref={ref}
        className={`input ${inputClassName}`}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={props['aria-label']}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        autoComplete="off"
        onFocus={() => openOnFocus && setOpen(true)}
        onChange={(e) => {
          onInputChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open) setOpen(true);
            else setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            if (open && active >= 0 && options[active]) {
              e.preventDefault();
              choose(options[active]);
            } else if (onEnterNoMatch) {
              e.preventDefault();
              setOpen(false);
              onEnterNoMatch(value);
            }
          } else if (e.key === 'Escape') {
            if (open) {
              e.stopPropagation();
              setOpen(false);
            }
          } else if (e.key === 'Tab') {
            setOpen(false);
          }
        }}
      />
      {open && (options.length > 0 || footer) && (
        <ul className="combo-list" id={listId} role="listbox">
          {options.map((o, i) => (
            <li
              key={getKey(o)}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
            >
              {renderOption(o)}
            </li>
          ))}
          {footer && <li className="combo-footer">{footer(() => setOpen(false))}</li>}
        </ul>
      )}
    </div>
  );
}) as <T>(props: ComboboxProps<T> & { ref?: React.Ref<HTMLInputElement> }) => React.ReactElement;
