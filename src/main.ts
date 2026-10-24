// Entry point: config → CUBE devices → engine → event stream and Telegram bot.
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandlers } from './app.ts';
import { loadConfig } from './config.ts';
import { CubeLink } from './cube/link.ts';
import { realClock } from './engine/clock.ts';
import { Engine } from './engine/engine.ts';
import { replay } from './engine/replay.ts';
import { Drafter } from './ai/draft.ts';
import { Health } from './notify/health.ts';
import { Notifications } from './notify/notifications.ts';
import { loadSettings } from './notify/settings.ts';
import { resolvePassword } from './panel/auth.ts';
import { startPanel, type Panel } from './panel/server.ts';
import { Library } from './rules/library.ts';
import { Store } from './store/db.ts';
import { TelegramBot } from './telegram/bot.ts';
import { applyPendingRestore, AutoBackup, backupDir, makeBackup } from './system/backup.ts';
import { SystemControl } from './system/control.ts';
import { LogBuffer } from './system/logbuf.ts';

const logs = new LogBuffer();
const log = (msg: string) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  logs.add(line);
};

// First run (e.g. a fresh Docker volume): put the example config, rules and scenes next to the config path.
// Folders that appeared in newer versions (scenes) are added to existing installs too.
function initIfMissing(configPath: string): boolean {
  const dir = dirname(resolve(configPath));
  const app = fileURLToPath(new URL('..', import.meta.url));
  mkdirSync(dir, { recursive: true });
  for (const folder of ['rules', 'scenes']) {
    if (!existsSync(join(dir, folder))) cpSync(join(app, folder), join(dir, folder), { recursive: true });
  }
  if (existsSync(configPath)) return false;
  copyFileSync(join(app, 'config.example.yaml'), configPath);
  return true;
}

async function main(): Promise<void> {
  const configPath = process.env.DOMOVOY_CONFIG ?? './config.yaml';
  if (initIfMissing(configPath)) {
    log(`Создал ${configPath} и папки rules, scenes рядом. Адрес CUBE и токен можно задать в панели: Система → CUBE.`);
  }
  const config = loadConfig(configPath);
  // Engine is created below; the library only calls back into it after start.
  let engineRef: Engine | undefined;
  const library = new Library({
    rulesDir: config.rules_dir, scenesDir: config.scenes_dir, log,
    context: () => ({ devices: engineRef?.deviceList() ?? [], vars: engineRef?.varList() ?? [], protected: config.protected }),
    onReload: async (r, sc) => {
      await engineRef?.reload(r, sc);
      log(`Карточки перечитаны: правил ${r.length}, сцен ${sc.length}`);
    },
  });
  const { rules, scenes } = library.load();
  for (const e of library.errors) log(`Карточка ${e.file} не загружена: ${e.error.split('\n')[0]}`);
  log(`Правил: ${rules.length} (${rules.map((r) => r.id).join(', ')}); сцен: ${scenes.length} (${scenes.map((x) => x.id).join(', ')})`);
  if (applyPendingRestore(config.db)) log('История восстановлена из резервной копии (прежняя база сохранена рядом).');
  const store = new Store(config.db);
  const abort = new AbortController();
  const startedAt = Date.now();

  let bot: TelegramBot | undefined;
  let panel: Panel | undefined;
  // Every notification is journaled; Telegram is just the way it is delivered (if configured).
  const notifications = new Notifications({
    store, clock: realClock, timezone: config.timezone, log, settings: () => loadSettings(store),
    messenger: () => bot?.messenger() ?? null, onChange: () => panel?.changed(),
  });
  const notifier = async (text: string, meta?: { source?: string; urgent?: boolean }) => { await notifications.send(text, meta); };
  const engine: Engine = new Engine({
    rules, store, clock: realClock, notifier, log, onChange: () => panel?.changed(),
    actuator: (id, state): Promise<void> => cubeLink.actuator(id, state),
    vars: config.vars, protectedDevices: config.protected, deviceSettings: config.devices,
    scenes, people: config.people, timezone: config.timezone, place: config.location,
  });
  engineRef = engine;
  library.watch();
  // Without a token the engine still starts: the token is obtained from the panel (Система → CUBE).
  const cubeLink: CubeLink = new CubeLink({
    url: config.cube.url, token: config.cubeToken, urlFromEnv: config.cubeUrlFromEnv, engine, store, log,
    onEvent: (e) => { if (e.type === 'state') health.touch(e.id); void engine.handleCubeEvent(e); },
    onChange: () => panel?.changed(),
  });
  const link = cubeLink.link;
  const health = new Health({
    store, clock: realClock, devices: () => engine.deviceList(), log, settings: () => loadSettings(store),
    notify: (text, meta) => notifications.send(text, meta),
  });

  if (config.telegramToken) {
    bot = new TelegramBot({
      token: config.telegramToken, chats: config.telegram.chats, log,
      handlers: {
        ...createHandlers(engine, store, { now: () => Date.now(), timezone: config.timezone, link: () => link }),
        // A chat linked to a person in config signs with that name ("Антон"), otherwise the Telegram name.
        ack: (id, who, chat) => notifications.ack(id, Object.values(config.people).find((p) => p.telegram === chat)?.name ?? who),
      },
    });
    if (!config.telegram.chats.length) log('Telegram: список чатов пуст — напиши боту /start: он пришлёт chat id, и id появится здесь в логе.');
    void bot.run(abort.signal);
  } else log('Telegram выключен: нет TELEGRAM_BOT_TOKEN.');
  notifications.resume(); // urgent notifications still waiting for «Принял» keep repeating after a restart

  const drafter = config.anthropicKey
    ? new Drafter({
      apiKey: config.anthropicKey, workspaceId: config.anthropicWorkspace, model: config.ai.model, effort: config.ai.effort,
      check: (kind, yaml) => library.check(kind, { yaml }),
    })
    : null;
  log(drafter ? `ИИ-черновики: ${config.ai.model}` : 'ИИ-черновики выключены: нет ANTHROPIC_API_KEY.');

  const paths = { configPath: config.configPath, rulesDir: config.rules_dir, scenesDir: config.scenes_dir, dbPath: config.db };
  const backups = new AutoBackup({ dir: backupDir(config.configPath), make: () => makeBackup(paths, store, true) });
  const system = new SystemControl({
    config, store, engine, library, link: cubeLink, bot: () => bot, logs, backups, paths, startedAt,
    envPath: join(dirname(config.configPath), '.env'),
    // A clean stop; Docker's restart policy (restart: unless-stopped) starts the engine again.
    restart: () => setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300),
    onChange: () => panel?.changed(),
  });

  if (config.panel.enabled) {
    const passwordFile = join(dirname(resolve(configPath)), 'panel-password.txt');
    const { password, generated } = resolvePassword(process.env.PANEL_PASSWORD, passwordFile);
    panel = await startPanel({
      engine, store, port: config.panel.port, host: config.panel.host, timezone: config.timezone, log, password,
      presenceToken: config.presenceToken, library, notifications, health, telegram: !!bot,
      link: () => link, simulator: () => cubeLink.isSimulator(), cubeUrl: config.cube.url, system, rooms: () => config.rooms,
      replay: (rule, hours) => replay({
        store, rule, devices: engine.deviceList(), from: Date.now() - hours * 3_600_000, to: Date.now(),
        scenes: engine.scenes, vars: config.vars, people: config.people, timezone: config.timezone, place: config.location,
        protectedDevices: config.protected, deviceSettings: config.devices,
      }),
      ai: {
        drafter,
        house: () => ({
          devices: engine.deviceList(), vars: engine.varList(), protected: config.protected,
          scenes: engine.scenes.map((x) => ({ id: x.id, name: x.name })), rules: engine.rules.map((r) => ({ id: r.id, name: r.name })),
          timezone: config.timezone, now: Date.now(),
        }),
      },
    });
    log(`Веб-панель: порт ${config.panel.port}; пароль ${process.env.PANEL_PASSWORD ? 'из PANEL_PASSWORD' : `в файле ${passwordFile}${generated ? ' (создан сейчас)' : ''}`}`);
  }

  store.addEvent(Date.now(), 'system', 'engine', `Движок запущен, правил: ${rules.length}`);
  cubeLink.start();
  backups.start(log);
  const prune = () => store.prune(Date.now());
  prune();
  const pruneTimer = setInterval(prune, 86_400_000);
  const checkHealth = () => void health.check().then(() => panel?.changed()).catch((e) => log(`Здоровье: ${(e as Error).message}`));
  checkHealth();
  const healthTimer = setInterval(checkHealth, 5 * 60_000);

  const shutdown = () => {
    log('Останавливаюсь…');
    abort.abort();
    cubeLink.stop();
    backups.stop();
    clearInterval(pruneTimer);
    clearInterval(healthTimer);
    health.flush();
    notifications.stop();
    engine.stop();
    library.close();
    void panel?.close();
    void engine.idle().finally(() => { store.close(); process.exit(0); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`Не запустился: ${(err as Error).message}`);
  process.exit(1);
});
