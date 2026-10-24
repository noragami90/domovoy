// Changes a value in the running simulator, as if a real sensor reported it:
//   npm run sim:set -- "Дверь лоджии" open true
//   npm run sim:set -- Санузел humidity 68
//   npm run sim:set -- Вытяжка power on
import { simPayload } from '../src/cube/sim-payload.ts';

const [device, attr, raw] = process.argv.slice(2);
const base = process.env.SIM_URL ?? 'http://127.0.0.1:8765';

if (!device || !attr || raw === undefined) {
  console.error('Формат: npm run sim:set -- <устройство> <атрибут> <значение>');
  process.exit(1);
}

const value: string | number | boolean = raw === 'true' ? true : raw === 'false' ? false : Number.isNaN(Number(raw)) ? raw : Number(raw);
const res = await fetch(`${base}/sim/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device, state: simPayload(attr, value) }) });
const json = (await res.json()) as { error: number; message: string };
if (json.error) { console.error(`Симулятор: ${json.message}`); process.exit(1); }
console.log(`${device}: ${attr} = ${JSON.stringify(value)}`);
