// "Why" without Telegram — reads the running engine's journal and asks CUBE for current states.
//   npm run why                 list rules with status
//   npm run why -- heat-leak    explanation for one rule
// In Docker: docker compose exec domovoy node /app/src/cli/why.ts heat-leak
import { createHandlers } from '../app.ts';
import { loadConfig } from '../config.ts';
import { CubeClient } from '../cube/client.ts';
import { realClock } from '../engine/clock.ts';
import { Engine } from '../engine/engine.ts';
import { loadRules, loadScenes } from '../rules/schema.ts';
import { Store } from '../store/db.ts';

const config = loadConfig(process.env.DOMOVOY_CONFIG ?? './config.yaml');
const store = new Store(config.db);
// Read-only engine: restores rule state from the database, never starts, never acts.
const engine = new Engine({
  rules: loadRules(config.rules_dir), store, clock: realClock,
  actuator: async () => { throw new Error('read-only'); }, notifier: async () => {},
  vars: config.vars, protectedDevices: config.protected, deviceSettings: config.devices,
  scenes: loadScenes(config.scenes_dir), people: config.people, timezone: config.timezone, place: config.location,
});
try {
  engine.loadDevices(await new CubeClient(config.cube.url, config.cubeToken).devices());
} catch (err) {
  console.error(`CUBE недоступна (${(err as Error).message}) — показываю только журнал.`);
}
const handlers = createHandlers(engine, store, { now: () => Date.now(), timezone: config.timezone, link: () => ({ connected: true, since: 0 }) });
const query = process.argv.slice(2).join(' ');
console.log(query ? handlers.why(query) : handlers.rules());
store.close();
