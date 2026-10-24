// Wires the engine to its read-side commands (used by the Telegram bot and tests).
import type { Value } from './cube/normalize.ts';
import { formatDuration } from './duration.ts';
import type { Engine } from './engine/engine.ts';
import { homeVar } from './engine/vars.ts';
import { explainRule, formatValue } from './explain/explain.ts';
import type { Rule } from './rules/schema.ts';
import type { Store } from './store/db.ts';
import type { BotHandlers } from './telegram/bot.ts';

export interface Link { connected: boolean; since: number; detail?: string }

export function findRules(rules: Rule[], query: string): Rule[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = rules.filter((r) => r.id === q || r.name.toLowerCase() === q);
  return exact.length ? exact : rules.filter((r) => r.id.includes(q) || r.name.toLowerCase().includes(q));
}

export function createHandlers(engine: Engine, store: Store, opts: { now: () => number; timezone: string; link: () => Link }): BotHandlers {
  const list = () => engine.rules.map((r) => `${r.id} — ${r.name}`).join('\n');
  const whoIs = (chatId: number) => Object.values(engine.people()).find((p) => p.telegram === chatId)?.name ?? 'Telegram';
  return {
    rules() {
      if (!engine.rules.length) return 'Правил нет: положи карточки в папку rules.';
      return engine.rules.map((r) => {
        const sw = engine.ruleSwitch(r.id);
        if (!sw.enabled) return `⏻ выключено — ${r.name} (${r.id})`;
        if (sw.pausedUntil) return `⏸ на паузе ещё ${formatDuration(sw.pausedUntil - opts.now())} — ${r.name} (${r.id})`;
        const snap = engine.snapshot(r);
        const rt = engine.runtime(r.id);
        const state = rt?.active ? '✓ активно' : snap.overall === 'waiting' ? '⏳ ждёт' : snap.overall === 'unknown' ? '? не хватает данных' : '· не выполняется';
        return `${state} — ${r.name} (${r.id})`;
      }).join('\n');
    },
    why(query) {
      if (!query.trim()) return `Какое правило? Например: /why ${engine.rules[0]?.id ?? 'heat-leak'}\n${list()}`;
      const found = findRules(engine.rules, query);
      if (!found.length) return `Не нашёл правило «${query}». Есть:\n${list()}`;
      if (found.length > 1) return `Подходит несколько:\n${found.map((r) => `${r.id} — ${r.name}`).join('\n')}`;
      return explainRule(found[0]!, engine, store, opts.now(), opts.timezone);
    },
    status() {
      const link = opts.link();
      const lines = [link.connected ? 'CUBE: на связи.' : `CUBE: нет связи${link.detail ? ` (${link.detail})` : ''}.`];
      const vars = engine.varList();
      if (vars.length) lines.push('Переменные:', ...vars.map((v) => `  ${v.label} (${v.name}): ${formatValue(undefined, v.value)}`));
      const devices = engine.deviceList();
      const offline = devices.filter((d) => !d.online);
      lines.push(`Устройств: ${devices.length}${offline.length ? `, не в сети: ${offline.map((d) => d.name).join(', ')}` : ', все в сети'}.`);
      return lines.join('\n');
    },
    devices() {
      const devices = engine.deviceList();
      if (!devices.length) return 'CUBE не вернула ни одного устройства.';
      return devices.map((d) => {
        const attrs = Object.entries(d.attrs).filter(([k]) => !['rssi', 'lqi', 'contact'].includes(k)).slice(0, 6)
          .map(([k, v]) => `${k}=${formatValue(k, v)}`).join(', ');
        return `${d.online ? '' : '(не в сети) '}${d.name} [${d.category}]${attrs ? ` — ${attrs}` : ''}`;
      }).join('\n');
    },
    async setVar(name: string, value: Value) {
      await engine.setVar(name, value);
      return `${engine.varLabel(name)} (${name}) = ${engine.varText(name, value) ?? formatValue(undefined, value)}`;
    },
    scenes() {
      if (!engine.scenes.length) return 'Сцен нет: положи карточки в папку scenes.';
      return ['Сцены:', ...engine.scenes.map((x) => `/scene ${x.id} — ${x.name}`)].join('\n');
    },
    async scene(query: string, chatId: number) {
      const scene = engine.findScene(query);
      if (!scene) return `Не нашёл сцену «${query}».\n${this.scenes()}`;
      const results = await engine.runScene(scene.id, whoIs(chatId));
      const lines = results.map((r) => `${r.skipped ? '·' : r.ok ? '✓' : '✗'} ${r.action}${r.skipped ? ' — пропущено' : r.ok ? '' : ` — ${r.error}`}`);
      return [`Сцена «${scene.name}»:`, ...lines].join('\n');
    },
    async mode(value: string, chatId: number) {
      const mode = engine.varList().find((v) => v.name === 'mode');
      if (!mode?.options) return 'Режимов нет: добавь в config.yaml переменную mode с options.';
      const list = mode.options.map((o) => `${o.value} — ${o.label}`).join('\n');
      if (!value.trim()) return `Режим: ${engine.varText('mode', mode.value) ?? mode.value}.\nМожно:\n${list}`;
      const q = value.trim().toLowerCase();
      const option = mode.options.find((o) => o.value === q || o.label.toLowerCase() === q);
      if (!option) return `Нет такого режима. Можно:\n${list}`;
      await engine.setVar('mode', option.value);
      store.addEvent(opts.now(), 'manual', 'mode', `${whoIs(chatId)}: режим — ${option.label}`);
      return `Режим: ${option.label}`;
    },
    async presence(chatId: number, home: boolean) {
      const entry = Object.entries(engine.people()).find(([, p]) => p.telegram === chatId);
      if (!entry) return `Этот чат не привязан к человеку. Добавь в config.yaml: people: { <id>: { name: <Имя>, telegram: ${chatId} } }`;
      const [id, person] = entry;
      await engine.setVar(homeVar(id), home);
      store.addEvent(opts.now(), 'manual', homeVar(id), `${person.name}: ${home ? 'дома' : 'ушёл'} (Telegram)`);
      return `${person.name}: ${home ? 'дома' : 'не дома'}`;
    },
  };
}
