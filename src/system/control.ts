// What the panel's "Система" tab can do: settings written to config.yaml and applied at once,
// the CUBE address and token, backups, the log. Secrets go to .env, never to config.yaml.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Config } from '../config.ts';
import type { CubeLink, LinkInfo } from '../cube/link.ts';
import type { Engine } from '../engine/engine.ts';
import type { Library } from '../rules/library.ts';
import type { Store } from '../store/db.ts';
import type { PendingChat, TelegramBot } from '../telegram/bot.ts';
import { makeBackup, readBackup, restoreBackup, stamp, type AutoBackup, type BackupPaths, type RestoreResult } from './backup.ts';
import { editConfigFile, setList, setValue } from './config-file.ts';
import type { LogBuffer } from './logbuf.ts';

export interface SystemDeps {
  config: Config;
  store: Store;
  engine: Engine;
  library: Library;
  link: CubeLink;
  bot: () => TelegramBot | undefined;
  logs: LogBuffer;
  backups: AutoBackup;
  paths: BackupPaths;
  envPath: string;
  startedAt: number;
  restart: () => void;
  onChange?: () => void;
}

export interface SystemOverview {
  startedAt: number;
  cube: LinkInfo;
  telegram: {
    enabled: boolean; bot: string | null; fromEnv: boolean;
    chats: { id: number; person: string | null }[];
    pending: PendingChat[];
    people: { id: string; name: string; telegram: number | null }[];
  };
  devices: {
    switches: { name: string; cubeName: string; protected: boolean }[];
    doors: { name: string; cubeName: string; mode: 'closed' | 'open'; open: boolean | null }[];
    all: { id: string; name: string; cubeName: string; room: string | null; label: string | null }[];
    rooms: string[];
  };
  backups: { dir: string; local: { name: string; size: number; ts: number }[] };
}

const SWITCH = /^(power|toggle\.\w+)$/;
const norm = (s: string) => s.trim().toLowerCase();

// KEY=value in .env: replaced or appended; the file stays private.
export function saveEnvValue(path: string, key: string, value: string): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith(`${key}=`)) : [];
  writeFileSync(path, [...lines, `${key}=${value}`, ''].join('\n'), { mode: 0o600 });
}

export class SystemControl {
  private readonly d: SystemDeps;

  constructor(d: SystemDeps) { this.d = d; }

  overview(): SystemOverview {
    const { config, engine } = this.d;
    const bot = this.d.bot();
    const guarded = new Set(config.protected.map(norm));
    const devices = engine.deviceList().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const personOf = (chat: number) => Object.entries(config.people).find(([, p]) => p.telegram === chat)?.[0] ?? null;
    return {
      startedAt: this.d.startedAt,
      cube: this.d.link.info(),
      telegram: {
        enabled: !!bot, bot: bot?.username() ?? null, fromEnv: config.chatsFromEnv,
        chats: config.telegram.chats.map((id) => ({ id, person: personOf(id) })),
        pending: bot?.pendingChats() ?? [],
        people: Object.entries(config.people).map(([id, p]) => ({ id, name: p.name, telegram: p.telegram ?? null })),
      },
      devices: {
        switches: devices.filter((x) => Object.keys(x.attrs).some((k) => SWITCH.test(k))).map((x) => ({
          name: x.name, cubeName: x.cubeName, protected: guarded.has(norm(x.name)) || guarded.has(norm(x.cubeName)) || guarded.has(norm(x.id)),
        })),
        doors: devices.filter((x) => 'open' in x.attrs).map((x) => ({
          name: x.name, cubeName: x.cubeName,
          mode: this.entry(x.cubeName)?.contact_true_means ?? 'closed',
          open: typeof x.attrs.open === 'boolean' ? x.attrs.open : null,
        })),
        all: devices.map((x) => ({ id: x.id, name: x.name, cubeName: x.cubeName, room: x.room, label: this.entry(x.cubeName)?.label ?? null })),
        rooms: config.rooms,
      },
      backups: { dir: this.d.backups.dir, local: this.d.backups.list() },
    };
  }

  logTail(n = 300): string[] { return this.d.logs.tail(n); }

  // Settings of one device are keyed by its CUBE name (any letter case).
  private key(cubeName: string): string {
    return Object.keys(this.d.config.devices).find((k) => norm(k) === norm(cubeName)) ?? cubeName;
  }
  private entry(cubeName: string) { return this.d.config.devices[this.key(cubeName)]; }

  // ── own names and rooms (CUBE is not touched; cards keep referring to CUBE names) ──

  setDeviceMeta(cubeName: string, meta: { label?: string | null; room?: string | null }): void {
    const { config } = this.d;
    const device = this.d.engine.deviceList().find((x) => norm(x.cubeName) === norm(cubeName));
    if (!device) throw new Error(`нет устройства «${cubeName}»`);
    const key = this.key(device.cubeName);
    const edits = [];
    const entry = { ...(config.devices[key] ?? { contact_true_means: 'closed' as const }) };
    if (meta.label !== undefined) {
      const label = meta.label?.trim() || null;
      const clean = label && label !== device.cubeName ? label : null;
      if (clean && clean.length > 60) throw new Error('имя — до 60 знаков');
      edits.push(setValue(['devices', key, 'label'], clean));
      if (clean) entry.label = clean; else delete entry.label;
    }
    if (meta.room !== undefined) {
      const room = meta.room?.trim() || null;
      if (room && !config.rooms.includes(room)) { config.rooms = [...config.rooms, room]; edits.push(setList(['rooms'], config.rooms)); }
      edits.push(setValue(['devices', key, 'room'], room));
      if (room) entry.room = room; else delete entry.room;
    }
    editConfigFile(config.configPath, ...edits);
    config.devices[key] = entry;
    this.d.engine.setDeviceSettings(config.devices);
    this.event(`устройство «${device.cubeName}»: ${entry.label ? `в панели «${entry.label}»` : 'имя из CUBE'}${entry.room ? `, ${entry.room}` : ', без комнаты'}`);
  }

  // add / rename / delete / move a room; devices follow a renamed room and lose a deleted one.
  editRooms(op: { add?: string; rename?: [string, string]; remove?: string; move?: [string, -1 | 1] }): void {
    const { config } = this.d;
    let rooms = [...config.rooms];
    const roomEdits: ((entry: { room?: string }) => string | null | undefined)[] = [];
    if (op.add) {
      const name = op.add.trim();
      if (!name || name.length > 40) throw new Error('название комнаты — от 1 до 40 знаков');
      if (!rooms.includes(name)) rooms.push(name);
    }
    if (op.rename) {
      const [from, to] = [op.rename[0], op.rename[1].trim()];
      if (!to || to.length > 40) throw new Error('название комнаты — от 1 до 40 знаков');
      if (rooms.includes(to) && to !== from) throw new Error(`комната «${to}» уже есть`);
      rooms = rooms.map((r) => (r === from ? to : r));
      roomEdits.push((e) => (e.room === from ? to : undefined));
    }
    if (op.remove) {
      rooms = rooms.filter((r) => r !== op.remove);
      roomEdits.push((e) => (e.room === op.remove ? null : undefined));
    }
    if (op.move) {
      const i = rooms.indexOf(op.move[0]);
      const j = i + op.move[1];
      if (i >= 0 && j >= 0 && j < rooms.length) [rooms[i], rooms[j]] = [rooms[j]!, rooms[i]!];
    }
    const edits = [setList(['rooms'], rooms)];
    const changed: [string, string | null][] = [];
    for (const [key, entry] of Object.entries(config.devices)) {
      for (const f of roomEdits) {
        const next = f(entry);
        if (next !== undefined) { changed.push([key, next]); edits.push(setValue(['devices', key, 'room'], next)); }
      }
    }
    editConfigFile(config.configPath, ...edits);
    config.rooms = rooms;
    for (const [key, room] of changed) { if (room) config.devices[key]!.room = room; else delete config.devices[key]!.room; }
    this.d.engine.setDeviceSettings(config.devices);
    this.event(`комнаты: ${rooms.join(', ') || 'нет'}`);
  }

  // ── Telegram chats and who is who ──

  setChat(id: number, add: boolean): void {
    const { config } = this.d;
    if (config.chatsFromEnv) throw new Error('чаты заданы переменной TELEGRAM_CHATS — правь её в .env');
    if (!Number.isSafeInteger(id) || id === 0) throw new Error('chat id — целое число');
    const chats = add ? [...new Set([...config.telegram.chats, id])] : config.telegram.chats.filter((c) => c !== id);
    editConfigFile(config.configPath, setList(['telegram', 'chats'], chats));
    config.telegram.chats = chats;
    this.d.bot()?.setChats(chats);
    this.event(`Telegram: чат ${id} ${add ? 'добавлен' : 'убран'}`);
  }

  // A chat linked to a person: /home and /away from it, «Принял» signed with the name.
  linkPerson(personId: string, chat: number | null): void {
    const { config } = this.d;
    const person = config.people[personId];
    if (!person) throw new Error(`нет человека «${personId}» в настройках`);
    editConfigFile(config.configPath, setValue(['people', personId, 'telegram'], chat));
    if (chat === null) delete person.telegram; else person.telegram = chat;
    this.event(`Telegram: ${person.name} — ${chat === null ? 'без чата' : `чат ${chat}`}`);
  }

  // ── devices ──

  setProtected(names: string[]): void {
    const { config } = this.d;
    const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    editConfigFile(config.configPath, setList(['protected'], clean));
    config.protected = clean;
    this.d.engine.setProtected(clean);
    this.event(`защищённые устройства: ${clean.join(', ') || 'нет'}`);
  }

  // How a door sensor reads its magnet; the device list is pulled again so "open" is recomputed.
  async setDoor(device: string, mode: 'closed' | 'open'): Promise<void> {
    const { config } = this.d;
    const key = this.key(device);
    editConfigFile(config.configPath, setValue(['devices', key, 'contact_true_means'], mode));
    config.devices[key] = { ...config.devices[key], contact_true_means: mode };
    this.d.engine.setDeviceSettings(config.devices);
    this.event(`датчик «${device}»: контакт = ${mode === 'closed' ? 'закрыто' : 'открыто'}`);
    await this.d.link.resync();
  }

  // ── CUBE ──

  async setCubeUrl(url: string): Promise<{ name?: string; fw_version?: string }> {
    const { config } = this.d;
    if (config.cubeUrlFromEnv) throw new Error('адрес задан переменной CUBE_URL (docker-compose) — панель его не меняет');
    const clean = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+$/.test(clean)) throw new Error('адрес вида http://192.168.1.20');
    const info = await this.d.link.probe(clean).catch((err) => { throw new Error(`CUBE по адресу ${clean} не отвечает: ${(err as Error).message}`); });
    editConfigFile(config.configPath, setValue(['cube', 'url'], clean));
    config.cube.url = clean;
    this.event(`адрес CUBE: ${clean}`);
    await this.d.link.restart(clean);
    return info;
  }

  requestToken(): void {
    const { config } = this.d;
    this.d.link.requestToken(config.cube.url, async (token) => {
      saveEnvValue(this.d.envPath, 'CUBE_TOKEN', token);
      config.cubeToken = token;
      this.event('CUBE: получен новый токен (сохранён в .env)');
      await this.d.link.restart(config.cube.url, token);
    });
  }

  // ── backups ──

  backupFile(withHistory: boolean): { name: string; data: Buffer } {
    return { name: `domovoy-${stamp(Date.now())}${withHistory ? '' : '-без-истории'}.backup.gz`, data: makeBackup(this.d.paths, this.d.store, withHistory) };
  }

  backupNow(): string { return this.d.backups.now(); }

  async restore(data: Buffer): Promise<RestoreResult> {
    const result = restoreBackup(readBackup(data), this.d.paths);
    await this.d.library.reload(); // cards work at once
    this.event(`восстановлено из копии: правил ${result.rules}, сцен ${result.scenes}${result.configChanged ? ', настройки' : ''}${result.history ? ', история (после перезапуска)' : ''}`);
    return result;
  }

  restoreLocal(name: string): Promise<RestoreResult> { return this.restore(this.d.backups.read(name)); }

  restart(): void {
    this.event('перезапуск движка из панели');
    this.d.restart();
  }

  private event(text: string): void {
    this.d.store.addEvent(Date.now(), 'manual', 'system', `Панель: ${text}`);
    this.d.onChange?.();
  }
}
