// CUBE device state ⇄ flat attributes the rules use.
// {"humidity":{"humidity":55}} → humidity=55; {"toggle":{"1":{"toggleState":"on"}}} → toggle.1="on";
// {"contact":{"contact":true}} → contact=true and open=false (see contact_true_means in config).
export type Value = string | number | boolean | null;
export type Attrs = Record<string, Value>;

export interface CubeDevice {
  serial_number: string;
  name: string;
  display_category?: string;
  model?: string;
  manufacturer?: string;
  online?: boolean;
  state?: Record<string, unknown>;
  capabilities?: { capability: string; name?: string }[];
}

export interface Device {
  id: string;
  name: string;            // shown everywhere: the panel's own name if set, otherwise the CUBE name
  cubeName: string;        // as in the eWeLink app; cards and settings refer to this one
  room: string | null;
  category: string;
  model: string;
  online: boolean;
  attrs: Attrs;
}

const isScalar = (v: unknown): v is Value => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

// Friendlier names for a few capabilities; everything else keeps the capability name.
const ALIASES: Record<string, string> = { 'water-leak': 'leak', 'illumination-level': 'light_level', detect: 'detected' };

export function flattenState(state: Record<string, unknown> = {}, contactTrueMeans: 'closed' | 'open' = 'closed'): Attrs {
  const attrs: Attrs = {};
  for (const [cap, raw] of Object.entries(state)) {
    if (isScalar(raw)) { attrs[cap] = raw; continue; }
    if (!raw || typeof raw !== 'object') continue;
    const base = ALIASES[cap] ?? cap;
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (isScalar(val)) {
        const own = key === cap || key === camel(cap) || Object.keys(raw).length === 1;
        attrs[own ? base : `${base}.${key}`] = val;
      } else if (val && typeof val === 'object') {
        // Per-channel values such as toggle.1 or multi-press.2.
        const leaf = Object.values(val as Record<string, unknown>).find(isScalar);
        if (leaf !== undefined) attrs[`${base}.${key}`] = leaf;
      }
    }
  }
  if ('electric-power' in attrs && typeof attrs['electric-power'] === 'number') {
    attrs.power_w = (attrs['electric-power'] as number) / 100; // CUBE reports 0.01 W units
  }
  if (typeof attrs.contact === 'boolean') attrs.open = contactTrueMeans === 'closed' ? !attrs.contact : attrs.contact;
  return attrs;
}

export function toDevice(raw: CubeDevice, contactTrueMeans: 'closed' | 'open' = 'closed'): Device {
  return {
    id: raw.serial_number,
    name: raw.name,
    cubeName: raw.name,
    room: null,
    category: raw.display_category ?? 'unknown',
    model: raw.model ?? '',
    online: raw.online !== false,
    attrs: flattenState(raw.state, contactTrueMeans),
  };
}

// Attribute write → CUBE state payload. Only switchable attributes are supported in this version.
export function stateForSet(attr: string, value: Value): Record<string, unknown> {
  const onOff = value === true || value === 'on' ? 'on' : value === false || value === 'off' ? 'off' : null;
  if (attr === 'power') {
    if (!onOff) throw new Error(`power принимает on/off, получено: ${String(value)}`);
    return { power: { powerState: onOff } };
  }
  const channel = /^toggle\.(\w+)$/.exec(attr);
  if (channel) {
    if (!onOff) throw new Error(`${attr} принимает on/off, получено: ${String(value)}`);
    return { toggle: { [channel[1]!]: { toggleState: onOff } } };
  }
  throw new Error(`Управлять «${attr}» пока нельзя: поддерживаются power и toggle.N`);
}
