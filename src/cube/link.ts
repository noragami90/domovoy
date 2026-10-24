// The connection to CUBE: device list sync, the event stream, connection statistics, and a restart
// with a new address or token (from the panel) without restarting the engine. Works without a token
// too — then it waits until one is obtained (the "link" pop-up in the CUBE web console).
import type { Link } from '../app.ts';
import type { Engine } from '../engine/engine.ts';
import type { Store } from '../store/db.ts';
import { CubeClient, type CubeEvent } from './client.ts';

export interface LinkInfo extends Link {
  url: string;
  urlFromEnv: boolean;
  hasToken: boolean;
  bridge: { name?: string; fw_version?: string; ip?: string } | null;
  simulator: boolean;
  reconnects: number;       // stream reconnections since the engine started
  events: number;           // events received since the engine started
  lastEventAt: number | null;
  token: { state: 'idle' | 'waiting' | 'done' | 'failed'; until: number | null; error: string | null };
}

export interface CubeLinkOptions {
  url: string;
  token?: string;
  urlFromEnv: boolean;
  engine: Engine;
  store: Store;
  onEvent?: (e: CubeEvent) => void;
  onChange?: () => void;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  tokenPollMs?: number;     // tests make it fast
}

const SIM_NAME = 'CUBE simulator';
const TOKEN_WAIT = 5 * 60_000;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});

export class CubeLink {
  readonly link: Link = { connected: false, since: Date.now() }; // shared with Telegram /status and the panel
  private readonly o: CubeLinkOptions;
  private url: string;
  private token: string | undefined;
  private client: CubeClient | null = null;
  private abort: AbortController | null = null;
  private bridge: LinkInfo['bridge'] = null;
  private simulator = false;
  private reconnects = 0;
  private connectedOnce = false;
  private events = 0;
  private lastEventAt: number | null = null;
  private tokenJob: LinkInfo['token'] = { state: 'idle', until: null, error: null };
  private tokenAbort: AbortController | null = null;

  constructor(o: CubeLinkOptions) {
    this.o = o;
    this.url = o.url;
    this.token = o.token;
  }

  info(): LinkInfo {
    return {
      ...this.link, url: this.url, urlFromEnv: this.o.urlFromEnv, hasToken: !!this.token, bridge: this.bridge, simulator: this.simulator,
      reconnects: this.reconnects, events: this.events, lastEventAt: this.lastEventAt, token: { ...this.tokenJob },
    };
  }

  isSimulator(): boolean { return this.simulator; }

  // For rule actions and the panel's switches.
  actuator = (id: string, state: Record<string, unknown>): Promise<void> => {
    if (!this.client) return Promise.reject(new Error('нет связи с CUBE (нет токена)'));
    return this.client.setState(id, state);
  };

  start(): void {
    this.stopStream();
    if (!this.token) {
      Object.assign(this.link, { connected: false, since: Date.now(), detail: 'нет токена — получи его в панели: Система → CUBE' });
      this.o.log?.('CUBE: нет токена — движок ждёт, пока токен получат в панели (Система → CUBE)');
      this.o.onChange?.();
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    const client = new CubeClient(this.url, this.token, this.o.fetchImpl);
    this.client = client;
    void this.sync(client, abort.signal);
    void client.events(
      (e) => { this.events += 1; this.lastEventAt = Date.now(); this.o.onEvent?.(e); },
      (status, detail) => this.status(status, detail, client, abort.signal),
      abort.signal,
    ).catch((err) => this.o.log?.(`CUBE поток событий: ${(err as Error).message}`));
  }

  async restart(url: string, token = this.token): Promise<void> {
    this.url = url;
    this.token = token;
    this.bridge = null;
    this.connectedOnce = false;
    this.start();
  }

  resync(): Promise<void> {
    return this.client && this.abort ? this.sync(this.client, this.abort.signal) : Promise.resolve();
  }

  // One look at a CUBE before switching to it: does it answer, what is it.
  async probe(url: string): Promise<{ name?: string; fw_version?: string; ip?: string }> {
    return new CubeClient(url, undefined, this.o.fetchImpl).bridgeInfo();
  }

  // Asks CUBE for a token for up to 5 minutes; CUBE gives it once someone confirms in its web console.
  requestToken(url: string, onToken: (token: string) => Promise<void> | void): void {
    this.tokenAbort?.abort();
    const abort = new AbortController();
    this.tokenAbort = abort;
    const until = Date.now() + TOKEN_WAIT;
    this.tokenJob = { state: 'waiting', until, error: null };
    this.o.onChange?.();
    const client = new CubeClient(url, undefined, this.o.fetchImpl);
    void (async () => {
      while (!abort.signal.aborted && Date.now() < until) {
        try {
          const token = await client.requestToken('domovoy');
          if (token) {
            await onToken(token);
            this.tokenJob = { state: 'done', until: null, error: null };
            this.o.log?.('CUBE: токен получен');
            this.o.onChange?.();
            return;
          }
        } catch (err) {
          this.tokenJob = { state: 'failed', until: null, error: (err as Error).message };
          this.o.onChange?.();
          return;
        }
        await sleep(this.o.tokenPollMs ?? 3_000, abort.signal);
      }
      if (!abort.signal.aborted) {
        this.tokenJob = { state: 'failed', until: null, error: 'подтверждение не пришло за 5 минут' };
        this.o.onChange?.();
      }
    })();
  }

  stop(): void {
    this.stopStream();
    this.tokenAbort?.abort();
  }

  private stopStream(): void {
    this.abort?.abort();
    this.abort = null;
    this.client = null;
  }

  // The full device list — at start and after every reconnect, so nothing is missed during a gap.
  private async sync(client: CubeClient, signal: AbortSignal): Promise<void> {
    for (let wait = 2_000; !signal.aborted; wait = Math.min(wait * 2, 60_000)) {
      try {
        const list = await client.devices();
        this.bridge = await client.bridgeInfo().catch(() => null);
        if (signal.aborted) return;
        this.simulator = this.bridge?.name === SIM_NAME;
        this.o.engine.loadDevices(list);
        this.o.log?.(`CUBE: устройств ${list.length}`);
        await this.o.engine.start();
        this.o.onChange?.();
        return;
      } catch (err) {
        this.o.log?.(`CUBE недоступна: ${(err as Error).message}; повтор через ${wait / 1000} с`);
        await sleep(wait, signal);
      }
    }
  }

  private status(status: 'connected' | 'disconnected', detail: string | undefined, client: CubeClient, signal: AbortSignal): void {
    if (signal.aborted) return;
    const was = this.link.connected;
    const now = status === 'connected';
    Object.assign(this.link, { connected: now, since: Date.now(), detail });
    this.o.log?.(`CUBE поток событий: ${now ? 'подключён' : `отключён (${detail ?? ''})`}`);
    if (was !== now) {
      this.o.store.addEvent(Date.now(), 'system', 'cube', now ? 'Связь с CUBE есть' : `Связь с CUBE потеряна${detail ? `: ${detail}` : ''}`);
      this.o.onChange?.();
    }
    if (now && !was) {
      if (this.connectedOnce) this.reconnects += 1;
      this.connectedOnce = true;
      void this.sync(client, signal);
    }
  }
}
