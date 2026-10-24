import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainRule } from '../src/explain/explain.ts';
import { Store } from '../src/store/db.ts';
import { FakeClock } from '../src/engine/clock.ts';
import { closed, harness, humidity, MIN, open, ruleFile, ruleYaml } from './helpers.ts';

const TZ = 'Asia/Tbilisi';

test('heat leak: reminds once the door has been open for 5 minutes', async () => {
  const h = await harness([ruleFile('heat-leak')]);
  await h.report('Дверь лоджии', open);
  await h.advance(4 * MIN);
  assert.equal(h.notes.length, 0);
  await h.advance(1 * MIN);
  assert.deepEqual(h.notes, ['Закрой лоджию: кондиционер работает, а дверь открыта уже 5 минут.']);
  await h.advance(10 * MIN);
  assert.equal(h.notes.length, 1, 'no repeats while the door stays open');
  const text = explainRule(h.engine.rules[0]!, h.engine, h.store, h.clock.now(), TZ);
  assert.match(text, /Сейчас: выполняется/);
  assert.match(text, /Последний раз сработало: \d\d:\d\d/);
});

test('heat leak: a short opening is explained as a near miss', async () => {
  const h = await harness([ruleFile('heat-leak')]);
  await h.report('Дверь лоджии', open);
  await h.advance(3 * MIN + 50_000);
  await h.report('Дверь лоджии', closed);
  await h.advance(10 * MIN);
  assert.equal(h.notes.length, 0);
  const text = explainRule(h.engine.rules[0]!, h.engine, h.store, h.clock.now(), TZ);
  assert.match(text, /Сейчас: не выполняется/);
  assert.match(text, /✗ Дверь лоджии: закрыта \(нужно: открыта, держится 5 мин\)/);
  assert.match(text, /Дверь лоджии: держалось 3 мин 50 с, а нужно 5 мин — не сработало/);
  assert.match(text, /Ещё не срабатывало/);
});

test('heat leak: AC off means no reminder, and the reason says so', async () => {
  const h = await harness([ruleFile('heat-leak')], { acRunning: false });
  await h.report('Дверь лоджии', open);
  await h.advance(10 * MIN);
  assert.equal(h.notes.length, 0);
  const text = explainRule(h.engine.rules[0]!, h.engine, h.store, h.clock.now(), TZ);
  assert.match(text, /✗ Кондиционер работает: нет \(нужно: да\)/);
  await h.engine.setVar('ac_running', true);
  await h.advance(0);
  assert.equal(h.notes.length, 1, 'fires right away: the door has been open long enough');
});

test('cooldown delays a repeat and fires when it runs out', async () => {
  const h = await harness([ruleFile('heat-leak')]);
  await h.report('Дверь лоджии', open);
  await h.advance(5 * MIN);                    // fired at 5 min
  await h.report('Дверь лоджии', closed);
  await h.advance(1 * MIN);
  await h.report('Дверь лоджии', open);         // open again at 6 min
  await h.advance(5 * MIN);                     // condition holds at 11 min, cooldown until 20 min
  assert.equal(h.notes.length, 1);
  const text = explainRule(h.engine.rules[0]!, h.engine, h.store, h.clock.now(), TZ);
  assert.match(text, /пауза после прошлого раза — ещё 9 мин/);
  await h.advance(9 * MIN);
  assert.equal(h.notes.length, 2);
});

async function seedNormalHumidity(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
  for (let i = 0; i < 18; i++) { await h.report('Санузел', humidity(47 + (i % 3))); await h.advance(20 * MIN); }
}

test('bath fan: on above the usual level, off 10 minutes after it drops', async () => {
  const h = await harness([ruleFile('bath-fan')]);
  await seedNormalHumidity(h);                  // usual ≈ 48 → threshold 63
  await h.report('Санузел', humidity(62));
  assert.equal(h.writes.length, 0);
  await h.report('Санузел', humidity(66));
  assert.deepEqual(h.writes, [{ id: 'sim-fan', state: { power: { powerState: 'on' } } }]);
  await h.report('Санузел', humidity(55));
  await h.advance(9 * MIN);
  assert.equal(h.writes.length, 1);
  await h.advance(1 * MIN);
  assert.deepEqual(h.writes[1], { id: 'sim-fan', state: { power: { powerState: 'off' } } });
  const text = explainRule(h.engine.rules[0]!, h.engine, h.store, h.clock.now(), TZ);
  assert.match(text, /выполнено «иначе»: Вытяжка: выключить/);
  assert.match(text, /порог 63% \(обычно 48%\)/);
});

test('bath fan: humidity rising again cancels the delayed switch-off', async () => {
  const h = await harness([ruleFile('bath-fan')]);
  await seedNormalHumidity(h);
  await h.report('Санузел', humidity(70));
  await h.report('Санузел', humidity(50));
  await h.advance(5 * MIN);
  await h.report('Санузел', humidity(71));
  await h.advance(20 * MIN);
  assert.equal(h.writes.length, 1, 'only the first "on"');
  assert.equal(h.engine.runtime('bath-fan')?.active, true);
});

test('bath fan: without enough history it waits and says why', async () => {
  const h = await harness([ruleFile('bath-fan')]);
  await h.report('Санузел', humidity(80));
  assert.equal(h.writes.length, 0);
  const text = explainRule(h.engine.rules[0]!, h.engine, h.store, h.clock.now(), TZ);
  assert.match(text, /мало истории для обычного уровня \(\d+ замеров из 10\)/);
});

test('rule state survives a restart', async () => {
  const store = new Store(':memory:');
  const clock = new FakeClock();
  const a = await harness([ruleFile('heat-leak')], { store, clock });
  await a.report('Дверь лоджии', open);
  await a.advance(3 * MIN);
  a.engine.stop();
  // After restart CUBE's device list still shows the door open.
  const b = await harness([ruleFile('heat-leak')], { store, clock, initial: { 'Дверь лоджии': open } });
  await b.advance(1 * MIN);
  assert.equal(b.notes.length, 0);
  await b.advance(1 * MIN);
  assert.equal(b.notes.length, 1, 'fires at 5 min total, not 5 min after restart');
});

test('protected devices are never switched; the user is told', async () => {
  const rule = ruleYaml(`
id: t
name: Тест
when: { all: [ { device: Дверь лоджии, attr: open, is: true } ] }
then: [ { set: { device: Вытяжка, attr: power, to: "on" } } ]
`);
  const h = await harness([rule], { protectedDevices: ['вытяжка'] });
  await h.report('Дверь лоджии', open);
  assert.equal(h.writes.length, 0);
  assert.match(h.notes[0]!, /защищено от управления/);
});

test('a missing device is reported, not guessed', async () => {
  const rule = ruleYaml(`
id: t
name: Тест
when: { all: [ { device: Кухня, attr: humidity, above: 60 } ] }
then: [ { notify: x } ]
`);
  const h = await harness([rule]);
  const text = explainRule(rule, h.engine, h.store, h.clock.now(), TZ);
  assert.match(text, /\? Кухня: нет такого устройства в CUBE/);
});

test('paused and disabled rules do nothing; pausing ends on its own', async () => {
  const h = await harness([ruleFile('heat-leak')]);
  await h.engine.pauseRule('heat-leak', h.clock.now() + 30 * MIN, 'Тест');
  await h.report('Дверь лоджии', open);
  await h.advance(10 * MIN);
  assert.equal(h.notes.length, 0, 'paused');
  await h.advance(20 * MIN);                    // pause over → evaluates afresh, waits 5 min of its own
  assert.equal(h.engine.ruleSwitch('heat-leak').pausedUntil, null);
  await h.advance(5 * MIN);
  assert.equal(h.notes.length, 1);
  await h.engine.setRuleEnabled('heat-leak', false, 'Тест');
  assert.equal(h.engine.isRunning(h.engine.rules[0]!), false);
  const feed = h.store.events({}).map((e) => e.text);
  assert.ok(feed.includes('Тест: правило «Утечка тепла» выключено'));
  assert.ok(feed.includes('«Утечка тепла»: пауза закончилась'));
});

test('rule switches survive a restart', async () => {
  const store = new Store(':memory:');
  const clock = new FakeClock();
  const a = await harness([ruleFile('heat-leak')], { store, clock });
  await a.engine.pauseRule('heat-leak', clock.now() + 60 * MIN, 'Тест');
  a.engine.stop();
  const b = await harness([ruleFile('heat-leak')], { store, clock });
  assert.ok(b.engine.ruleSwitch('heat-leak').pausedUntil);
  await b.advance(61 * MIN);
  assert.equal(b.engine.ruleSwitch('heat-leak').pausedUntil, null, 'the restored pause still ends');
});

test('manual control uses the same protection as rules and lands in the feed', async () => {
  const h = await harness([], { protectedDevices: ['Вытяжка'] });
  await assert.rejects(h.engine.control('Вытяжка', 'power', 'on', 'Тест'), /защищено/);
  await h.engine.control('Прихожая выключатель', 'toggle.1', 'on', 'Тест');
  assert.deepEqual(h.writes, [{ id: 'sim-hall-switch', state: { toggle: { 1: { toggleState: 'on' } } } }]);
  assert.equal(h.store.events({ kind: 'manual' })[0]!.text, 'Тест: Прихожая выключатель: канал 1 — включено');
});

test('the feed shows state changes, not every number', async () => {
  const h = await harness([ruleFile('heat-leak')]);
  await h.report('Санузел', humidity(55));
  await h.report('Дверь лоджии', open);
  await h.report('Дверь лоджии', open);         // no change, no new line
  await h.engine.handleCubeEvent({ type: 'online', id: 'sim-fan', online: false });
  await h.advance(5 * MIN);
  const feed = h.store.events({}).map((e) => `${e.kind}: ${e.text}`).reverse();
  assert.deepEqual(feed.filter((t) => t.startsWith('device')), ['device: Дверь лоджии: открыта', 'device: Вытяжка: не в сети']);
  assert.ok(feed.some((t) => t.startsWith('rule: «Утечка тепла»: сработало')));
  assert.ok(feed.every((t) => !t.includes('влажность')));
});

test('reload: unchanged rules keep waiting, changed ones restart, removed ones stop', async () => {
  const heat = ruleFile('heat-leak');
  const h = await harness([heat, ruleFile('bath-fan')]);
  await h.report('Дверь лоджии', open);
  await h.advance(3 * MIN);
  await h.engine.reload([heat, ruleFile('bath-fan')], []);   // same cards
  await h.advance(2 * MIN);
  assert.equal(h.notes.length, 1, 'the 5-minute wait was not reset');

  const shorter = ruleYaml(`
id: heat-leak
name: Утечка тепла
when: { all: [ { device: Дверь лоджии, attr: open, is: true, for: 1m }, { var: ac_running, is: true } ] }
then: [ { notify: "снова" } ]
cooldown: 15m
`);
  await h.engine.reload([shorter], []);
  await h.advance(2 * MIN);
  assert.equal(h.notes.length, 1, 'changed rule starts afresh but keeps its cooldown');
  await h.advance(10 * MIN);                    // 17 min: the 15-minute pause from the 5th minute still holds
  assert.equal(h.notes.length, 1);
  await h.advance(4 * MIN);                     // 21 min
  assert.deepEqual(h.notes.slice(1), ['снова']);
  assert.equal(h.engine.rules.length, 1);

  await h.engine.reload([], []);
  await h.report('Дверь лоджии', closed);
  await h.report('Дверь лоджии', open);
  await h.advance(30 * MIN);
  assert.equal(h.notes.length, 2, 'removed rule never fires again');
});
