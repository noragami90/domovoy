// Web panel: login, the house at a glance, rules (switch, pause, «Почему?»), variables,
// devices (control, simulator, charts) and the event feed. Refreshes on every "change" from /api/events.
import { renderChart } from './chart.js';
import { AuthError, ago, api, attrLabel, clock, h } from './dom.js';
import { createEditor } from './editor.js';
import { createNotifications } from './notifications.js';
import { createDevicePage } from './device.js';
import { createSystem } from './system.js';
import { createTablet } from './tablet.js';
import { createTimeline } from './timeline.js';

const $ = (id) => document.getElementById(id);
const STATUS = { active: 'Активно', waiting: 'Ждёт', idle: 'Не выполняется', unknown: 'Не хватает данных', paused: 'На паузе', off: 'Выключено' };
const MARKS = { ok: '✓', waiting: '⏳', fail: '✗', unknown: '?' };
const PAUSES = [[30, '30 мин'], [60, '1 час'], [180, '3 часа'], [480, '8 часов'], [1440, 'сутки']];
const CHART_ATTRS = ['humidity', 'temperature', 'power_w', 'battery'];
const RANGES = [['1h', '1 ч', 3_600_000], ['24h', '24 ч', 86_400_000], ['7d', '7 д', 7 * 86_400_000]];

let state = null;
let events = null;
const openWhy = new Map();     // rule id → explanation ('' while loading)
const ruleCards = new Map();   // rule id → elements, built once and updated in place
const openCharts = new Map();  // device id → { attr, range }
const lastJson = {};

let errorTimer;
function toast(msg, tone = 'error') {
  const e = $('error');
  e.className = tone;
  e.textContent = msg;
  e.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { e.hidden = true; }, 5000);
}
function fail(e) { if (e instanceof AuthError) showLogin(); else toast(e.message); }
const act = (fn) => async (...args) => { try { await fn(...args); } catch (e) { fail(e); } };

// ── login ──────────────────────────────────────────────────────────────────

function showLogin() {
  events?.close();
  events = null;
  for (const id of ['app', 'tabs', 'link', 'logout', 'sim-badge']) $(id).hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('login-error');
  try {
    await api('/api/login', { password: $('password').value });
    $('password').value = '';
    err.hidden = true;
    start();
  } catch (e) { err.textContent = e.message; err.hidden = false; }
});
$('logout').addEventListener('click', act(async () => { await api('/api/logout', {}); showLogin(); }));

// ── views ──────────────────────────────────────────────────────────────────

const timeline = createTimeline($('view-timeline'), {
  onError: fail,
  refs: () => [
    ...(state?.devices ?? []).map((d) => [d.id, `Устройство: ${d.name}`]),
    ...(state?.rules ?? []).map((r) => [r.id, `Правило: ${r.name}`]),
  ],
});
const editor = createEditor($('view-editor'), { onError: fail, toast: (msg, tone) => toast(msg, tone) });
const notifications = createNotifications($('view-notifications'), { onError: fail, toast: (msg, tone) => toast(msg, tone) });
const devicePage = createDevicePage($('view-device'), { onError: fail, toast: (msg, tone) => toast(msg, tone) });
const system = createSystem($('view-system'), { onError: fail, toast: (msg, tone) => toast(msg, tone) });
const tablet = createTablet($('view-tablet'), { onError: fail, toast: (msg, tone) => toast(msg, tone) });
const VIEWS = ['overview', 'timeline', 'editor', 'notifications', 'device', 'system', 'tablet'];
// "#device/<id>" opens a device page; other hashes are tabs.
const deviceId = () => (location.hash.startsWith('#device/') ? decodeURIComponent(location.hash.slice(8)) : null);
const currentView = () => (deviceId() ? 'device' : VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview');
const deviceLink = (name) => {
  const d = state?.devices.find((x) => x.name === name);
  return d ? h('a', { class: 'dev-link', href: `#device/${encodeURIComponent(d.id)}` }, name) : name;
};
function applyView() {
  const v = currentView();
  for (const name of VIEWS) $(`view-${name}`).hidden = v !== name;
  for (const a of document.querySelectorAll('.tab')) a.setAttribute('aria-current', a.dataset.view === v ? 'page' : 'false');
  if (v !== 'overview') window.scrollTo(0, 0);
  if (v === 'timeline') void timeline.refresh();
  if (v === 'editor') void editor.show();
  if (v === 'notifications') void notifications.show();
  if (v === 'device') void devicePage.show(deviceId());
  if (v === 'system') void system.show();
  // Tablet on the wall: no header, its own dark look.
  document.body.classList.toggle('tablet-mode', v === 'tablet');
  if (v === 'tablet') { tablet.show(); if (state) tablet.render(state); } else tablet.hide();
}
window.addEventListener('hashchange', applyView);

// ── remote: scenes, home mode, who is home ─────────────────────────────────

const PRESENCE = /^home_|^anyone_home$/;

async function runScene(scene) {
  const out = await api(`/api/scenes/${encodeURIComponent(scene.id)}/run`, {});
  const done = out.results.filter((r) => r.ok && !r.skipped).map((r) => r.action);
  const failed = out.results.filter((r) => !r.ok).map((r) => `${r.action}: ${r.error}`);
  toast(failed.length ? `«${scene.name}»: ${failed.join('; ')}` : `«${scene.name}»: ${done.join('; ') || 'нечего делать'}`, failed.length ? 'error' : 'notice');
}

function renderRemote() {
  const mode = state.vars.find((v) => v.name === 'mode' && v.options);
  const blocks = [];
  if (mode) {
    blocks.push(h('div', { class: 'remote-block' }, h('div', { class: 'remote-title' }, mode.label),
      h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': mode.label }, mode.options.map((o) =>
        h('button', { class: `seg${o.value === mode.value ? ' on' : ''}`, role: 'radio', 'aria-checked': String(o.value === mode.value),
          onclick: act(() => api('/api/vars/mode', { value: o.value })) }, o.label)))));
  }
  if (state.scenes.length) {
    blocks.push(h('div', { class: 'remote-block' }, h('div', { class: 'remote-title' }, 'Сцены'),
      h('div', { class: 'scene-row' }, state.scenes.map((x) =>
        h('button', { class: 'btn scene', title: x.description ?? '', onclick: act(() => runScene(x)) }, x.name)))));
  }
  if (state.home.people.length) {
    blocks.push(h('div', { class: 'remote-block' }, h('div', { class: 'remote-title' }, 'Кто дома'),
      h('div', { class: 'scene-row' }, state.home.people.map((p) =>
        h('button', { class: `btn person${p.home ? ' on' : ''}`, 'aria-pressed': String(p.home),
          onclick: act(() => api(`/api/presence/${encodeURIComponent(p.id)}`, { home: !p.home })) }, `${p.name}: ${p.home ? 'дома' : 'нет'}`)))));
  }
  $('remote').hidden = !blocks.length;
  $('remote').replaceChildren(...blocks);
}

// ── the house at a glance ──────────────────────────────────────────────────

function tile(title, tone, ...body) {
  return h('div', { class: `tile ${tone}` }, h('div', { class: 'tile-title' }, title), h('div', { class: 'tile-body' }, ...body));
}
const rows = (items) => h('ul', { class: 'tile-list' }, items.map((t) => h('li', {}, ...[t].flat())));
const ackNow = (id) => act(async () => { await api(`/api/notifications/${id}/ack`, {}); toast('Принято', 'notice'); });

function renderHome() {
  const m = state.home;
  const r = m.rules;
  const ruleText = [[r.active, 'активно'], [r.waiting, 'ждёт'], [r.paused, 'на паузе'], [r.off, 'выключено'], [r.unknown, 'без данных']]
    .filter(([n]) => n).map(([n, t]) => `${n} ${t}`).join(' · ') || 'все ждут своего часа';
  const offline = [...m.offline, ...(state.link.connected ? [] : ['CUBE'])];
  const link = [
    ...offline.map((d) => [deviceLink(d), ' — нет связи']),
    ...m.silent.map((s) => [deviceLink(s.device), ` — молчит: ${s.text}`]),
  ];
  $('home').replaceChildren(...[
    m.leaks.length ? tile('Протечки', 'alert', rows(m.leaks.map((d) => `${d} — ПРОТЕЧКА`))) : tile('Протечки', 'ok', 'Сухо'),
    m.open.length ? tile('Двери и окна', 'warn', rows(m.open.map((o) => `${o.device} — открыта${o.since ? ` ${ago(o.since)}` : ''}`))) : tile('Двери и окна', 'ok', 'Всё закрыто'),
    tile('Климат', '', m.climate.length ? rows(m.climate.map((c) => `${c.device}: ${[c.temperature, c.humidity].filter(Boolean).join(' · ')}`)) : 'Нет датчиков'),
    m.lowBattery.length ? tile('Батарейки', 'warn', rows(m.lowBattery.map((b) => [deviceLink(b.device), ` — ${b.text}`]))) : tile('Батарейки', 'ok', 'В порядке'),
    link.length ? tile('Связь', 'warn', rows(link)) : tile('Связь', 'ok', 'Всё на связи'),
    m.people.length ? tile('Кто дома', '', m.people.some((p) => p.home) ? m.people.filter((p) => p.home).map((p) => p.name).join(', ') : 'Никого') : null,
    tile('Правила', '', ruleText),
    m.power ? tile('Мощность', '', m.power) : null,
  ].filter(Boolean)); // replaceChildren would print a null as text
}

// Urgent notifications waiting for «Принял»: their own block, rebuilt only when they change,
// so the button is not replaced under the cursor by the once-a-second refresh.
function renderAcks() {
  const list = state.home.pendingAcks;
  $('ack-count').hidden = !list.length;
  $('ack-count').textContent = String(list.length);
  $('acks').hidden = !list.length;
  $('acks').replaceChildren(...list.map((n) => h('div', { class: 'ack-item', role: 'alert' },
    h('span', { class: 'ack-text' }, h('b', {}, '🚨 '), n.text, h('span', { class: 'muted' }, ` · ${clock(n.ts)}${n.repeats ? ` · повторов: ${n.repeats}` : ''}`)),
    h('button', { class: 'btn primary', onclick: ackNow(n.id) }, 'Принял'))));
}

// ── rules ──────────────────────────────────────────────────────────────────

async function loadWhy(id) {
  try {
    const { text } = await api(`/api/why/${encodeURIComponent(id)}`);
    if (openWhy.has(id)) { openWhy.set(id, text); renderRules(); }
  } catch (e) { fail(e); }
}
function toggleWhy(id) {
  if (openWhy.has(id)) openWhy.delete(id); else { openWhy.set(id, ''); void loadWhy(id); }
  renderRules();
}

function ruleCard(id) {
  let c = ruleCards.get(id);
  if (c) return c;
  c = {
    name: h('div', { class: 'rule-name' }),
    pill: h('span', { class: 'pill' }),
    toggle: h('button', { class: 'switch', role: 'switch', 'aria-label': 'Правило включено', onclick: act(() => api(`/api/rules/${id}/enabled`, { enabled: !c.data.enabled })) }),
    desc: h('p', { class: 'desc' }),
    lines: h('ul', { class: 'lines' }),
    fired: h('span', {}),
    pause: h('span', { class: 'pause' }),
    btn: h('button', { class: 'why-btn', onclick: () => toggleWhy(id) }, 'Почему?'),
    why: h('div', { class: 'why' }),
  };
  c.card = h('article', { class: 'card rule' },
    h('div', { class: 'rule-head' }, h('div', {}, c.name, h('div', { class: 'rule-id' }, id)), h('div', { class: 'rule-ctl' }, c.pill, c.toggle)),
    c.desc, c.lines, h('div', { class: 'rule-foot' }, c.fired, h('span', { class: 'foot-actions' }, c.pause, c.btn)), c.why);
  ruleCards.set(id, c);
  return c;
}

function pauseControl(r, c) {
  const key = `${r.enabled}|${r.pausedUntil}`;
  if (c.pauseKey === key) return; // keep the control (and an open drop-down) as it is
  c.pauseKey = key;
  if (!r.enabled) return c.pause.replaceChildren();
  if (r.pausedUntil) {
    return c.pause.replaceChildren(h('span', { class: 'paused-until' }, `до ${clock(r.pausedUntil)}`),
      h('button', { class: 'btn', onclick: act(() => api(`/api/rules/${r.id}/pause`, { minutes: null })) }, 'Снять паузу'));
  }
  const select = h('select', { class: 'pause-select', 'aria-label': 'Пауза', onchange: act(async (e) => { const m = Number(e.target.value); e.target.value = ''; if (m) await api(`/api/rules/${r.id}/pause`, { minutes: m }); }) },
    h('option', { value: '' }, 'Пауза…'), PAUSES.map(([m, t]) => h('option', { value: m }, `на ${t}`)));
  c.pause.replaceChildren(select);
}

function renderRules() {
  const box = $('rules');
  if (!state.rules.length) return box.replaceChildren(h('p', { class: 'empty' }, 'Правил нет — положи карточки в папку rules.'));
  box.querySelector('.empty')?.remove();
  const seen = new Set();
  for (const r of state.rules) {
    const c = ruleCard(r.id);
    c.data = r;
    seen.add(r.id);
    c.card.classList.toggle('dim', r.status === 'off' || r.status === 'paused');
    c.name.textContent = r.name;
    c.pill.className = `pill ${r.status}`;
    c.pill.textContent = STATUS[r.status];
    c.toggle.setAttribute('aria-checked', String(r.enabled));
    c.desc.textContent = r.description ?? '';
    c.desc.hidden = !r.description;
    c.lines.replaceChildren(...r.lines.map((l) => h('li', {}, h('span', { class: `mark ${l.status}`, 'aria-hidden': 'true' }, MARKS[l.status]), h('span', {}, l.text))));
    const fired = r.lastFiredAt ? `Сработало: ${clock(r.lastFiredAt)}` : 'Ещё не срабатывало';
    c.fired.textContent = r.nextTimeAt && r.enabled && !r.pausedUntil ? `${fired} · по времени: ${clock(r.nextTimeAt)}` : fired;
    pauseControl(r, c);
    const expanded = openWhy.has(r.id);
    c.btn.setAttribute('aria-expanded', String(expanded));
    c.why.hidden = !expanded;
    c.why.textContent = expanded ? openWhy.get(r.id) || 'Загружаю…' : '';
    box.append(c.card);
  }
  for (const [id, c] of ruleCards) if (!seen.has(id)) { c.card.remove(); ruleCards.delete(id); }
}

// ── variables ──────────────────────────────────────────────────────────────

function renderVars() {
  const box = $('vars');
  // The mode and presence live on the remote above.
  const vars = state.vars.filter((v) => !(v.name === 'mode' && v.options) && !PRESENCE.test(v.name));
  if (!vars.length) return box.replaceChildren(h('p', { class: 'empty' }, 'Переменных нет.'));
  box.replaceChildren(...vars.map((v) => h('div', { class: 'card var-row' },
    h('div', {}, h('div', {}, v.label), h('div', { class: 'var-name' }, v.name)),
    typeof v.value === 'boolean'
      ? h('button', { class: 'switch', role: 'switch', 'aria-checked': String(v.value), 'aria-label': v.label, onclick: act(() => api(`/api/vars/${encodeURIComponent(v.name)}`, { value: !v.value })) })
      : h('span', { class: 'value' }, v.text))));
}

// ── devices ────────────────────────────────────────────────────────────────

const choice = (text, active, onclick) => h('button', { class: `btn${active ? ' on' : ''}`, onclick: act(onclick) }, text);
const group = (label, ...items) => h('span', { class: 'ctl' }, label ? h('span', { class: 'ctl-label' }, label) : null, ...items);
const sim = (d, attr, value) => api('/api/sim/state', { device: d.name, attr, value });
const control = (d, attr, value) => api(`/api/devices/${encodeURIComponent(d.id)}/set`, { attr, value });

function controlsFor(d) {
  const real = [];
  const fake = [];
  for (const { key: k, value: v, text, control: c } of d.attrs) {
    if (c === 'switch') real.push(group(attrLabel(k), choice('Вкл', v === 'on', () => control(d, k, 'on')), choice('Выкл', v === 'off', () => control(d, k, 'off'))));
    if (!state.simulator) continue;
    if (k === 'open') fake.push(group(null, choice('Открыть', v === true, () => sim(d, 'open', true)), choice('Закрыть', v === false, () => sim(d, 'open', false))));
    else if ((k === 'humidity' || k === 'temperature') && typeof v === 'number') {
      const step = k === 'humidity' ? 5 : 0.5;
      const round = (x) => Math.round(x * 10) / 10;
      fake.push(group(attrLabel(k),
        h('button', { class: 'btn step', 'aria-label': `${attrLabel(k)}: меньше`, onclick: act(() => sim(d, k, round(v - step))) }, '−'),
        h('span', { class: 'value' }, text),
        h('button', { class: 'btn step', 'aria-label': `${attrLabel(k)}: больше`, onclick: act(() => sim(d, k, round(v + step))) }, '+'),
        h('button', { class: 'btn', title: 'Записать сутки обычных показаний — для обычного уровня и графика', onclick: act(() => api('/api/sim/seed', { device: d.name, attr: k })) }, 'Сутки истории')));
    } else if (['leak', 'motion', 'detected'].includes(k)) {
      fake.push(group(attrLabel(k), choice('Да', v === true, () => sim(d, k, true)), choice('Нет', v === false, () => sim(d, k, false))));
    }
  }
  return [
    real.length ? h('div', { class: 'controls' }, h('span', { class: 'ctl-kind' }, 'Управление'), real) : null,
    fake.length ? h('div', { class: 'controls sim' }, h('span', { class: 'ctl-kind' }, 'Симулятор'), fake) : null,
  ];
}

async function loadChart(d, box) {
  const o = openCharts.get(d.id);
  if (!o) return;
  const range = RANGES.find(([k]) => k === o.range);
  try {
    const data = await api(`/api/history?device=${encodeURIComponent(d.id)}&attr=${o.attr}&range=${o.range}`);
    renderChart(box, data, range[2]);
  } catch (e) { fail(e); }
}

function chartPanel(d) {
  // In CHART_ATTRS order: humidity first — that is what the rules usually watch.
  const attrs = CHART_ATTRS.filter((k) => d.attrs.some((a) => a.key === k && a.numeric));
  if (!attrs.length) return null;
  const o = openCharts.get(d.id);
  const toggle = h('button', { class: 'btn', 'aria-expanded': String(!!o), onclick: () => {
    if (openCharts.has(d.id)) openCharts.delete(d.id); else openCharts.set(d.id, { attr: attrs[0], range: '24h' });
    lastJson.devices = null;
    renderDevices();
  } }, o ? 'Скрыть график' : 'График');
  if (!o) return h('div', { class: 'chart-bar' }, toggle);
  const box = h('div', { class: 'chart-box' }, 'Загружаю…');
  const pick = (patch) => { openCharts.set(d.id, { ...o, ...patch }); lastJson.devices = null; renderDevices(); };
  void loadChart(d, box);
  return h('div', { class: 'chart-wrap' },
    h('div', { class: 'chart-bar' }, toggle,
      attrs.length > 1 ? h('span', { class: 'ctl' }, attrs.map((a) => choice(attrLabel(a), a === o.attr, () => pick({ attr: a })))) : null,
      h('span', { class: 'ctl' }, RANGES.map(([k, t]) => choice(t, k === o.range, () => pick({ range: k }))))),
    box);
}

function renderDevices() {
  const box = $('devices');
  $('device-count').textContent = state.devices.length ? `· ${state.devices.length}` : '';
  if (!state.devices.length) return box.replaceChildren(h('p', { class: 'empty' }, 'CUBE не вернула ни одного устройства.'));
  // By room, in the order set in «Система»; without a room — last.
  const groups = [...state.rooms.map((r) => [r, state.devices.filter((d) => d.room === r)]),
    [state.rooms.length ? 'Без комнаты' : null, state.devices.filter((d) => !d.room || !state.rooms.includes(d.room))]].filter(([, list]) => list.length);
  box.replaceChildren(...groups.flatMap(([room, list]) => [room ? h('h3', { class: 'room-head' }, room) : null, ...list.map((d) => deviceCard(d))]).filter(Boolean));
}

function deviceCard(d) {
  return h('article', { class: 'card' },
    h('div', { class: 'dev-head' }, h('a', { class: 'dev-name dev-link', href: `#device/${encodeURIComponent(d.id)}` }, d.name),
      d.online ? h('span', { class: 'dev-meta' }, [d.model, d.category].filter(Boolean).join(' · ')) : h('span', { class: 'offline' }, 'не в сети')),
    h('div', { class: 'attrs' }, d.attrs.map((a) => h('span', { class: 'chip' }, `${attrLabel(a.key)} `, h('b', {}, a.text)))),
    ...controlsFor(d),
    chartPanel(d));
}

// ── refresh loop ───────────────────────────────────────────────────────────

function changedPart(key, value) {
  const json = JSON.stringify(value);
  if (lastJson[key] === json) return false;
  lastJson[key] = json;
  return true;
}

let loading = false;
let again = false;
let tick;
async function refresh() {
  if (loading) { again = true; return; }
  loading = true;
  try {
    state = await api('/api/state');
    $('link').hidden = false;
    $('link').className = `badge link ${state.link.connected ? 'on' : 'off'}`;
    $('link-text').textContent = state.link.connected ? 'CUBE на связи' : 'CUBE: нет связи';
    $('sim-badge').hidden = !state.simulator;
    $('sim-hint').hidden = !state.simulator;
    if (changedPart('remote', [state.scenes, state.vars.find((v) => v.name === 'mode'), state.home.people])) renderRemote();
    if (currentView() === 'tablet') tablet.render(state);
    if (changedPart('acks', state.home.pendingAcks)) renderAcks();
    renderHome();
    renderRules();
    if (changedPart('vars', state.vars)) renderVars();
    if (changedPart('devices', [state.devices, state.simulator, state.rooms])) renderDevices();
    for (const id of openWhy.keys()) void loadWhy(id);
    // "уже 12 с из 5 мин" and "открыта 3 мин" change with time: tick every second while something waits.
    clearTimeout(tick);
    if (state.rules.some((r) => r.status === 'waiting') || state.home.open.length) tick = setTimeout(() => void refresh(), 1000);
  } catch (e) {
    fail(e);
  } finally {
    loading = false;
    if (again) { again = false; void refresh(); }
  }
}

function start() {
  $('login').hidden = true;
  for (const id of ['app', 'tabs', 'logout']) $(id).hidden = false;
  events?.close();
  events = new EventSource('/api/events');
  events.addEventListener('change', () => {
    void refresh();
    if (currentView() === 'timeline') void timeline.refresh();
    if (currentView() === 'notifications') void notifications.refresh();
    if (currentView() === 'device') void devicePage.refresh();
    if (currentView() === 'system') void system.refresh();
  });
  void refresh();
  applyView();
}

setInterval(() => { if (events) void refresh(); }, 30_000);
api('/api/session').then((s) => (s.authenticated ? start() : showLogin())).catch(() => showLogin());
