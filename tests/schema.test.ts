import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, parseDuration } from '../src/duration.ts';
import { conditionsOf, loadRules } from '../src/rules/schema.ts';
import { ruleYaml } from './helpers.ts';

test('durations parse and format in Russian', () => {
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('250ms'), 250);
  assert.throws(() => parseDuration('5 minutes'), /Неверная длительность/);
  assert.equal(formatDuration(230_000), '3 мин 50 с');
  assert.equal(formatDuration(3_900_000), '1 ч 5 мин');
  assert.equal(formatDuration(300_000), '5 мин');
  assert.equal(formatDuration(45_000), '45 с');
});

test('example rule cards load and validate', () => {
  const rules = loadRules(new URL('../rules', import.meta.url).pathname);
  assert.deepEqual(rules.map((r) => r.id).sort(), ['auto-away', 'bath-fan', 'garland', 'heat-leak']);
  assert.equal(rules.find((r) => r.id === 'auto-away')!.enabled, false, 'off until people are configured');
  const heat = rules.find((r) => r.id === 'heat-leak')!;
  assert.equal(heat.cooldown, 900_000);
  assert.equal((conditionsOf(heat)[0] as { for?: number }).for, 300_000);
  const fan = rules.find((r) => r.id === 'bath-fan')!;
  assert.deepEqual((conditionsOf(fan)[0] as any).above_baseline, { amount: 15, relative: false });
  assert.equal(fan.otherwise?.after, 600_000);
});

test('relative baseline delta and defaults', () => {
  const r = ruleYaml(`
id: t
name: T
when: { all: [ { device: X, attr: humidity, above_baseline: "20%" } ] }
then: [ { notify: hi } ]
`);
  const c = conditionsOf(r)[0] as any;
  assert.deepEqual(c.above_baseline, { amount: 20, relative: true });
  assert.equal(r.enabled, true);
});

test('invalid cards are rejected with readable reasons', () => {
  const bad = (text: string, pattern: RegExp) => assert.throws(() => ruleYaml(text), pattern);
  bad(`id: t\nname: T\nwhen: { all: [ { device: X, attr: a, is: 1, above: 2 } ] }\nthen: [ { notify: x } ]`, /ровно одно сравнение/);
  bad(`id: t\nname: T\nwhen: { all: [ { device: X, attr: a, is: 1, for: 5 minutes } ] }\nthen: [ { notify: x } ]`, /Неверная длительность/);
  bad(`id: Bad_Id\nname: T\nwhen: { all: [ { var: v, is: true } ] }\nthen: [ { notify: x } ]`, /латиница/);
  bad(`id: t\nname: T\nwhen: { all: [ { var: v, is: true } ] }\nthen: [ { shell: "rm -rf /" } ]`, /не прошла проверку/);
  bad(`id: t\nname: T\nwhen: { all: [] }\nthen: [ { notify: x } ]`, /не прошла проверку/);
});
