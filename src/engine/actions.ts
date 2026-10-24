// Runs the actions of a rule or a scene: switch devices, notify, set variables, turn everything off,
// start another scene. Each action may have "if" — conditions checked right before it runs.
import { stateForSet, type Device, type Value } from '../cube/normalize.ts';
import type { NotifyMeta } from '../notify/notifications.ts';
import type { Action, Condition } from '../rules/schema.ts';

export interface ActionResult { action: string; ok: boolean; error?: string; skipped?: boolean }

export interface ActionHost {
  device(ref: string): Device;                 // resolves and refuses protected devices (throws)
  devices(): Device[];
  isProtected(device: Device): boolean;
  actuator(deviceId: string, state: Record<string, unknown>): Promise<void>;
  notifier(text: string, meta?: NotifyMeta): Promise<void>;
  setVar(name: string, value: Value): void;
  runScene(id: string, owner: string, depth: number): Promise<ActionResult[]>;
  check(conditions: Condition[]): boolean;
  describeVar(name: string, value: Value): string; // "Режим: Ночь"
  displayName?(ref: string): string;
}

const MAX_DEPTH = 3;
const SWITCH = /^(power|toggle\.\w+)$/;

export function actionLabel(a: Action, host?: ActionHost): string {
  if ('set' in a) {
    const { attr, to } = a.set;
    const device = host?.displayName?.(a.set.device) ?? a.set.device; // the panel's own name, if any
    const what = attr === 'power' ? device : attr.startsWith('toggle.') ? `${device}, канал ${attr.slice(7)}` : `${device}.${attr}`;
    return `${what}: ${to === 'on' ? 'включить' : to === 'off' ? 'выключить' : `= ${to}`}`;
  }
  if ('notify' in a) return `${a.urgent ? 'срочное уведомление' : 'уведомление'}: ${a.notify}`;
  if ('set_var' in a) return host ? host.describeVar(a.set_var.var, a.set_var.to) : `${a.set_var.var} = ${a.set_var.to}`;
  if ('all_off' in a) return 'выключить всё';
  return `сцена ${a.scene}`;
}

async function allOff(host: ActionHost, except: string[]): Promise<string> {
  const skip = new Set(except.map((s) => s.trim().toLowerCase()));
  const done: string[] = [];
  for (const d of host.devices()) {
    if (host.isProtected(d) || skip.has(d.name.toLowerCase()) || skip.has(d.cubeName.toLowerCase()) || skip.has(d.id.toLowerCase()) || !d.online) continue;
    for (const [attr, v] of Object.entries(d.attrs)) {
      if (!SWITCH.test(attr) || v !== 'on') continue;
      await host.actuator(d.id, stateForSet(attr, 'off'));
      done.push(attr === 'power' ? d.name : `${d.name} (канал ${attr.slice(7)})`);
    }
  }
  return done.length ? `выключено: ${done.join(', ')}` : 'выключать нечего';
}

export async function runActions(host: ActionHost, owner: string, list: Action[], depth = 0): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const a of list) {
    let label = actionLabel(a, host);
    try {
      if (a.if && !host.check(a.if)) {
        results.push({ action: label, ok: true, skipped: true });
        continue;
      }
      if ('notify' in a) await host.notifier(a.notify, { source: owner, urgent: a.urgent });
      else if ('set_var' in a) host.setVar(a.set_var.var, a.set_var.to);
      else if ('set' in a) await host.actuator(host.device(a.set.device).id, stateForSet(a.set.attr, a.set.to));
      else if ('all_off' in a) label = await allOff(host, a.all_off.except);
      else {
        if (depth >= MAX_DEPTH) throw new Error('сцены вызывают друг друга слишком глубоко');
        const inner = await host.runScene(a.scene, owner, depth + 1);
        const failed = inner.filter((r) => !r.ok);
        if (failed.length) throw new Error(failed.map((r) => `${r.action}: ${r.error}`).join('; '));
      }
      results.push({ action: label, ok: true });
    } catch (err) {
      const msg = (err as Error).message;
      results.push({ action: label, ok: false, error: msg });
      if (!('notify' in a)) await host.notifier(`«${owner}»: не получилось ${label} — ${msg}`, { source: owner }).catch(() => {});
    }
  }
  return results;
}

export function resultsText(results: ActionResult[]): string {
  return results.map((r) => (r.skipped ? `${r.action} — пропущено` : r.ok ? r.action : `${r.action} — ошибка: ${r.error}`)).join('; ');
}
