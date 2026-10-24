// The rule engine: keeps device state from CUBE, evaluates rule cards on every relevant change and
// on timers, runs actions, and writes a journal so it can explain itself later.
import type { CubeEvent } from '../cube/client.ts';
import { stateForSet, type CubeDevice, type Device, type Value } from '../cube/normalize.ts';
import { conditionsOf, isDeviceCondition, isVarCondition, modeOf, type Action, type Condition, type Rule, type Scene } from '../rules/schema.ts';
import { formatDuration } from '../duration.ts';
import { changeText, describeEntry } from '../explain/explain.ts';
import { DeviceRegistry, type DeviceChange, type DeviceSettings } from './devices.ts';
import type { RuleOverride, Store } from '../store/db.ts';
import type { Clock } from './clock.ts';
import type { NotifyMeta } from '../notify/notifications.ts';
import { actionLabel, resultsText, runActions, type ActionHost, type ActionResult } from './actions.ts';
import { combine, evaluateCondition, type ConditionContext, type ItemResult, type ItemStatus } from './conditions.ts';
import { hhmm, windowAt, type Place } from './time.ts';
import { Variables, type Person, type VarDef, type VarInfo } from './vars.ts';

export type { ActionResult } from './actions.ts';

export type Outcome = 'idle' | 'waiting' | 'active' | 'fired' | 'cooldown' | 'released'
  | 'otherwise_scheduled' | 'otherwise_done' | 'otherwise_cancelled' | 'action_error';
// Outcomes that are always journaled; others only when statuses or the outcome change.
const ACTION_OUTCOMES: Outcome[] = ['fired', 'released', 'otherwise_scheduled', 'otherwise_done', 'otherwise_cancelled', 'action_error'];

export interface Trigger { kind: 'start' | 'event' | 'timer' | 'var' | 'resume'; device?: string; attr?: string; value?: Value }
export interface JournalData {
  trigger: Trigger; mode: 'all' | 'any'; overall: ItemStatus; items: ItemResult[]; actions: ActionResult[];
  cooldownLeftMs?: number; otherwiseInMs?: number;
}

interface Runtime {
  active: boolean;
  lastFiredAt: number | null;
  otherwiseDueAt: number | null;
  trueSince: (number | null)[];
  lastStatuses: ItemStatus[];
  lastOutcome: Outcome | null;
}

export interface EngineOptions {
  rules: Rule[];
  store: Store;
  clock: Clock;
  actuator: (deviceId: string, state: Record<string, unknown>) => Promise<void>;
  notifier: (text: string, meta?: NotifyMeta) => Promise<void>; // meta: who sent it, urgent or not
  vars?: Record<string, VarDef>;
  people?: Record<string, Person>;
  scenes?: Scene[];
  timezone?: string;
  place?: Place;
  protectedDevices?: string[];
  deviceSettings?: DeviceSettings;
  log?: (msg: string) => void;
  onChange?: () => void; // devices, variables or rule state changed (the web panel refreshes)
  samples?: (deviceId: string, attr: string, from: number, to: number) => number[]; // a replay serves history from memory
}

const norm = (s: string) => s.trim().toLowerCase();
const TBILISI: Place = { lat: 41.7151, lon: 44.8271 };
const freshRuntime = (n: number): Runtime => ({ active: false, lastFiredAt: null, otherwiseDueAt: null, trueSince: Array(n).fill(null), lastStatuses: [], lastOutcome: null });

export class Engine {
  rules: Rule[];
  scenes: Scene[];
  private readonly o: EngineOptions;
  private readonly devices: DeviceRegistry;
  private readonly vars: Variables;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly wakeTimers = new Map<string, unknown>();
  private readonly overrides: Map<string, RuleOverride>;
  private readonly pauseTimers = new Map<string, unknown>();
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(o: EngineOptions) {
    this.o = o;
    this.rules = o.rules;
    this.overrides = o.store.ruleOverrides();
    this.scenes = o.scenes ?? [];
    this.vars = new Variables(o.store, o.vars, o.people);
    this.devices = new DeviceRegistry(o.store, o.deviceSettings);
    for (const rule of this.rules) {
      const n = conditionsOf(rule).length;
      const prev = o.store.ruleState<Runtime>(rule.id);
      this.runtimes.set(rule.id, prev && prev.trueSince?.length === n ? { ...freshRuntime(n), ...prev } : freshRuntime(n));
      const until = this.overrides.get(rule.id)?.pausedUntil;
      if (until) this.schedulePauseEnd(rule, until);
    }
  }

  // New rule and scene cards without a restart. Unchanged rules keep their waits; a changed rule starts
  // afresh but remembers when it last fired (so its cooldown holds); removed rules stop their timers.
  reload(rules: Rule[], scenes: Scene[]): Promise<void> {
    const before = new Map(this.rules.map((r) => [r.id, r]));
    const nextIds = new Set(rules.map((r) => r.id));
    for (const old of this.rules) if (!nextIds.has(old.id)) { this.clearTimers(old.id); this.runtimes.delete(old.id); }
    const touched: Rule[] = [];
    for (const rule of rules) {
      const prev = before.get(rule.id);
      if (prev && JSON.stringify(prev) === JSON.stringify(rule)) continue;
      this.clearTimers(rule.id);
      this.runtimes.set(rule.id, { ...freshRuntime(conditionsOf(rule).length), lastFiredAt: this.runtimes.get(rule.id)?.lastFiredAt ?? null });
      const until = this.overrides.get(rule.id)?.pausedUntil;
      if (until) this.schedulePauseEnd(rule, until);
      touched.push(rule);
    }
    this.rules = rules;
    this.scenes = scenes;
    this.o.onChange?.();
    return this.enqueue(touched, { kind: 'start' });
  }

  // The editor saved the card: its "enabled" in YAML wins over the panel switch again.
  resetEnabledSwitch(ruleId: string): void {
    const o = this.overrides.get(ruleId);
    if (o && o.enabled !== null) this.saveOverride(ruleId, { enabled: null, pausedUntil: o.pausedUntil });
  }

  // ── inputs ────────────────────────────────────────────────────────────────

  loadDevices(list: CubeDevice[]): void {
    this.devices.load(list, this.o.clock.now());
    this.o.onChange?.();
  }

  handleCubeEvent(e: CubeEvent): Promise<void> {
    const change = this.devices.apply(e, this.o.clock.now());
    this.o.onChange?.();
    return change ? this.evaluateFor(change) : Promise.resolve();
  }

  setVar(name: string, value: Value): Promise<void> {
    const changed = this.vars.set(name, value, this.o.clock.now());
    this.o.onChange?.();
    const rules = this.rules.filter((r) => conditionsOf(r).some((c) => isVarCondition(c) && changed.includes(c.var)));
    return this.enqueue(rules, { kind: 'var', device: name, value });
  }

  // Scene from the panel or Telegram: queued with rule evaluations so they never interleave.
  runScene(sceneId: string, who: string): Promise<ActionResult[]> {
    if (!this.findScene(sceneId)) throw new Error(`Нет сцены «${sceneId}». Есть: ${this.scenes.map((x) => x.id).join(', ') || '—'}`);
    let out: ActionResult[] = [];
    this.chain = this.chain.then(async () => { out = await this.runSceneNow(sceneId, who, 0); })
      .catch((err) => this.o.log?.(`Ошибка сцены ${sceneId}: ${(err as Error).message}`));
    return this.chain.then(() => out);
  }

  findScene(ref: string): Scene | undefined {
    const q = norm(ref);
    return this.scenes.find((x) => x.id === q || norm(x.name) === q);
  }

  start(): Promise<void> {
    this.vars.snapshot(this.o.clock.now());
    return this.enqueue(this.rules, { kind: 'start' });
  }

  // Manual control from the panel or Telegram; the same protection as rule actions.
  async control(deviceRef: string, attr: string, value: Value, who: string): Promise<void> {
    const device = this.guardedDevice(deviceRef);
    await this.o.actuator(device.id, stateForSet(attr, value));
    this.o.store.addEvent(this.o.clock.now(), 'manual', device.id, `${who}: ${changeText(device.name, attr, value)}`);
    this.o.onChange?.();
  }

  // ── rule switches: off, or paused until a moment (survive restarts) ───────

  ruleSwitch(ruleId: string): { enabled: boolean; pausedUntil: number | null } {
    const rule = this.rules.find((r) => r.id === ruleId);
    const o = this.overrides.get(ruleId);
    const paused = o?.pausedUntil && o.pausedUntil > this.o.clock.now() ? o.pausedUntil : null;
    return { enabled: o?.enabled ?? rule?.enabled ?? false, pausedUntil: paused };
  }

  isRunning(rule: Rule): boolean {
    const s = this.ruleSwitch(rule.id);
    return s.enabled && s.pausedUntil === null;
  }

  setRuleEnabled(ruleId: string, enabled: boolean, who: string): Promise<void> {
    const rule = this.ruleOrThrow(ruleId);
    const o = { enabled, pausedUntil: this.overrides.get(ruleId)?.pausedUntil ?? null };
    this.saveOverride(rule.id, o);
    this.o.store.addEvent(this.o.clock.now(), 'manual', rule.id, `${who}: правило «${rule.name}» ${enabled ? 'включено' : 'выключено'}`);
    return this.afterSwitch(rule);
  }

  // until = null resumes right away.
  pauseRule(ruleId: string, until: number | null, who: string): Promise<void> {
    const rule = this.ruleOrThrow(ruleId);
    const o = { enabled: this.overrides.get(ruleId)?.enabled ?? null, pausedUntil: until };
    this.saveOverride(rule.id, o);
    const prev = this.pauseTimers.get(rule.id);
    if (prev !== undefined) this.o.clock.clearTimeout(prev);
    this.pauseTimers.delete(rule.id);
    if (until) this.schedulePauseEnd(rule, until);
    const text = until ? `пауза на ${formatDuration(until - this.o.clock.now())}` : 'снято с паузы';
    this.o.store.addEvent(this.o.clock.now(), 'manual', rule.id, `${who}: правило «${rule.name}» — ${text}`);
    return this.afterSwitch(rule);
  }

  changedSince(deviceId: string, attr: string): number | null { return this.devices.changedSince(deviceId, attr); }

  idle(): Promise<void> { return this.chain; }

  stop(): void {
    this.stopped = true;
    for (const t of [...this.wakeTimers.values(), ...this.pauseTimers.values()]) this.o.clock.clearTimeout(t);
    this.wakeTimers.clear();
    this.pauseTimers.clear();
  }

  // ── read side (status, explanations) ──────────────────────────────────────

  deviceList(): Device[] { return this.devices.list(); }
  varList(): VarInfo[] { return this.vars.list(); }
  varLabel(name: string): string { return this.vars.label(name); }
  varText(name: string, value: Value): string | null { return this.vars.text(name, value); }
  people(): Record<string, Person> { return this.o.people ?? {}; }
  runtime(ruleId: string): Readonly<Runtime> | undefined { return this.runtimes.get(ruleId); }

  // Current condition results without touching runtime state.
  snapshot(rule: Rule): { overall: ItemStatus; items: ItemResult[] } {
    const rt = this.runtimes.get(rule.id)!;
    const ctx = this.context();
    const copy = [...rt.trueSince];
    const items = conditionsOf(rule).map((c, i) => evaluateCondition(c, ctx, copy, i, false));
    return { overall: combine(modeOf(rule), items), items };
  }

  // ── replay ("what if") and preview (rule diagram) ─────────────────────────

  restoreDevices(list: Device[]): void { this.devices.restore(list); }

  applyAttrs(id: string, attrs: Record<string, Value>): Promise<void> {
    const change = this.devices.applyAttrs(id, attrs, this.o.clock.now());
    return change ? this.evaluateFor(change) : Promise.resolve();
  }

  // Any conditions (also of an unsaved card) against the house right now; a condition that holds
  // counts from its device's last change.
  preview(conditions: Condition[]): ItemResult[] {
    const ctx = this.context();
    return conditions.map((c) => {
      let since: number | null = null;
      if (isDeviceCondition(c)) {
        const r = this.devices.resolve(c.device);
        if (r.status === 'ok') since = this.devices.changedSince(r.device.id, c.attr);
      }
      return evaluateCondition(c, ctx, [since], 0, false);
    });
  }

  describeAction(a: Action): string { return actionLabel(a, this.host()); }

  // The panel changed the list of devices the engine must not touch.
  setProtected(names: string[]): void { this.o.protectedDevices = names; }
  setDeviceSettings(s: DeviceSettings): void { this.devices.setSettings(s); this.o.onChange?.(); }

  // A card's device reference (CUBE name, own name or id) as the panel shows it.
  displayName(ref: string): string {
    const r = this.devices.resolve(ref);
    return r.status === 'ok' ? r.device.name : ref;
  }

  // ── evaluation ────────────────────────────────────────────────────────────

  private evaluateFor(change: DeviceChange): Promise<void> {
    const dev = change.device;
    const keys = new Set([norm(dev.name), norm(dev.cubeName), norm(dev.id)]);
    const rules = this.rules.filter((r) => conditionsOf(r).some((c) => isDeviceCondition(c) && keys.has(norm(c.device))));
    return this.enqueue(rules, { kind: 'event', device: dev.name, attr: change.attr, value: change.value });
  }

  private enqueue(rules: Rule[], trigger: Trigger): Promise<void> {
    for (const rule of rules) {
      this.chain = this.chain.then(() => this.evaluate(rule, trigger)).catch((err) => this.o.log?.(`Ошибка правила ${rule.id}: ${(err as Error).stack ?? err}`));
    }
    return this.chain;
  }

  private async evaluate(rule: Rule, trigger: Trigger): Promise<void> {
    if (this.stopped || !this.isRunning(rule)) return;
    const now = this.o.clock.now();
    const rt = this.runtimes.get(rule.id)!;
    const items = conditionsOf(rule).map((c, i) => evaluateCondition(c, this.context(), rt.trueSince, i));
    const overall = combine(modeOf(rule), items);
    const actions: ActionResult[] = [];
    let outcome: Outcome;

    if (overall === 'ok') {
      if (rt.otherwiseDueAt !== null) {
        // Condition came back before the delayed "otherwise" ran: the "then" state is still in effect.
        rt.otherwiseDueAt = null;
        rt.active = true;
        outcome = 'otherwise_cancelled';
      } else if (rt.active) {
        outcome = 'active';
      } else if (rule.cooldown !== undefined && rt.lastFiredAt !== null && now - rt.lastFiredAt < rule.cooldown) {
        outcome = 'cooldown';
      } else {
        actions.push(...await this.run(rule, rule.then));
        rt.active = true;
        rt.lastFiredAt = now;
        outcome = actions.some((a) => !a.ok) ? 'action_error' : 'fired';
      }
    } else {
      outcome = overall === 'waiting' ? 'waiting' : 'idle';
      if (rt.active) {
        rt.active = false;
        if (rule.otherwise) { rt.otherwiseDueAt = now + rule.otherwise.after; outcome = 'otherwise_scheduled'; } else outcome = 'released';
      }
      if (rule.otherwise && rt.otherwiseDueAt !== null && now >= rt.otherwiseDueAt) {
        rt.otherwiseDueAt = null;
        actions.push(...await this.run(rule, rule.otherwise.do));
        outcome = actions.some((a) => !a.ok) ? 'action_error' : 'otherwise_done';
      }
    }

    if (actions.length) {
      this.o.log?.(`«${rule.name}»: ${outcome} — ${actions.map((a) => (a.ok ? a.action : `${a.action} (ошибка: ${a.error})`)).join('; ')}`);
    }
    const statuses = items.map((i) => i.status);
    const changed = statuses.join() !== rt.lastStatuses.join();
    if (changed || outcome !== rt.lastOutcome || ACTION_OUTCOMES.includes(outcome)) {
      const data: JournalData = { trigger, mode: modeOf(rule), overall, items, actions };
      if (outcome === 'cooldown') data.cooldownLeftMs = rule.cooldown! - (now - rt.lastFiredAt!);
      if (outcome === 'otherwise_scheduled') data.otherwiseInMs = rt.otherwiseDueAt! - now;
      this.o.store.addJournal(now, rule.id, outcome, data);
      const line = describeEntry({ id: 0, ts: now, ruleId: rule.id, outcome, data }, this);
      if (line) this.o.store.addEvent(now, 'rule', rule.id, `«${rule.name}»: ${line}`);
    }
    rt.lastStatuses = statuses;
    rt.lastOutcome = outcome;
    this.o.store.saveRuleState(rule.id, rt);
    this.scheduleWake(rule, rt, items, overall, now);
    this.o.onChange?.();
  }

  // One timer per rule at the earliest moment something can change by itself:
  // a "for" period ending, a delayed "otherwise", or a cooldown running out.
  private scheduleWake(rule: Rule, rt: Runtime, items: ItemResult[], overall: ItemStatus, now: number): void {
    const prev = this.wakeTimers.get(rule.id);
    if (prev !== undefined) this.o.clock.clearTimeout(prev);
    this.wakeTimers.delete(rule.id);
    const candidates: number[] = [];
    items.forEach((it, i) => {
      if (it.status === 'waiting' && it.needForMs !== undefined && rt.trueSince[i] != null) candidates.push(rt.trueSince[i]! + it.needForMs);
    });
    if (rt.otherwiseDueAt !== null) candidates.push(rt.otherwiseDueAt);
    for (const it of items) if (it.nextChangeAt !== undefined && it.nextChangeAt > now) candidates.push(it.nextChangeAt);
    if (overall === 'ok' && !rt.active && rule.cooldown !== undefined && rt.lastFiredAt !== null) candidates.push(rt.lastFiredAt + rule.cooldown);
    if (!candidates.length || this.stopped) return;
    const at = Math.min(...candidates);
    this.wakeTimers.set(rule.id, this.o.clock.setTimeout(() => {
      this.wakeTimers.delete(rule.id);
      void this.enqueue([rule], { kind: 'timer' });
    }, Math.max(0, at - now)));
  }

  private run(rule: Rule, list: Rule['then']): Promise<ActionResult[]> {
    return runActions(this.host(), rule.name, list);
  }

  private async runSceneNow(sceneId: string, who: string, depth: number): Promise<ActionResult[]> {
    const scene = this.findScene(sceneId);
    if (!scene) throw new Error(`нет сцены «${sceneId}»`);
    const results = await runActions(this.host(), `Сцена «${scene.name}»`, scene.do, depth);
    this.o.store.addEvent(this.o.clock.now(), depth ? 'rule' : 'manual', scene.id, `${who}: сцена «${scene.name}» — ${resultsText(results) || 'нечего делать'}`);
    this.o.log?.(`Сцена «${scene.name}» (${who}): ${resultsText(results)}`);
    this.o.onChange?.();
    return results;
  }

  private host(): ActionHost {
    return {
      device: (ref) => this.guardedDevice(ref),
      devices: () => this.deviceList(),
      isProtected: (d) => this.isProtected(d),
      actuator: (id, state) => this.o.actuator(id, state),
      notifier: (text, meta) => this.o.notifier(text, meta),
      setVar: (name, value) => {
        const changed = this.vars.set(name, value, this.o.clock.now());
        const dependents = this.rules.filter((r) => conditionsOf(r).some((c) => isVarCondition(c) && changed.includes(c.var)));
        void this.enqueue(dependents, { kind: 'var', device: name, value });
      },
      runScene: (id, owner, depth) => this.runSceneNow(id, owner, depth),
      check: (conditions) => this.check(conditions),
      displayName: (ref) => this.displayName(ref),
      describeVar: (name, value) => `${this.vars.label(name)}: ${this.vars.text(name, value) ?? (typeof value === 'boolean' ? (value ? 'да' : 'нет') : String(value))}`,
    };
  }

  // Conditions of an action's "if": all must hold right now ("for" is ignored).
  private check(conditions: Condition[]): boolean {
    const ctx = this.context();
    return conditions.every((c, i) => {
      const r = evaluateCondition('for' in c ? { ...c, for: undefined } as Condition : c, ctx, [], i, false);
      return r.status === 'ok';
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private timezone(): string { return this.o.timezone ?? 'Asia/Tbilisi'; }

  private clearTimers(ruleId: string): void {
    for (const timers of [this.wakeTimers, this.pauseTimers]) {
      const t = timers.get(ruleId);
      if (t !== undefined) this.o.clock.clearTimeout(t);
      timers.delete(ruleId);
    }
  }

  private ruleOrThrow(ruleId: string): Rule {
    const rule = this.rules.find((r) => r.id === ruleId);
    if (!rule) throw new Error(`Нет правила «${ruleId}»`);
    return rule;
  }

  private saveOverride(ruleId: string, o: RuleOverride): void {
    this.overrides.set(ruleId, o);
    this.o.store.saveRuleOverride(ruleId, o);
  }

  // A rule that stops running forgets half-done waits; one that starts again looks at the house afresh.
  private afterSwitch(rule: Rule): Promise<void> {
    const wake = this.wakeTimers.get(rule.id);
    if (wake !== undefined) this.o.clock.clearTimeout(wake);
    this.wakeTimers.delete(rule.id);
    const rt = this.runtimes.get(rule.id)!;
    if (!this.isRunning(rule)) {
      Object.assign(rt, { active: false, otherwiseDueAt: null, trueSince: rt.trueSince.map(() => null), lastStatuses: [], lastOutcome: null });
      this.o.store.saveRuleState(rule.id, rt);
      this.o.onChange?.();
      return this.chain;
    }
    this.o.onChange?.();
    return this.enqueue([rule], { kind: 'resume' });
  }

  private schedulePauseEnd(rule: Rule, until: number): void {
    const delay = until - this.o.clock.now();
    if (delay <= 0) return;
    this.pauseTimers.set(rule.id, this.o.clock.setTimeout(() => {
      this.pauseTimers.delete(rule.id);
      this.saveOverride(rule.id, { enabled: this.overrides.get(rule.id)?.enabled ?? null, pausedUntil: null });
      this.o.store.addEvent(this.o.clock.now(), 'rule', rule.id, `«${rule.name}»: пауза закончилась`);
      void this.afterSwitch(rule);
    }, delay));
  }

  private isProtected(device: Device): boolean {
    const guarded = (this.o.protectedDevices ?? []).map(norm);
    return guarded.includes(norm(device.name)) || guarded.includes(norm(device.cubeName)) || guarded.includes(norm(device.id));
  }

  private guardedDevice(ref: string): Device {
    const r = this.devices.resolve(ref);
    if (r.status !== 'ok') throw new Error(`устройство «${ref}» ${r.status === 'missing' ? 'не найдено' : 'неоднозначно'}`);
    const device = r.device;
    if (this.isProtected(device)) throw new Error(`устройство «${device.name}» защищено от управления`);
    return device;
  }

  private context(): ConditionContext {
    return {
      now: this.o.clock.now(),
      device: (ref) => {
        const r = this.devices.resolve(ref);
        if (r.status !== 'ok') return r;
        return { status: 'ok', id: r.device.id, online: r.device.online, attrs: r.device.attrs };
      },
      variable: (name) => this.vars.get(name),
      samples: this.o.samples ?? ((id, attr, from, to) => this.o.store.samples(id, attr, from, to)),
      window: (spec) => windowAt(spec, this.o.clock.now(), this.timezone(), this.o.place ?? TBILISI),
      clock: (ts) => hhmm(ts, this.timezone()),
    };
  }

}
