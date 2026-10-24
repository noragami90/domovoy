import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Device } from '../src/cube/normalize.ts';
import { FakeClock } from '../src/engine/clock.ts';
import { Health } from '../src/notify/health.ts';
import { DEFAULT_SETTINGS } from '../src/notify/settings.ts';
import { Store } from '../src/store/db.ts';
import { MIN } from './helpers.ts';

function setup(devices: Device[], store = new Store(':memory:'), clock = new FakeClock()) {
  const said: string[] = [];
  const health = new Health({ store, clock, devices: () => devices, settings: () => DEFAULT_SETTINGS, notify: async (t) => { said.push(t); } });
  return { health, said, store, clock };
}
const device = (patch: Partial<Device> & { attrs?: Device['attrs'] }): Device =>
  ({ id: 'd1', name: 'Дверь лоджии', category: 'contactSensor', model: 'SNZB-04P', online: true, attrs: {}, ...patch }) as Device;

test('battery: one message when it gets low, one when it is replaced; not repeated after a restart', async () => {
  const d = device({ attrs: { battery: 50 } });
  const { health, said, store, clock } = setup([d]);
  await health.check();
  d.attrs.battery = 15;
  await health.check();
  await health.check();
  d.attrs.battery = 18;
  await health.check();
  assert.deepEqual(said, ['🔋 Садится батарейка: Дверь лоджии — 15%. Пора заменить.']);
  const again = setup([d], store, clock);
  await again.health.check();
  assert.deepEqual(again.said, [], 'the alert state lives in the database');
  d.attrs.battery = 100;
  await again.health.check();
  assert.deepEqual(again.said, ['🔋 Батарейку заменили: Дверь лоджии — 100%.']);
});

test('offline: only after 10 minutes, and "back online" only if we said it was gone', async () => {
  const d = device({ online: false });
  const { health, said, clock } = setup([d]);
  await health.check();
  clock.advance(5 * MIN);
  d.online = true;
  await health.check();
  assert.deepEqual(said, [], 'a short drop is not worth a message');
  d.online = false;
  await health.check();
  clock.advance(11 * MIN);
  await health.check();
  d.online = true;
  await health.check();
  assert.deepEqual(said, ['📴 Не в сети: Дверь лоджии — уже 11 мин.', '📶 Снова в сети: Дверь лоджии.']);
});

test('silence: a sensor that reports every 10 minutes is "quiet" after hours, not minutes', async () => {
  const d = device({ id: 'bath', name: 'Санузел', category: 'temperatureAndHumiditySensor', attrs: { humidity: 50, battery: 90 } });
  const { health, said, store, clock } = setup([d]);
  const reports: [string, number][] = [];
  for (let t = clock.now() - 2 * 86_400_000; t < clock.now(); t += 10 * MIN) reports.push(['bath', t]);
  store.addReports(reports);
  health.touch('bath');
  clock.advance(30 * MIN);
  await health.check();
  assert.deepEqual(said, []);
  assert.equal(health.info(d).usualGapMs, 10 * MIN);
  clock.advance(2 * 60 * MIN);
  await health.check();
  assert.deepEqual(said, ['🤫 Молчит дольше обычного: Санузел — нет данных 2 ч 30 мин (обычно присылает раз в 10 мин).']);
  health.touch('bath');
  await health.check();
  assert.equal(said.at(-1), '📡 Снова присылает данные: Санузел.');
  assert.equal(store.seenAll().get('bath'), clock.now(), 'last-seen is saved');
});

test('silence: never judged from a burst of events, and never for doors (silent while nobody uses them)', async () => {
  const bath = device({ id: 'bath', name: 'Санузел', attrs: { humidity: 50 } });
  const door = device({ id: 'door', attrs: { open: false, battery: 95 } });
  const { health, said, store, clock } = setup([bath, door]);
  // An afternoon of testing: dozens of events within an hour, then quiet for the night.
  for (let i = 0; i < 60; i++) { health.touch('bath'); health.touch('door'); clock.advance(7_000); }
  clock.advance(6 * 60 * MIN);
  await health.check();
  assert.equal(health.info(bath).usualGapMs, null, 'a burst is not a rhythm');
  assert.equal(health.info(door).usualGapMs, null, 'doors report only when used');
  // An old wrong alert goes away without a "back again" message.
  store.saveAlert('silent:bath', clock.now() - 60 * MIN, true);
  await health.check();
  assert.deepEqual(said, []);
  assert.equal(store.alerts().has('silent:bath'), false);
});
