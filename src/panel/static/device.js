// Device page (#device/<id>): values and control, health (last seen, usual interval, battery),
// a chart, which rules and scenes use it, and its recent events.
import { renderChart } from './chart.js';
import { ago, api, attrLabel, clock, fill, h } from './dom.js';

const CHART_ATTRS = ['humidity', 'temperature', 'power_w', 'battery'];
const RANGES = [['1h', '1 ч', 3_600_000], ['24h', '24 ч', 86_400_000], ['7d', '7 д', 7 * 86_400_000]];

const every = (ms) => {
  const min = Math.round(ms / 60_000);
  return min < 1 ? 'чаще раза в минуту' : min < 60 ? `раз в ${min} мин` : `раз в ${Math.round(min / 60)} ч`;
};

function healthLines(d) {
  const hl = d.health;
  if (!hl) return [];
  const lines = [];
  if (!d.online) lines.push(h('li', { class: 'warn' }, 'CUBE сообщает: не в сети'));
  lines.push(h('li', {}, hl.lastSeen ? `Последний раз присылал данные ${ago(hl.lastSeen)} назад (${clock(hl.lastSeen)})` : 'С запуска движка ещё ничего не присылал'));
  lines.push(h('li', { class: 'muted' }, hl.usualGapMs ? `Обычно присылает ${every(hl.usualGapMs)}`
    : hl.measured ? 'Обычный ритм ещё считается — нужно хотя бы полдня его сообщений'
      : 'Присылает данные только при изменениях — за ним следит «не в сети» от CUBE'));
  if (hl.silentForMs) lines.push(h('li', { class: 'warn' }, `Молчит дольше обычного: нет данных ${ago(Date.now() - hl.silentForMs)}`));
  const battery = d.attrs.find((a) => a.key === 'battery');
  if (battery) lines.push(h('li', { class: hl.lowBattery ? 'warn' : '' }, `Батарейка: ${battery.text}${hl.lowBattery ? ' — пора заменить' : ''}`));
  return lines;
}

// Simulator buttons change a sensor as if the real one did. The simulator knows a device by its id.
function simCard(d, run) {
  const choice = (text, on, fn) => h('button', { class: `btn${on ? ' on' : ''}`, onclick: fn }, text);
  const group = (label, ...items) => h('span', { class: 'ctl' }, label ? h('span', { class: 'ctl-label' }, label) : null, ...items);
  const set = (attr, value) => run('/api/sim/state', { device: d.id, attr, value });
  const rows = [];
  for (const { key: k, value: v, text } of d.attrs) {
    if (k === 'open') rows.push(group(null, choice('Открыть', v === true, () => set('open', true)), choice('Закрыть', v === false, () => set('open', false))));
    else if ((k === 'humidity' || k === 'temperature') && typeof v === 'number') {
      const step = k === 'humidity' ? 5 : 0.5;
      const round = (x) => Math.round(x * 10) / 10;
      rows.push(group(attrLabel(k),
        h('button', { class: 'btn step', 'aria-label': `${attrLabel(k)}: меньше`, onclick: () => set(k, round(v - step)) }, '−'),
        h('span', { class: 'value' }, text),
        h('button', { class: 'btn step', 'aria-label': `${attrLabel(k)}: больше`, onclick: () => set(k, round(v + step)) }, '+'),
        h('button', { class: 'btn', title: 'Записать сутки обычных показаний — для обычного уровня и графика', onclick: () => run('/api/sim/seed', { device: d.id, attr: k }, 'Записаны сутки истории') }, 'Сутки истории')));
    } else if (['leak', 'motion', 'detected'].includes(k)) {
      rows.push(group(attrLabel(k), choice('Да', v === true, () => set(k, true)), choice('Нет', v === false, () => set(k, false))));
    }
  }
  if (!rows.length) return null;
  return h('section', { class: 'card dp-card dp-sim' }, h('h3', { class: 'nt-h' }, 'Симулятор'),
    h('p', { class: 'muted sys-hint' }, 'Меняет показания так, будто это сделал настоящий датчик.'),
    h('div', { class: 'controls sim' }, rows));
}

export function createDevicePage(root, { onError, toast, simulator }) {
  let id = null;
  let chart = null; // { attr, range }
  const run = async (path, body, ok) => {
    try { await api(path, body); if (ok) toast?.(ok, 'notice'); await load(); } catch (e) { onError(e); }
  };

  const meta = async (patch, ok) => {
    try { await api('/api/system/device', { cubeName: current.cubeName, ...patch }); toast?.(ok, 'notice'); await load(); } catch (e) { onError(e); }
  };
  let current = null;

  function nameCard(d) {
    return h('section', { class: 'card dp-card' }, h('h3', { class: 'nt-h' }, 'Имя и комната'),
      h('div', { class: 'sys-row' },
        h('input', { type: 'text', class: 'sys-input', value: d.name !== d.cubeName ? d.name : '', placeholder: d.cubeName, maxlength: '60', 'aria-label': 'Имя в панели',
          onchange: (e) => void meta({ label: e.target.value || null }, 'Имя сохранено') }),
        h('select', { 'aria-label': 'Комната', onchange: (e) => void meta({ room: e.target.value || null }, 'Комната сохранена') },
          h('option', { value: '' }, 'без комнаты'), d.rooms.map((r) => h('option', { value: r, selected: d.room === r }, r)))),
      h('p', { class: 'muted sys-hint' }, `В CUBE: «${d.cubeName}» — правила ссылаются на это имя, поэтому своё имя можно менять смело.${d.rooms.length ? '' : ' Комнаты заводятся в «Система → Комнаты и имена».'}`));
  }

  const control = async (attr, value) => {
    try { await api(`/api/devices/${encodeURIComponent(id)}/set`, { attr, value }); await load(); } catch (e) { onError(e); }
  };

  function chartBlock(d) {
    const attrs = CHART_ATTRS.filter((k) => d.attrs.some((a) => a.key === k && a.numeric));
    if (!attrs.length) return null;
    chart ??= { attr: attrs[0], range: '24h' };
    const box = h('div', { class: 'chart-box' }, 'Загружаю…');
    const pick = (patch) => { chart = { ...chart, ...patch }; void load(); };
    const choice = (text, on, fn) => h('button', { class: `btn${on ? ' on' : ''}`, onclick: fn }, text);
    const range = RANGES.find(([k]) => k === chart.range);
    api(`/api/history?device=${encodeURIComponent(d.id)}&attr=${chart.attr}&range=${chart.range}`)
      .then((data) => renderChart(box, data, range[2])).catch(onError);
    return h('section', { class: 'card dp-card dp-wide' }, h('h3', { class: 'nt-h' }, 'График'),
      h('div', { class: 'chart-bar' },
        attrs.length > 1 ? h('span', { class: 'ctl' }, attrs.map((a) => choice(attrLabel(a), a === chart.attr, () => pick({ attr: a })))) : null,
        h('span', { class: 'ctl' }, RANGES.map(([k, t]) => choice(t, k === chart.range, () => pick({ range: k }))))),
      box);
  }

  function render(d) {
    const switches = d.attrs.filter((a) => a.control === 'switch');
    fill(root,
      h('a', { class: 'dp-back', href: '#' }, '‹ Дом'),
      h('div', { class: 'dp-head' },
        h('h2', { class: 'ed-title' }, d.name),
        h('span', { class: d.online ? 'pill active' : 'pill paused' }, d.online ? 'на связи' : 'не в сети'),
        h('span', { class: 'muted' }, [d.room, d.model, d.category].filter(Boolean).join(' · '))),
      h('div', { class: 'dp-grid' },
        h('section', { class: 'card dp-card' }, h('h3', { class: 'nt-h' }, 'Сейчас'),
          h('div', { class: 'attrs' }, d.attrs.map((a) => h('span', { class: 'chip' }, `${attrLabel(a.key)} `, h('b', {}, a.text)))),
          switches.length ? h('div', { class: 'controls' }, h('span', { class: 'ctl-kind' }, 'Управление'), switches.map((a) =>
            h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, attrLabel(a.key)),
              h('button', { class: `btn${a.value === 'on' ? ' on' : ''}`, onclick: () => void control(a.key, 'on') }, 'Вкл'),
              h('button', { class: `btn${a.value === 'off' ? ' on' : ''}`, onclick: () => void control(a.key, 'off') }, 'Выкл')))) : null),
        simulator?.() ? simCard(d, run) : null,
        h('section', { class: 'card dp-card' }, h('h3', { class: 'nt-h' }, 'Здоровье'), h('ul', { class: 'dp-list' }, healthLines(d))),
        nameCard(d),
        h('section', { class: 'card dp-card' }, h('h3', { class: 'nt-h' }, 'Где используется'),
          d.rules.length || d.scenes.length ? h('ul', { class: 'dp-list' },
            d.rules.map((r) => h('li', {}, h('b', {}, r.name), h('span', { class: 'muted' }, ` — ${r.roles.join(', ')}`))),
            d.scenes.map((s) => h('li', {}, h('b', {}, `Сцена «${s.name}»`)))) : h('p', { class: 'muted' }, 'Ни одно правило и ни одна сцена его не используют.')),
        chartBlock(d),
        h('section', { class: 'card dp-card dp-wide' }, h('h3', { class: 'nt-h' }, 'Последние события'),
          d.events.length ? h('ul', { class: 'dp-list dp-events' }, d.events.map((e) => h('li', {}, h('time', {}, clock(e.ts)), e.text)))
            : h('p', { class: 'muted' }, 'Событий пока нет.'))));
  }

  async function load() {
    if (!id) return;
    try { current = await api(`/api/devices/${encodeURIComponent(id)}`); render(current); } catch (e) { onError(e); }
  }

  return {
    show(deviceId) { if (deviceId !== id) chart = null; id = deviceId; return load(); },
    refresh: () => {
      const typing = ['INPUT', 'SELECT'].includes(document.activeElement?.tagName) && root.contains(document.activeElement);
      return typing ? undefined : load(); // keep a name that is being typed
    },
  };
}
