import { useCallback, useEffect, useRef, useState } from 'react';
import { call, errorMessage, type ApiInput, type ApiOutput, type RouteName } from './api';
import { modalDepth } from './components/modal';
import { isScreenLocked } from './guards';

export interface QueryState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  /** Re-run the query. */
  reload: () => Promise<void>;
  setData: (d: T) => void;
}

/**
 * Load data from an API route. Re-runs whenever the input changes (compared
 * by value). Pass `null` as input to skip the call.
 */
export function useQuery<K extends RouteName>(name: K, input: ApiInput<K> | null, opts: { enabled?: boolean } = {}): QueryState<ApiOutput<K>> {
  const [data, setData] = useState<ApiOutput<K> | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(input);
  const seq = useRef(0);
  const enabled = opts.enabled !== false && input !== null;

  const run = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await (call as any)(name, input === undefined ? undefined : JSON.parse(key));
      if (my === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(errorMessage(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, key, enabled]);

  useEffect(() => {
    void run();
  }, [run]);

  return { data, loading, error, reload: run, setData };
}

export interface MutationState<K extends RouteName> {
  run: (input: ApiInput<K>) => Promise<ApiOutput<K>>;
  loading: boolean;
  error: string | null;
  fields: Record<string, string>;
  reset: () => void;
}

/** Call a changing API route. `run` rejects on error (and also stores the message). */
export function useMutation<K extends RouteName>(name: K): MutationState<K> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const run = useCallback(
    async (input: ApiInput<K>) => {
      setLoading(true);
      setError(null);
      setFields({});
      try {
        return await (call as any)(name, input);
      } catch (e: any) {
        setError(errorMessage(e));
        setFields(e?.fields ?? {});
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [name],
  );
  return { run, loading, error, fields, reset: () => (setError(null), setFields({})) };
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

function keyName(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey && e.key.length > 1) parts.push('shift');
  parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  return parts.join('+');
}

/**
 * Keyboard shortcuts, e.g. useHotkeys({ F2: newBill, 'ctrl+s': save, Escape: close }).
 * Function keys and ctrl combos work even while typing in an input.
 *
 * Shortcuts belong to the layer they were set up in: page shortcuts stop working while a dialog is open
 * (so F10 cannot save the bill behind "Clear this bill?"), and a dialog's own shortcuts (set up by the
 * component that renders the <Modal>) work only while it is the top-most one. Nothing fires while the
 * screen is locked.
 */
export function useHotkeys(map: HotkeyMap, deps: unknown[] = []): void {
  const ref = useRef(map);
  ref.current = map;
  // Modal depth when this component first set up its shortcuts. A component rendering <Modal open> sets up
  // its shortcuts after the modal opened (child effects run first), so it lands on the modal's layer.
  const layer = useRef<number | null>(null);
  useEffect(() => {
    if (layer.current === null) layer.current = modalDepth();
    const handler = (e: KeyboardEvent) => {
      if (isScreenLocked()) return;
      if (modalDepth() > (layer.current ?? 0)) return;
      const name = keyName(e);
      const fn = ref.current[name];
      if (!fn) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const always = /^F\d+$/.test(e.key) || name.startsWith('ctrl+') || name.startsWith('alt+') || e.key === 'Escape';
      if (typing && !always) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Persist a small piece of UI state (e.g. last chosen report period) in localStorage. */
export function useStoredState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem('bf:' + key);
      return s ? (JSON.parse(s) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      try {
        localStorage.setItem('bf:' + key, JSON.stringify(nv));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set];
}
