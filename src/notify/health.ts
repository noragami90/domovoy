// Device health: low batteries, devices CUBE reports offline, and sensors that went quiet for longer
// than usual. One message when a problem starts and one when it is over; states survive restarts.
import type { Device } from '../cube/normalize.ts';
import type { Clock } from '../engine/clock.ts';
import { formatDuration } from '../duration.ts';
import type { Store } from '../store/db.ts';
import type { NotifyMeta } from './notifications.ts';
import type { NotifySettings } from './settings.ts';

export interface HealthOptions {
  store: Store;
  clock: Clock;
  devices: () => Device[];
  notify: (text: string, meta: NotifyMeta) => Promise<unknown>;
  settings: () => NotifySettings;
  log?: (msg: string) => void;
}

export interface DeviceHealth {
  lastSeen: number | null;
  measured: boolean;           // a climate or power sensor: reports by itself, so silence means something
  usualGapMs: number | null;   // how often it normally reports (median gap); null — unknown yet, or not a regular reporter
  silentForMs: number | null;  // set when it is quieter than usual
  lowBattery: boolean;
}

const HISTORY = 3 * 86_400_000;   // look at three days of reports
const MIN_REPORTS = 20;
const MIN_SPAN = 12 * 3_600_000;  // judge only from at least half a day of reports (not a burst while testing)
const MIN_SILENCE = 3_600_000;    // never call it silent before an hour
// Only sensors whose reports come from the environment by themselves. Doors, motion and switches
// stay silent for days when nobody uses them (a vacation) — for them CUBE's own "offline" is the signal.
const MEASURED = new Set(['temperature', 'humidity', 'power_w', 'light_level', 'illumination', 'co2', 'pm25', 'voc', 'pressure']);
const OFFLINE_GRACE = 10 * 60_000;
const BATTERY_HYSTERESIS = 5;     // "replaced" only when it is clearly back up
const SOURCE = 'Здоровье устройств';

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

export class Health {
  private readonly o: HealthOptions;
  private readonly seen: Map<string, number>;
  private readonly dirty = new Set<string>();
  private reports: [string, number][] = []; // not yet saved
  private readonly gaps = new Map<string, { at: number; usual: number | null; slack: number | null }>();

  constructor(o: HealthOptions) {
    this.o = o;
    this.seen = o.store.seenAll();
  }

  // The device itself sent a state report.
  touch(deviceId: string): void {
    const now = this.o.clock.now();
    this.seen.set(deviceId, now);
    this.dirty.add(deviceId);
    this.reports.push([deviceId, now]);
  }

  lastSeen(deviceId: string): number | null { return this.seen.get(deviceId) ?? null; }

  // Usual gap between the device's own reports over three days; cached for half an hour.
  // "Silent" means: well past both the usual rhythm and the longest pause seen recently.
  private gap(d: Device): { usual: number | null; slack: number | null } {
    const now = this.o.clock.now();
    const c = this.gaps.get(d.id);
    if (c && now - c.at < 30 * 60_000) return c;
    let usual: number | null = null, slack: number | null = null;
    if (Object.keys(d.attrs).some((k) => MEASURED.has(k))) {
      this.saveReports();
      const times = this.o.store.reportTimes(d.id, now - HISTORY);
      if (times.length >= MIN_REPORTS && times.at(-1)! - times[0]! >= MIN_SPAN) {
        const gaps = times.slice(1).map((t, i) => t - times[i]!).sort((a, b) => a - b);
        usual = quantile(gaps, 0.5);
        slack = Math.max(4 * quantile(gaps, 0.9), 1.5 * gaps.at(-1)!, MIN_SILENCE);
      }
    }
    const r = { at: now, usual, slack };
    this.gaps.set(d.id, r);
    return r;
  }

  private saveReports(): void {
    if (!this.reports.length) return;
    this.o.store.addReports(this.reports);
    this.reports = [];
  }

  info(d: Device): DeviceHealth {
    const now = this.o.clock.now();
    const lastSeen = this.lastSeen(d.id);
    const { usual, slack } = this.gap(d);
    const silent = this.o.settings().silence.enabled && d.online && lastSeen !== null && slack !== null && now - lastSeen > slack;
    return {
      lastSeen, measured: Object.keys(d.attrs).some((k) => MEASURED.has(k)), usualGapMs: usual, silentForMs: silent ? now - lastSeen! : null,
      lowBattery: typeof d.attrs.battery === 'number' && d.attrs.battery < this.o.settings().battery.below,
    };
  }

  // Every few minutes: save last-seen times, compare with what was already reported, notify changes.
  async check(): Promise<void> {
    const now = this.o.clock.now();
    this.flush();
    const alerts = this.o.store.alerts();
    const s = this.o.settings();
    const say = (text: string) => this.o.notify(text, { source: SOURCE }).catch((e) => this.o.log?.(`Здоровье: ${(e as Error).message}`));

    for (const d of this.o.devices()) {
      // A device seen for the first time starts its clock now, so silence is measured from a known point.
      if (!this.seen.has(d.id)) { this.seen.set(d.id, now); this.dirty.add(d.id); }

      const battery = d.attrs.battery;
      const bKey = `battery:${d.id}`;
      if (typeof battery === 'number') {
        if (battery < s.battery.below && !alerts.has(bKey)) {
          this.o.store.saveAlert(bKey, now, true);
          await say(`🔋 Садится батарейка: ${d.name} — ${battery}%. Пора заменить.`);
        } else if (battery >= s.battery.below + BATTERY_HYSTERESIS && alerts.has(bKey)) {
          this.o.store.deleteAlert(bKey);
          await say(`🔋 Батарейку заменили: ${d.name} — ${battery}%.`);
        }
      }

      const oKey = `offline:${d.id}`;
      const off = alerts.get(oKey);
      if (!d.online) {
        if (!off) this.o.store.saveAlert(oKey, now, false);
        else if (!off.notified && now - off.since >= OFFLINE_GRACE) {
          this.o.store.saveAlert(oKey, off.since, true);
          await say(`📴 Не в сети: ${d.name} — уже ${formatDuration(now - off.since)}.`);
        }
      } else if (off) {
        this.o.store.deleteAlert(oKey);
        if (off.notified) await say(`📶 Снова в сети: ${d.name}.`);
      }

      const sKey = `silent:${d.id}`;
      const h = this.info(d);
      if (h.silentForMs !== null && !alerts.has(sKey)) {
        this.o.store.saveAlert(sKey, now, true);
        await say(`🤫 Молчит дольше обычного: ${d.name} — нет данных ${formatDuration(h.silentForMs)} (обычно присылает раз в ${formatDuration(h.usualGapMs!)}).`);
      } else if (h.silentForMs === null && alerts.has(sKey) && d.online) {
        this.o.store.deleteAlert(sKey);
        // Only if it really reported since; an alert that turned out wrong goes away quietly.
        if ((h.lastSeen ?? 0) >= alerts.get(sKey)!.since) await say(`📡 Снова присылает данные: ${d.name}.`);
      }
    }
  }

  flush(): void {
    this.saveReports();
    if (!this.dirty.size) return;
    this.o.store.saveSeen([...this.dirty].map((id) => [id, this.seen.get(id)!]));
    this.dirty.clear();
  }
}
