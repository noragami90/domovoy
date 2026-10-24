// What the web panel shows, as plain JSON: the house at a glance, rules, devices, variables,
// and chart data for one device attribute.
import type { Link } from '../app.ts';
import type { Device, Value } from '../cube/normalize.ts';
import type { ItemStatus } from '../engine/conditions.ts';
import type { Engine } from '../engine/engine.ts';
import { homeVar, type VarInfo } from '../engine/vars.ts';
import { formatValue, itemText } from '../explain/explain.ts';
import { formatDuration } from '../duration.ts';
import type { Store } from '../store/db.ts';
import type { Health } from '../notify/health.ts';
import type { Notifications } from '../notify/notifications.ts';

export type RuleStatus = 'active' | 'waiting' | 'idle' | 'unknown' | 'paused' | 'off';

export interface PanelState {
  link: Link;
  simulator: boolean;
  rooms: string[];   // in the order set in the panel; devices without a room come last
  home: {
    open: { device: string; since: number | null }[];
    leaks: string[];
    climate: { device: string; temperature: string | null; humidity: string | null }[];
    lowBattery: { device: string; text: string }[];
    people: { id: string; name: string; home: boolean }[];
    offline: string[];
    silent: { id: string; device: string; text: string }[];     // quieter than usual
    pendingAcks: { id: number; ts: number; text: string; repeats: number }[]; // urgent, waiting for «Принял»
    power: string | null;
    rules: Record<RuleStatus, number>;
  };
  rules: {
    id: string; name: string; description?: string;
    status: RuleStatus; enabled: boolean; pausedUntil: number | null;
    lines: { status: ItemStatus; text: string }[];
    lastFiredAt: number | null;
    nextTimeAt: number | null;
  }[];
  scenes: { id: string; name: string; description?: string }[];
  devices: {
    id: string; name: string; cubeName: string; room: string | null; category: string; model: string; online: boolean;
    lastSeen: number | null;
    attrs: PanelAttr[];
  }[];
  vars: (VarInfo & { text: string })[];
}

export interface PanelAttr { key: string; value: Value; text: string; control: 'switch' | null; numeric: boolean }
export interface PanelExtras { health?: Health; notifications?: Notifications; batteryBelow?: number; rooms?: string[] }

const HIDDEN_ATTRS = new Set(['rssi', 'lqi', 'contact', 'electric-power']);
const isSwitch = (k: string) => k === 'power' || /^toggle\.\w+$/.test(k);

export const attrsOf = (d: Device): PanelAttr[] => Object.entries(d.attrs).filter(([k]) => !HIDDEN_ATTRS.has(k)).map(([key, value]) => ({
  key, value, text: formatValue(key, value), control: isSwitch(key) ? 'switch' as const : null, numeric: typeof value === 'number',
}));

function home(engine: Engine, devices: Device[], rules: PanelState['rules'], x: PanelExtras): PanelState['home'] {
  const lowBattery = x.batteryBelow ?? 20;
  const counts: Record<RuleStatus, number> = { active: 0, waiting: 0, idle: 0, unknown: 0, paused: 0, off: 0 };
  for (const r of rules) counts[r.status] += 1;
  const watts = devices.map((d) => d.attrs.power_w).filter((w): w is number => typeof w === 'number');
  return {
    open: devices.filter((d) => d.attrs.open === true).map((d) => ({ device: d.name, since: engine.changedSince(d.id, 'open') })),
    leaks: devices.filter((d) => d.attrs.leak === true).map((d) => d.name),
    climate: devices.filter((d) => typeof d.attrs.temperature === 'number' || typeof d.attrs.humidity === 'number').map((d) => ({
      device: d.name,
      temperature: typeof d.attrs.temperature === 'number' ? formatValue('temperature', d.attrs.temperature) : null,
      humidity: typeof d.attrs.humidity === 'number' ? formatValue('humidity', d.attrs.humidity) : null,
    })),
    lowBattery: devices.filter((d) => typeof d.attrs.battery === 'number' && d.attrs.battery < lowBattery)
      .map((d) => ({ device: d.name, text: formatValue('battery', d.attrs.battery) })),
    people: Object.entries(engine.people()).map(([id, p]) => ({ id, name: p.name, home: engine.varList().find((v) => v.name === homeVar(id))?.value === true })),
    offline: devices.filter((d) => !d.online).map((d) => d.name),
    silent: x.health ? devices.flatMap((d) => {
      const h = x.health!.info(d);
      return h.silentForMs !== null ? [{ id: d.id, device: d.name, text: `нет данных ${formatDuration(h.silentForMs)}` }] : [];
    }) : [],
    pendingAcks: (x.notifications?.pending() ?? []).map((n) => ({ id: n.id, ts: n.ts, text: n.text, repeats: n.repeats })),
    power: watts.length ? formatValue('power_w', Math.max(...watts)) : null, // the whole-house clamp reads the most
    rules: counts,
  };
}

export function panelState(engine: Engine, store: Store, link: Link, simulator: boolean, x: PanelExtras = {}): PanelState {
  const rules = engine.rules.map((r) => {
    const sw = engine.ruleSwitch(r.id);
    const snap = engine.snapshot(r);
    const rt = engine.runtime(r.id);
    const status: RuleStatus = !sw.enabled ? 'off' : sw.pausedUntil ? 'paused' : rt?.active ? 'active'
      : snap.overall === 'waiting' ? 'waiting' : snap.overall === 'unknown' ? 'unknown' : 'idle';
    return {
      id: r.id, name: r.name, description: r.description, status, enabled: sw.enabled, pausedUntil: sw.pausedUntil,
      lines: snap.items.map((it) => ({ status: it.reason ? 'unknown' as const : it.status, text: itemText(it, engine) })),
      lastFiredAt: store.lastJournal(r.id, ['fired'])?.ts ?? null,
      nextTimeAt: Math.min(...snap.items.map((it) => it.nextChangeAt ?? Infinity)),
    };
  }).map((r) => ({ ...r, nextTimeAt: Number.isFinite(r.nextTimeAt) ? r.nextTimeAt : null }));
  const devices = engine.deviceList().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return {
    link,
    simulator,
    rooms: x.rooms ?? [],
    home: home(engine, devices, rules, x),
    rules,
    devices: devices.map((d) => ({
      id: d.id, name: d.name, cubeName: d.cubeName, room: d.room, category: d.category, model: d.model, online: d.online,
      lastSeen: x.health?.lastSeen(d.id) ?? null,
      attrs: attrsOf(d),
    })),
    scenes: engine.scenes.map((x) => ({ id: x.id, name: x.name, description: x.description })),
    vars: engine.varList().map((v) => ({ ...v, text: engine.varText(v.name, v.value) ?? formatValue(undefined, v.value) })),
  };
}

export interface History {
  device: string; attr: string;
  points: [number, number][];
  lines: { label: string; value: number }[];
}

// Up to ~240 averaged points for the range, plus lines from rules that watch this attribute:
// the usual level and the threshold for baseline rules, the fixed limit for above/below rules.
export function history(engine: Engine, store: Store, deviceId: string, attr: string, rangeMs: number, now: number): History | null {
  const device = engine.deviceList().find((d) => d.id === deviceId);
  if (!device) return null;
  const raw = store.series(deviceId, attr, now - rangeMs, now + 1);
  const bucket = Math.max(1, Math.ceil(rangeMs / 240));
  const sums = new Map<number, { sum: number; n: number }>();
  for (const [ts, v] of raw) {
    const key = Math.floor(ts / bucket) * bucket;
    const b = sums.get(key) ?? { sum: 0, n: 0 };
    b.sum += v; b.n += 1;
    sums.set(key, b);
  }
  const points = [...sums].sort((a, b) => a[0] - b[0]).map(([ts, b]) => [ts + bucket / 2, Math.round((b.sum / b.n) * 100) / 100] as [number, number]);
  const lines: History['lines'] = [];
  const names = new Set([device.name.trim().toLowerCase(), device.cubeName.trim().toLowerCase(), device.id.toLowerCase()]);
  for (const rule of engine.rules) {
    for (const it of engine.snapshot(rule).items) {
      if (it.kind !== 'device' || it.attr !== attr || !names.has(it.ref.trim().toLowerCase())) continue;
      if (it.baseline?.value != null) lines.push({ label: 'обычно', value: Math.round(it.baseline.value * 10) / 10 });
      if (typeof it.target === 'number' && it.op !== 'is' && it.op !== 'not') lines.push({ label: `порог «${rule.name}»`, value: it.target });
    }
  }
  return { device: device.name, attr, points, lines };
}
