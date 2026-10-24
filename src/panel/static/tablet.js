// Tablet on the wall (#tablet): the NSPanel home screen, big. On the left the climate, the clock, what
// needs attention, the mode and the scenes; on the right the rooms with a tile per switch channel.
// Rebuilt only when what it shows changes, so a tile is never replaced under a finger; the clock ticks on its own.
import { api, attrLabel, fill, h, num } from './dom.js';
import { deviceIcon, icon, modeIcon, sceneIcon } from './icons.js';

const SWITCH = /^(power|toggle\.\w+)$/;
const value = (d, key) => d.attrs.find((a) => a.key === key);
const parts = (ic, name, state, big) => [
  h('span', { class: 'ns-top' }, h('span', { class: 'ns-icon' }, icon(ic))),
  big, h('span', { class: 'ns-foot' }, h('span', { class: 'ns-name' }, name), state ? h('span', { class: 'ns-state' }, state) : null),
];

function tiles(d, act) {
  const out = [];
  const ic = deviceIcon(d);
  const switches = d.attrs.filter((a) => SWITCH.test(a.key));
  for (const a of switches) {
    const on = a.value === 'on';
    const name = switches.length > 1 ? `${d.name} · ${attrLabel(a.key)}` : d.name; // one channel — just the name
    out.push(h('button', {
      class: `ns-tile tb${on ? ' on' : ''}${d.online ? '' : ' offline'}`, 'aria-pressed': String(on), disabled: !d.online,
      onclick: act(() => api(`/api/devices/${encodeURIComponent(d.id)}/set`, { attr: a.key, value: on ? 'off' : 'on' })),
    }, parts(ic, name, d.online ? (on ? 'включено' : 'выключено') : 'не в сети')));
  }
  const t = value(d, 'temperature'), hum = value(d, 'humidity');
  if (t || hum) {
    const big = h('span', { class: 'ns-big' }, t ? `${num(t.value)}°` : `${num(hum.value)}%`, t && hum ? h('small', {}, `${num(hum.value)}%`) : null);
    out.push(h('div', { class: 'ns-tile tb' }, parts(ic, d.name, null, big)));
  }
  const door = value(d, 'open');
  if (door) out.push(h('div', { class: `ns-tile tb${door.value === true ? ' ajar' : ''}` }, parts(ic, d.name, door.text)));
  const leak = value(d, 'leak');
  if (leak) out.push(h('div', { class: `ns-tile tb${leak.value === true ? ' alarm' : ''}` }, parts(ic, d.name, leak.value === true ? 'Протечка!' : 'сухо')));
  const watts = value(d, 'power_w');
  if (watts && !switches.length) out.push(h('div', { class: 'ns-tile tb' }, parts(ic, d.name, null, h('span', { class: 'ns-big' }, `${Math.round(watts.value)} Вт`))));
  return out;
}

export function createTablet(root, { onError, toast }) {
  let key = null;
  let clockTimer = null;
  const act = (fn) => async () => { try { await fn(); } catch (e) { onError(e); } };

  const clock = h('div', { class: 'hero-time tb-clock' });
  const date = h('div', { class: 'hero-date' });
  const tick = () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const day = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
    date.textContent = day.charAt(0).toUpperCase() + day.slice(1);
  };
  const quick = (cls, ic, label, props) => h('button', { class: `qa ${cls}`, ...props }, h('span', { class: 'qa-icon' }, icon(ic)), h('span', { class: 'qa-label' }, label));

  function render(state) {
    const m = state.home;
    const mode = state.vars.find((v) => v.name === 'mode' && v.options);
    const view = {
      devices: state.devices.map((d) => [d.id, d.name, d.room, d.online, d.attrs.map((a) => [a.key, a.value])]),
      rooms: state.rooms, mode: mode?.value, scenes: state.scenes.map((s) => [s.id, s.name]), acks: m.pendingAcks.map((n) => n.id),
      leaks: m.leaks, open: m.open.map((o) => o.device), offline: m.offline, link: state.link.connected,
    };
    const next = JSON.stringify(view);
    if (next === key) return;
    key = next;

    const alerts = [
      ...m.pendingAcks.map((n) => h('div', { class: 'tb-alert alert', role: 'alert' }, h('span', {}, n.text),
        h('button', { class: 'tb-ack', onclick: act(async () => { await api(`/api/notifications/${n.id}/ack`, {}); toast('Принято', 'notice'); }) }, 'Принял'))),
      ...m.leaks.map((d) => h('div', { class: 'tb-alert alert', role: 'alert' }, `Протечка: ${d}`)),
      m.open.length ? h('div', { class: 'tb-alert warn' }, `Открыто: ${m.open.map((o) => o.device).join(', ')}`) : null,
      !state.link.connected ? h('div', { class: 'tb-alert warn' }, 'Нет связи с CUBE') : null,
      m.offline.length ? h('div', { class: 'tb-alert warn' }, `Не в сети: ${m.offline.join(', ')}`) : null,
    ].filter(Boolean);

    const groups = [...state.rooms.map((r) => [r, state.devices.filter((d) => d.room === r)]),
      [state.rooms.length ? 'Остальное' : 'Устройства', state.devices.filter((d) => !d.room || !state.rooms.includes(d.room))]]
      .map(([room, list]) => [room, list.flatMap((d) => tiles(d, act))]).filter(([, t]) => t.length);

    fill(root,
      h('div', { class: 'tb-side' },
        h('div', { class: 'hero-sun', 'aria-hidden': 'true' }),
        h('a', { class: 'tb-exit', href: '#', 'aria-label': 'Обычная панель', title: 'Обычная панель' }, icon('away')),
        h('div', { class: 'hero-climate' }, m.climate.map((c, i) => h('span', { class: 'hc' }, i ? null : icon('temp'),
          h('span', { class: 'hc-val' }, [c.temperature?.replace(/\s*°C$/, '°'), c.humidity].filter(Boolean).join(' ')), h('span', { class: 'hc-where' }, c.device)))),
        clock, date,
        alerts.length ? h('div', { class: 'tb-alerts' }, alerts) : null,
        mode ? h('div', { class: 'qa-block' }, h('h3', { class: 'qa-title' }, mode.label),
          h('div', { class: 'qa-row', role: 'radiogroup', 'aria-label': mode.label }, mode.options.map((o) => quick(o.value === mode.value ? 'on' : '', modeIcon(o), o.label,
            { role: 'radio', 'aria-checked': String(o.value === mode.value), onclick: act(() => api('/api/vars/mode', { value: o.value })) })))) : null,
        state.scenes.length ? h('div', { class: 'qa-block' }, h('h3', { class: 'qa-title' }, 'Сцены'),
          h('div', { class: 'qa-row' }, state.scenes.map((s) => quick('scene', sceneIcon(s), s.name,
            { onclick: act(async () => { await api(`/api/scenes/${encodeURIComponent(s.id)}/run`, {}); toast(`«${s.name}»`, 'notice'); }) })))) : null),
      h('div', { class: 'tb-rooms' }, groups.map(([room, t]) => h('section', { class: 'tb-room' }, h('h2', { class: 'tb-room-name' }, room), h('div', { class: 'tb-grid' }, t)))));
    tick();
  }

  return {
    render,
    show() { key = null; tick(); clearInterval(clockTimer); clockTimer = setInterval(tick, 10_000); },
    hide() { clearInterval(clockTimer); clockTimer = null; key = null; },
  };
}
