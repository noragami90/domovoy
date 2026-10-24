import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../src/engine/clock.ts';
import { Notifications, type Messenger } from '../src/notify/notifications.ts';
import { DEFAULT_SETTINGS, inQuiet, loadSettings, saveSettings, type NotifySettings } from '../src/notify/settings.ts';
import { Store } from '../src/store/db.ts';
import { MIN } from './helpers.ts';

const flush = () => new Promise((r) => setImmediate(r));

function messenger() {
  const sent: { text: string; silent: boolean; ackId?: number }[] = [];
  const edits: { messages: number[]; text: string }[] = [];
  let id = 0;
  const m: Messenger = {
    send: async (text, o) => { sent.push({ text, ...o }); return { deliveries: [{ chat: 42, messageId: ++id }], errors: [] }; },
    edit: async (d, text) => { edits.push({ messages: d.map((x) => x.messageId), text }); },
  };
  return { m, sent, edits };
}

// FakeClock starts at 22:00 in Tbilisi; quiet hours are 23:00–08:00 by default.
function setup(o: { store?: Store; clock?: FakeClock; settings?: NotifySettings; withTelegram?: boolean } = {}) {
  const store = o.store ?? new Store(':memory:');
  const clock = o.clock ?? new FakeClock();
  const tg = messenger();
  const n = new Notifications({
    store, clock, timezone: 'Asia/Tbilisi', settings: () => o.settings ?? DEFAULT_SETTINGS,
    messenger: () => (o.withTelegram === false ? null : tg.m),
  });
  const advance = async (ms: number) => { for (let left = ms; left > 0; left -= MIN) { clock.advance(Math.min(MIN, left)); await flush(); } };
  return { store, clock, n, tg, advance };
}

test('quiet hours: windows across midnight; ordinary messages go silent, urgent ones ring', async () => {
  assert.equal(inQuiet(DEFAULT_SETTINGS, '23:30'), true);
  assert.equal(inQuiet(DEFAULT_SETTINGS, '07:59'), true);
  assert.equal(inQuiet(DEFAULT_SETTINGS, '08:00'), false);
  assert.equal(inQuiet({ ...DEFAULT_SETTINGS, quiet: { enabled: true, from: '13:00', to: '15:00' } }, '14:00'), true);
  assert.equal(inQuiet({ ...DEFAULT_SETTINGS, quiet: { enabled: false, from: '13:00', to: '15:00' } }, '14:00'), false);

  const { n, tg, advance, store } = setup();
  await n.send('днём', { source: 'Тест' });
  await advance(90 * MIN); // 23:30
  await n.send('ночью', { source: 'Тест' });
  await n.send('протечка', { source: 'Тест', urgent: true });
  assert.deepEqual(tg.sent.map((s) => [s.text, s.silent]), [['днём', false], ['ночью', true], ['🚨 протечка', false]]);
  assert.deepEqual(store.notifications().map((r) => [r.text, r.quiet, r.urgent, r.status]),
    [['протечка', false, true, 'sent'], ['ночью', true, false, 'sent'], ['днём', false, false, 'sent']]);
});

test('urgent: repeats every 5 minutes until «Принял»; then the button goes away everywhere', async () => {
  const { n, tg, advance } = setup();
  const id = await n.send('Протечка: Санузел!', { source: 'Протечка', urgent: true });
  assert.equal(tg.sent[0]!.ackId, id);
  await advance(10 * MIN);
  assert.deepEqual(tg.sent.map((s) => s.text), ['🚨 Протечка: Санузел!', '🚨 Повтор 1 из 12: Протечка: Санузел!', '🚨 Повтор 2 из 12: Протечка: Санузел!']);
  assert.equal(n.pending().length, 1);
  assert.equal(await n.ack(id, 'Антон'), true);
  assert.deepEqual(tg.edits[0]!.messages, [1, 2, 3]);
  assert.match(tg.edits[0]!.text, /✓ Принял: Антон, 22:10/);
  await advance(30 * MIN);
  assert.equal(tg.sent.length, 3, 'no more repeats');
  assert.equal(await n.ack(id, 'Антон'), false, 'already accepted');
  assert.equal(n.pending().length, 0);
});

test('urgent: gives up after the last repeat; repeats survive a restart; without Telegram it is only journaled', async () => {
  const two = { ...DEFAULT_SETTINGS, repeat: { everyMin: 5, max: 2 } };
  const a = setup({ settings: two });
  await a.n.send('Протечка', { urgent: true });
  await a.advance(30 * MIN);
  assert.deepEqual(a.tg.sent.map((s) => s.text).slice(1), ['🚨 Повтор 1 из 2: Протечка', '🚨 Никто не нажал «Принял», повторил 2 раза: Протечка']);

  const store = new Store(':memory:');
  const clock = new FakeClock();
  const first = setup({ store, clock });
  await first.n.send('Протечка', { urgent: true });
  first.n.stop(); // the engine restarts
  const second = setup({ store, clock });
  second.n.resume();
  await second.advance(5 * MIN);
  assert.deepEqual(second.tg.sent.map((s) => s.text), ['🚨 Повтор 1 из 12: Протечка']);

  const offline = setup({ withTelegram: false });
  const id = await offline.n.send('Протечка', { urgent: true });
  await offline.advance(20 * MIN);
  assert.equal(offline.store.notification(id)!.status, 'no_telegram');
  assert.equal(offline.n.pending().length, 1, 'still waits for «Принял» in the panel');
  assert.equal(await offline.n.ack(id, 'Панель'), true);
});

test('settings: saved in the database, validated, defaults otherwise', () => {
  const store = new Store(':memory:');
  assert.deepEqual(loadSettings(store), DEFAULT_SETTINGS);
  saveSettings(store, { ...DEFAULT_SETTINGS, quiet: { enabled: true, from: '22:30', to: '07:00' } });
  assert.equal(loadSettings(store).quiet.from, '22:30');
  assert.throws(() => saveSettings(store, { ...DEFAULT_SETTINGS, quiet: { enabled: true, from: '25:00', to: '07:00' } }), /ЧЧ:ММ/);
});
