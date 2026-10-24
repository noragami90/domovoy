// Panel login: one password, sessions in an HttpOnly cookie, a short lockout after repeated failures.
// Without PANEL_PASSWORD a random password is generated once and kept in a file next to config.yaml.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Store } from '../store/db.ts';

export const COOKIE = 'domovoy_session';
const SESSION_MS = 30 * 86_400_000;
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest();

export function resolvePassword(fromEnv: string | undefined, file: string): { password: string; generated: boolean } {
  if (fromEnv) return { password: fromEnv, generated: false };
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved) return { password: saved, generated: false };
  }
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const chars = [...randomBytes(12)].map((b) => alphabet[b % alphabet.length]).join('');
  const password = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  writeFileSync(file, `${password}\n`, { mode: 0o600 });
  return { password, generated: true };
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return out;
}

export class PanelAuth {
  private readonly store: Store;
  private readonly hash: Buffer;
  private readonly now: () => number;
  private readonly fails = new Map<string, { count: number; lockedUntil: number }>();

  constructor(store: Store, password: string, now: () => number = Date.now) {
    this.store = store;
    this.hash = sha256(password);
    this.now = now;
  }

  // Returns a session token, or an error the login form can show.
  login(password: unknown, client: string): { token: string } | { error: string; status: number } {
    const f = this.fails.get(client);
    if (f && f.lockedUntil > this.now()) {
      return { error: `Слишком много попыток. Подожди ${Math.ceil((f.lockedUntil - this.now()) / 1000)} с.`, status: 429 };
    }
    if (typeof password !== 'string' || !timingSafeEqual(sha256(password), this.hash)) {
      const count = (f?.count ?? 0) + 1;
      this.fails.set(client, count >= MAX_FAILS ? { count: 0, lockedUntil: this.now() + LOCK_MS } : { count, lockedUntil: 0 });
      return { error: 'Неверный пароль', status: 401 };
    }
    this.fails.delete(client);
    const token = randomBytes(32).toString('base64url');
    this.store.addSession(sha256(token).toString('hex'), this.now(), this.now() + SESSION_MS);
    return { token };
  }

  valid(token: string | undefined): boolean {
    return !!token && this.store.hasSession(sha256(token).toString('hex'), this.now());
  }

  logout(token: string | undefined): void {
    if (token) this.store.deleteSession(sha256(token).toString('hex'));
  }

  static cookie(token: string): string {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
  }

  static clearCookie(): string {
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
}
