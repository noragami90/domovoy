// Engine + real HTTP: CubeClient talks to the simulator over REST and SSE.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startSimulator } from '../sim/server.ts';
import { CubeClient } from '../src/cube/client.ts';
import { realClock } from '../src/engine/clock.ts';
import { Engine } from '../src/engine/engine.ts';
import { Store } from '../src/store/db.ts';
import { ruleYaml, scenarioDevices } from './helpers.ts';

const waitFor = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
};

test('token flow: refused until confirmed, then issued', async () => {
  const sim = await startSimulator(scenarioDevices(), { approveAfter: 1 });
  try {
    const cube = new CubeClient(sim.url);
    assert.equal(await cube.requestToken(), null);
    const token = await cube.requestToken();
    assert.ok(token);
    await assert.rejects(new CubeClient(sim.url, 'wrong').devices(), /invalid access_token/);
    assert.equal((await new CubeClient(sim.url, token!).devices()).length, 6);
  } finally { await sim.close(); }
});

test('events from CUBE drive rules; actions go back to CUBE', async () => {
  const sim = await startSimulator(scenarioDevices(), { approveAfter: 0 });
  const cube = new CubeClient(sim.url, (await new CubeClient(sim.url).requestToken())!);
  const notes: string[] = [];
  const engine = new Engine({
    rules: [
      ruleYaml(`
id: door
name: Дверь
when: { all: [ { device: Дверь лоджии, attr: open, is: true, for: 300ms } ] }
then: [ { notify: "дверь открыта" } ]
`),
      ruleYaml(`
id: fan
name: Вытяжка
when: { all: [ { device: Санузел, attr: humidity, above: 60 } ] }
then: [ { set: { device: Вытяжка, attr: power, to: "on" } } ]
`),
    ],
    store: new Store(':memory:'), clock: realClock,
    notifier: async (t) => { notes.push(t); },
    actuator: (id, state) => cube.setState(id, state),
  });
  const abort = new AbortController();
  try {
    engine.loadDevices(await cube.devices());
    await engine.start();
    let connected = false;
    void cube.events((e) => { void engine.handleCubeEvent(e); }, (s) => { connected = s === 'connected'; }, abort.signal);
    await waitFor(() => connected);

    sim.setState('Дверь лоджии', { contact: { contact: false } });
    await waitFor(() => notes.length === 1);
    assert.deepEqual(notes, ['дверь открыта']);

    sim.setState('Санузел', { humidity: { humidity: 70 } });
    await waitFor(() => sim.requests.some((r) => r.method === 'PUT'));
    const fan = sim.devices.find((d) => d.name === 'Вытяжка')!;
    assert.deepEqual(fan.state, { power: { powerState: 'on' } });
    await waitFor(() => engine.deviceList().find((d) => d.name === 'Вытяжка')?.attrs.power === 'on');
  } finally {
    abort.abort();
    engine.stop();
    await sim.close();
  }
});
