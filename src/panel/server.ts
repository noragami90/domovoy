// Web panel: static page + JSON API + an event stream that tells the page to refresh.
// Public: the page itself, GET /api/session, POST /api/login. Everything else needs a session.
//   GET  /api/state                 house summary, rules, devices, variables
//   GET  /api/why/:rule             the same explanation as /why in Telegram
//   GET  /api/timeline?kind&ref&before
//   GET  /api/history?device&attr&range=1h|24h|7d
//   GET  /api/events                SSE: "change" whenever something changed
//   POST /api/vars/:name            {"value": true}
//   POST /api/devices/:id/set       {"attr": "power", "value": "on"}
//   POST /api/rules/:id/enabled     {"enabled": false}
//   POST /api/rules/:id/pause       {"minutes": 60} or {"minutes": null} to resume
//   POST /api/scenes/:id/run         start a scene
//   POST /api/presence/:person      {"home": true} — also with "Authorization: Bearer <PRESENCE_TOKEN>" (iPhone Shortcuts)
//   GET  /api/library               rule and scene files for the editor, plus devices / variables for hints
//   POST /api/library/check         {"kind": "rule", "card": {...}} or {"yaml": "..."} — issues and warnings
//   POST /api/library/save          same body + "originalId" when editing; reloads the engine
//   POST /api/library/delete        {"kind": "rule", "id": "..."} — the file goes to .trash
//   GET  /api/templates, POST /api/templates/build {"id": "...", "params": {...}}
//   POST /api/library/replay        card body + {"hours": 24 | 168} — "what if" over recorded history
//   GET  /api/ai, POST /api/ai/draft {"text": "..."} — a card drafted by Claude (needs ANTHROPIC_API_KEY)
//   GET  /api/notifications?filter=all|urgent|pending&before — journal + settings
//   POST /api/notifications/:id/ack, /api/notifications/settings {...}, /api/notifications/test {"urgent": true}
//   GET  /api/devices/:id           device page: values, health, rules and scenes using it, recent events
//   POST /api/sim/state, /api/sim/seed — only when CUBE is the simulator
// POSTs must be JSON from this same page (Origin), so another site cannot press buttons.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Link } from '../app.ts';
import { simPayload } from '../cube/sim-payload.ts';
import type { Value } from '../cube/normalize.ts';
import type { Engine } from '../engine/engine.ts';
import { homeVar } from '../engine/vars.ts';
import { explainRule, formatValue } from '../explain/explain.ts';
import type { EventKind, Store } from '../store/db.ts';
import type { CardKind, Library } from '../rules/library.ts';
import { buildFromTemplate, paramOptions, TEMPLATES } from '../rules/templates.ts';
import type { Rule } from '../rules/schema.ts';
import type { ReplayResult } from '../engine/replay.ts';
import { DraftError, type Drafter } from '../ai/draft.ts';
import type { HouseContext } from '../ai/prompt.ts';
import { buildDiagram } from './diagram.ts';
import { HttpError, json, readJson, sameOrigin, SECURITY } from './http.ts';
import { systemRoute } from './system-routes.ts';
import type { SystemControl } from '../system/control.ts';
import { devicePage } from './device.ts';
import type { Health } from '../notify/health.ts';
import type { Notifications } from '../notify/notifications.ts';
import { loadSettings, saveSettings } from '../notify/settings.ts';
import { COOKIE, PanelAuth, parseCookies } from './auth.ts';
import { history, panelState } from './state.ts';

export interface PanelOptions {
  engine: Engine;
  store: Store;
  port: number;
  host?: string;
  timezone: string;
  password: string;
  presenceToken?: string;
  library?: Library;
  link: () => Link;
  simulator: () => boolean;
  cubeUrl: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  replay?: (rule: Rule, hours: number) => Promise<ReplayResult>;
  ai?: { drafter: Drafter | null; house: () => HouseContext };
  notifications?: Notifications;
  health?: Health;
  telegram?: boolean; // is there a bot to deliver notifications
  system?: SystemControl;
  rooms?: () => string[];
}

export interface Panel { url: string; changed(): void; close(): Promise<void> }

const STATIC: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/panel.css': ['panel.css', 'text/css; charset=utf-8'],
  '/theme.css': ['theme.css', 'text/css; charset=utf-8'],
  '/fonts.css': ['fonts.css', 'text/css; charset=utf-8'],
  '/panel.js': ['panel.js', 'text/javascript; charset=utf-8'],
  '/chart.js': ['chart.js', 'text/javascript; charset=utf-8'],
  '/timeline.js': ['timeline.js', 'text/javascript; charset=utf-8'],
  '/dom.js': ['dom.js', 'text/javascript; charset=utf-8'],
  '/editor.js': ['editor.js', 'text/javascript; charset=utf-8'],
  '/form.js': ['form.js', 'text/javascript; charset=utf-8'],
  '/diagram.js': ['diagram.js', 'text/javascript; charset=utf-8'],
  '/whatif.js': ['whatif.js', 'text/javascript; charset=utf-8'],
  '/ai.js': ['ai.js', 'text/javascript; charset=utf-8'],
  '/notifications.js': ['notifications.js', 'text/javascript; charset=utf-8'],
  '/device.js': ['device.js', 'text/javascript; charset=utf-8'],
  '/system.js': ['system.js', 'text/javascript; charset=utf-8'],
  '/tablet.js': ['tablet.js', 'text/javascript; charset=utf-8'],
  '/tiles.js': ['tiles.js', 'text/javascript; charset=utf-8'],
  '/icons.js': ['icons.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/apple-touch-icon.png': ['icon-180.png', 'image/png'], // iOS asks for it at the root by itself
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const RANGES: Record<string, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 };
const KINDS: EventKind[] = ['device', 'rule', 'manual', 'system'];
const WHO = 'Панель';

const isScalar = (v: unknown): v is Value => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const sha = (s: string) => createHash('sha256').update(s).digest();

// "Authorization: Bearer <token>" for presence from phones; compared in constant time.
function bearerOk(req: IncomingMessage, token: string | undefined): boolean {
  const header = req.headers.authorization ?? '';
  return !!token && header.startsWith('Bearer ') && timingSafeEqual(sha(header.slice(7)), sha(token));
}

export function startPanel(o: PanelOptions): Promise<Panel> {
  const files: Record<string, { body: Buffer; type: string; cache?: string }> = Object.fromEntries(Object.entries(STATIC).map(([path, [file, type]]) =>
    [path, { body: readFileSync(new URL(`./static/${file}`, import.meta.url)), type }]));
  // Fonts live in the panel itself (no Google): every file in static/fonts, cached by the browser for a month.
  for (const file of readdirSync(new URL('./static/fonts/', import.meta.url))) {
    const type = file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.txt') ? 'text/plain; charset=utf-8' : null;
    if (type) files[`/fonts/${file}`] = { body: readFileSync(new URL(`./static/fonts/${file}`, import.meta.url)), type, cache: 'public, max-age=2592000' };
  }
  const streams = new Set<ServerResponse>();
  const now = o.now ?? Date.now;
  const fetchImpl = o.fetchImpl ?? fetch;
  const auth = new PanelAuth(o.store, o.password, now);
  const { engine, store } = o;
  let pending: NodeJS.Timeout | null = null;
  // Many changes arrive in bursts; tell the page at most every 250 ms.
  const changed = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; for (const s of streams) s.write('event: change\ndata: {}\n\n'); }, 250);
  };

  const simulator = async (device: string, state: Record<string, unknown>) => {
    const r = await fetchImpl(`${o.cubeUrl.replace(/\/+$/, '')}/sim/state`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device, state }),
    });
    const answer = (await r.json()) as { error: number; message: string };
    if (answer.error) throw new HttpError(400, `симулятор: ${answer.message}`);
  };

  async function presence(personId: string, body: Record<string, unknown>, via: string, res: ServerResponse): Promise<void> {
    const person = engine.people()[personId];
    if (!person) throw new HttpError(404, `нет человека «${personId}» в настройках`);
    if (typeof body.home !== 'boolean') throw new HttpError(400, 'home: true или false');
    await engine.setVar(homeVar(personId), body.home);
    store.addEvent(now(), 'manual', homeVar(personId), `${person.name}: ${body.home ? 'дома' : 'ушёл'} (${via})`);
    return json(res, 200, { ok: true });
  }

  const kindOf = (v: unknown): CardKind => {
    if (v !== 'rule' && v !== 'scene') throw new HttpError(400, 'kind: rule или scene');
    return v;
  };
  const draft = (body: Record<string, unknown>) => ({
    yaml: typeof body.yaml === 'string' ? body.yaml : undefined,
    card: body.card,
  });
  const lib = () => {
    if (!o.library) throw new HttpError(404, 'редактор выключен');
    return o.library;
  };

  async function postLibrary(path: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const kind = path === '/api/templates/build' ? 'rule' : kindOf(body.kind);
    const originalId = typeof body.originalId === 'string' ? body.originalId : undefined;
    if (path === '/api/library/check') {
      const { card, ...checked } = lib().check(kind, draft(body), originalId);
      return json(res, 200, { ...checked, diagram: card ? buildDiagram(kind, card, engine) : null });
    }
    if (path === '/api/library/replay') {
      if (kind !== 'rule') throw new HttpError(400, '«что было бы» — только для правил');
      if (!o.replay) throw new HttpError(404, 'прогон выключен');
      const { card } = lib().check(kind, draft(body), originalId);
      if (!card) throw new HttpError(400, 'сначала исправь карточку — она не проходит проверку');
      return json(res, 200, await o.replay(card as Rule, body.hours === 168 ? 168 : 24));
    }
    if (path === '/api/library/save') {
      const saved = await lib().save(kind, draft(body), originalId);
      if (kind === 'rule') engine.resetEnabledSwitch(saved.id);
      const name = (kind === 'rule' ? engine.rules : engine.scenes).find((x) => x.id === saved.id)?.name ?? saved.id;
      store.addEvent(now(), 'manual', saved.id, `${WHO}: ${kind === 'rule' ? 'правило' : 'сцена'} «${name}» ${saved.created ? 'создано' : 'сохранено'}`);
      return json(res, 200, { ok: true, ...saved });
    }
    if (path === '/api/library/delete') {
      if (typeof body.id !== 'string') throw new HttpError(400, 'нужен id');
      await lib().remove(kind, body.id);
      store.addEvent(now(), 'manual', body.id, `${WHO}: ${kind === 'rule' ? 'правило' : 'сцена'} «${body.id}» удалено (в корзину .trash)`);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/templates/build') {
      if (typeof body.id !== 'string' || !body.params || typeof body.params !== 'object') throw new HttpError(400, 'нужны id и params');
      const t = TEMPLATES.find((x) => x.id === body.id);
      const card = buildFromTemplate(body.id, body.params as Record<string, string>, engine.deviceList());
      const checked = lib().check(t?.kind ?? 'rule', { card });
      return json(res, 200, { kind: t?.kind ?? 'rule', card, yaml: checked.yaml, issues: checked.issues, warnings: checked.warnings });
    }
    throw new HttpError(404, 'не найдено');
  }

  async function post(path: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    let m: RegExpExecArray | null;
    if (path.startsWith('/api/library/') || path === '/api/templates/build') return postLibrary(path, body, res);
    if (path === '/api/ai/draft') return postDraft(body, res);
    if (path.startsWith('/api/notifications/')) return postNotifications(path, body, res);
    if ((m = /^\/api\/vars\/([^/]+)$/.exec(path))) {
      if (!isScalar(body.value)) throw new HttpError(400, 'value: строка, число или да/нет');
      const name = decodeURIComponent(m[1]!);
      await engine.setVar(name, body.value);
      store.addEvent(now(), 'manual', name, `${WHO}: ${engine.varLabel(name)} — ${engine.varText(name, body.value) ?? formatValue(undefined, body.value)}`);
      return json(res, 200, { ok: true });
    }
    if ((m = /^\/api\/scenes\/([^/]+)\/run$/.exec(path))) {
      const results = await engine.runScene(decodeURIComponent(m[1]!), WHO);
      return json(res, 200, { ok: results.every((r) => r.ok), results });
    }
    if ((m = /^\/api\/presence\/([^/]+)$/.exec(path))) return presence(decodeURIComponent(m[1]!), body, WHO, res);
    if ((m = /^\/api\/devices\/([^/]+)\/set$/.exec(path))) {
      if (typeof body.attr !== 'string' || !isScalar(body.value)) throw new HttpError(400, 'нужны attr и value');
      await engine.control(decodeURIComponent(m[1]!), body.attr, body.value, WHO);
      return json(res, 200, { ok: true });
    }
    if ((m = /^\/api\/rules\/([^/]+)\/enabled$/.exec(path))) {
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled: true или false');
      await engine.setRuleEnabled(decodeURIComponent(m[1]!), body.enabled, WHO);
      return json(res, 200, { ok: true });
    }
    if ((m = /^\/api\/rules\/([^/]+)\/pause$/.exec(path))) {
      const minutes = body.minutes;
      if (minutes !== null && (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 1440)) {
        throw new HttpError(400, 'minutes: от 1 до 10080 или null');
      }
      await engine.pauseRule(decodeURIComponent(m[1]!), minutes === null ? null : now() + minutes * 60_000, WHO);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/sim/state' || path === '/api/sim/seed') {
      if (!o.simulator()) throw new HttpError(409, 'CUBE — не симулятор: кнопки симулятора выключены');
      if (typeof body.device !== 'string' || typeof body.attr !== 'string') throw new HttpError(400, 'нужны device и attr');
      if (path === '/api/sim/state') {
        if (!isScalar(body.value)) throw new HttpError(400, 'нужно value');
        await simulator(body.device, simPayload(body.attr, body.value));
        return json(res, 200, { ok: true });
      }
      // A day of ordinary readings around the current value, so baseline rules and charts work right away.
      const dev = engine.deviceList().find((d) => d.name === body.device || d.id === body.device);
      const current = dev?.attrs[body.attr];
      if (!dev || typeof current !== 'number') throw new HttpError(400, 'у устройства нет такого числового значения');
      const end = now() - 35 * 60_000;
      for (let ts = end - 86_400_000, i = 0; ts <= end; ts += 10 * 60_000, i++) {
        store.addSample(dev.id, body.attr, ts, Math.round((current + Math.sin(i / 7) * Math.max(0.5, Math.abs(current) * 0.03)) * 10) / 10);
      }
      store.addEvent(now(), 'manual', dev.id, `${WHO}: симулятор — заполнены сутки истории «${body.attr}» для ${dev.name}`);
      await engine.start();
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'не найдено');
  }

  async function postNotifications(path: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const n = o.notifications;
    if (!n) throw new HttpError(404, 'уведомления выключены');
    if (path === '/api/notifications/settings') {
      try { saveSettings(store, body); } catch (err) { throw new HttpError(400, (err as Error).message); }
      store.addEvent(now(), 'manual', 'notifications', `${WHO}: настройки уведомлений изменены`);
      changed();
      return json(res, 200, { ok: true, settings: loadSettings(store) });
    }
    if (path === '/api/notifications/test') {
      const urgent = body.urgent === true;
      const id = await n.send(urgent ? 'Проверка срочного уведомления — нажми «Принял»' : 'Проверка уведомлений из панели', { source: WHO, urgent });
      return json(res, 200, { ok: true, id });
    }
    const m = /^\/api\/notifications\/(\d+)\/ack$/.exec(path);
    if (m) return json(res, 200, { ok: await n.ack(Number(m[1]), WHO) });
    throw new HttpError(404, 'не найдено');
  }

  // One draft at a time: each one is a paid Claude request.
  let drafting = false;
  async function postDraft(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const drafter = o.ai?.drafter;
    if (!o.ai || !drafter) throw new HttpError(409, 'ИИ выключен: нет ANTHROPIC_API_KEY');
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length < 5 || text.length > 1000) throw new HttpError(400, 'опиши правило словами: от 5 до 1000 знаков');
    if (drafting) throw new HttpError(429, 'Claude уже пишет черновик — подожди');
    drafting = true;
    try {
      const result = await drafter.draft(text, o.ai.house());
      const u = result.usage;
      o.log?.(`Claude: черновик «${text.slice(0, 60)}» — попыток ${result.attempts}, вход ${u.input + u.cacheRead + u.cacheWrite} (кэш: прочитано ${u.cacheRead}, записано ${u.cacheWrite}), выход ${u.output}`);
      return json(res, 200, result);
    } catch (err) {
      if (err instanceof DraftError) throw new HttpError(502, err.message);
      throw err;
    } finally { drafting = false; }
  }

  function get(path: string, url: URL, res: ServerResponse): void {
    if (path === '/api/state') {
      return json(res, 200, panelState(engine, store, o.link(), o.simulator(), { health: o.health, notifications: o.notifications, batteryBelow: loadSettings(store).battery.below, rooms: o.rooms?.() }));
    }
    if (path === '/api/notifications') {
      const f = url.searchParams.get('filter');
      const filter = f === 'urgent' || f === 'pending' ? f : 'all';
      const items = store.notifications({ filter, before: Number(url.searchParams.get('before')) || undefined, limit: 50 });
      return json(res, 200, { items, nextBefore: items.length === 50 ? items.at(-1)!.id : null, settings: loadSettings(store), telegram: !!o.telegram });
    }
    if (path.startsWith('/api/devices/')) {
      const page = devicePage(engine, store, o.health, decodeURIComponent(path.slice('/api/devices/'.length)), o.rooms?.());
      if (!page) throw new HttpError(404, 'нет такого устройства');
      return json(res, 200, page);
    }
    if (path === '/api/ai') {
      const d = o.ai?.drafter;
      return json(res, 200, d ? { enabled: true, model: d.model } : { enabled: false, hint: 'Добавь ANTHROPIC_API_KEY в файл .env рядом с config.yaml и перезапусти движок.' });
    }
    if (path === '/api/library') {
      const files = lib().files();
      return json(res, 200, {
        rules: files.filter((f) => f.kind === 'rule'),
        scenes: files.filter((f) => f.kind === 'scene'),
        errors: lib().errors,
        context: {
          // name — what cards store (the CUBE name); label — what the panel shows.
          devices: engine.deviceList().map((d) => ({ id: d.id, name: d.cubeName, label: d.name, room: d.room, attrs: Object.keys(d.attrs).filter((a) => !['rssi', 'lqi', 'contact', 'electric-power'].includes(a)) })),
          vars: engine.varList(),
          scenes: engine.scenes.map((x) => ({ id: x.id, name: x.name })),
        },
      });
    }
    if (path === '/api/templates') {
      const devices = engine.deviceList();
      return json(res, 200, TEMPLATES.map((t) => ({
        id: t.id, name: t.name, description: t.description, kind: t.kind,
        params: t.params.map((p) => ({ key: p.key, label: p.label, type: p.type, default: p.default, options: paramOptions(p, devices) })),
      })));
    }
    if (path.startsWith('/api/why/')) {
      const id = decodeURIComponent(path.slice('/api/why/'.length));
      const rule = engine.rules.find((r) => r.id === id);
      if (!rule) throw new HttpError(404, `нет правила «${id}»`);
      return json(res, 200, { text: explainRule(rule, engine, store, now(), o.timezone) });
    }
    if (path === '/api/timeline') {
      const kind = url.searchParams.get('kind') as EventKind | null;
      if (kind && !KINDS.includes(kind)) throw new HttpError(400, 'kind: device, rule, manual или system');
      const before = Number(url.searchParams.get('before')) || undefined;
      const events = store.events({ kind: kind ?? undefined, ref: url.searchParams.get('ref') || undefined, before, limit: 50 });
      return json(res, 200, { events, nextBefore: events.length === 50 ? events.at(-1)!.id : null });
    }
    if (path === '/api/history') {
      const range = RANGES[url.searchParams.get('range') ?? '24h'];
      if (!range) throw new HttpError(400, 'range: 1h, 24h или 7d');
      const h = history(engine, store, url.searchParams.get('device') ?? '', url.searchParams.get('attr') ?? '', range, now());
      if (!h) throw new HttpError(404, 'нет такого устройства');
      return json(res, 200, h);
    }
    throw new HttpError(404, 'не найдено');
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://panel');
    const path = url.pathname;
    const token = parseCookies(req.headers.cookie).get(COOKIE);
    try {
      if (req.method === 'GET' && files[path]) {
        res.writeHead(200, { 'content-type': files[path].type, 'cache-control': files[path].cache ?? 'no-cache', ...SECURITY });
        return void res.end(files[path].body);
      }
      if (!path.startsWith('/api/')) throw new HttpError(404, 'не найдено');
      if (req.method === 'POST' && !sameOrigin(req)) throw new HttpError(403, 'запрос с чужой страницы');
      if (req.method === 'GET' && path === '/api/session') return json(res, 200, { authenticated: auth.valid(token) });
      if (req.method === 'POST' && path === '/api/login') {
        const body = await readJson(req);
        const result = auth.login(body.password, req.socket.remoteAddress ?? 'unknown');
        if ('error' in result) return json(res, result.status, { error: result.error });
        return json(res, 200, { ok: true }, { 'set-cookie': PanelAuth.cookie(result.token) });
      }
      if (req.method === 'POST' && path === '/api/logout') {
        auth.logout(token);
        return json(res, 200, { ok: true }, { 'set-cookie': PanelAuth.clearCookie() });
      }
      const presencePath = /^\/api\/presence\/([^/]+)$/.exec(path);
      if (req.method === 'POST' && presencePath && !auth.valid(token) && bearerOk(req, o.presenceToken)) {
        return await presence(decodeURIComponent(presencePath[1]!), await readJson(req), 'телефон', res);
      }
      if (!auth.valid(token)) throw new HttpError(401, 'нужно войти');
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...SECURITY });
        res.write(': connected\n\n');
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      if (o.system && path.startsWith('/api/system')) return await systemRoute(req, res, path, url, o.system);
      if (req.method === 'GET') return get(path, url, res);
      if (req.method === 'POST') return await post(path, await readJson(req), res);
      throw new HttpError(405, 'метод не поддерживается');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof SyntaxError ? 400 : 400;
      json(res, status, { error: (err as Error).message });
    }
  });

  const heartbeat = setInterval(() => { for (const s of streams) s.write(': ping\n\n'); }, 20_000);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host ?? '0.0.0.0', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        changed,
        close: () => new Promise((r) => {
          clearInterval(heartbeat);
          if (pending) clearTimeout(pending);
          for (const s of streams) s.end();
          server.closeAllConnections();
          server.close(() => r());
        }),
      });
    });
  });
}
