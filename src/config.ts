// Engine settings from config.yaml; secrets come from the environment (.env), never from the file.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

z.config(z.locales.ru()); // validation messages in Russian here too (also used before the rule schema loads)

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const configSchema = z.object({
  timezone: z.string().default('Asia/Tbilisi'),
  // For sunrise and sunset; default — Tbilisi.
  location: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict().default({ lat: 41.7151, lon: 44.8271 }),
  cube: z.object({ url: z.string().url() }).strict(),
  telegram: z.object({ chats: z.array(z.number().int()).default([]) }).strict().default({ chats: [] }),
  panel: z.object({
    enabled: z.boolean().default(true),
    port: z.number().int().min(1).max(65535).default(8080),
    host: z.string().default('0.0.0.0'),
  }).strict().default({ enabled: true, port: 8080, host: '0.0.0.0' }),
  rules_dir: z.string().default('./rules'),
  scenes_dir: z.string().default('./scenes'),
  // People for "who is home": each gets a variable home_<id>; "telegram" links a chat to /home and /away.
  people: z.record(z.string().regex(/^[a-z0-9_]+$/, 'id человека: латиница, цифры, _'), z.object({
    name: z.string().min(1),
    telegram: z.number().int().optional(),
  }).strict()).default({}),
  db: z.string().default('./data/domovoy.db'),
  vars: z.record(z.string(), z.object({
    label: z.string(),
    initial: scalar,
    // Choice variables (e.g. the home mode): only these values, shown as buttons.
    options: z.array(z.object({ value: z.string(), label: z.string() }).strict()).min(2).optional(),
  }).strict()).default({}),
  // Devices the engine must never control (for example, an AC that must not lose power).
  protected: z.array(z.string()).default([]),
  // Drafts of cards from plain words (Claude API). The key is ANTHROPIC_API_KEY in .env.
  ai: z.object({
    model: z.string().default('claude-opus-5-5'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  }).strict().default({ model: 'claude-opus-5-5', effort: 'medium' }),
  // Keyed by the device name in CUBE (the eWeLink app).
  devices: z.record(z.string(), z.object({
    // CUBE reports contact=true when the magnet is detected; for most door sensors that means closed.
    contact_true_means: z.enum(['closed', 'open']).default('closed'),
    label: z.string().trim().min(1).max(60).optional(), // the panel's own name; CUBE is not touched
    room: z.string().trim().min(1).max(40).optional(),
  }).strict()).default({}),
  // Rooms in the order they are shown.
  rooms: z.array(z.string().trim().min(1).max(40)).default([]),
}).strict();

export type Config = z.output<typeof configSchema> & {
  cubeToken: string | undefined;
  telegramToken: string | undefined;
  presenceToken: string | undefined;
  anthropicKey: string | undefined;
  anthropicWorkspace: string | undefined;
  configPath: string;
  cubeUrlFromEnv: boolean;  // CUBE_URL is set: the address is managed outside (docker-compose), the panel only shows it
  chatsFromEnv: boolean;
};

// For edits made from the panel: the same validation as at start; null when fine.
export function checkConfig(raw: unknown): string | null {
  const r = configSchema.safeParse(raw);
  return r.success ? null : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  const raw = YAML.parse(readFileSync(path, 'utf8'));
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`${path}: настройки не прошли проверку\n${issues}`);
  }
  const base = dirname(resolve(path));
  const cfg = result.data;
  // Environment overrides, handy in containers: CUBE_URL, PANEL_PORT, TELEGRAM_CHATS=123,456.
  if (env.CUBE_URL) cfg.cube.url = env.CUBE_URL;
  if (env.PANEL_PORT && Number.isInteger(Number(env.PANEL_PORT))) cfg.panel.port = Number(env.PANEL_PORT);
  if (env.TELEGRAM_CHATS) {
    const chats = env.TELEGRAM_CHATS.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n !== 0);
    if (chats.length) cfg.telegram.chats = chats;
  }
  return {
    ...cfg,
    rules_dir: resolve(base, cfg.rules_dir),
    scenes_dir: resolve(base, cfg.scenes_dir),
    db: cfg.db === ':memory:' ? cfg.db : resolve(base, cfg.db),
    cubeToken: env.CUBE_TOKEN || undefined,
    telegramToken: env.TELEGRAM_BOT_TOKEN || undefined,
    presenceToken: env.PRESENCE_TOKEN || undefined,
    anthropicKey: env.ANTHROPIC_API_KEY || undefined,
    anthropicWorkspace: env.ANTHROPIC_WORKSPACE_ID || undefined,
    configPath: resolve(path),
    cubeUrlFromEnv: !!env.CUBE_URL,
    chatsFromEnv: !!env.TELEGRAM_CHATS,
  };
}
