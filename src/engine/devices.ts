// Device state as the engine sees it: built from CUBE's device list, kept up to date by events.
// Records numeric samples (charts, baselines) and state changes (the feed).
import type { CubeEvent } from '../cube/client.ts';
import { flattenState, toDevice, type CubeDevice, type Device, type Value } from '../cube/normalize.ts';
import { changeText } from '../explain/explain.ts';
import type { Store } from '../store/db.ts';

export interface DeviceChange { device: Device; attr?: string; value?: Value }
// Per-device settings keyed by the CUBE name: how a door sensor reads, the panel's own name, the room.
export type DeviceSettings = Record<string, { contact_true_means?: 'closed' | 'open'; label?: string; room?: string }>;

const norm = (s: string) => s.trim().toLowerCase();
// Numbers (humidity, temperature, power) change all the time: they go to charts, not to the feed.
const FEED_SKIP = new Set(['rssi', 'lqi', 'contact', 'battery', 'electric-power']);

export class DeviceRegistry {
  private readonly map = new Map<string, Device>();
  private readonly changedAt = new Map<string, number>(); // "deviceId|attr" → when the value last changed
  private readonly store: Store;
  private settings: DeviceSettings;

  constructor(store: Store, settings: DeviceSettings = {}) {
    this.store = store;
    this.settings = settings;
  }

  list(): Device[] { return [...this.map.values()]; }
  // New names or rooms from the panel apply at once; a door's reading changes with the next sync.
  setSettings(s: DeviceSettings): void {
    this.settings = s;
    for (const d of this.map.values()) this.dress(d);
  }

  private entry(cubeName: string): DeviceSettings[string] | undefined {
    return Object.entries(this.settings).find(([k]) => norm(k) === norm(cubeName))?.[1];
  }

  private dress(d: Device): Device {
    const e = this.entry(d.cubeName);
    d.name = e?.label?.trim() || d.cubeName;
    d.room = e?.room?.trim() || null;
    return d;
  }
  get(id: string): Device | undefined { return this.map.get(id); }
  changedSince(id: string, attr: string): number | null { return this.changedAt.get(`${id}|${attr}`) ?? null; }

  resolve(ref: string): { status: 'ok'; device: Device } | { status: 'missing' | 'ambiguous' } {
    const key = norm(ref);
    const byId = this.list().find((d) => norm(d.id) === key);
    if (byId) return { status: 'ok', device: byId };
    const byName = this.list().filter((d) => norm(d.name) === key || norm(d.cubeName) === key);
    if (byName.length === 1) return { status: 'ok', device: byName[0]! };
    return { status: byName.length ? 'ambiguous' : 'missing' };
  }

  // Full list from CUBE (start, reconnect): changes during a disconnect still reach the feed.
  load(list: CubeDevice[], now: number): void {
    const before = new Map(this.map);
    this.map.clear();
    for (const raw of list) {
      const dev = this.dress(toDevice(raw, this.contactMode(raw.name)));
      this.map.set(dev.id, dev);
      this.recordSamples(dev.id, dev.attrs, now);
      const prev = before.get(dev.id);
      if (prev) this.noteChanges(dev, prev.attrs, dev.attrs, now);
      // First sight of a device (engine start): a snapshot, so a replay knows where history begins.
      else for (const [attr, v] of Object.entries(dev.attrs)) if (typeof v !== 'number') this.store.addChange(now, dev.id, attr, v);
    }
  }

  // A replay starts from a reconstructed state: no feed, no samples, no history.
  restore(list: Device[]): void {
    this.map.clear();
    for (const d of list) this.map.set(d.id, { ...d, attrs: { ...d.attrs } });
  }

  // Already-normalized values (a replay feeding history back in).
  applyAttrs(id: string, attrs: Record<string, Value>, now: number): DeviceChange | null {
    const dev = this.map.get(id);
    if (!dev) return null;
    this.noteChanges(dev, dev.attrs, attrs, now);
    Object.assign(dev.attrs, attrs);
    this.recordSamples(dev.id, attrs, now);
    const [attr, value] = Object.entries(attrs)[0] ?? [];
    return { device: dev, attr, value };
  }

  // Applies one CUBE event; returns what changed, or null if the device is unknown or nothing matters.
  apply(e: CubeEvent, now: number): DeviceChange | null {
    if (e.type === 'added') {
      const d = this.dress(toDevice(e.device, this.contactMode(e.device.name)));
      this.map.set(d.id, d);
      this.store.addEvent(now, 'device', d.id, `${d.name}: новое устройство в CUBE`);
      return { device: d };
    }
    const dev = this.map.get(e.id);
    if (!dev) return null;
    if (e.type === 'removed') {
      this.map.delete(e.id);
      this.store.addEvent(now, 'device', dev.id, `${dev.name}: удалено из CUBE`);
      return { device: dev };
    }
    if (e.type === 'info') { if (e.name) { dev.cubeName = e.name; this.dress(dev); } return null; }
    if (e.type === 'online') {
      if (dev.online !== e.online) this.store.addEvent(now, 'device', dev.id, `${dev.name}: ${e.online ? 'снова в сети' : 'не в сети'}`);
      dev.online = e.online;
      return { device: dev, attr: 'online', value: e.online };
    }
    return this.applyAttrs(dev.id, flattenState(e.state, this.contactMode(dev.cubeName)), now);
  }

  private contactMode(name: string): 'closed' | 'open' {
    const entry = Object.entries(this.settings).find(([k]) => norm(k) === norm(name));
    return entry?.[1].contact_true_means ?? 'closed';
  }

  private recordSamples(id: string, attrs: Record<string, Value>, ts: number): void {
    for (const [attr, v] of Object.entries(attrs)) if (typeof v === 'number' && Number.isFinite(v)) this.store.addSample(id, attr, ts, v);
  }

  private noteChanges(dev: Device, prev: Record<string, Value>, next: Record<string, Value>, now: number): void {
    for (const [attr, v] of Object.entries(next)) {
      if (prev[attr] === v) continue;
      this.changedAt.set(`${dev.id}|${attr}`, now);
      if (typeof v !== 'number') this.store.addChange(now, dev.id, attr, v); // numbers are in samples
      if (!FEED_SKIP.has(attr) && typeof v !== 'number' && prev[attr] !== undefined) {
        this.store.addEvent(now, 'device', dev.id, changeText(dev.name, attr, v));
      }
    }
  }
}
