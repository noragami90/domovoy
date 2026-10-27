// Home screens of the panel, like the pages of the NSPanel: which panels sit on which screen, in what order.
// Edited in the panel, kept in SQLite. Until the user saves their own, a default set is built from the rooms:
// «Дом» (clock, mode, scenes, who is home), «Устройства» (a panel per room), «Автоматика» (rules, variables).
// A panel is a word: clock, mode, scenes, people, rules, vars, or room:<name> ("room:" — devices without a room).
// Each panel is on at most one screen.
import { z } from 'zod';
import type { Store } from '../store/db.ts';

const KEY = 'screens';
const PANEL = /^(clock|mode|scenes|people|rules|vars|room:.{0,40})$/;

const screenSchema = z.object({
  name: z.string().trim().min(1, 'у экрана нужно имя').max(30, 'имя экрана — до 30 знаков'),
  panels: z.array(z.string().regex(PANEL, 'неизвестная панель')).max(24),
}).strict();

export const screensSchema = z.array(screenSchema).min(1, 'нужен хотя бы один экран').max(10, 'не больше 10 экранов')
  .superRefine((screens, ctx) => {
    const seen = new Set<string>();
    for (const [i, s] of screens.entries()) {
      for (const p of s.panels) {
        if (seen.has(p)) ctx.addIssue({ code: 'custom', path: [i, 'panels'], message: `панель «${p}» уже есть на другом экране` });
        seen.add(p);
      }
    }
  });

export type Screen = z.output<typeof screenSchema>;

export function defaultScreens(rooms: string[]): Screen[] {
  return [
    { name: 'Дом', panels: ['clock', 'mode', 'scenes', 'people'] },
    { name: 'Устройства', panels: [...rooms.map((r) => `room:${r}`), 'room:'] },
    { name: 'Автоматика', panels: ['rules', 'vars'] },
  ];
}

export function loadScreens(store: Store, rooms: string[]): { screens: Screen[]; custom: boolean } {
  const saved = screensSchema.safeParse(store.setting(KEY));
  return saved.success ? { screens: saved.data, custom: true } : { screens: defaultScreens(rooms), custom: false };
}

export function saveScreens(store: Store, input: unknown): Screen[] {
  const r = screensSchema.safeParse(input);
  if (!r.success) throw new Error(r.error.issues.map((i) => i.message).join('; '));
  store.saveSetting(KEY, r.data);
  return r.data;
}

export function resetScreens(store: Store): void { store.saveSetting(KEY, null); }

// A room was renamed or deleted in «Система»: its panel follows (or goes away) on the saved screens.
export function followRoom(store: Store, from: string, to: string | null): void {
  const saved = screensSchema.safeParse(store.setting(KEY));
  if (!saved.success) return; // the default set is rebuilt from the rooms anyway
  const panel = `room:${from}`;
  const next = saved.data.map((s) => ({ ...s, panels: s.panels.flatMap((p) => (p !== panel ? [p] : to === null ? [] : [`room:${to}`])) }));
  store.saveSetting(KEY, next);
}
