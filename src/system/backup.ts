// Backups: one gzip file with config.yaml, rule and scene cards and (optionally) the history database.
// Secrets from .env are never included. Restoring puts the current files aside first (.trash,
// *.before-restore-*), applies cards at once, and swaps the database in at the next start.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import YAML from 'yaml';
import { checkConfig } from '../config.ts';
import type { Store } from '../store/db.ts';

export interface BackupPaths { configPath: string; rulesDir: string; scenesDir: string; dbPath: string }
export interface BackupBundle {
  format: 'domovoy-backup'; version: 1; createdAt: number;
  config: string; rules: Record<string, string>; scenes: Record<string, string>;
  history: string | null; // base64 SQLite file
}
export interface RestoreResult { rules: number; scenes: number; configChanged: boolean; history: boolean }

const CARD = /^[\p{L}\p{N}._-]+\.ya?ml$/u;
const SQLITE = Buffer.from('SQLite format 3\0');
export const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 19).replace(/:/g, '-');

function readCards(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter((f) => CARD.test(f)).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
}

export function makeBackup(p: BackupPaths, store: Store, withHistory: boolean, now = Date.now()): Buffer {
  let history: string | null = null;
  if (withHistory && p.dbPath !== ':memory:') {
    const tmp = `${p.dbPath}.snapshot-${now}`;
    store.snapshot(tmp);
    try { history = readFileSync(tmp).toString('base64'); } finally { unlinkSync(tmp); }
  }
  const bundle: BackupBundle = {
    format: 'domovoy-backup', version: 1, createdAt: now,
    config: readFileSync(p.configPath, 'utf8'), rules: readCards(p.rulesDir), scenes: readCards(p.scenesDir), history,
  };
  return gzipSync(JSON.stringify(bundle));
}

export function readBackup(data: Buffer): BackupBundle {
  let text: string;
  try { text = gunzipSync(data).toString('utf8'); } catch { text = data.toString('utf8'); }
  let b: Partial<BackupBundle>;
  try { b = JSON.parse(text) as Partial<BackupBundle>; } catch { throw new Error('это не резервная копия «Домового»'); }
  if (b.format !== 'domovoy-backup' || b.version !== 1) throw new Error('это не резервная копия «Домового» (или из более новой версии)');
  if (typeof b.config !== 'string' || !b.rules || !b.scenes) throw new Error('копия повреждена: нет настроек или карточек');
  for (const name of [...Object.keys(b.rules), ...Object.keys(b.scenes)]) {
    if (!CARD.test(name) || basename(name) !== name) throw new Error(`копия повреждена: странное имя файла «${name}»`);
  }
  return b as BackupBundle;
}

// Everything is checked before anything is touched.
export function restoreBackup(b: BackupBundle, p: BackupPaths, now = Date.now()): RestoreResult {
  let parsed: unknown;
  try { parsed = YAML.parse(b.config); } catch (err) { throw new Error(`в копии сломан config.yaml: ${(err as Error).message}`); }
  const problem = checkConfig(parsed);
  if (problem) throw new Error(`в копии config.yaml не проходит проверку: ${problem}`);
  const db = b.history ? Buffer.from(b.history, 'base64') : null;
  if (db && !db.subarray(0, SQLITE.length).equals(SQLITE)) throw new Error('в копии повреждена история (не файл SQLite)');

  const tag = `before-restore-${stamp(now)}`;
  for (const [dir, cards] of [[p.rulesDir, b.rules], [p.scenesDir, b.scenes]] as const) {
    mkdirSync(dir, { recursive: true });
    const aside = join(dir, '.trash', tag);
    for (const f of readdirSync(dir).filter((x) => CARD.test(x))) {
      mkdirSync(aside, { recursive: true });
      renameSync(join(dir, f), join(aside, f));
    }
    for (const [name, text] of Object.entries(cards)) writeFileSync(join(dir, name), text);
  }
  const configChanged = readFileSync(p.configPath, 'utf8') !== b.config;
  if (configChanged) {
    copyFileSync(p.configPath, `${p.configPath}.${tag}`);
    writeFileSync(`${p.configPath}.tmp`, b.config);
    renameSync(`${p.configPath}.tmp`, p.configPath);
  }
  if (db && p.dbPath !== ':memory:') writeFileSync(`${p.dbPath}.restore`, db);
  return { rules: Object.keys(b.rules).length, scenes: Object.keys(b.scenes).length, configChanged, history: !!db };
}

// At start, before the database is opened: a restored history replaces the current one (kept aside).
export function applyPendingRestore(dbPath: string, now = Date.now()): boolean {
  const restore = `${dbPath}.restore`;
  if (dbPath === ':memory:' || !existsSync(restore)) return false;
  const tag = `before-restore-${stamp(now)}`;
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, `${dbPath}.${tag}${suffix}`);
  renameSync(restore, dbPath);
  return true;
}

// Daily copies next to config.yaml (backups/), the newest few kept. They guard against a bad edit,
// not against a dead SD card — for that, download a copy to another device.
export class AutoBackup {
  readonly dir: string;
  private readonly keep: number;
  private readonly make: () => Buffer;
  private timer: NodeJS.Timeout | null = null;

  constructor(o: { dir: string; keep?: number; make: () => Buffer }) {
    this.dir = o.dir;
    this.keep = o.keep ?? 7;
    this.make = o.make;
  }

  list(): { name: string; size: number; ts: number }[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith('.backup.gz'))
      .map((name) => { const s = statSync(join(this.dir, name)); return { name, size: s.size, ts: s.mtimeMs }; })
      .sort((a, b) => b.ts - a.ts);
  }

  now(ts = Date.now()): string {
    mkdirSync(this.dir, { recursive: true });
    const name = `domovoy-${stamp(ts)}.backup.gz`;
    writeFileSync(join(this.dir, name), this.make());
    for (const old of this.list().slice(this.keep)) unlinkSync(join(this.dir, old.name));
    return name;
  }

  read(name: string): Buffer {
    if (basename(name) !== name || !name.endsWith('.backup.gz') || !existsSync(join(this.dir, name))) throw new Error(`нет такой копии: ${name}`);
    return readFileSync(join(this.dir, name));
  }

  // A copy now if the last one is older than a day, then every day.
  start(log?: (msg: string) => void): void {
    const tick = () => {
      const last = this.list()[0];
      if (last && Date.now() - last.ts < 23 * 3_600_000) return;
      try { log?.(`Резервная копия: ${this.now()}`); } catch (err) { log?.(`Резервная копия не сделана: ${(err as Error).message}`); }
    };
    tick();
    this.timer = setInterval(tick, 3_600_000);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}

export const backupDir = (configPath: string) => join(dirname(configPath), 'backups');
