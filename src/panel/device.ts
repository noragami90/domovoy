// The device page: values, health (last seen, usual report interval, battery), which rules and
// scenes use it, and its recent events.
import type { Device } from '../cube/normalize.ts';
import type { Engine } from '../engine/engine.ts';
import type { DeviceHealth, Health } from '../notify/health.ts';
import { conditionsOf, isDeviceCondition, type Action, type Condition } from '../rules/schema.ts';
import type { FeedEvent, Store } from '../store/db.ts';
import { attrsOf, type PanelAttr } from './state.ts';

export interface DevicePage {
  id: string; name: string; cubeName: string; room: string | null; rooms: string[]; model: string; category: string; online: boolean;
  attrs: PanelAttr[];
  health: DeviceHealth | null;
  rules: { id: string; name: string; roles: string[] }[];
  scenes: { id: string; name: string }[];
  events: FeedEvent[];
}

const norm = (s: string) => s.trim().toLowerCase();

export function deviceUsage(engine: Engine, d: Device): Pick<DevicePage, 'rules' | 'scenes'> {
  const keys = new Set([norm(d.name), norm(d.cubeName), norm(d.id)]);
  const watches = (list: Condition[] = []) => list.some((c) => isDeviceCondition(c) && keys.has(norm(c.device)));
  const controls = (list: Action[]) => list.some((a) => 'set' in a && keys.has(norm(a.set.device)));
  const checks = (list: Action[]) => list.some((a) => watches(a.if));
  const rules = engine.rules.flatMap((r) => {
    const actions = [...r.then, ...(r.otherwise?.do ?? [])];
    const roles = [
      watches(conditionsOf(r)) ? 'следит' : null,
      controls(actions) ? 'управляет' : null,
      checks(actions) ? 'проверяет перед действием' : null,
    ].filter((x): x is string => x !== null);
    return roles.length ? [{ id: r.id, name: r.name, roles }] : [];
  });
  const scenes = engine.scenes.filter((s) => controls(s.do) || checks(s.do)).map((s) => ({ id: s.id, name: s.name }));
  return { rules, scenes };
}

export function devicePage(engine: Engine, store: Store, health: Health | undefined, id: string, rooms: string[] = []): DevicePage | null {
  const d = engine.deviceList().find((x) => x.id === id);
  if (!d) return null;
  return {
    id: d.id, name: d.name, cubeName: d.cubeName, room: d.room, rooms, model: d.model, category: d.category, online: d.online,
    attrs: attrsOf(d),
    health: health?.info(d) ?? null,
    ...deviceUsage(engine, d),
    events: store.events({ ref: d.id, limit: 20 }),
  };
}
