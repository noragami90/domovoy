// HTTP helpers shared by the panel's routes.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SECURITY = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY, ...headers });
  res.end(JSON.stringify(body));
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(400, 'нужен content-type: application/json');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 65_536) throw new HttpError(413, 'слишком большой запрос');
  }
  const parsed = JSON.parse(body || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'ожидается объект JSON');
  return parsed as Record<string, unknown>;
}

export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// A file upload (backup restore): raw bytes, with a size limit.
export async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, `файл больше ${Math.round(max / 1_048_576)} МБ`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
