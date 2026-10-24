// Evaluates one condition of a rule card against current devices, variables, history and the clock.
import type { Value } from '../cube/normalize.ts';
import { isDeviceCondition, isTimeCondition, type Condition, type TimeCondition } from '../rules/schema.ts';
import { DAY_NAMES, type WindowSpec, type WindowState } from './time.ts';

export type ItemStatus = 'ok' | 'waiting' | 'fail' | 'unknown';

export interface ItemResult {
  kind: 'device' | 'var' | 'time';
  ref: string;              // device name/id, variable name, or "время"
  attr?: string;
  status: ItemStatus;
  value: Value | undefined;
  op: 'is' | 'not' | 'above' | 'below' | 'above_baseline' | 'below_baseline' | 'between';
  target: Value;            // compared value; baselines — the computed threshold; time — the window as text
  baseline?: { value: number | null; samples: number; needed: number; amount: number; relative: boolean };
  trueForMs?: number;       // how long the comparison has held (when status is ok/waiting with "for")
  needForMs?: number;
  wasTrueForMs?: number;    // set on the evaluation where it stopped holding
  nextChangeAt?: number;    // time windows: when the window opens or closes next
  reason?: 'device_missing' | 'device_ambiguous' | 'offline' | 'no_value' | 'baseline_insufficient' | 'no_window' | 'var_missing';
}

export interface ConditionContext {
  now: number;
  device(ref: string): { status: 'ok'; id: string; online: boolean; attrs: Record<string, Value> } | { status: 'missing' | 'ambiguous' };
  variable(name: string): Value | undefined;
  samples(deviceId: string, attr: string, from: number, to: number): number[];
  window(spec: WindowSpec): WindowState | null;
  clock(ts: number): string; // "HH:MM" in the home time zone
}

export const sameValue = (a: Value | undefined, b: Value) => a === b || (a !== undefined && a !== null && String(a) === String(b));

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

type Partial = Omit<ItemResult, 'status'> & { holds: boolean };

// trueSince is the per-condition memory of when the comparison started to hold; it is updated in place
// unless `mutate` is false (used for read-only status snapshots).
export function evaluateCondition(c: Condition, ctx: ConditionContext, trueSince: (number | null)[], index: number, mutate = true): ItemResult {
  const base: Partial = isDeviceCondition(c) ? evaluateDevice(c, ctx) : isTimeCondition(c) ? evaluateTime(c, ctx) : evaluateVar(c, ctx);
  const { holds, ...result } = base;
  const r: ItemResult = { ...result, status: 'fail' };
  if (base.reason) { r.status = 'unknown'; r.reason = base.reason; }
  const needFor = 'for' in c ? c.for : undefined;

  const since = trueSince[index] ?? null;
  if (holds) {
    const start = since ?? ctx.now;
    if (mutate) trueSince[index] = start;
    const held = ctx.now - start;
    if (needFor !== undefined && held < needFor) {
      r.status = 'waiting';
      r.trueForMs = held;
      r.needForMs = needFor;
    } else {
      r.status = 'ok';
      if (needFor !== undefined) { r.trueForMs = held; r.needForMs = needFor; }
    }
  } else {
    if (since !== null) r.wasTrueForMs = ctx.now - since;
    if (mutate) trueSince[index] = null;
    if (needFor !== undefined) r.needForMs = needFor;
  }
  return r;
}

function evaluateVar(c: Extract<Condition, { var: string }>, ctx: ConditionContext): Partial {
  const value = ctx.variable(c.var);
  const out: Partial = { kind: 'var', ref: c.var, op: 'is', target: c.is, value, holds: sameValue(value, c.is) };
  return value === undefined ? { ...out, holds: false, reason: 'var_missing' } : out;
}

function pointLabel(point: string, ts: number, ctx: ConditionContext): string {
  const m = /^(sunrise|sunset)([+-])?(.*)$/.exec(point);
  if (!m) return point;
  const name = m[1] === 'sunrise' ? 'восхода' : 'заката';
  const shift = m[2] ? ` ${m[2] === '-' ? '−' : '+'} ${m[3]}` : '';
  return `${name}${shift} (${ctx.clock(ts)})`;
}

function daysLabel(days: number[] | undefined): string {
  if (!days) return '';
  const key = days.join();
  if (key === '1,2,3,4,5') return ', по будням';
  if (key === '0,6') return ', по выходным';
  return `, ${days.map((d) => DAY_NAMES[d]).join(' ')}`;
}

function evaluateTime(c: TimeCondition, ctx: ConditionContext): Partial {
  const spec = { between: c.time.between, days: c.time.days };
  const w = ctx.window(spec);
  const out: Partial = { kind: 'time', ref: 'время', op: 'between', value: ctx.clock(ctx.now), target: null, holds: false };
  if (!w) return { ...out, reason: 'no_window' };
  const [a, b] = c.time.between;
  const target = `с ${pointLabel(a, w.start, ctx)} до ${pointLabel(b, w.end, ctx)}${daysLabel(c.time.days)}`;
  return { ...out, target, holds: w.inside, nextChangeAt: w.next };
}

function evaluateDevice(c: Extract<Condition, { device: string }>, ctx: ConditionContext): Partial {
  const op = c.is !== undefined ? 'is' : c.not !== undefined ? 'not' : c.above !== undefined ? 'above'
    : c.below !== undefined ? 'below' : c.above_baseline !== undefined ? 'above_baseline' : 'below_baseline';
  const out: Partial = { kind: 'device', ref: c.device, attr: c.attr, op, target: null, value: undefined, holds: false };
  const dev = ctx.device(c.device);
  if (dev.status !== 'ok') return { ...out, reason: dev.status === 'missing' ? 'device_missing' : 'device_ambiguous' };
  if (!dev.online) return { ...out, reason: 'offline' };
  const value = dev.attrs[c.attr];
  out.value = value;
  if (value === undefined || value === null) return { ...out, reason: 'no_value' };

  switch (op) {
    case 'is': return { ...out, target: c.is!, holds: sameValue(value, c.is!) };
    case 'not': return { ...out, target: c.not!, holds: !sameValue(value, c.not!) };
    case 'above': return { ...out, target: c.above!, holds: typeof value === 'number' && value > c.above! };
    case 'below': return { ...out, target: c.below!, holds: typeof value === 'number' && value < c.below! };
    default: {
      const delta = (op === 'above_baseline' ? c.above_baseline : c.below_baseline)!;
      const opts = c.baseline ?? { window: 86_400_000, exclude_recent: 1_800_000, min_samples: 10 };
      const samples = ctx.samples(dev.id, c.attr, ctx.now - opts.window, ctx.now - opts.exclude_recent);
      const med = median(samples);
      const baseline = { value: med, samples: samples.length, needed: opts.min_samples, amount: delta.amount, relative: delta.relative };
      if (med === null || samples.length < opts.min_samples) return { ...out, baseline, reason: 'baseline_insufficient' };
      const shift = delta.relative ? med * delta.amount / 100 : delta.amount;
      const threshold = Math.round((op === 'above_baseline' ? med + shift : med - shift) * 100) / 100;
      const holds = typeof value === 'number' && (op === 'above_baseline' ? value >= threshold : value <= threshold);
      return { ...out, baseline, target: threshold, holds };
    }
  }
}

// Combines item statuses: "all" needs every item ok, "any" needs one.
export function combine(mode: 'all' | 'any', items: ItemResult[]): ItemStatus {
  const has = (s: ItemStatus) => items.some((i) => i.status === s);
  if (mode === 'all') {
    if (items.every((i) => i.status === 'ok')) return 'ok';
    if (has('fail')) return 'fail';
    if (has('unknown')) return 'unknown';
    return 'waiting';
  }
  if (has('ok')) return 'ok';
  if (has('waiting')) return 'waiting';
  return has('fail') ? 'fail' : 'unknown';
}

