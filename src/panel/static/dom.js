// Small helpers shared by the panel modules. Everything from the engine is inserted as text.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export class AuthError extends Error {}

export async function api(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(json.error || 'нужно войти');
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const sameDay = (a, b) => a.toDateString() === b.toDateString();

export function clock(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return sameDay(d, new Date()) ? time : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} ${time}`;
}

export function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.floor(s / 60)} мин`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;
  return `${Math.floor(s / 86400)} д`;
}

export const ATTR = {
  humidity: 'Влажность', temperature: 'Температура', open: 'Дверь', power: 'Питание', battery: 'Батарея',
  power_w: 'Мощность', leak: 'Протечка', motion: 'Движение', detected: 'Обнаружение', light_level: 'Освещённость',
};
export const attrLabel = (k) => ATTR[k] ?? (k.startsWith('toggle.') ? `Канал ${k.slice(7)}` : k);
export const UNIT = { humidity: '%', temperature: ' °C', power_w: ' Вт', battery: '%' };
export const num = (v) => String(Math.round(v * 10) / 10).replace('.', ',');

// replaceChildren that flattens arrays and drops null/false (replaceChildren would print them as text).
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}
