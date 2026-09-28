import { type Ctx, now, today } from './context';
import { defaultSettings, type AppSettings, type SettingsSection } from '../shared/settings';

function merge<T>(defaults: T, stored: unknown): T {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaults;
  const out: any = Array.isArray(defaults) ? [...(defaults as any)] : { ...(defaults as any) };
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    const d = (defaults as any)?.[k];
    out[k] = d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object' ? merge(d, v) : v;
  }
  return out;
}

/** All settings, with defaults filled in for anything not saved yet. */
export function getSettings(ctx: Ctx): AppSettings {
  const defaults = defaultSettings(today(ctx));
  const rows = ctx.db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
  const stored: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      stored[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore corrupt value, fall back to default */
    }
  }
  const out = { ...defaults } as any;
  for (const section of Object.keys(defaults) as SettingsSection[]) {
    out[section] = merge(defaults[section], stored[section]);
  }
  return out as AppSettings;
}

export function getSection<K extends SettingsSection>(ctx: Ctx, section: K): AppSettings[K] {
  return getSettings(ctx)[section];
}

/** Merge a partial update into one settings section and save it. */
export function updateSection<K extends SettingsSection>(ctx: Ctx, section: K, patch: Partial<AppSettings[K]>): AppSettings[K] {
  const current = getSection(ctx, section);
  const next = merge(current, patch) as AppSettings[K];
  ctx.db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [section, JSON.stringify(next), now(ctx)],
  );
  return next;
}

/** Internal flags not exposed as user settings (e.g. setup completed). */
export function getMeta(ctx: Ctx, key: string): string | null {
  return ctx.db.value<string | null>('SELECT value FROM settings WHERE key = ?', ['meta.' + key], null);
}

export function setMeta(ctx: Ctx, key: string, value: string): void {
  ctx.db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ['meta.' + key, value, now(ctx)],
  );
}
