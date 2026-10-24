// SQLite storage (built into Node): numeric samples for baselines and charts, the rule journal,
// rule runtime state (survives restarts), variables, the event feed, rule switches and panel sessions.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Value } from '../cube/normalize.ts';

export interface JournalEntry<T = unknown> { id: number; ts: number; ruleId: string; outcome: string; data: T }

export type EventKind = 'device' | 'rule' | 'manual' | 'system';
export interface FeedEvent { id: number; ts: number; kind: EventKind; ref: string; text: string }
export interface RuleOverride { enabled: boolean | null; pausedUntil: number | null }
export interface StateChange { ts: number; ref: string; attr: string; value: Value }
export interface Delivery { chat: number; messageId: number }
export type NotificationStatus = 'sent' | 'no_telegram' | 'failed';
export interface NotificationRow {
  id: number; ts: number; source: string; text: string; urgent: boolean; quiet: boolean;
  status: NotificationStatus; deliveries: Delivery[]; repeats: number; nextAt: number | null;
  ackedAt: number | null; ackedBy: string | null; error: string | null;
}
export const VAR_REF = '@var';

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS samples (device_id TEXT NOT NULL, attr TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS samples_key ON samples (device_id, attr, ts);
      CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, rule_id TEXT NOT NULL, outcome TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS journal_rule ON journal (rule_id, ts);
      CREATE TABLE IF NOT EXISTS rule_state (rule_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vars (name TEXT PRIMARY KEY, value TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
      CREATE TABLE IF NOT EXISTS rule_overrides (rule_id TEXT PRIMARY KEY, enabled INTEGER, paused_until INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (ts INTEGER NOT NULL, ref TEXT NOT NULL, attr TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS changes_key ON changes (ref, attr, ts);
      CREATE INDEX IF NOT EXISTS changes_ts ON changes (ts);
      CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL,
        urgent INTEGER NOT NULL, quiet INTEGER NOT NULL, status TEXT NOT NULL, deliveries TEXT NOT NULL, repeats INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER, acked_at INTEGER, acked_by TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_seen (device_id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS alerts (key TEXT PRIMARY KEY, since INTEGER NOT NULL, notified INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS device_reports (device_id TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS device_reports_key ON device_reports (device_id, ts);
    `);
  }

  // ── notifications journal ──

  addNotification(n: Omit<NotificationRow, 'id' | 'repeats' | 'nextAt' | 'ackedAt' | 'ackedBy' | 'error'>): number {
    const r = this.db.prepare('INSERT INTO notifications (ts, source, text, urgent, quiet, status, deliveries) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(n.ts, n.source, n.text, n.urgent ? 1 : 0, n.quiet ? 1 : 0, n.status, JSON.stringify(n.deliveries));
    return Number(r.lastInsertRowid);
  }

  updateNotification(id: number, p: Partial<Pick<NotificationRow, 'status' | 'deliveries' | 'repeats' | 'nextAt' | 'ackedAt' | 'ackedBy' | 'error'>>): void {
    const cols: Record<string, string> = { status: 'status', deliveries: 'deliveries', repeats: 'repeats', nextAt: 'next_at', ackedAt: 'acked_at', ackedBy: 'acked_by', error: 'error' };
    const keys = Object.keys(p) as (keyof typeof p)[];
    if (!keys.length) return;
    const values = keys.map((k) => (k === 'deliveries' ? JSON.stringify(p[k]) : (p[k] ?? null)) as string | number | null);
    this.db.prepare(`UPDATE notifications SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
  }

  private static row(r: Record<string, unknown>): NotificationRow {
    return {
      id: r.id as number, ts: r.ts as number, source: r.source as string, text: r.text as string, urgent: r.urgent === 1, quiet: r.quiet === 1,
      status: r.status as NotificationStatus, deliveries: JSON.parse(r.deliveries as string) as Delivery[], repeats: r.repeats as number,
      nextAt: r.next_at as number | null, ackedAt: r.acked_at as number | null, ackedBy: r.acked_by as string | null, error: r.error as string | null,
    };
  }

  notification(id: number): NotificationRow | undefined {
    const r = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r && Store.row(r);
  }

  // Newest first. "pending": urgent and nobody pressed «Принял» yet.
  notifications(f: { filter?: 'all' | 'urgent' | 'pending'; before?: number; limit?: number } = {}): NotificationRow[] {
    const where: string[] = [];
    if (f.filter === 'urgent') where.push('urgent = 1');
    if (f.filter === 'pending') where.push('urgent = 1 AND acked_at IS NULL');
    if (f.before) where.push(`id < ${Math.floor(f.before)}`);
    const sql = `SELECT * FROM notifications ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(Math.min(f.limit ?? 50, 200)) as Record<string, unknown>[]).map(Store.row);
  }

  // ── settings, device last-seen, alert states ──

  setting<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  }

  saveSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  seenAll(): Map<string, number> {
    const rows = this.db.prepare('SELECT device_id, ts FROM device_seen').all() as { device_id: string; ts: number }[];
    return new Map(rows.map((r) => [r.device_id, r.ts]));
  }

  saveSeen(entries: [string, number][]): void {
    const st = this.db.prepare('INSERT INTO device_seen (device_id, ts) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET ts = excluded.ts');
    for (const [id, ts] of entries) st.run(id, ts);
  }

  // Moments a device itself sent something (state events from CUBE — not our own reloads of the device list).
  addReports(entries: [string, number][]): void {
    const st = this.db.prepare('INSERT INTO device_reports (device_id, ts) VALUES (?, ?)');
    for (const [id, ts] of entries) st.run(id, ts);
  }

  reportTimes(deviceId: string, from: number): number[] {
    return (this.db.prepare('SELECT ts FROM device_reports WHERE device_id = ? AND ts >= ? ORDER BY ts').all(deviceId, from) as { ts: number }[]).map((r) => r.ts);
  }

  alerts(): Map<string, { since: number; notified: boolean }> {
    const rows = this.db.prepare('SELECT key, since, notified FROM alerts').all() as { key: string; since: number; notified: number }[];
    return new Map(rows.map((r) => [r.key, { since: r.since, notified: r.notified === 1 }]));
  }

  saveAlert(key: string, since: number, notified: boolean): void {
    this.db.prepare('INSERT INTO alerts (key, since, notified) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET since = excluded.since, notified = excluded.notified')
      .run(key, since, notified ? 1 : 0);
  }

  deleteAlert(key: string): void { this.db.prepare('DELETE FROM alerts WHERE key = ?').run(key); }

  // ── non-numeric state history (doors, switches, variables) for "what if" replays ──
  // ref is a device id, or VAR_REF for variables (attr = variable name).

  addChange(ts: number, ref: string, attr: string, value: Value): void {
    this.db.prepare('INSERT INTO changes (ts, ref, attr, value) VALUES (?, ?, ?, ?)').run(ts, ref, attr, JSON.stringify(value));
  }

  changes(from: number, to: number): StateChange[] {
    const rows = this.db.prepare('SELECT ts, ref, attr, value FROM changes WHERE ts >= ? AND ts < ? ORDER BY ts, rowid')
      .all(from, to) as { ts: number; ref: string; attr: string; value: string }[];
    return rows.map((r) => ({ ts: r.ts, ref: r.ref, attr: r.attr, value: JSON.parse(r.value) as Value }));
  }

  // The latest value of every ref/attr strictly before ts.
  stateBefore(ts: number): Map<string, Value> {
    const rows = this.db.prepare('SELECT ref, attr, value, MAX(ts) AS t FROM changes WHERE ts < ? GROUP BY ref, attr')
      .all(ts) as { ref: string; attr: string; value: string }[];
    return new Map(rows.map((r) => [`${r.ref}|${r.attr}`, JSON.parse(r.value) as Value]));
  }

  firstChange(ref: string, attr: string): number | null {
    const row = this.db.prepare('SELECT MIN(ts) AS t FROM changes WHERE ref = ? AND attr = ?').get(ref, attr) as { t: number | null };
    return row.t;
  }

  firstSample(deviceId: string, attr: string): number | null {
    const row = this.db.prepare('SELECT MIN(ts) AS t FROM samples WHERE device_id = ? AND attr = ?').get(deviceId, attr) as { t: number | null };
    return row.t;
  }

  lastSampleBefore(deviceId: string, attr: string, ts: number): number | null {
    const row = this.db.prepare('SELECT value FROM samples WHERE device_id = ? AND attr = ? AND ts < ? ORDER BY ts DESC LIMIT 1')
      .get(deviceId, attr, ts) as { value: number } | undefined;
    return row ? row.value : null;
  }

  addSample(deviceId: string, attr: string, ts: number, value: number): void {
    this.db.prepare('INSERT INTO samples (device_id, attr, ts, value) VALUES (?, ?, ?, ?)').run(deviceId, attr, ts, value);
  }

  series(deviceId: string, attr: string, from: number, to: number): [number, number][] {
    const rows = this.db.prepare('SELECT ts, value FROM samples WHERE device_id = ? AND attr = ? AND ts >= ? AND ts < ? ORDER BY ts')
      .all(deviceId, attr, from, to) as { ts: number; value: number }[];
    return rows.map((r) => [r.ts, r.value]);
  }

  addEvent(ts: number, kind: EventKind, ref: string, text: string): void {
    this.db.prepare('INSERT INTO events (ts, kind, ref, text) VALUES (?, ?, ?, ?)').run(ts, kind, ref, text);
  }

  // Newest first; `before` pages back by event id.
  events(f: { kind?: EventKind; ref?: string; before?: number; limit?: number } = {}): FeedEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.kind) { where.push('kind = ?'); args.push(f.kind); }
    if (f.ref) { where.push('ref = ?'); args.push(f.ref); }
    if (f.before) { where.push('id < ?'); args.push(f.before); }
    const sql = `SELECT id, ts, kind, ref, text FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(f.limit ?? 50, 200)) as unknown as FeedEvent[];
  }

  ruleOverrides(): Map<string, RuleOverride> {
    const rows = this.db.prepare('SELECT rule_id, enabled, paused_until FROM rule_overrides').all() as { rule_id: string; enabled: number | null; paused_until: number | null }[];
    return new Map(rows.map((r) => [r.rule_id, { enabled: r.enabled === null ? null : r.enabled === 1, pausedUntil: r.paused_until }]));
  }

  saveRuleOverride(ruleId: string, o: RuleOverride): void {
    this.db.prepare('INSERT INTO rule_overrides (rule_id, enabled, paused_until) VALUES (?, ?, ?) ON CONFLICT(rule_id) DO UPDATE SET enabled = excluded.enabled, paused_until = excluded.paused_until')
      .run(ruleId, o.enabled === null ? null : o.enabled ? 1 : 0, o.pausedUntil);
  }

  addSession(tokenHash: string, created: number, expires: number): void {
    this.db.prepare('INSERT INTO sessions (token_hash, created, expires) VALUES (?, ?, ?)').run(tokenHash, created, expires);
  }

  hasSession(tokenHash: string, now: number): boolean {
    return this.db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires > ?').get(tokenHash, now) !== undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  samples(deviceId: string, attr: string, from: number, to: number): number[] {
    const rows = this.db.prepare('SELECT value FROM samples WHERE device_id = ? AND attr = ? AND ts >= ? AND ts < ? ORDER BY ts')
      .all(deviceId, attr, from, to) as { value: number }[];
    return rows.map((r) => r.value);
  }

  addJournal(ts: number, ruleId: string, outcome: string, data: unknown): void {
    this.db.prepare('INSERT INTO journal (ts, rule_id, outcome, data) VALUES (?, ?, ?, ?)').run(ts, ruleId, outcome, JSON.stringify(data));
  }

  journal<T>(ruleId: string, since: number, limit = 50): JournalEntry<T>[] {
    const rows = this.db.prepare('SELECT id, ts, rule_id, outcome, data FROM journal WHERE rule_id = ? AND ts >= ? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(ruleId, since, limit) as { id: number; ts: number; rule_id: string; outcome: string; data: string }[];
    return rows.map((r) => ({ id: r.id, ts: r.ts, ruleId: r.rule_id, outcome: r.outcome, data: JSON.parse(r.data) as T }));
  }

  lastJournal<T>(ruleId: string, outcomes: string[]): JournalEntry<T> | undefined {
    const marks = outcomes.map(() => '?').join(',');
    const row = this.db.prepare(`SELECT id, ts, rule_id, outcome, data FROM journal WHERE rule_id = ? AND outcome IN (${marks}) ORDER BY ts DESC, id DESC LIMIT 1`)
      .get(ruleId, ...outcomes) as { id: number; ts: number; rule_id: string; outcome: string; data: string } | undefined;
    return row && { id: row.id, ts: row.ts, ruleId: row.rule_id, outcome: row.outcome, data: JSON.parse(row.data) as T };
  }

  ruleState<T>(ruleId: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM rule_state WHERE rule_id = ?').get(ruleId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  saveRuleState(ruleId: string, state: unknown): void {
    this.db.prepare('INSERT INTO rule_state (rule_id, data) VALUES (?, ?) ON CONFLICT(rule_id) DO UPDATE SET data = excluded.data')
      .run(ruleId, JSON.stringify(state));
  }

  vars(): Map<string, Value> {
    const rows = this.db.prepare('SELECT name, value FROM vars').all() as { name: string; value: string }[];
    return new Map(rows.map((r) => [r.name, JSON.parse(r.value) as Value]));
  }

  saveVar(name: string, value: Value, ts: number): void {
    this.db.prepare('INSERT INTO vars (name, value, ts) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, ts = excluded.ts')
      .run(name, JSON.stringify(value), ts);
  }

  prune(now: number, sampleDays = 7, journalDays = 30): void {
    this.db.prepare('DELETE FROM samples WHERE ts < ?').run(now - sampleDays * 86_400_000);
    this.db.prepare('DELETE FROM device_reports WHERE ts < ?').run(now - sampleDays * 86_400_000);
    // Old changes go, except the last one before the cut: a door closed for two weeks still has a known state.
    this.db.prepare(`DELETE FROM changes WHERE ts < :cut AND EXISTS (
      SELECT 1 FROM changes n WHERE n.ref = changes.ref AND n.attr = changes.attr AND n.ts > changes.ts AND n.ts <= :cut)`)
      .run({ cut: now - sampleDays * 86_400_000 });
    this.db.prepare('DELETE FROM journal WHERE ts < ?').run(now - journalDays * 86_400_000);
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(now - journalDays * 86_400_000);
    this.db.prepare('DELETE FROM notifications WHERE ts < ? AND (urgent = 0 OR acked_at IS NOT NULL OR next_at IS NULL)').run(now - journalDays * 86_400_000);
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  }

  // A consistent copy of the whole database while it is in use (for backups).
  snapshot(path: string): void { this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`); }

  close(): void { this.db.close(); }
}
