// Attribute + value → the CUBE state payload a real sensor would report.
// Used by the simulator CLI and the web panel's simulator buttons.
import type { Value } from './normalize.ts';

export function simPayload(attr: string, value: Value): Record<string, unknown> {
  switch (attr) {
    case 'open': return { contact: { contact: !value } }; // contact=true means closed
    case 'contact': return { contact: { contact: value } };
    case 'leak': return { 'water-leak': { waterLeak: value } };
    case 'power': return { power: { powerState: value === true ? 'on' : value === false ? 'off' : value } };
    case 'motion': return { motion: { motion: value } };
    case 'detected': return { detect: { detected: value } };
    default: {
      const ch = /^toggle\.(\w+)$/.exec(attr);
      if (ch) return { toggle: { [ch[1]!]: { toggleState: value === true ? 'on' : value === false ? 'off' : value } } };
      if (!/^[a-z][a-z0-9_-]*$/.test(attr)) throw new Error(`Нельзя задать «${attr}» в симуляторе`);
      return { [attr]: { [attr]: value } }; // humidity, temperature, battery…
    }
  }
}
