import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SIM_TOKEN, startSimulator } from '../sim/server.ts';
import { loadConfig } from '../src/config.ts';
import { CubeLink } from '../src/cube/link.ts';
import { Library } from '../src/rules/library.ts';
import { Store } from '../src/store/db.ts';
import { applyPendingRestore, AutoBackup, makeBackup, readBackup } from '../src/system/backup.ts';
import { SystemControl } from '../src/system/control.ts';
import { LogBuffer } from '../src/system/logbuf.ts';
import { TelegramBot } from '../src/telegram/bot.ts';
import { harness, scenarioDevices } from './helpers.ts';

const until = async (cond: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), 'condition not reached in time');
};

async function setup(o: { token?: string; env?: NodeJS.ProcessEnv } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'domovoy-sys-'));
  for (const d of ['rules', 'scenes']) cpSync(new URL(`../${d}`, import.meta.url).pathname, join(root, d), { recursive: true });
  const sim = await startSimulator(scenarioDevices(), { approveAfter: 2 });
  const example = readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8')
    .replace(/url: http:\/\/192\.168\.88\.20/, `url: ${sim.url}`)
    .replace('people: {}', 'people:\n  anton: { name: Антон }');
  writeFileSync(join(root, 'config.yaml'), example);
  const config = loadConfig(join(root, 'config.yaml'), o.env ?? {});
  const store = new Store(config.db === ':memory:' ? ':memory:' : join(root, 'domovoy.db'));
  const library = new Library({
    rulesDir: config.rules_dir, scenesDir: config.scenes_dir,
    context: () => ({ devices: h.engine.deviceList(), vars: h.engine.varList(), protected: config.protected }),
    onReload: (r, s) => h.engine.reload(r, s),
  });
  const { rules, scenes } = library.load();
  const h = await harness(rules, { store, scenes });
  const link = new CubeLink({ url: sim.url, token: o.token, urlFromEnv: config.cubeUrlFromEnv, engine: h.engine, store, tokenPollMs: 20 });
  const fetchImpl = (async () => new Response(JSON.stringify({ ok: true, result: {} }))) as unknown as typeof fetch;
  const bot = new TelegramBot({ token: 'T', chats: config.telegram.chats, handlers: {} as never, fetchImpl });
  const paths = { configPath: config.configPath, rulesDir: config.rules_dir, scenesDir: config.scenes_dir, dbPath: join(root, 'domovoy.db') };
  const backups = new AutoBackup({ dir: join(root, 'backups'), make: () => makeBackup(paths, store, true) });
  let restarts = 0;
  const sys = new SystemControl({
    config, store, engine: h.engine, library, link, bot: () => bot, logs: new LogBuffer(), backups, paths,
    envPath: join(root, '.env'), startedAt: Date.now(), restart: () => { restarts += 1; },
  });
  const close = async () => { link.stop(); library.close(); await sim.close(); };
  return { root, sim, config, store, h, link, bot, sys, backups, paths, close, restarts: () => restarts };
}

test('settings from the panel: written into config.yaml with comments kept, applied at once', async () => {
  const s = await setup({ token: SIM_TOKEN });
  try {
    s.link.start();
    await until(() => s.link.link.connected);
    const file = () => readFileSync(s.config.configPath, 'utf8');

    await s.bot.handle(77, '/start', { name: 'Аня', username: 'anya' });
    assert.deepEqual(s.sys.overview().telegram.pending.map((p) => [p.id, p.name, p.username]), [[77, 'Аня', 'anya']]);
    s.sys.setChat(77, true);
    assert.match(file(), /chats: \[ 77 \] +# id чатов/, 'the comment on the line survives');
    assert.match(file(), /- \{ value: home, label: Дома \}/, 'untouched lines keep their look');
    assert.deepEqual(s.bot.chats(), [77]);
    assert.deepEqual(s.sys.overview().telegram.pending, []);
    s.sys.linkPerson('anton', 77);
    assert.match(file(), /anton: \{ name: Антон, telegram: 77 \}/);
    assert.equal(s.sys.overview().telegram.chats[0]!.person, 'anton');
    assert.throws(() => s.sys.linkPerson('nobody', 1), /нет человека/);

    s.sys.setProtected(['Вытяжка']);
    assert.match(file(), /protected: \[ Вытяжка \]/);
    await assert.rejects(s.h.engine.control('Вытяжка', 'power', 'on', 'тест'), /защищено/);
    assert.equal(s.sys.overview().devices.switches.find((d) => d.name === 'Вытяжка')!.protected, true);

    const door = () => s.h.engine.deviceList().find((d) => d.name === 'Дверь лоджии')!.attrs.open;
    assert.equal(door(), false);
    await s.sys.setDoor('Дверь лоджии', 'open');
    assert.equal(door(), true, 'the device list was pulled again with the new meaning');
    assert.match(file(), /"Дверь лоджии":\n {4}contact_true_means: open/);

    await assert.rejects(s.sys.setCubeUrl('не адрес'), /адрес вида/);
    await assert.rejects(s.sys.setCubeUrl('http://127.0.0.1:1'), /не отвечает/);
    assert.equal((await s.sys.setCubeUrl(s.sim.url)).name, 'CUBE simulator');
  } finally { await s.close(); }
});

test('CUBE without a token: the engine waits; the panel asks CUBE for one, saves it to .env and connects', async () => {
  const s = await setup();
  try {
    s.link.start();
    assert.equal(s.link.info().hasToken, false);
    assert.match(s.link.link.detail ?? '', /нет токена/);
    await assert.rejects(s.link.actuator('x', {}), /нет связи с CUBE/);
    s.sys.requestToken();
    assert.equal(s.link.info().token.state, 'waiting');
    await until(() => s.link.info().token.state === 'done');
    assert.match(readFileSync(join(s.root, '.env'), 'utf8'), new RegExp(`CUBE_TOKEN=${SIM_TOKEN}`));
    assert.equal(statSync(join(s.root, '.env')).mode & 0o777, 0o600, '.env stays private');
    await until(() => s.link.link.connected);
    await until(() => s.h.engine.deviceList().length === 6);
    assert.equal(s.link.isSimulator(), true);

    const env = await setup({ env: { CUBE_URL: s.sim.url } });
    await assert.rejects(env.sys.setCubeUrl(s.sim.url), /CUBE_URL/);
    await env.close();
  } finally { await s.close(); }
});

test('backup: a copy, a broken house, and back again', async () => {
  const s = await setup({ token: SIM_TOKEN });
  try {
    s.store.addEvent(Date.now(), 'system', 'test', 'история до копии');
    const { name, data } = s.sys.backupFile(true);
    assert.match(name, /^domovoy-.*\.backup\.gz$/);
    const bundle = readBackup(data);
    assert.ok(bundle.rules['heat-leak.yaml']);
    assert.ok(bundle.history, 'with history');
    assert.equal(readBackup(s.sys.backupFile(false).data).history, null);
    assert.throws(() => readBackup(Buffer.from('что-то другое')), /не резервная копия/);

    unlinkSync(join(s.config.rules_dir, 'heat-leak.yaml'));
    writeFileSync(join(s.config.rules_dir, 'junk.yaml'), 'id: junk\n');
    writeFileSync(s.config.configPath, readFileSync(s.config.configPath, 'utf8').replace('timezone: Asia/Tbilisi', 'timezone: Europe/Moscow'));

    const r = await s.sys.restore(data);
    assert.deepEqual([r.configChanged, r.history], [true, true]);
    assert.ok(existsSync(join(s.config.rules_dir, 'heat-leak.yaml')));
    assert.ok(!existsSync(join(s.config.rules_dir, 'junk.yaml')));
    const aside = readdirSync(join(s.config.rules_dir, '.trash'));
    assert.ok(readdirSync(join(s.config.rules_dir, '.trash', aside[0]!)).includes('junk.yaml'), 'what was there is kept aside');
    assert.match(readFileSync(s.config.configPath, 'utf8'), /timezone: Asia\/Tbilisi/);
    assert.ok(readdirSync(s.root).some((f) => f.startsWith('config.yaml.before-restore-')));
    assert.ok(s.h.engine.rules.some((x) => x.id === 'heat-leak'), 'cards work without a restart');

    for (let i = 0; i < 9; i++) s.backups.now(Date.now() + i * 1000);
    assert.equal(s.backups.list().length, 7, 'only the newest seven are kept');
    assert.throws(() => s.backups.read('../config.yaml'), /нет такой копии/);

    s.store.addEvent(Date.now(), 'system', 'test', 'после копии');
    s.store.close();
    assert.equal(applyPendingRestore(s.paths.dbPath), true);
    const back = new Store(s.paths.dbPath);
    const texts = back.events({ ref: 'test' }).map((e) => e.text);
    assert.ok(texts.includes('история до копии') && !texts.includes('после копии'), 'the history from the copy');
    back.close();
    assert.ok(readdirSync(s.root).some((f) => f.startsWith('domovoy.db.before-restore-')));
  } finally { await s.close(); }
});

test('panel API: overview, protected devices, download a backup and upload it back', async () => {
  const { startPanel } = await import('../src/panel/server.ts');
  const s = await setup({ token: SIM_TOKEN });
  const password = 'correct horse';
  const panel = await startPanel({
    engine: s.h.engine, store: s.store, port: 0, host: '127.0.0.1', timezone: 'Asia/Tbilisi', password,
    link: () => s.link.link, simulator: () => true, cubeUrl: s.sim.url, system: s.sys,
  });
  try {
    const login = await fetch(`${panel.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const overview = await (await fetch(`${panel.url}/api/system`, { headers: { cookie } })).json() as any;
    assert.equal(overview.cube.url, s.sim.url);
    assert.deepEqual(overview.telegram.people.map((p: any) => p.id), ['anton']);
    assert.ok(overview.devices.doors.some((d: any) => d.name === 'Дверь лоджии' && d.mode === 'closed'));

    const r = await fetch(`${panel.url}/api/system/protected`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ devices: ['Гирлянда лоджии'] }) });
    assert.equal(r.status, 200);
    assert.deepEqual(s.config.protected, ['Гирлянда лоджии']);

    const dl = await fetch(`${panel.url}/api/system/backup?history=1`, { headers: { cookie } });
    assert.equal(dl.headers.get('content-type'), 'application/gzip');
    assert.match(dl.headers.get('content-disposition') ?? '', /attachment/);
    const file = Buffer.from(await dl.arrayBuffer());
    assert.ok(readBackup(file).rules['garland.yaml']);

    unlinkSync(join(s.config.rules_dir, 'garland.yaml'));
    const up = await fetch(`${panel.url}/api/system/restore`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie }, body: file });
    const result = await up.json() as any;
    assert.equal(up.status, 200, JSON.stringify(result));
    assert.ok(existsSync(join(s.config.rules_dir, 'garland.yaml')));
    assert.equal((await fetch(`${panel.url}/api/system/restore`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie }, body: 'мусор' })).status, 400);
    assert.equal((await fetch(`${panel.url}/api/system`)).status, 401, 'needs a session');
  } finally { await panel.close(); await s.close(); }
});

test('own names and rooms: shown everywhere, rules and protection keep working through CUBE names', async () => {
  const { explainRule } = await import('../src/explain/explain.ts');
  const s = await setup({ token: SIM_TOKEN });
  try {
    s.link.start();
    await until(() => s.h.engine.deviceList().length === 6);
    const file = () => readFileSync(s.config.configPath, 'utf8');
    s.sys.setProtected(['Вытяжка']);
    s.sys.setDeviceMeta('Вытяжка', { label: 'Вентилятор ванной', room: 'Санузел' });
    s.sys.setDeviceMeta('Дверь лоджии', { label: 'Лоджия', room: 'Лоджия' });
    assert.match(file(), /rooms: \[ Санузел, Лоджия \]/);
    assert.match(file(), /Вытяжка:\n {4}label: Вентилятор ванной\n {4}room: Санузел/);
    const fan = s.h.engine.deviceList().find((d) => d.cubeName === 'Вытяжка')!;
    assert.deepEqual([fan.name, fan.room], ['Вентилятор ванной', 'Санузел']);
    await assert.rejects(s.h.engine.control('Вентилятор ванной', 'power', 'on', 'тест'), /защищено/, 'protection by CUBE name holds');

    const heat = s.h.engine.rules.find((r) => r.id === 'heat-leak')!; // refers to «Дверь лоджии»
    assert.match(explainRule(heat, s.h.engine, s.store, Date.now(), 'Asia/Tbilisi'), /Лоджия: закрыта/, '«почему» shows the own name');
    await s.h.engine.control('Гирлянда лоджии', 'power', 'on', 'Тест');
    assert.match(s.store.events({ kind: 'manual' })[0]!.text, /Гирлянда лоджии/);

    s.sys.editRooms({ add: 'Прихожая' });
    s.sys.editRooms({ rename: ['Санузел', 'Ванная'] });
    assert.equal(s.h.engine.deviceList().find((d) => d.cubeName === 'Вытяжка')!.room, 'Ванная', 'devices follow a renamed room');
    s.sys.editRooms({ move: ['Прихожая', -1] });
    assert.deepEqual(s.config.rooms, ['Ванная', 'Прихожая', 'Лоджия']);
    s.sys.editRooms({ remove: 'Лоджия' });
    assert.equal(s.h.engine.deviceList().find((d) => d.cubeName === 'Дверь лоджии')!.room, null);
    assert.throws(() => s.sys.editRooms({ rename: ['Ванная', 'Прихожая'] }), /уже есть/);

    s.sys.setDeviceMeta('Вытяжка', { label: null });
    assert.equal(s.h.engine.deviceList().find((d) => d.cubeName === 'Вытяжка')!.name, 'Вытяжка', 'back to the CUBE name');
    assert.throws(() => s.sys.setDeviceMeta('Нет такого', { label: 'x' }), /нет устройства/);
  } finally { await s.close(); }
});
