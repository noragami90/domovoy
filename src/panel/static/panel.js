// Web panel: login, the home screen (clock, how the house is, mode, scenes, devices by room), rules
// (switch, pause, «Почему?»), variables and the other tabs. Refreshes on every "change" from /api/events.
import { AuthError, ago, api, clock, h } from './dom.js';
import { createEditor } from './editor.js';
import { icon, modeIcon, sceneIcon } from './icons.js';
import { createNotifications } from './notifications.js';
import { createDevicePage } from './device.js';
import { createSystem } from './system.js';
import { createTablet } from './tablet.js';
import { deviceTile } from './tiles.js';
import { createTimeline } from './timeline.js';

const $ = (id) => document.getElementById(id);
const STATUS = { active: 'Активно', waiting: 'Ждёт', idle: 'Не выполняется', unknown: 'Не хватает данных', paused: 'На паузе', off: 'Выключено' };
const MARKS = { ok: '✓', waiting: '⏳', fail: '✗', unknown: '?' };
const PAUSES = [[30, '30 мин'], [60, '1 час'], [180, '3 часа'], [480, '8 часов'], [1440, 'сутки']];

let state = null;
let events = null;
const openWhy = new Map();     // rule id → explanation ('' while loading)
const ruleCards = new Map();   // rule id → elements, built once and updated in place
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
const devicePage = createDevicePage($('view-device'), { onError: fail, toast: (msg, tone) => toast(msg, tone), simulator: () => state?.simulator });
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
  document.body.dataset.view = v; // the status bar shows the time everywhere but on the home screen, which has the big clock
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

// Quick cards like the ones along the bottom of the wall panel: an icon in a circle and a word.
const quick = (cls, ic, label, props, sub) => h('button', { class: `qa ${cls}`, ...props },
  h('span', { class: 'qa-icon' }, icon(ic)), h('span', { class: 'qa-label' }, label), sub ? h('span', { class: 'qa-sub' }, sub) : null);
const block = (title, row) => h('div', { class: 'qa-block' }, h('h3', { class: 'qa-title' }, title), row);

function renderRemote() {
  const mode = state.vars.find((v) => v.name === 'mode' && v.options);
  const blocks = [];
  if (mode) {
    blocks.push(block(mode.label, h('div', { class: 'qa-row', role: 'radiogroup', 'aria-label': mode.label }, mode.options.map((o) => {
      const on = o.value === mode.value;
      return quick(on ? 'on' : '', modeIcon(o), o.label, { role: 'radio', 'aria-checked': String(on), onclick: act(() => api('/api/vars/mode', { value: o.value })) });
    }))));
  }
  if (state.scenes.length) {
    blocks.push(block('Сцены', h('div', { class: 'qa-row' }, state.scenes.map((x) => quick('scene', sceneIcon(x), x.name, {
      title: x.description ?? '',
      onclick: act(async (e) => {
        const card = e.currentTarget;
        card.classList.add('ran'); // a short blue flash: the scene was sent
        setTimeout(() => card.classList.remove('ran'), 700);
        await runScene(x);
      }),
    })))));
  }
  if (state.home.people.length) {
    blocks.push(block('Кто дома', h('div', { class: 'qa-row' }, state.home.people.map((p) => quick(`person${p.home ? ' on' : ''}`, 'person', p.name, {
      'aria-pressed': String(p.home), 'aria-label': `${p.name}: ${p.home ? 'дома' : 'нет дома'}`,
      onclick: act(() => api(`/api/presence/${encodeURIComponent(p.id)}`, { home: !p.home })),
    }, p.home ? 'дома' : 'нет дома')))));
  }
  $('remote').hidden = !blocks.length;
  $('remote').replaceChildren(...blocks);
}

// ── the house at a glance ──────────────────────────────────────────────────

// How the house is, as one row of chips under the clock: calm and short while all is well, amber for
// what wants a look, red for a leak. The climate sits above the clock, where the panel shows the weather.
const chip = (tone, ic, ...text) => h('span', { class: `st ${tone}` }, icon(ic), h('span', {}, ...text));
const ackNow = (id) => act(async () => { await api(`/api/notifications/${id}/ack`, {}); toast('Принято', 'notice'); });
const short = (t) => t?.replace(/\s*°C$/, '°');

function renderHome() {
  const m = state.home;
  const r = m.rules;
  const ruleText = [[r.active, 'активно'], [r.waiting, 'ждёт'], [r.paused, 'на паузе'], [r.off, 'выключено'], [r.unknown, 'без данных']]
    .filter(([n]) => n).map(([n, t]) => `${n} ${t}`).join(', ');
  const offline = [...m.offline, ...(state.link.connected ? [] : ['CUBE'])];
  const chips = [
    ...m.leaks.map((d) => chip('alert', 'drop', 'Протечка: ', deviceLink(d))),
    ...m.open.map((o) => chip('warn', 'door', deviceLink(o.device), ` открыта${o.since ? ` ${ago(o.since)}` : ''}`)),
    ...offline.map((d) => chip('warn', 'signal', deviceLink(d), ': нет связи')),
    ...m.silent.map((s) => chip('warn', 'signal', deviceLink(s.device), ` молчит: ${s.text}`)),
    ...m.lowBattery.map((b) => chip('warn', 'battery', deviceLink(b.device), `: батарейка ${b.text}`)),
    m.leaks.length ? null : chip('ok', 'drop', 'Сухо'),
    m.open.length ? null : chip('ok', 'door', 'Всё закрыто'),
    offline.length || m.silent.length ? null : chip('ok', 'signal', 'Всё на связи'),
    m.lowBattery.length ? null : chip('ok', 'battery', 'Батарейки в порядке'),
    ruleText ? chip('', 'rules', `Правила: ${ruleText}`) : null,
    m.power ? chip('', 'bolt', m.power) : null,
  ];
  $('home').replaceChildren(...chips.filter(Boolean)); // replaceChildren would print a null as text
  $('hero-climate').replaceChildren(...m.climate.map((c, i) => h('span', { class: 'hc' }, i ? null : icon('temp'),
    h('span', { class: 'hc-val' }, [short(c.temperature), c.humidity].filter(Boolean).join(' ')), h('span', { class: 'hc-where' }, c.device))));
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

const control = (d, attr, value) => api(`/api/devices/${encodeURIComponent(d.id)}/set`, { attr, value });
const NO_ROOM = '\u0000none';

// Rooms as tabs over the tiles, like in eWeLink: «Все» shows every room under its heading. The choice is
// remembered in this browser.
let roomFilter = (() => { try { return localStorage.getItem('domovoy.room') ?? ''; } catch { return ''; } })();
function pickRoom(room) {
  roomFilter = room;
  try { localStorage.setItem('domovoy.room', room); } catch { /* private mode: just not remembered */ }
  lastJson.devices = null;
  renderDevices();
}

function renderDevices() {
  const box = $('devices');
  $('device-count').textContent = state.devices.length ? String(state.devices.length) : '';
  if (!state.devices.length) { $('room-tabs').hidden = true; return box.replaceChildren(h('p', { class: 'empty' }, 'CUBE не вернула ни одного устройства.')); }
  // By room, in the order set in «Система»; without a room — last.
  const loose = state.devices.filter((d) => !d.room || !state.rooms.includes(d.room));
  const groups = [...state.rooms.map((r) => [r, r, state.devices.filter((d) => d.room === r)]),
    [NO_ROOM, state.rooms.length ? 'Без комнаты' : null, loose]].filter(([, , list]) => list.length);
  if (roomFilter && !groups.some(([key]) => key === roomFilter)) roomFilter = '';
  const tabs = [['', 'Все'], ...groups.filter(([, label]) => label).map(([key, label]) => [key, label])];
  $('room-tabs').hidden = tabs.length < 3; // one room: nothing to choose
  $('room-tabs').replaceChildren(...tabs.map(([key, label]) => h('button', { class: 'rt', 'aria-pressed': String(key === roomFilter), onclick: () => pickRoom(key) }, label)));
  const shown = roomFilter ? groups.filter(([key]) => key === roomFilter) : groups;
  const tile = (d) => deviceTile(d, { control, act });
  box.replaceChildren(...shown.flatMap(([, label, list]) => [label && !roomFilter ? h('h3', { class: 'room-head' }, label) : null, ...list.map(tile)]).filter(Boolean));
}

// Clock on the top bar and the home screen, like on the wall panel.
function tickClock() {
  const now = new Date();
  const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const day = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const date = day.charAt(0).toUpperCase() + day.slice(1); // «Суббота, 24 октября» — the month stays lowercase
  for (const [id, text] of [['top-time', time], ['hero-time', time], ['login-time', time], ['top-date', date], ['hero-date', date]]) {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
  }
  const hour = now.getHours();
  document.body.classList.toggle('night', hour >= 21 || hour < 6); // the sun on the home screen turns into the moon
}
tickClock();
setInterval(tickClock, 5000);

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
