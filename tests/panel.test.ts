import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startSimulator } from '../sim/server.ts';
import { resolvePassword } from '../src/panel/auth.ts';
import { startPanel, type Panel } from '../src/panel/server.ts';
import type { PanelState } from '../src/panel/state.ts';
import { closed, harness, MIN, open, ruleFile, scenarioDevices } from './helpers.ts';

const PASSWORD = 'correct horse';

async function setup(opts: { simulator?: boolean; cubeUrl?: string } = {}) {
  let panel: Panel | undefined;
  const h = await harness([ruleFile('heat-leak'), ruleFile('bath-fan')], { onChange: () => panel?.changed() });
  panel = await startPanel({
    engine: h.engine, store: h.store, port: 0, host: '127.0.0.1', timezone: 'Asia/Tbilisi', password: PASSWORD, now: () => h.clock.now(),
    link: () => ({ connected: true, since: 0 }), simulator: () => opts.simulator ?? false, cubeUrl: opts.cubeUrl ?? 'http://127.0.0.1:1',
  });
  let cookie = '';
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${panel!.url}${path}`, body === undefined
    ? { headers: { cookie, ...headers } }
    : { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify(body) });
  const login = async () => {
    const res = await call('/api/login', { password: PASSWORD });
    assert.equal(res.status, 200);
    cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  };
  return { h, panel, call, login };
}

test('password: generated once into a private file, env wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'domovoy-pass-'));
  const file = join(dir, 'panel-password.txt');
  const a = resolvePassword(undefined, file);
  assert.equal(a.generated, true);
  assert.match(a.password, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, 'utf8').trim(), a.password);
  assert.deepEqual(resolvePassword(undefined, file), { password: a.password, generated: false });
  assert.deepEqual(resolvePassword('from-env', file), { password: 'from-env', generated: false });
});

test('login: data needs a session; wrong passwords lock out; logout ends the session', async () => {
  const { panel, call, login } = await setup();
  try {
    assert.equal((await call('/')).status, 200, 'the page itself is public');
    assert.deepEqual(await (await call('/api/session')).json(), { authenticated: false });
    for (const path of ['/api/state', '/api/timeline', '/api/events', '/api/why/heat-leak']) assert.equal((await call(path)).status, 401, path);
    assert.equal((await call('/api/vars/ac_running', { value: false })).status, 401);

    for (let i = 0; i < 5; i++) assert.equal((await call('/api/login', { password: 'nope' })).status, 401);
    const locked = await call('/api/login', { password: PASSWORD });
    assert.equal(locked.status, 429, 'locked after five failures, even with the right password');
    assert.match(((await locked.json()) as { error: string }).error, /Подожди/);
  } finally { await panel.close(); }

  const s = await setup();
  try {
    await s.login();
    const res = await s.call('/api/login', { password: PASSWORD });
    assert.match(res.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.equal((await s.call('/api/state')).status, 200);
    assert.deepEqual(await (await s.call('/api/session')).json(), { authenticated: true });
    await s.call('/api/logout', {});
    assert.equal((await s.call('/api/state')).status, 401);
  } finally { await s.panel.close(); }
});

test('page: strict CSP, no inline code, all modules served', async () => {
  const { panel, call } = await setup();
  try {
    const res = await call('/');
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    const html = await res.text();
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>|\sstyle=|\son[a-z]+=/);
    for (const f of ['/panel.js', '/dom.js', '/chart.js', '/timeline.js', '/editor.js', '/form.js', '/diagram.js', '/whatif.js', '/ai.js', '/notifications.js', '/device.js', '/system.js', '/tablet.js', '/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png', '/panel.css', '/favicon.svg']) assert.equal((await call(f)).status, 200, f);
    assert.equal((await call('/nope')).status, 404);
  } finally { await panel.close(); }
});

test('state: the house at a glance, rules with switches, controllable devices', async () => {
  const { h, panel, call, login } = await setup();
  try {
    await login();
    await h.report('Дверь лоджии', open);
    const s = (await (await call('/api/state')).json()) as PanelState;
    assert.deepEqual(s.home.open.map((o) => o.device), ['Дверь лоджии']);
    assert.equal(s.home.open[0]!.since, h.clock.now());
    assert.deepEqual(s.home.leaks, []);
    assert.ok(s.home.climate.some((c) => c.device === 'Санузел' && c.humidity === '48%'));
    assert.equal(s.home.rules.waiting, 1);
    const heat = s.rules.find((r) => r.id === 'heat-leak')!;
    assert.deepEqual([heat.status, heat.enabled, heat.pausedUntil], ['waiting', true, null]);
    const fan = s.devices.find((d) => d.name === 'Вытяжка')!;
    assert.equal(fan.attrs.find((a) => a.key === 'power')!.control, 'switch');
    assert.equal(s.devices.find((d) => d.name === 'Санузел')!.attrs.find((a) => a.key === 'humidity')!.numeric, true);
  } finally { await panel.close(); }
});

test('control, rule switches and the feed', async () => {
  const { h, panel, call, login } = await setup();
  try {
    await login();
    assert.equal((await call('/api/devices/sim-fan/set', { attr: 'power', value: 'on' })).status, 200);
    assert.deepEqual(h.writes.at(-1), { id: 'sim-fan', state: { power: { powerState: 'on' } } });
    assert.equal((await call('/api/devices/sim-fan/set', { attr: 'brightness', value: 5 })).status, 400);

    assert.equal((await call('/api/rules/heat-leak/pause', { minutes: 60 })).status, 200);
    let s = (await (await call('/api/state')).json()) as PanelState;
    assert.equal(s.rules.find((r) => r.id === 'heat-leak')!.status, 'paused');
    assert.equal((await call('/api/rules/heat-leak/pause', { minutes: 0 })).status, 400);
    assert.equal((await call('/api/rules/heat-leak/pause', { minutes: null })).status, 200);
    assert.equal((await call('/api/rules/bath-fan/enabled', { enabled: false })).status, 200);
    s = (await (await call('/api/state')).json()) as PanelState;
    assert.deepEqual(s.rules.map((r) => [r.id, r.status]), [['heat-leak', 'idle'], ['bath-fan', 'off']]);
    assert.equal((await call('/api/rules/nope/enabled', { enabled: true })).status, 400);

    await h.report('Дверь лоджии', open);
    const feed = (await (await call('/api/timeline')).json()) as { events: { kind: string; text: string }[] };
    const texts = feed.events.map((e) => `${e.kind}: ${e.text}`);
    assert.ok(texts.includes('device: Дверь лоджии: открыта'), texts.join('\n'));
    assert.ok(texts.includes('manual: Панель: Вытяжка: включено'));
    assert.ok(texts.includes('manual: Панель: правило «Утечка тепла» — пауза на 1 ч'));
    assert.ok(texts.includes('manual: Панель: правило «Вытяжка по влажности» выключено'));
    const onlyRules = (await (await call('/api/timeline?kind=rule')).json()) as { events: { kind: string }[] };
    assert.ok(onlyRules.events.every((e) => e.kind === 'rule'));
    assert.equal((await call('/api/timeline?kind=hack')).status, 400);
  } finally { await panel.close(); }
});

test('history: averaged points and the usual level / threshold lines', async () => {
  const { h, panel, call, login } = await setup();
  try {
    await login();
    for (let i = 0; i < 18; i++) { await h.report('Санузел', { humidity: { humidity: 47 + (i % 3) } }); await h.advance(20 * MIN); }
    const data = (await (await call('/api/history?device=sim-bath-sensor&attr=humidity&range=24h')).json()) as { points: [number, number][]; lines: { label: string; value: number }[] };
    assert.ok(data.points.length >= 10 && data.points.length <= 240);
    assert.deepEqual(data.lines, [{ label: 'обычно', value: 48 }, { label: 'порог «Вытяжка по влажности»', value: 63 }]);
    assert.equal((await call('/api/history?device=nope&attr=humidity')).status, 404);
    assert.equal((await call('/api/history?device=sim-bath-sensor&attr=humidity&range=1y')).status, 400);
  } finally { await panel.close(); }
});

test('cross-site posts are refused; the page is told to refresh', async () => {
  const { h, panel, call, login } = await setup();
  const abort = new AbortController();
  try {
    await login();
    assert.equal((await call('/api/vars/ac_running', { value: false }, { origin: 'https://evil.example' })).status, 403);
    const plain = await fetch(`${panel.url}/api/vars/ac_running`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"value":false}' });
    assert.equal(plain.status, 401);
    assert.equal(h.engine.varList().find((v) => v.name === 'ac_running')!.value, true);

    const res = await fetch(`${panel.url}/api/events`, { signal: abort.signal, headers: { cookie: (await loginCookie(panel.url)) } });
    const reader = res.body!.getReader();
    await reader.read();
    void h.report('Санузел', { humidity: { humidity: 55 } });
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: change/);
  } finally { abort.abort(); await panel.close(); }
});

async function loginCookie(url: string): Promise<string> {
  const res = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

test('simulator: buttons and a seeded day of history make the baseline rule work', async () => {
  const sim = await startSimulator(scenarioDevices());
  const { h, panel, call, login } = await setup({ simulator: true, cubeUrl: sim.url });
  try {
    await login();
    assert.equal((await call('/api/sim/state', { device: 'Дверь лоджии', attr: 'open', value: true })).status, 200);
    assert.deepEqual(sim.devices.find((d) => d.name === 'Дверь лоджии')!.state!.contact, { contact: false });
    assert.equal((await call('/api/sim/seed', { device: 'Санузел', attr: 'humidity' })).status, 200);
    await h.engine.idle();
    const s = (await (await call('/api/state')).json()) as PanelState;
    assert.equal(s.rules.find((r) => r.id === 'bath-fan')!.status, 'idle', 'enough history now');
    await h.report('Санузел', { humidity: { humidity: 70 } });
    assert.deepEqual(h.writes.at(-1), { id: 'sim-fan', state: { power: { powerState: 'on' } } });
    assert.equal((await call('/api/sim/seed', { device: 'Вытяжка', attr: 'power' })).status, 400);
  } finally { await panel.close(); await sim.close(); }
});

test('scenes and presence: run from the panel; phones mark presence with a token', async () => {
  let panel: Panel | undefined;
  const { harness: make, sceneFile: scene } = await import('./helpers.ts');
  const h = await make([ruleFile('heat-leak')], { scenes: [scene('away')], people: { anton: { name: 'Антон' } }, onChange: () => panel?.changed() });
  panel = await startPanel({
    engine: h.engine, store: h.store, port: 0, host: '127.0.0.1', timezone: 'Asia/Tbilisi', password: PASSWORD, presenceToken: 'phone-secret',
    link: () => ({ connected: true, since: 0 }), simulator: () => false, cubeUrl: 'http://127.0.0.1:1',
  });
  const cookie = await loginCookie(panel.url);
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    fetch(`${panel!.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const s = (await (await fetch(`${panel.url}/api/state`, { headers: { cookie } })).json()) as PanelState;
    assert.deepEqual(s.scenes.map((x) => x.id), ['away']);
    assert.deepEqual(s.home.people, [{ id: 'anton', name: 'Антон', home: true }]);
    assert.deepEqual(s.vars.find((v) => v.name === 'mode')!.text, 'Дома');

    const run = (await (await post('/api/scenes/away/run', {}, { cookie })).json()) as { ok: boolean; results: { action: string }[] };
    assert.equal(run.ok, true);
    assert.equal(run.results[0]!.action, 'Режим: Ушёл');
    assert.equal((await post('/api/scenes/nope/run', {}, { cookie })).status, 400);

    assert.equal((await post('/api/presence/anton', { home: false }, {})).status, 401, 'no session, no token');
    assert.equal((await post('/api/presence/anton', { home: false }, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post('/api/presence/anton', { home: false }, { authorization: 'Bearer phone-secret' })).status, 200);
    assert.equal(h.engine.varList().find((v) => v.name === 'home_anton')!.value, false);
    assert.equal(h.engine.varList().find((v) => v.name === 'anyone_home')!.value, false);
    assert.equal((await post('/api/presence/nina', { home: true }, { authorization: 'Bearer phone-secret' })).status, 404);
    assert.equal((await post('/api/vars/ac_running', { value: false }, { authorization: 'Bearer phone-secret' })).status, 401, 'the token only marks presence');
    assert.equal(h.store.events({ kind: 'manual' })[0]!.text, 'Антон: ушёл (телефон)');
  } finally { await panel.close(); }
});

test('editor API: list, check, save into the running engine, templates, delete', async () => {
  const { cpSync, mkdtempSync: tmp } = await import('node:fs');
  const { Library } = await import('../src/rules/library.ts');
  const root = tmp(join(tmpdir(), 'domovoy-ed-'));
  const rulesDir = join(root, 'rules');
  const scenesDir = join(root, 'scenes');
  cpSync(new URL('../rules', import.meta.url).pathname, rulesDir, { recursive: true });
  cpSync(new URL('../scenes', import.meta.url).pathname, scenesDir, { recursive: true });
  let panel: Panel | undefined;
  let engineRef: Awaited<ReturnType<typeof harness>>['engine'] | undefined;
  const library = new Library({
    rulesDir, scenesDir,
    context: () => ({ devices: engineRef!.deviceList(), vars: engineRef!.varList(), protected: [] }),
    onReload: (r, s) => engineRef!.reload(r, s),
  });
  const { rules, scenes } = library.load();
  const h = await harness(rules, { scenes, onChange: () => panel?.changed() });
  engineRef = h.engine;
  panel = await startPanel({
    engine: h.engine, store: h.store, port: 0, host: '127.0.0.1', timezone: 'Asia/Tbilisi', password: PASSWORD, library,
    link: () => ({ connected: true, since: 0 }), simulator: () => false, cubeUrl: 'http://127.0.0.1:1',
  });
  const cookie = await loginCookie(panel.url);
  const get = async (path: string) => (await fetch(`${panel!.url}${path}`, { headers: { cookie } })).json() as Promise<any>;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${panel!.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  try {
    const lib = await get('/api/library');
    assert.deepEqual(lib.rules.map((f: any) => f.id).sort(), ['auto-away', 'bath-fan', 'garland', 'heat-leak']);
    assert.deepEqual(lib.scenes.map((f: any) => f.id).sort(), ['away', 'home', 'night']);
    assert.ok(lib.context.devices.some((d: any) => d.name === 'Санузел' && d.attrs.includes('humidity')));

    const card = { id: 'leak-test', name: 'Тест протечки', when: { all: [{ device: 'Дверь лоджии', attr: 'open', is: true }] }, then: [{ notify: 'открыто!' }] };
    const checked = await post('/api/library/check', { kind: 'rule', card });
    assert.equal(checked.body.ok, true);
    assert.match(checked.body.yaml, /^id: leak-test\nname: Тест протечки\n/);

    const saved = await post('/api/library/save', { kind: 'rule', card });
    assert.deepEqual([saved.status, saved.body.id, saved.body.created], [200, 'leak-test', true]);
    assert.ok(h.engine.rules.some((r) => r.id === 'leak-test'), 'the engine has it without a restart');
    await h.report('Дверь лоджии', open);
    assert.ok(h.notes.includes('открыто!'), 'and it works');

    const bad = await post('/api/library/save', { kind: 'rule', card: { ...card, then: [{ scene: 'nope' }] }, originalId: 'leak-test' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /нет сцены «nope»/);

    const templates = await get('/api/templates');
    const fan = templates.find((t: any) => t.id === 'humidity-fan');
    assert.deepEqual(fan.params.find((p: any) => p.key === 'sensor').options.map((o: any) => o.value), ['Санузел']);
    const built = await post('/api/templates/build', { id: 'humidity-fan', params: { sensor: 'Санузел', fan: 'Вытяжка|power', rise: '12', after: '5m' } });
    assert.deepEqual(built.body.issues, []);
    assert.equal(built.body.card.when.all[0].above_baseline, 12);

    assert.equal((await post('/api/library/delete', { kind: 'rule', id: 'leak-test' })).status, 200);
    assert.ok(!h.engine.rules.some((r) => r.id === 'leak-test'));
    const feed = h.store.events({ kind: 'manual' }).map((e) => e.text);
    assert.ok(feed.includes('Панель: правило «Тест протечки» создано'));
    assert.ok(feed.some((t) => /удалено \(в корзину \.trash\)/.test(t)));
    assert.equal((await post('/api/library/check', { kind: 'dream', card })).status, 400);
  } finally { await panel.close(); library.close(); }
});

test('batch Г API: diagram with "now", what if over history, AI off without a key', async () => {
  const { cpSync, mkdtempSync: tmp } = await import('node:fs');
  const { Library } = await import('../src/rules/library.ts');
  const { replay } = await import('../src/engine/replay.ts');
  const root = tmp(join(tmpdir(), 'domovoy-g-'));
  cpSync(new URL('../rules', import.meta.url).pathname, join(root, 'rules'), { recursive: true });
  cpSync(new URL('../scenes', import.meta.url).pathname, join(root, 'scenes'), { recursive: true });
  let engineRef: Awaited<ReturnType<typeof harness>>['engine'] | undefined;
  const library = new Library({
    rulesDir: join(root, 'rules'), scenesDir: join(root, 'scenes'),
    context: () => ({ devices: engineRef!.deviceList(), vars: engineRef!.varList(), protected: [] }),
    onReload: (r, s) => engineRef!.reload(r, s),
  });
  const { rules, scenes } = library.load();
  const h = await harness(rules, { scenes });
  engineRef = h.engine;
  const panel = await startPanel({
    engine: h.engine, store: h.store, port: 0, host: '127.0.0.1', timezone: 'Asia/Tbilisi', password: PASSWORD, library,
    link: () => ({ connected: true, since: 0 }), simulator: () => false, cubeUrl: 'http://127.0.0.1:1',
    replay: (rule, hours) => replay({ store: h.store, rule, devices: h.engine.deviceList(), from: h.clock.now() - hours * 3_600_000, to: h.clock.now(), scenes: h.engine.scenes, timezone: 'Asia/Tbilisi' }),
    ai: { drafter: null, house: () => { throw new Error('not used'); } },
  });
  const cookie = await loginCookie(panel.url);
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${panel.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  try {
    const card = { id: 'door-note', name: 'Дверь', when: { all: [{ device: 'Дверь лоджии', attr: 'open', is: true, for: '1m' }] }, then: [{ notify: 'открыто!' }], cooldown: '15m' };
    const d = (await post('/api/library/check', { kind: 'rule', card })).body.diagram;
    assert.equal(d.kind, 'rule');
    assert.equal(d.live, false);
    assert.deepEqual(d.conditions[0], { text: 'Дверь лоджии: открыта', now: 'сейчас: закрыта', status: 'fail', timer: '1 мин' });
    assert.deepEqual(d.then, [{ text: 'Уведомление: открыто!', when: [] }]);
    assert.equal(d.cooldown, '15 мин');

    const saved = library.files('rule').find((f) => f.id === 'garland')!;
    const g = (await post('/api/library/check', { kind: 'rule', yaml: saved.yaml, originalId: 'garland' })).body.diagram;
    assert.equal(g.live, true, 'the saved, unchanged rule shows its real state');
    assert.match(g.otherwise.do[0].text, /Гирлянда лоджии: выключить/);
    const away = library.files('scene').find((f) => f.id === 'away')!;
    const s = (await post('/api/library/check', { kind: 'scene', yaml: away.yaml })).body.diagram;
    assert.equal(s.kind, 'scene');
    assert.ok(s.steps.some((x: any) => x.when.length && /Дверь лоджии/.test(x.when[0])));

    await h.advance(5 * MIN);
    await h.report('Дверь лоджии', open); await h.advance(2 * MIN); await h.report('Дверь лоджии', closed);
    await h.advance(MIN);
    const r = await post('/api/library/replay', { kind: 'rule', card, hours: 24 });
    assert.equal(r.status, 200);
    assert.equal(r.body.counts.fired, 1);
    assert.equal(r.body.notifications[0].text, 'открыто!');
    assert.equal((await post('/api/library/replay', { kind: 'rule', card: { id: 'x' } })).status, 400);

    const ai = await (await fetch(`${panel.url}/api/ai`, { headers: { cookie } })).json() as any;
    assert.equal(ai.enabled, false);
    assert.match(ai.hint, /ANTHROPIC_API_KEY/);
    assert.equal((await post('/api/ai/draft', { text: 'включи свет на закате' })).status, 409);
  } finally { await panel.close(); library.close(); }
});

test('batch Д API: journal, «Принял» from the panel, settings, device page', async () => {
  const { Notifications } = await import('../src/notify/notifications.ts');
  const { Health } = await import('../src/notify/health.ts');
  const { loadSettings } = await import('../src/notify/settings.ts');
  const h = await harness([ruleFile('bath-fan'), ruleFile('heat-leak')]);
  const sent: string[] = [];
  const notifications = new Notifications({
    store: h.store, clock: h.clock, timezone: 'Asia/Tbilisi', settings: () => loadSettings(h.store),
    messenger: () => ({ send: async (t) => { sent.push(t); return { deliveries: [{ chat: 42, messageId: sent.length }], errors: [] }; }, edit: async () => {} }),
  });
  const health = new Health({ store: h.store, clock: h.clock, devices: () => h.engine.deviceList(), settings: () => loadSettings(h.store), notify: (t, m) => notifications.send(t, m) });
  const panel = await startPanel({
    engine: h.engine, store: h.store, port: 0, host: '127.0.0.1', timezone: 'Asia/Tbilisi', password: PASSWORD,
    link: () => ({ connected: true, since: 0 }), simulator: () => false, cubeUrl: 'http://127.0.0.1:1', notifications, health, telegram: true, now: () => h.clock.now(),
  });
  const cookie = await loginCookie(panel.url);
  const get = async (path: string) => (await fetch(`${panel.url}${path}`, { headers: { cookie } })).json() as Promise<any>;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${panel.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  try {
    const empty = await get('/api/notifications');
    assert.deepEqual([empty.items.length, empty.telegram, empty.settings.quiet.from], [0, true, '23:00']);

    const { body: t } = await post('/api/notifications/test', { urgent: true });
    assert.match(sent[0]!, /^🚨 Проверка срочного/);
    assert.deepEqual((await get('/api/state')).home.pendingAcks.map((n: any) => n.id), [t.id]);
    assert.equal((await get('/api/notifications?filter=pending')).items.length, 1);
    assert.equal((await post(`/api/notifications/${t.id}/ack`, {})).body.ok, true);
    assert.equal((await get('/api/state')).home.pendingAcks.length, 0);
    assert.equal((await get('/api/notifications')).items[0].ackedBy, 'Панель');

    assert.equal((await post('/api/notifications/settings', { ...empty.settings, repeat: { everyMin: 0, max: 3 } })).status, 400);
    const saved = await post('/api/notifications/settings', { ...empty.settings, quiet: { enabled: true, from: '22:00', to: '07:30' } });
    assert.equal(saved.body.settings.quiet.from, '22:00');

    health.touch('sim-bath-fan');
    const fanId = h.engine.deviceList().find((d) => d.name === 'Вытяжка')!.id;
    const fan = await get(`/api/devices/${fanId}`);
    assert.deepEqual(fan.rules, [{ id: 'bath-fan', name: 'Вытяжка по влажности', roles: ['управляет'] }]);
    assert.ok(fan.attrs.some((a: any) => a.key === 'power' && a.control === 'switch'));
    const bathId = h.engine.deviceList().find((d) => d.name === 'Санузел')!.id;
    const bath = await get(`/api/devices/${bathId}`);
    assert.deepEqual(bath.rules.map((r: any) => [r.id, r.roles]), [['bath-fan', ['следит']]]);
    assert.equal(bath.health.usualGapMs, null, 'no regular reports yet');
    assert.equal((await fetch(`${panel.url}/api/devices/nope`, { headers: { cookie } })).status, 404);
  } finally { await panel.close(); notifications.stop(); }
});
