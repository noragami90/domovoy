import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replay } from '../src/engine/replay.ts';
import { Store } from '../src/store/db.ts';
import { closed, harness, humidity, MIN, MODE, open, ruleYaml } from './helpers.ts';

const doorLight = ruleYaml(`
id: door-light
name: Свет при открытии
when: { all: [ { device: Дверь лоджии, attr: open, is: true } ] }
then: [ { set: { device: Прихожая выключатель, attr: toggle.1, to: 'on' } } ]
otherwise: { do: [ { set: { device: Прихожая выключатель, attr: toggle.1, to: 'off' } } ] }
`);

// Lives through some history with no rules at all, then replays a card over it.
async function lived(steps: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>) {
  const store = new Store(':memory:');
  const h = await harness([], { store });
  const t0 = h.clock.now();
  await steps(h);
  const run = (rule = doorLight, from = t0 - 60 * MIN) => replay({
    store, rule, devices: h.engine.deviceList(), from, to: h.clock.now(), timezone: 'Asia/Tbilisi',
    vars: { mode: MODE, ac_running: { label: 'Кондиционер работает', initial: true } },
  });
  return { h, t0, run, store };
}

test('replay: a new rule over recorded door history — fires and undoes, never touches real devices', async () => {
  const { h, t0, run } = await lived(async (h) => {
    await h.advance(10 * MIN); await h.report('Дверь лоджии', open);
    await h.advance(3 * MIN); await h.report('Дверь лоджии', closed);
    await h.advance(60 * MIN); await h.report('Дверь лоджии', open);
    await h.advance(1 * MIN); await h.report('Дверь лоджии', closed);
    await h.advance(5 * MIN);
  });
  const r = await run();
  assert.equal(r.from, t0, 'history starts at the first snapshot');
  assert.match(r.limitedBy ?? '', /Дверь лоджии \(open\)/);
  assert.deepEqual(r.missing, []);
  assert.equal(r.counts.fired, 2);
  assert.equal(r.counts.otherwise_done, 2);
  assert.equal(r.writes.length, 4);
  assert.equal(r.entries[0]!.ts, t0 + 10 * MIN);
  assert.match(r.entries[0]!.text, /сработало: Прихожая выключатель, канал 1: включить/);
  assert.equal(h.writes.length, 0, 'the real actuator was not called');
});

test('replay: durations, variables and cooldown work on history', async () => {
  const heatLeak = ruleYaml(`
id: heat-leak
name: Утечка тепла
when: { all: [ { device: Дверь лоджии, attr: open, is: true, for: 5m }, { var: ac_running, is: true } ] }
then: [ { notify: Закрой лоджию } ]
cooldown: 15m
`);
  const { run } = await lived(async (h) => {
    await h.report('Дверь лоджии', open); await h.advance(6 * MIN);     // fires at 5 min
    await h.report('Дверь лоджии', closed); await h.advance(2 * MIN);
    await h.report('Дверь лоджии', open); await h.advance(6 * MIN);     // 5 min again, but cooldown
    await h.report('Дверь лоджии', closed);
    await h.engine.setVar('ac_running', false); await h.advance(MIN);
    await h.report('Дверь лоджии', open); await h.advance(20 * MIN);    // AC off: nothing
    await h.report('Дверь лоджии', closed);
  });
  const r = await run(heatLeak);
  assert.equal(r.counts.fired, 1);
  assert.equal(r.counts.cooldown, 1);
  assert.equal(r.notifications.length, 1);
  assert.equal(r.notifications[0]!.text, 'Закрой лоджию');
});

test('replay: numeric conditions read samples; a card about an unknown device says what is missing', async () => {
  const fan = ruleYaml(`
id: fan
name: Вытяжка
when: { all: [ { device: Санузел, attr: humidity, above: 70, for: 2m } ] }
then: [ { set: { device: Вытяжка, attr: power, to: 'on' } } ]
`);
  const { run } = await lived(async (h) => {
    await h.report('Санузел', humidity(50)); await h.advance(10 * MIN);
    await h.report('Санузел', humidity(80)); await h.advance(MIN);
    await h.report('Санузел', humidity(55)); await h.advance(10 * MIN);  // 1 min only: no
    await h.report('Санузел', humidity(85)); await h.advance(5 * MIN);   // fires after 2 min
  });
  const r = await run(fan);
  assert.equal(r.counts.fired, 1);
  assert.equal(r.writes[0]!.device, 'Вытяжка');

  const ghost = await run(ruleYaml(`
id: ghost
name: Призрак
when: { all: [ { device: Кухня, attr: open, is: true } ] }
then: [ { notify: x } ]
`));
  assert.deepEqual(ghost.missing, ['Кухня']);
  assert.equal(ghost.events, 0);
});

test('replay: "above the usual level" over two days of readings (served from memory)', async () => {
  const { toDevice } = await import('../src/cube/normalize.ts');
  const { scenarioDevices } = await import('./helpers.ts');
  const store = new Store(':memory:');
  const devices = scenarioDevices().map((d) => toDevice(d));
  const bath = devices.find((d) => d.name === 'Санузел')!;
  const now = Date.UTC(2026, 9, 22, 18, 0);
  const from = now - 2 * 86_400_000;
  for (let t = from, i = 0; t < now; t += 60_000, i++) {
    const shower = i >= 2400 && i < 2430; // one 30-minute shower on the second day
    store.addSample(bath.id, 'humidity', t, shower ? 85 : 50 + Math.sin(i / 50) * 3);
  }
  const r = await replay({
    store, devices, from: now - 86_400_000, to: now, timezone: 'Asia/Tbilisi',
    rule: ruleYaml(`
id: fan
name: Вытяжка
when: { all: [ { device: Санузел, attr: humidity, above_baseline: 15, for: 2m } ] }
then: [ { set: { device: Вытяжка, attr: power, to: 'on' } } ]
otherwise: { after: 10m, do: [ { set: { device: Вытяжка, attr: power, to: 'off' } } ] }
`),
  });
  assert.equal(r.counts.fired, 1);
  assert.equal(r.counts.otherwise_done, 1);
  assert.equal(r.entries[0]!.ts, from + 2402 * 60_000, 'fires after holding 2 minutes above the usual level');
});
