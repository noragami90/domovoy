// CUBE simulator: the subset of Open API V2 the engine uses (token, devices, PUT state, SSE),
// plus /sim/* endpoints to change sensor values by hand. Run: npm run sim
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { CubeDevice } from '../src/cube/normalize.ts';

export const SIM_TOKEN = 'sim-token-0000';

export interface Simulator {
  url: string;
  devices: CubeDevice[];
  setState(ref: string, state: Record<string, unknown>): CubeDevice;
  requests: { method: string; path: string; body?: unknown }[];
  close(): Promise<void>;
}

function merge(target: Record<string, any>, patch: Record<string, any>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) { target[k] ??= {}; merge(target[k], v); } else target[k] = v;
  }
}

const send = (res: ServerResponse, error: number, data: unknown = {}, message = error ? 'error' : 'success') => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error, data, message }));
};

async function readJson(req: IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : undefined;
}

// approveAfter: how many token requests are refused before the "pop-up" counts as confirmed.
export function startSimulator(devices: CubeDevice[], opts: { port?: number; host?: string; approveAfter?: number } = {}): Promise<Simulator> {
  const streams = new Set<ServerResponse>();
  const requests: Simulator['requests'] = [];
  let tokenCalls = 0;
  const find = (ref: string) => devices.find((d) => d.serial_number === ref || d.name.toLowerCase() === ref.toLowerCase());
  const emit = (event: string, data: unknown) => { for (const s of streams) s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  const setState = (ref: string, state: Record<string, unknown>): CubeDevice => {
    const dev = find(ref);
    if (!dev) throw new Error(`нет устройства «${ref}»`);
    dev.state ??= {};
    merge(dev.state, state);
    emit('device#v2#updateDeviceState', { endpoint: { serial_number: dev.serial_number }, payload: state });
    return dev;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://sim');
    const authed = req.headers.authorization === `Bearer ${SIM_TOKEN}` || url.searchParams.get('access_token') === SIM_TOKEN;
    try {
      const body = req.method === 'PUT' || req.method === 'POST' ? await readJson(req) : undefined;
      requests.push({ method: req.method ?? 'GET', path: url.pathname, body });
      const path = url.pathname;
      if (path === '/open-api/v2/rest/bridge') return send(res, 0, { name: 'CUBE simulator', fw_version: 'sim', ip: '127.0.0.1' });
      if (path === '/open-api/v2/rest/bridge/access_token') {
        tokenCalls += 1;
        return tokenCalls > (opts.approveAfter ?? 1) ? send(res, 0, { token: SIM_TOKEN }) : send(res, 401, {}, 'link button not pressed');
      }
      if (path === '/open-api/v2/sse/bridge') {
        if (!authed) return send(res, 401, {}, 'invalid access_token');
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      if (path.startsWith('/open-api/')) {
        if (!authed) return send(res, 401, {}, 'invalid access_token');
        if (path === '/open-api/v2/rest/devices' && req.method === 'GET') return send(res, 0, { device_list: devices });
        const m = /^\/open-api\/v2\/rest\/devices\/([^/]+)$/.exec(path);
        if (m && req.method === 'PUT') {
          if (!find(decodeURIComponent(m[1]!))) return send(res, 110000, {}, 'device not found');
          setState(decodeURIComponent(m[1]!), body?.state ?? {});
          return send(res, 0);
        }
        return send(res, 404, {}, 'not implemented in simulator');
      }
      if (path === '/sim/devices') return send(res, 0, devices);
      if (path === '/sim/state' && req.method === 'POST') return send(res, 0, setState(String(body?.device), body?.state ?? {}));
      res.writeHead(404).end();
    } catch (err) {
      send(res, 500, {}, (err as Error).message);
    }
  });

  const heartbeat = setInterval(() => { for (const s of streams) s.write(': ping\n\n'); }, 15_000);
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${opts.host && opts.host !== '0.0.0.0' ? opts.host : '127.0.0.1'}:${port}`, devices, setState, requests,
        close: () => new Promise((r) => { clearInterval(heartbeat); for (const s of streams) s.end(); server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scenario = YAML.parse(readFileSync(new URL('./scenario.yaml', import.meta.url), 'utf8')) as { devices: CubeDevice[] };
  const sim = await startSimulator(scenario.devices, { port: Number(process.env.SIM_PORT ?? 8765), host: process.env.SIM_HOST, approveAfter: 0 });
  console.log(`Симулятор CUBE: ${sim.url}\nТокен для .env: CUBE_TOKEN=${SIM_TOKEN}\nУстройства: ${sim.devices.map((d) => d.name).join(', ')}\nМенять значения: npm run sim:set -- "Дверь лоджии" open true`);
}
