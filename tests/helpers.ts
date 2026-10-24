import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import type { CubeDevice } from '../src/cube/normalize.ts';
import { FakeClock } from '../src/engine/clock.ts';
import { Engine } from '../src/engine/engine.ts';
import { parseRule, parseScene, type Rule, type Scene } from '../src/rules/schema.ts';
import type { Person, VarDef } from '../src/engine/vars.ts';
import { Store } from '../src/store/db.ts';

export const scenarioDevices = (): CubeDevice[] =>
  (YAML.parse(readFileSync(new URL('../sim/scenario.yaml', import.meta.url), 'utf8')) as { devices: CubeDevice[] }).devices;

export const ruleFile = (name: string): Rule => parseRule(YAML.parse(readFileSync(new URL(`../rules/${name}.yaml`, import.meta.url), 'utf8')), name);
export const ruleYaml = (text: string): Rule => parseRule(YAML.parse(text));
export const sceneFile = (name: string): Scene => parseScene(YAML.parse(readFileSync(new URL(`../scenes/${name}.yaml`, import.meta.url), 'utf8')), name);
export const sceneYaml = (text: string): Scene => parseScene(YAML.parse(text));

export const MODE: VarDef = {
  label: 'Режим', initial: 'home',
  options: [{ value: 'home', label: 'Дома' }, { value: 'away', label: 'Ушёл' }, { value: 'night', label: 'Ночь' }, { value: 'vacation', label: 'Отпуск' }],
};

export interface Harness {
  engine: Engine;
  clock: FakeClock;
  store: Store;
  notes: string[];
  writes: { id: string; state: Record<string, unknown> }[];
  // Sends a CUBE state event for a device by name and waits for the engine.
  report(name: string, state: Record<string, unknown>): Promise<void>;
  advance(ms: number): Promise<void>;
}

export async function harness(rules: Rule[], opts: {
  store?: Store; clock?: FakeClock; protectedDevices?: string[]; acRunning?: boolean;
  initial?: Record<string, Record<string, unknown>>; // device name → state at load time
  onChange?: () => void;
  scenes?: Scene[];
  people?: Record<string, Person>;
} = {}): Promise<Harness> {
  const clock = opts.clock ?? new FakeClock();
  const store = opts.store ?? new Store(':memory:');
  const notes: string[] = [];
  const writes: Harness['writes'] = [];
  const devices = scenarioDevices();
  for (const [name, state] of Object.entries(opts.initial ?? {})) {
    const d = devices.find((x) => x.name === name)!;
    d.state = { ...d.state, ...state };
  }
  const engine = new Engine({
    rules, store, clock,
    notifier: async (t) => { notes.push(t); },
    actuator: async (id, state) => { writes.push({ id, state }); },
    vars: { mode: MODE, ac_running: { label: 'Кондиционер работает', initial: opts.acRunning ?? true } },
    scenes: opts.scenes, people: opts.people, timezone: 'Asia/Tbilisi',
    protectedDevices: opts.protectedDevices,
    onChange: () => opts.onChange?.(),
  });
  engine.loadDevices(devices);
  await engine.start();
  const idOf = (name: string) => devices.find((d) => d.name === name)!.serial_number;
  return {
    engine, clock, store, notes, writes,
    async report(name, state) { await engine.handleCubeEvent({ type: 'state', id: idOf(name), state }); await engine.idle(); },
    async advance(ms) {
      // Step in small slices so timers and queued evaluations interleave like in real time.
      const step = 1_000;
      for (let left = ms; left > 0; left -= step) { clock.advance(Math.min(step, left)); await engine.idle(); }
    },
  };
}

export const MIN = 60_000;
export const open = { contact: { contact: false } };
export const closed = { contact: { contact: true } };
export const humidity = (v: number) => ({ humidity: { humidity: v } });
