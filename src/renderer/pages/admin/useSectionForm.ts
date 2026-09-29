import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation } from '../../hooks';
import { useToast } from '../../feedback';
import type { AppSettings } from '../../../shared/settings';

export type FormSection = 'business' | 'gst' | 'stock' | 'receipt' | 'billing' | 'security' | 'backup';

/**
 * Local draft of one settings section: dirty tracking, save (only the changed
 * keys are sent) and field errors from the server.
 */
export function useSectionForm<K extends FormSection>(section: K, saved: AppSettings[K] | undefined, onSaved: (values: AppSettings[K]) => void) {
  const [draft, setDraft] = useState<AppSettings[K] | undefined>(saved);
  const m = useMutation('settings.update');
  const toast = useToast();
  useEffect(() => {
    setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(saved)]);

  const changedKeys = useMemo(() => {
    if (!draft || !saved) return [] as string[];
    return Object.keys(draft).filter((k) => JSON.stringify((draft as any)[k]) !== JSON.stringify((saved as any)[k]));
  }, [draft, saved]);

  const set = useCallback(<F extends keyof AppSettings[K]>(key: F, value: AppSettings[K][F]) => {
    setDraft((d) => (d ? ({ ...d, [key]: value } as AppSettings[K]) : d));
  }, []);

  const save = useCallback(
    async (message = 'Settings saved') => {
      if (!draft || !changedKeys.length) return false;
      const values = Object.fromEntries(changedKeys.map((k) => [k, (draft as any)[k]]));
      try {
        const res = await m.run({ section, values });
        setDraft(res.values as AppSettings[K]);
        onSaved(res.values as AppSettings[K]);
        toast.success(message);
        return true;
      } catch {
        return false;
      }
    },
    [draft, changedKeys, m, section, onSaved, toast],
  );

  /** Field error from the server, e.g. err('name') or err('prefixes.bill'). */
  const err = (key: string): string | null => m.fields[key] ?? null;

  return {
    draft,
    set,
    setDraft,
    dirty: changedKeys.length > 0,
    changedKeys,
    save,
    saving: m.loading,
    error: m.error,
    err,
    reset: () => {
      setDraft(saved);
      m.reset();
    },
  };
}
