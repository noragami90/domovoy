// Tablet on the wall (#tablet): dark, big, touch-first. A clock, what needs attention, the home mode,
// scenes, and the rooms with tap-to-toggle switches and big sensor readings. Rebuilt only when what
// it shows changes, so a tile is never replaced under a finger; the clock ticks on its own.
import { api, attrLabel, fill, h, num } from './dom.js';

const SWITCH = /^(power|toggle\.\w+)$/;
const value = (d, key) => d.attrs.find((a) => a.key === key);

function tiles(d, act) {
  const out = [];
  const switches = d.attrs.filter((a) => SWITCH.test(a.key));
  for (const a of switches) {
    const on = a.value === 'on';
    const label = switches.length > 1 ? `${d.name} · ${attrLabel(a.key)}` : d.name; // one channel — just the name
    out.push(h('button', {
      class: `tb-tile tb-switch${on ? ' on' : ''}`, 'aria-pressed': String(on), disabled: !d.online,
      onclick: act(() => api(`/api/devices/${encodeURIComponent(d.id)}/set`, { attr: a.key, value: on ? 'off' : 'on' })),
    }, h('span', { class: 'tb-name' }, label), h('span', { class: 'tb-state' }, d.online ? (on ? 'включено' : 'выключено') : 'не в сети')));
  }
  const t = value(d, 'temperature'), hum = value(d, 'humidity');
  if (t || hum) {
    out.push(h('div', { class: 'tb-tile tb-sensor' }, h('span', { class: 'tb-name' }, d.name),
      h('span', { class: 'tb-big' }, t ? `${num(t.value)}°` : '', hum ? h('span', { class: 'tb-small' }, ` ${num(hum.value)}%`) : null)));
  }
  const door = value(d, 'open');
  if (door) out.push(h('div', { class: `tb-tile tb-door${door.value === true ? ' warn' : ''}` }, h('span', { class: 'tb-name' }, d.name), h('span', { class: 'tb-state' }, door.text)));
  const leak = value(d, 'leak');
  if (leak) out.push(h('div', { class: `tb-tile${leak.value === true ? ' alert' : ''}` }, h('span', { class: 'tb-name' }, d.name), h('span', { class: 'tb-state' }, leak.value === true ? 'ПРОТЕЧКА' : 'сухо')));
  const watts = value(d, 'power_w');
  if (watts && !switches.length) out.push(h('div', { class: 'tb-tile tb-sensor' }, h('span', { class: 'tb-name' }, d.name), h('span', { class: 'tb-big' }, `${Math.round(watts.value)} Вт`)));
  return out;
}

export function createTablet(root, { onError, toast }) {
  let key = null;
  let clockTimer = null;
  const act = (fn) => async () => { try { await fn(); } catch (e) { onError(e); } };

  const clock = h('div', { class: 'tb-clock' });
  const date = h('div', { class: 'tb-date' });
  const tick = () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    date.textContent = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  };

  function render(state) {
    const m = state.home;
    const mode = state.vars.find((v) => v.name === 'mode' && v.options);
    const view = {
      devices: state.devices.map((d) => [d.id, d.name, d.room, d.online, d.attrs.map((a) => [a.key, a.value])]),
      rooms: state.rooms, mode: mode?.value, scenes: state.scenes.map((s) => s.id), acks: m.pendingAcks.map((n) => n.id),
      leaks: m.leaks, open: m.open.map((o) => o.device), offline: m.offline, link: state.link.connected,
    };
    const next = JSON.stringify(view);
    if (next === key) return;
    key = next;

    const alerts = [
      ...m.pendingAcks.map((n) => h('div', { class: 'tb-alert alert' }, h('span', {}, `🚨 ${n.text}`),
        h('button', { class: 'tb-ack', onclick: act(async () => { await api(`/api/notifications/${n.id}/ack`, {}); toast('Принято', 'notice'); }) }, 'Принял'))),
      ...m.leaks.map((d) => h('div', { class: 'tb-alert alert' }, `💧 Протечка: ${d}`)),
      m.open.length ? h('div', { class: 'tb-alert warn' }, `🚪 Открыто: ${m.open.map((o) => o.device).join(', ')}`) : null,
      !state.link.connected ? h('div', { class: 'tb-alert warn' }, 'Нет связи с CUBE') : null,
      m.offline.length ? h('div', { class: 'tb-alert warn' }, `Не в сети: ${m.offline.join(', ')}`) : null,
    ].filter(Boolean);

    const groups = [...state.rooms.map((r) => [r, state.devices.filter((d) => d.room === r)]),
      [state.rooms.length ? 'Остальное' : 'Устройства', state.devices.filter((d) => !d.room || !state.rooms.includes(d.room))]]
      .map(([room, list]) => [room, list.flatMap((d) => tiles(d, act))]).filter(([, t]) => t.length);

    fill(root,
      h('div', { class: 'tb-top' }, h('div', {}, clock, date),
        h('a', { class: 'tb-exit', href: '#', title: 'Выйти из режима планшета' }, '⋯')),
      alerts.length ? h('div', { class: 'tb-alerts' }, alerts) : null,
      mode ? h('h2', { class: 'tb-room-name' }, mode.label) : null,
      mode ? h('div', { class: 'tb-modes', role: 'radiogroup', 'aria-label': mode.label }, mode.options.map((o) =>
        h('button', { class: `tb-mode${o.value === mode.value ? ' on' : ''}`, role: 'radio', 'aria-checked': String(o.value === mode.value),
          onclick: act(() => api('/api/vars/mode', { value: o.value })) }, o.label))) : null,
      state.scenes.length ? h('h2', { class: 'tb-room-name' }, 'Сцены') : null,
      state.scenes.length ? h('div', { class: 'tb-scenes' }, state.scenes.map((s) =>
        h('button', { class: 'tb-scene', onclick: act(async () => { await api(`/api/scenes/${encodeURIComponent(s.id)}/run`, {}); toast(`«${s.name}»`, 'notice'); }) }, `▶ ${s.name}`))) : null,
      h('div', { class: 'tb-rooms' }, groups.map(([room, t]) => h('section', { class: 'tb-room' }, h('h2', { class: 'tb-room-name' }, room), h('div', { class: 'tb-grid' }, t)))));
    tick();
  }

  return {
    render,
    show() { key = null; tick(); clearInterval(clockTimer); clockTimer = setInterval(tick, 10_000); },
    hide() { clearInterval(clockTimer); clockTimer = null; key = null; },
  };
}
