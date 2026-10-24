import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainRule } from '../src/explain/explain.ts';
import { FakeClock } from '../src/engine/clock.ts';
import { zoned } from '../src/engine/time.ts';
import { harness, MIN, open, ruleFile, sceneFile, sceneYaml } from './helpers.ts';

const TZ = 'Asia/Tbilisi';
const H = 60 * MIN;
const on = (id: string) => ({ id, state: { power: { powerState: 'on' } } });
const off = (id: string) => ({ id, state: { power: { powerState: 'off' } } });

test('garland: on from sunset, off at 23:30, again the next evening', async () => {
  const clock = new FakeClock(zoned({ y: 2026, m: 10, d: 22 }, 16 * 60, TZ)); // 16:00, before sunset (18:09)
  const h = await harness([ruleFile('garland')], { clock });
  assert.deepEqual(h.writes, []);
  const why = explainRule(h.engine.rules[0]!, h.engine, h.store, h.clock.now(), TZ);
  assert.match(why, /✗ Время: 16:00 \(нужно: с заката \(18:09\) до 23:30\)/);
  await h.advance(2 * H + 8 * MIN);              // 18:08 — not yet
  assert.deepEqual(h.writes, []);
  await h.advance(2 * MIN);                      // 18:10 — sunset was at 18:09
  assert.deepEqual(h.writes, [on('sim-garland')]);
  await h.advance(5 * H + 20 * MIN);             // 23:30
  assert.deepEqual(h.writes, [on('sim-garland'), off('sim-garland')]);
  await h.advance(18 * H + 40 * MIN);            // next day 18:10 (sunset 18:07)
  assert.deepEqual(h.writes.at(-1), on('sim-garland'));
});

test('garland: switching the mode to "away" turns it off', async () => {
  const clock = new FakeClock(zoned({ y: 2026, m: 10, d: 22 }, 20 * 60, TZ));
  const h = await harness([ruleFile('garland')], { clock });
  assert.deepEqual(h.writes, [on('sim-garland')]);
  await h.engine.setVar('mode', 'away');
  await h.engine.idle();
  assert.deepEqual(h.writes.at(-1), off('sim-garland'));
  await assert.rejects(async () => h.engine.setVar('mode', 'party'), /можно home \(Дома\)/);
});

test('scene "away": mode, everything off, warnings only when they apply', async () => {
  const h = await harness([], { scenes: [sceneFile('away')], protectedDevices: ['Прихожая выключатель'] });
  await h.report('Вытяжка', { power: { powerState: 'on' } });
  await h.report('Прихожая выключатель', { toggle: { 1: { toggleState: 'on' } } });
  await h.report('Дверь лоджии', open);
  await h.engine.setVar('ac_running', false);
  const results = await h.engine.runScene('away', 'Тест');
  assert.equal(h.engine.varList().find((v) => v.name === 'mode')!.value, 'away');
  assert.deepEqual(h.writes, [off('sim-fan')], 'only what was on, never protected devices');
  assert.deepEqual(h.notes, ['Дверь лоджии осталась открытой.']);
  assert.deepEqual(results.map((r) => [r.action, !!r.skipped]), [
    ['Режим: Ушёл', false], ['выключено: Вытяжка', false],
    ['уведомление: Дверь лоджии осталась открытой.', false], ['уведомление: Кондиционер, похоже, работает — выключи его пультом.', true],
  ]);
  assert.match(h.store.events({ kind: 'manual' })[0]!.text, /^Тест: сцена «Ушёл» — Режим: Ушёл; выключено: Вытяжка; .*пропущено$/);
  assert.equal(h.engine.findScene('ушёл')?.id, 'away', 'found by name too');
  assert.throws(() => h.engine.runScene('nope', 'Тест'), /Нет сцены «nope»/);
});

test('scene "home" turns the hall light on only after dark', async () => {
  const day = await harness([], { scenes: [sceneFile('home')], clock: new FakeClock(zoned({ y: 2026, m: 10, d: 22 }, 12 * 60, TZ)) });
  await day.engine.runScene('home', 'Тест');
  assert.deepEqual(day.writes, []);
  const night = await harness([], { scenes: [sceneFile('home')], clock: new FakeClock(zoned({ y: 2026, m: 10, d: 22 }, 21 * 60, TZ)) });
  await night.engine.runScene('home', 'Тест');
  assert.deepEqual(night.writes, [{ id: 'sim-hall-switch', state: { toggle: { 1: { toggleState: 'on' } } } }]);
});

test('scenes calling each other stop at a safe depth', async () => {
  const loop = sceneYaml('id: loop\nname: Петля\ndo: [ { scene: loop } ]');
  const h = await harness([], { scenes: [loop] });
  const results = await h.engine.runScene('loop', 'Тест');
  assert.equal(results[0]!.ok, false);
  assert.match(results[0]!.error!, /слишком глубоко/);
});

test('who is home: per person, anyone_home is computed; everyone leaving starts "away"', async () => {
  const auto = { ...ruleFile('auto-away'), enabled: true };
  const h = await harness([auto], { scenes: [sceneFile('away')], people: { anton: { name: 'Антон' }, nina: { name: 'Нина' } } });
  const v = (name: string) => h.engine.varList().find((x) => x.name === name)!.value;
  assert.equal(v('anyone_home'), true);
  await assert.rejects(async () => h.engine.setVar('anyone_home', false), /считается само/);
  await assert.rejects(async () => h.engine.setVar('home_anton', 'maybe'), /только да или нет/);
  await h.engine.setVar('home_anton', false);
  assert.equal(v('anyone_home'), true);
  await h.engine.setVar('home_nina', false);
  assert.equal(v('anyone_home'), false);
  await h.advance(4 * MIN);
  assert.equal(v('mode'), 'home');
  await h.advance(1 * MIN);
  assert.equal(v('mode'), 'away', 'the rule started the scene after 5 minutes');
  assert.ok(h.store.events({ kind: 'rule' }).some((e) => e.text.startsWith('Все ушли — сцена «Ушёл»: сцена «Ушёл»')));
});
