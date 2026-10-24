// eWeLink CUBE Open API V2 client: token, device list, state changes, event stream.
// Docs: https://ewelink.cc/ewelink-cube/introduce-open-api/document/
import type { CubeDevice } from './normalize.ts';
import { runSse, type SseEvent } from './sse.ts';

interface Envelope<T> { error: number; data: T; message: string }

export class CubeError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`CUBE: ${message} (код ${code})`);
    this.code = code;
  }
}

export type CubeEvent =
  | { type: 'state'; id: string; state: Record<string, unknown> }
  | { type: 'online'; id: string; online: boolean }
  | { type: 'added'; device: CubeDevice }
  | { type: 'removed'; id: string }
  | { type: 'info'; id: string; name?: string };

export class CubeClient {
  private readonly base: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(url: string, token?: string, fetchImpl: typeof fetch = fetch) {
    this.base = url.replace(/\/+$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) {
      if (!this.token) throw new CubeError(401, 'нет токена — получи его командой: npm run cube -- token');
      headers.authorization = `Bearer ${this.token}`;
    }
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!json || typeof json.error !== 'number') throw new CubeError(res.status, `неожиданный ответ HTTP ${res.status}`);
    if (json.error !== 0) throw new CubeError(json.error, json.message || 'ошибка');
    return json.data;
  }

  bridgeInfo(): Promise<{ name?: string; ip?: string; fw_version?: string; domain?: string }> {
    return this.call('GET', '/open-api/v2/rest/bridge', undefined, false);
  }

  // Returns the token once the request is confirmed in the CUBE web console (pop-up) within 5 minutes;
  // until then CUBE answers 401 "link button not pressed".
  async requestToken(appName = 'domovoy'): Promise<string | null> {
    try {
      const data = await this.call<{ token: string }>('GET', `/open-api/v2/rest/bridge/access_token?app_name=${encodeURIComponent(appName)}`, undefined, false);
      return data.token;
    } catch (err) {
      if (err instanceof CubeError && err.code === 401) return null;
      throw err;
    }
  }

  async devices(): Promise<CubeDevice[]> {
    const data = await this.call<{ device_list: CubeDevice[] }>('GET', '/open-api/v2/rest/devices');
    return data.device_list ?? [];
  }

  async setState(serial: string, state: Record<string, unknown>): Promise<void> {
    await this.call('PUT', `/open-api/v2/rest/devices/${encodeURIComponent(serial)}`, { state });
  }

  // Streams device events until the signal aborts; reconnects on its own.
  events(onEvent: (e: CubeEvent) => void, onStatus: (s: 'connected' | 'disconnected', detail?: string) => void, signal: AbortSignal): Promise<void> {
    if (!this.token) throw new CubeError(401, 'нет токена для потока событий');
    const url = `${this.base}/open-api/v2/sse/bridge?access_token=${encodeURIComponent(this.token)}`;
    return runSse({ url, signal, onStatus, fetchImpl: this.fetchImpl, onEvent: (e) => { const ev = parseCubeEvent(e); if (ev) onEvent(ev); } });
  }
}

// "device#v2#updateDeviceState" etc. Unknown modules/types are ignored.
export function parseCubeEvent(e: SseEvent): CubeEvent | null {
  const [module, , type] = e.event.split('#');
  if (module !== 'device' || !type) return null;
  let data: any;
  try { data = JSON.parse(e.data); } catch { return null; }
  const id: string | undefined = data?.endpoint?.serial_number;
  switch (type) {
    case 'updateDeviceState': return id && data.payload ? { type: 'state', id, state: data.payload } : null;
    case 'updateDeviceOnline': return id && typeof data.payload?.online === 'boolean' ? { type: 'online', id, online: data.payload.online } : null;
    case 'addDevice': return data?.payload?.serial_number ? { type: 'added', device: data.payload } : null;
    case 'deleteDevice': return id ? { type: 'removed', id } : null;
    case 'updateDeviceInfo': return id ? { type: 'info', id, name: data.payload?.name } : null;
    default: return null;
  }
}
