// "What if": runs one rule card over recorded history in a sandbox engine with a fake clock.
// Real devices and Telegram are never touched: actions are recorded, and a "set" only changes
// the sandbox copy of the device (so "if" and "all_off" see it).
import { flattenState, type Device, type Value } from '../cube/normalize.ts';
import { describeEntry } from '../explain/explain.ts';
import { conditionsOf, isDeviceCondition, isVarCondition, type Condition, type Rule, type Scene } from '../rules/schema.ts';
import { Store, VAR_REF } from '../store/db.ts';
import { FakeClock } from './clock.ts';
import { Engine, type JournalData, type Outcome } from './engine.ts';
import type { Place } from './time.ts';
import type { Person, VarDef } from './vars.ts';

export interface ReplayOptions {
  store: Store;          // the real store: read only
  rule: Rule;
  devices: Device[];     // current devices: names, ids, which values are numbers
  from: number;
  to: number;
  scenes?: Scene[];
  vars?: Record<string, VarDef>;
  people?: Record<string, Person>;
  timezone?: string;
  place?: Place;
  protectedDevices?: string[];
  deviceSettings?: Record<string, { contact_true_means: 'closed' | 'open' }>;
}

export interface ReplayEntry { ts: number; outcome: Outcome; text: string }
export interface ReplayResult {
  from: number; to: number; requestedFrom: number;
  limitedBy: string | null;   // why history starts later than asked
  missing: string[];          // conditions without any history
  events: number;
  counts: Partial<Record<Outcome, number>>;
  notifications: { ts: number; text: string }[];
  writes: { ts: number; device: string; text: string }[];
  entries: ReplayEntry[];
}

const SHOWN: Outcome[] = ['fired', 'action_error', 'cooldown', 'otherwise_done', 'otherwise_cancelled', 'released'];
const MAX_EVENTS = 300_000;

// Every condition the card reads: "when" plus the "if" of each action.
function allConditions(rule: Rule, scenes: Scene[]): Condition[] {
  const out = [...conditionsOf(rule)];
  const fromActions = (list: Rule['then'], depth: number) => {
    for (const a of list) {
      if (a.if) out.push(...a.if);
      if ('scene' in a && depth < 3) {
        const s = scenes.find((x) => x.id === a.scene);
        if (s) fromActions(s.do, depth + 1);
      }
    }
  };
  fromActions(rule.then, 0);
  if (rule.otherwise) fromActions(rule.otherwise.do, 0);
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();
const varLabel = (o: ReplayOptions, name: string) => {
  const person = name.startsWith('home_') ? o.people?.[name.slice(5)] : undefined;
  return o.vars?.[name]?.label ?? (person ? `${person.name} дома` : name === 'anyone_home' ? 'Кто-нибудь дома' : name);
};
const findDevice = (devices: Device[], ref: string) =>
  devices.find((d) => norm(d.id) === norm(ref)) ?? devices.find((d) => norm(d.name) === norm(ref) || norm(d.cubeName) === norm(ref));

export async function replay(o: ReplayOptions): Promise<ReplayResult> {
  const scenes = o.scenes ?? [];
  const numeric = new Map<string, { id: string; attr: string }>(); // device attrs that live in samples
  const missing: string[] = [];
  let start = o.from;
  let limitedBy: string | null = null;
  const later = (ts: number | null, what: string) => {
    if (ts === null) { missing.push(what); return; }
    if (ts > start) { start = ts; limitedBy = what; }
  };

  for (const c of allConditions(o.rule, scenes)) {
    if (isDeviceCondition(c)) {
      const d = findDevice(o.devices, c.device);
      if (!d) { missing.push(c.device); continue; }
      const what = `${d.name} (${c.attr})`;
      if (typeof d.attrs[c.attr] === 'number') {
        numeric.set(`${d.id}|${c.attr}`, { id: d.id, attr: c.attr });
        later(o.store.firstSample(d.id, c.attr), what);
      } else later(o.store.firstChange(d.id, c.attr), what);
    } else if (isVarCondition(c)) later(o.store.firstChange(VAR_REF, c.var), varLabel(o, c.var));
  }
  const empty = (): ReplayResult => ({
    from: start, to: o.to, requestedFrom: o.from, limitedBy, missing, events: 0, counts: {}, notifications: [], writes: [], entries: [],
  });
  if (missing.length || start >= o.to) return empty();

  // Readings for "usual level" conditions come from memory: re-reading a day of samples from SQLite
  // on every event made a week-long replay ~25 times slower. Only samples before "now" are ever asked for.
  const lookback = Math.max(86_400_000, ...allConditions(o.rule, scenes).map((c) => (isDeviceCondition(c) && c.baseline ? c.baseline.window : 0))) + 3_600_000;
  const readings = new Map<string, { ts: number[]; v: number[] }>();
  for (const { id, attr } of numeric.values()) {
    const rows = o.store.series(id, attr, start - lookback, o.to);
    readings.set(`${id}|${attr}`, { ts: rows.map((r) => r[0]), v: rows.map((r) => r[1]) });
  }
  const firstAtOrAfter = (ts: number[], t: number) => {
    let lo = 0, hi = ts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid]! < t) lo = mid + 1; else hi = mid; }
    return lo;
  };

  // Sandbox: its own memory store with the variables as they were.
  const sandbox = new Store(':memory:');
  const before = o.store.stateBefore(start);
  for (const [key, v] of before) {
    const [ref, name] = key.split('|') as [string, string];
    if (ref === VAR_REF) sandbox.saveVar(name, v, start);
  }
  // Devices as they were: switches and doors from changes, numbers from the last reading.
  const devices = o.devices.map((d) => {
    const attrs: Record<string, Value> = {};
    for (const [attr, cur] of Object.entries(d.attrs)) {
      const v = typeof cur === 'number' ? o.store.lastSampleBefore(d.id, attr, start) : before.get(`${d.id}|${attr}`);
      if (v !== undefined && v !== null) attrs[attr] = v;
    }
    return { ...d, online: true, attrs };
  });

  const clock = new FakeClock(start);
  const notifications: ReplayResult['notifications'] = [];
  const writes: ReplayResult['writes'] = [];
  const engine: Engine = new Engine({
    rules: [{ ...o.rule, enabled: true }], store: sandbox, clock,
    vars: o.vars, people: o.people, scenes, timezone: o.timezone, place: o.place,
    protectedDevices: o.protectedDevices, deviceSettings: o.deviceSettings,
    samples: (id, attr, from, to) => {
      const r = readings.get(`${id}|${attr}`);
      return r ? r.v.slice(firstAtOrAfter(r.ts, from), firstAtOrAfter(r.ts, to)) : sandbox.samples(id, attr, from, to);
    },
    notifier: async (text) => { notifications.push({ ts: clock.now(), text }); },
    actuator: async (id, state) => {
      const d = devices.find((x) => x.id === id);
      const attrs = flattenState(state as never);
      writes.push({ ts: clock.now(), device: d?.name ?? id, text: Object.entries(attrs).map(([k, v]) => `${k}=${v}`).join(', ') });
      void engine.applyAttrs(id, attrs); // not awaited: we are inside the engine's queue
    },
  });
  engine.restoreDevices(devices);
  await engine.start();

  // History in time order: switches, doors and variables from changes, numbers from samples.
  type Ev = { ts: number; ref: string; attr: string; value: Value };
  const events: Ev[] = o.store.changes(start, o.to);
  for (const { id, attr } of numeric.values()) {
    for (const [ts, value] of o.store.series(id, attr, start, o.to)) events.push({ ts, ref: id, attr, value });
  }
  events.sort((a, b) => a.ts - b.ts);
  const used = events.slice(0, MAX_EVENTS);
  const to = used.length < events.length ? used.at(-1)!.ts : o.to;

  const advanceTo = async (ts: number) => {
    // Step from timer to timer, so every evaluation runs at its own moment.
    for (let next = clock.nextAt(); next !== null && next <= ts; next = clock.nextAt()) {
      clock.advance(next - clock.now());
      await engine.idle();
    }
    if (ts > clock.now()) clock.advance(ts - clock.now());
  };
  for (const e of used) {
    await advanceTo(e.ts);
    if (e.ref === VAR_REF) {
      try { await engine.setVar(e.attr, e.value); } catch { /* computed (anyone_home) or no longer in config */ }
    } else await engine.applyAttrs(e.ref, { [e.attr]: e.value });
    await engine.idle();
  }
  await advanceTo(to);
  await engine.idle();
  engine.stop();

  const counts: ReplayResult['counts'] = {};
  const entries: ReplayEntry[] = [];
  for (const j of sandbox.journal<JournalData>(o.rule.id, start, 100_000).reverse()) {
    const outcome = j.outcome as Outcome;
    if (!SHOWN.includes(outcome)) continue;
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    entries.push({ ts: j.ts, outcome, text: describeEntry(j, engine) ?? outcome });
  }
  sandbox.close();
  return {
    from: start, to, requestedFrom: o.from, limitedBy: used.length < events.length ? `слишком много событий — прогнал первые ${MAX_EVENTS}` : limitedBy,
    missing, events: used.length, counts, notifications, writes, entries: entries.slice(-300),
  };
}
