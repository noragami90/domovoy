// Rule cards: plain YAML data with a strict schema. The engine, a future web panel and AI drafts
// all go through this one schema; anything that fails validation is rejected.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { parseDuration } from '../duration.ts';
import { POINT_RE } from '../engine/time.ts';

z.config(z.locales.ru()); // generic validation messages in Russian, like our own

const duration = z.string().transform((s, ctx) => {
  try { return parseDuration(s); } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); return z.NEVER; }
});
const scalar = z.union([z.string(), z.number(), z.boolean()]);

// "15" = 15 units of the attribute (e.g. humidity points), "15%" = 15% of the baseline.
const baselineDelta = z.union([z.number().positive(), z.string().regex(/^\d+(\.\d+)?%$/, 'пример: 15 или "15%"')])
  .transform((v) => (typeof v === 'number' ? { amount: v, relative: false } : { amount: Number(v.slice(0, -1)), relative: true }));

const baselineOptions = z.object({
  window: duration.default(parseDuration('24h')),
  exclude_recent: duration.default(parseDuration('30m')),
  min_samples: z.number().int().positive().default(10),
}).strict();

const deviceCondition = z.object({
  device: z.string().min(1),
  attr: z.string().min(1),
  is: scalar.optional(),
  not: scalar.optional(),
  above: z.number().optional(),
  below: z.number().optional(),
  above_baseline: baselineDelta.optional(),
  below_baseline: baselineDelta.optional(),
  baseline: baselineOptions.optional(),
  for: duration.optional(),
}).strict().refine(
  (c) => [c.is, c.not, c.above, c.below, c.above_baseline, c.below_baseline].filter((v) => v !== undefined).length === 1,
  { message: 'нужно ровно одно сравнение: is, not, above, below, above_baseline или below_baseline' },
);

const varCondition = z.object({
  var: z.string().min(1),
  is: scalar,
  for: duration.optional(),
}).strict();

// "between": two points — "HH:MM", "sunrise", "sunset", optionally shifted: "sunset-30m", "sunrise+1h".
// "days": mon…sun, or weekdays / weekend; the window counts from the day it starts on.
const DAY_KEYS: Record<string, number[]> = {
  sun: [0], mon: [1], tue: [2], wed: [3], thu: [4], fri: [5], sat: [6], weekdays: [1, 2, 3, 4, 5], weekend: [0, 6],
};
const point = z.string().regex(POINT_RE, 'время: "07:30", "sunset", "sunrise+30m", "sunset-1h"');
const timeCondition = z.object({
  time: z.object({
    between: z.tuple([point, point]),
    days: z.array(z.enum(Object.keys(DAY_KEYS) as [string, ...string[]])).min(1).optional()
      .transform((d) => (d ? [...new Set(d.flatMap((k) => DAY_KEYS[k]!))].sort() : undefined)),
  }).strict(),
}).strict();

// Picks the branch by which key is present, so errors point at the real problem
// (a plain union would only say "Invalid input").
function byKey<T extends Record<string, z.ZodType>>(branches: T, what: string) {
  type Out = z.output<T[keyof T]>;
  return z.unknown().transform((v, ctx): Out => {
    const key = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(branches).find((k) => k in v) : undefined;
    if (!key) {
      ctx.addIssue({ code: 'custom', message: `${what}: ожидается одно из — ${Object.keys(branches).join(', ')}` });
      return z.NEVER;
    }
    const r = branches[key]!.safeParse(v);
    if (!r.success) {
      for (const i of r.error.issues) ctx.addIssue({ code: 'custom', message: i.message, path: i.path });
      return z.NEVER;
    }
    return r.data as Out;
  });
}

export const conditionSchema = byKey({ device: deviceCondition, var: varCondition, time: timeCondition }, 'условие');

// Any action may carry "if": conditions checked right before it runs ("for" is not used there).
const when = { if: z.array(conditionSchema).min(1).optional() };
const action = byKey({
  set: z.object({ set: z.object({ device: z.string().min(1), attr: z.string().min(1), to: scalar }).strict(), ...when }).strict(),
  // urgent: rings even in quiet hours and repeats until someone presses «Принял».
  notify: z.object({ notify: z.string().min(1), urgent: z.boolean().optional(), ...when }).strict(),
  set_var: z.object({ set_var: z.object({ var: z.string().min(1), to: scalar }).strict(), ...when }).strict(),
  // Turn off every switch and channel that is on, except the listed devices and protected ones.
  all_off: z.object({ all_off: z.object({ except: z.array(z.string()).default([]) }).strict().default({ except: [] }), ...when }).strict(),
  scene: z.object({ scene: z.string().min(1), ...when }).strict(),
}, 'действие');

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id: латиница в нижнем регистре, цифры и дефис');

// Scenes: a named list of actions started by a button, a Telegram command or a rule.
export const sceneSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  do: z.array(action).min(1),
}).strict();

export const ruleSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
  when: byKey({
    all: z.object({ all: z.array(conditionSchema).min(1, 'нужно хотя бы одно условие') }).strict(),
    any: z.object({ any: z.array(conditionSchema).min(1, 'нужно хотя бы одно условие') }).strict(),
  }, 'when'),
  then: z.array(action).min(1),
  otherwise: z.object({ after: duration.default(0), do: z.array(action).min(1) }).strict().optional(),
  cooldown: duration.optional(),
}).strict();

export type Rule = z.output<typeof ruleSchema>;
export type Condition = z.output<typeof conditionSchema>;
export type DeviceCondition = z.output<typeof deviceCondition>;
export type Action = z.output<typeof action>;
export type Scene = z.output<typeof sceneSchema>;
export type TimeCondition = z.output<typeof timeCondition>;

export const isDeviceCondition = (c: Condition): c is DeviceCondition => 'device' in c;
export const isTimeCondition = (c: Condition): c is TimeCondition => 'time' in c;
export const isVarCondition = (c: Condition): c is z.output<typeof varCondition> => 'var' in c;
export const conditionsOf = (rule: Rule): Condition[] => ('all' in rule.when ? rule.when.all : rule.when.any);
export const modeOf = (rule: Rule): 'all' | 'any' => ('all' in rule.when ? 'all' : 'any');

export function parseRule(source: unknown, origin = 'rule'): Rule {
  const result = ruleSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.') || '(корень)'}: ${i.message}`).join('\n');
    throw new Error(`${origin}: карточка правила не прошла проверку\n${issues}`);
  }
  return result.data;
}

export function parseScene(source: unknown, origin = 'scene'): Scene {
  const result = sceneSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.') || '(корень)'}: ${i.message}`).join('\n');
    throw new Error(`${origin}: карточка сцены не прошла проверку\n${issues}`);
  }
  return result.data;
}

function loadDir<T extends { id: string }>(dir: string, parse: (src: unknown, origin: string) => T, what: string): T[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const items = files.map((f) => parse(YAML.parse(readFileSync(join(dir, f), 'utf8')), f));
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) throw new Error(`Повторяется id ${what}: ${it.id}`);
    seen.add(it.id);
  }
  return items;
}

export const loadRules = (dir: string): Rule[] => loadDir(dir, parseRule, 'правила');
export const loadScenes = (dir: string): Scene[] => loadDir(dir, parseScene, 'сцены');
