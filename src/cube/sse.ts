// Minimal Server-Sent Events client over fetch: parses the stream, reconnects with backoff.
export interface SseEvent { event: string; data: string }

// Incremental parser for text/event-stream. Feed it chunks; it returns complete events.
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.buffer.slice(0, nl);
      const sepLen = this.buffer.startsWith('\r\n', nl) ? 2 : 1;
      this.buffer = this.buffer.slice(nl + sepLen);
      if (line === '') {
        if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n') });
        this.event = '';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value;
      else if (field === 'data') this.data.push(value);
    }
    return out;
  }
}

export interface SseOptions {
  url: string;
  onEvent: (e: SseEvent) => void;
  onStatus?: (status: 'connected' | 'disconnected', detail?: string) => void;
  signal?: AbortSignal;
  maxBackoffMs?: number;
  fetchImpl?: typeof fetch;
}

// Keeps a connection open until the signal aborts. Never throws; reports status changes instead.
export async function runSse(opts: SseOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let backoff = 1_000;
  while (!opts.signal?.aborted) {
    try {
      const res = await fetchImpl(opts.url, { headers: { accept: 'text/event-stream' }, signal: opts.signal });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !res.body || !type.includes('text/event-stream')) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      }
      opts.onStatus?.('connected');
      backoff = 1_000;
      const parser = new SseParser();
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        for (const e of parser.push(decoder.decode(chunk as Uint8Array, { stream: true }))) opts.onEvent(e);
      }
      opts.onStatus?.('disconnected', 'поток закрыт сервером');
    } catch (err) {
      if (opts.signal?.aborted) return;
      opts.onStatus?.('disconnected', (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, opts.maxBackoffMs ?? 30_000);
  }
}
