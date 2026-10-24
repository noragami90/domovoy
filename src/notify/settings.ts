// Notification settings: changed in the panel, kept in SQLite (no restart, no editing config.yaml).
import { z } from 'zod';
import type { Store } from '../store/db.ts';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const settingsSchema = z.object({
  // Quiet hours: ordinary notifications arrive without sound; urgent ones always ring.
  quiet: z.object({ enabled: z.boolean(), from: z.string().regex(HHMM, 'время: ЧЧ:ММ'), to: z.string().regex(HHMM, 'время: ЧЧ:ММ') }).strict(),
  // Urgent notifications repeat until someone presses «Принял».
  repeat: z.object({ everyMin: z.number().int().min(1).max(120), max: z.number().int().min(0).max(100) }).strict(),
  battery: z.object({ below: z.number().int().min(1).max(99) }).strict(),
  silence: z.object({ enabled: z.boolean() }).strict(),
}).strict();

export type NotifySettings = z.output<typeof settingsSchema>;

export const DEFAULT_SETTINGS: NotifySettings = {
  quiet: { enabled: true, from: '23:00', to: '08:00' },
  repeat: { everyMin: 5, max: 12 },
  battery: { below: 20 },
  silence: { enabled: true },
};

const KEY = 'notifications';

export function loadSettings(store: Store): NotifySettings {
  const saved = store.setting<Partial<NotifySettings>>(KEY) ?? {};
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  const r = settingsSchema.safeParse(merged);
  return r.success ? r.data : DEFAULT_SETTINGS;
}

export function saveSettings(store: Store, input: unknown): NotifySettings {
  const r = settingsSchema.safeParse(input);
  if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  store.saveSetting(KEY, r.data);
  return r.data;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

// "now" is the local HH:MM; a window may cross midnight (23:00–08:00).
export function inQuiet(s: NotifySettings, localHHMM: string): boolean {
  if (!s.quiet.enabled || s.quiet.from === s.quiet.to) return false;
  const now = minutes(localHHMM), from = minutes(s.quiet.from), to = minutes(s.quiet.to);
  return from < to ? now >= from && now < to : now >= from || now < to;
}
