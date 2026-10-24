import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Drafter } from '../src/ai/draft.ts';
import { houseText, type HouseContext } from '../src/ai/prompt.ts';
import { toDevice } from '../src/cube/normalize.ts';
import { Library } from '../src/rules/library.ts';
import { scenarioDevices } from './helpers.ts';

const devices = scenarioDevices().map((d) => toDevice(d));
const VARS = [
  { name: 'mode', label: 'Режим', value: 'home', options: [{ value: 'home', label: 'Дома' }, { value: 'away', label: 'Ушёл' }] },
  { name: 'ac_running', label: 'Кондиционер работает', value: true },
];
const house: HouseContext = {
  devices, vars: VARS, scenes: [{ id: 'away', name: 'Ушёл' }], rules: [{ id: 'heat-leak', name: 'Утечка тепла' }],
  protected: ['Прихожая выключатель'], timezone: 'Asia/Tbilisi', now: Date.UTC(2026, 9, 22, 18, 0),
};

function library() {
  const root = mkdtempSync(join(tmpdir(), 'domovoy-ai-'));
  cpSync(new URL('../rules', import.meta.url).pathname, join(root, 'rules'), { recursive: true });
  cpSync(new URL('../scenes', import.meta.url).pathname, join(root, 'scenes'), { recursive: true });
  return new Library({
    rulesDir: join(root, 'rules'), scenesDir: join(root, 'scenes'),
    context: () => ({ devices, vars: VARS, protected: ['Прихожая выключатель'] }), onReload: async () => {},
  });
}

// A stand-in for the Messages API: answers from a script and remembers what it was asked.
async function fakeClaude(answers: ({ status?: number; body: unknown })[]) {
  const seen: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({ headers: req.headers, body: JSON.parse(raw) });
    const a = answers.shift() ?? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'no more answers' } } };
    res.writeHead(a.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const message = (answer: object, stop = 'end_turn') => ({
  body: {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, stop_sequence: null,
    content: [{ type: 'text', text: JSON.stringify(answer) }],
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});

const fanYaml = (forValue: string) => `id: bath-fan-2
name: Вытяжка после душа
when:
  all:
    - device: Санузел
      attr: humidity
      above: 70
      for: ${forValue}
then:
  - set: { device: Вытяжка, attr: power, to: "on" }
otherwise:
  after: 10m
  do:
    - set: { device: Вытяжка, attr: power, to: "off" }
`;

test('draft: structured request with fallback and cache; a failed check goes back to Claude once', async () => {
  const claude = await fakeClaude([
    message({ kind: 'rule', yaml: fanYaml('2 минуты'), summary: 'Вытяжка после душа', assumptions: ['порог 70%'], question: '' }),
    message({ kind: 'rule', yaml: fanYaml('2m'), summary: 'Вытяжка включается после душа и выключается через 10 минут', assumptions: ['порог 70%'], question: '' }),
  ]);
  try {
    const drafter = new Drafter({ apiKey: 'test-key', model: 'claude-opus-5-5', effort: 'medium', baseURL: claude.url, check: (k, y) => library().check(k, { yaml: y }) });
    const r = await drafter.draft('когда в ванной сыро — включи вытяжку, потом выключи', house);
    assert.equal(r.attempts, 2);
    assert.equal(r.check?.ok, true);
    assert.equal((r.card as { id: string }).id, 'bath-fan-2');
    assert.deepEqual(r.assumptions, ['порог 70%']);
    assert.deepEqual(r.usage, { input: 2400, output: 600, cacheRead: 0, cacheWrite: 0 });

    const [first, second] = claude.seen;
    assert.equal(first!.headers.authorization, 'Bearer test-key');
    assert.match(String(first!.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(first!.body.model, 'claude-opus-5-5');
    assert.equal(first!.body.fallbacks, 'default');
    assert.deepEqual((first!.body.output_config as { effort: string }).effort, 'medium');
    assert.equal((first!.body.output_config as { format: { type: string } }).format.type, 'json_schema');
    assert.deepEqual((first!.body.system as { cache_control: unknown }[])[0]!.cache_control, { type: 'ephemeral' });
    const firstUser = (first!.body.messages as { content: string }[])[0]!.content;
    assert.match(firstUser, /Вытяжка \[switch\]: power = "off" \(выключено\) — можно управлять: power/);
    assert.match(firstUser, /Прихожая выключатель .*ЗАЩИЩЕНО/);
    assert.match(firstUser, /Просьба: когда в ванной сыро/);

    const msgs = second!.body.messages as { role: string; content: unknown }[];
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user'], 'append-only history');
    assert.match(String(msgs[2]!.content), /Неверная длительность/);
  } finally { await claude.close(); }
});

test('draft: a question instead of a card, refusals and a bad key become readable errors', async () => {
  const claude = await fakeClaude([
    message({ kind: 'rule', yaml: '', summary: '', assumptions: [], question: 'В доме нет датчика движения — добавь его в CUBE.' }),
    message({ kind: 'rule', yaml: '', summary: '', assumptions: [], question: '' }, 'refusal'),
    { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
  ]);
  try {
    const drafter = new Drafter({ apiKey: 'test-key', model: 'claude-opus-5-5', effort: 'medium', baseURL: claude.url, check: (k, y) => library().check(k, { yaml: y }) });
    const q = await drafter.draft('включай свет, когда я захожу', house);
    assert.equal(q.question, 'В доме нет датчика движения — добавь его в CUBE.');
    assert.equal(q.card, null);
    await assert.rejects(drafter.draft('что-то', house), /отказался/);
    await assert.rejects(drafter.draft('что-то', house), /не принял ключ/);
  } finally { await claude.close(); }
});

test('house text: values in words, what can be switched, read-only variables', () => {
  const text = houseText({ ...house, vars: [...VARS, { name: 'anyone_home', label: 'Кто-нибудь дома', value: true, readonly: true }] });
  assert.match(text, /Дверь лоджии \[contactSensor\]: .*open = false \(закрыта\)/);
  const named = houseText({ ...house, devices: devices.map((d) => (d.name === 'Прихожая выключатель' ? { ...d, name: 'Свет в прихожей', room: 'Прихожая' } : d)) });
  assert.match(named, /- Прихожая выключатель \(в панели «Свет в прихожей», комната Прихожая\) \[switch\]/, 'cards keep the CUBE name; the own name and room help Claude');
  assert.match(text, /mode — Режим: home \(Дома\) \| away \(Ушёл\); сейчас "home"/);
  assert.match(text, /anyone_home .* — только читать/);
  assert.match(text, /Сцены: away \(Ушёл\)/);
});

test('draft: a key without a workspace — the header is sent when configured, and the error says what to do', async () => {
  const notScoped = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.' } } };
  const claude = await fakeClaude([notScoped, message({ kind: 'rule', yaml: '', summary: '', assumptions: [], question: 'нужен датчик' })]);
  try {
    const plain = new Drafter({ apiKey: 'test-key', model: 'claude-opus-5-5', effort: 'medium', baseURL: claude.url, check: (k, y) => library().check(k, { yaml: y }) });
    await assert.rejects(plain.draft('что-то', house), /ANTHROPIC_WORKSPACE_ID/);
    const scoped = new Drafter({ apiKey: 'test-key', workspaceId: 'wrkspc_test', model: 'claude-opus-5-5', effort: 'medium', baseURL: claude.url, check: (k, y) => library().check(k, { yaml: y }) });
    assert.equal((await scoped.draft('что-то', house)).question, 'нужен датчик');
    assert.equal(claude.seen[0]!.headers['anthropic-workspace-id'], undefined);
    assert.equal(claude.seen[1]!.headers['anthropic-workspace-id'], 'wrkspc_test');
  } finally { await claude.close(); }
});
