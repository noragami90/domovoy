import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hhmm, sunTimes, windowAt, zoned } from '../src/engine/time.ts';
import { conditionsOf } from '../src/rules/schema.ts';
import { ruleYaml } from './helpers.ts';

const TZ = 'Asia/Tbilisi';
const TBILISI = { lat: 41.7151, lon: 44.8271 };
const at = (d: number, h: number, m = 0) => zoned({ y: 2026, m: 10, d }, h * 60 + m, TZ); // 22.10.2026 is a Thursday
const utc = (ts: number | null) => (ts === null ? null : new Date(ts).toISOString().slice(11, 16));

test('sunrise and sunset match published times', () => {
  const june = sunTimes({ y: 2024, m: 6, d: 21 }, { lat: 51.5074, lon: -0.1278 }); // London: 03:43 / 20:21 UTC
  assert.deepEqual([utc(june.sunrise), utc(june.sunset)], ['03:43', '20:21']);
  const dec = sunTimes({ y: 2024, m: 12, d: 21 }, { lat: 51.5074, lon: -0.1278 }); // 08:04 / 15:53 UTC
  assert.ok(Math.abs(dec.sunrise! - Date.UTC(2024, 11, 21, 8, 4)) <= 120_000);
  assert.deepEqual(sunTimes({ y: 2024, m: 12, d: 21 }, { lat: 69.65, lon: 18.96 }), { sunrise: null, sunset: null }, 'polar night');
  const tb = sunTimes({ y: 2026, m: 10, d: 22 }, TBILISI);
  assert.deepEqual([hhmm(tb.sunrise!, TZ), hhmm(tb.sunset!, TZ)], ['07:20', '18:09']);
});

test('windows: across midnight, by weekday, by the sun', () => {
  const night = { between: ['23:00', '07:00'] as [string, string] };
  assert.equal(windowAt(night, at(22, 22), TZ, TBILISI)!.inside, false);
  assert.equal(windowAt(night, at(22, 22), TZ, TBILISI)!.next, at(22, 23));
  assert.equal(windowAt(night, at(22, 23, 30), TZ, TBILISI)!.inside, true);
  assert.equal(windowAt(night, at(23, 6, 59), TZ, TBILISI)!.inside, true);
  const morning = windowAt(night, at(23, 7), TZ, TBILISI)!;
  assert.deepEqual([morning.inside, morning.next], [false, at(23, 23)]);

  const workdays = { between: ['08:00', '09:00'] as [string, string], days: [1, 2, 3, 4, 5] };
  assert.equal(windowAt(workdays, at(23, 8, 30), TZ, TBILISI)!.inside, true, 'Friday');
  const saturday = windowAt(workdays, at(24, 8, 30), TZ, TBILISI)!;
  assert.deepEqual([saturday.inside, saturday.next], [false, at(26, 8)], 'Saturday → Monday');

  const evening = windowAt({ between: ['sunset-30m', '23:30'] }, at(22, 17, 45), TZ, TBILISI)!;
  assert.equal(evening.inside, true, 'sunset 18:09 − 30 min = 17:39');
  assert.equal(hhmm(evening.start, TZ), '17:39');
});

test('time conditions in cards: points, offsets and days are checked', () => {
  const r = ruleYaml(`
id: t
name: T
when: { all: [ { time: { between: [sunset-30m, "23:30"], days: [weekend, mon] } } ] }
then: [ { notify: x } ]
`);
  assert.deepEqual((conditionsOf(r)[0] as any).time, { between: ['sunset-30m', '23:30'], days: [0, 1, 6] });
  assert.throws(() => ruleYaml(`id: t\nname: T\nwhen: { all: [ { time: { between: ["25:00", "07:00"] } } ] }\nthen: [ { notify: x } ]`), /время/);
  assert.throws(() => ruleYaml(`id: t\nname: T\nwhen: { all: [ { time: { between: [noon, "07:00"] } } ] }\nthen: [ { notify: x } ]`), /время/);
  assert.throws(() => ruleYaml(`id: t\nname: T\nwhen: { all: [ { time: { between: ["07:00", "08:00"], days: [friday] } } ] }\nthen: [ { notify: x } ]`), /не прошла проверку/);
});
