import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCubeEvent } from '../src/cube/client.ts';
import { flattenState, stateForSet } from '../src/cube/normalize.ts';
import { SseParser } from '../src/cube/sse.ts';

test('CUBE state flattens into rule attributes', () => {
  assert.deepEqual(flattenState({
    power: { powerState: 'on' },
    toggle: { 1: { toggleState: 'off' }, 2: { toggleState: 'on' } },
    humidity: { humidity: 61 },
    temperature: { temperature: 23.5 },
    'water-leak': { waterLeak: false },
    'electric-power': { 'electric-power': 1250 },
    contact: { contact: true },
  }), {
    power: 'on', 'toggle.1': 'off', 'toggle.2': 'on', humidity: 61, temperature: 23.5, leak: false,
    'electric-power': 1250, power_w: 12.5, contact: true, open: false,
  });
  assert.equal(flattenState({ contact: { contact: true } }, 'open').open, true);
});

test('writes map to CUBE payloads; unsupported ones fail clearly', () => {
  assert.deepEqual(stateForSet('power', 'on'), { power: { powerState: 'on' } });
  assert.deepEqual(stateForSet('power', false), { power: { powerState: 'off' } });
  assert.deepEqual(stateForSet('toggle.2', 'on'), { toggle: { 2: { toggleState: 'on' } } });
  assert.throws(() => stateForSet('brightness', 50), /поддерживаются power и toggle/);
  assert.throws(() => stateForSet('power', 'maybe'), /on\/off/);
});

test('SSE parser handles split chunks, CRLF, comments and multi-line data', () => {
  const p = new SseParser();
  assert.deepEqual(p.push(': hello\n\nevent: device#v2#upd'), []);
  assert.deepEqual(p.push('ateDeviceState\r\ndata: {"a":\r\ndata: 1}\r\n'), []);
  assert.deepEqual(p.push('\r\n'), [{ event: 'device#v2#updateDeviceState', data: '{"a":\n1}' }]);
  assert.deepEqual(p.push('data: x\n\n'), [{ event: 'message', data: 'x' }]);
});

test('CUBE events are recognised; others ignored', () => {
  assert.deepEqual(parseCubeEvent({ event: 'device#v2#updateDeviceState', data: JSON.stringify({ endpoint: { serial_number: 'S1' }, payload: { humidity: { humidity: 60 } } }) }),
    { type: 'state', id: 'S1', state: { humidity: { humidity: 60 } } });
  assert.deepEqual(parseCubeEvent({ event: 'device#v2#updateDeviceOnline', data: JSON.stringify({ endpoint: { serial_number: 'S1' }, payload: { online: false } }) }),
    { type: 'online', id: 'S1', online: false });
  assert.equal(parseCubeEvent({ event: 'security#v2#alarm', data: '{}' }), null);
  assert.equal(parseCubeEvent({ event: 'device#v2#updateDeviceState', data: 'not json' }), null);
});
