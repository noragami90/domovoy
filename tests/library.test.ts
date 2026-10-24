import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { toDevice } from '../src/cube/normalize.ts';
import { Library, toYaml } from '../src/rules/library.ts';
import { parseRule, parseScene, type Rule, type Scene } from '../src/rules/schema.ts';
import { buildFromTemplate, paramOptions, TEMPLATES } from '../src/rules/templates.ts';
import { scenarioDevices } from './helpers.ts';

const devices = scenarioDevices().map((d) => toDevice(d));
const VARS = [
  { name: 'mode', label: 'Режим', value: 'home', options: [{ value: 'home', label: 'Дома' }, { value: 'away', label: 'Ушёл' }] },
  { name: 'ac_running', label: 'Кондиционер работает', value: true },
  { name: 'anyone_home', label: 'Кто-нибудь дома', value: true, readonly: true },
];

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'domovoy-lib-'));
  const rulesDir = join(root, 'rules');
  const scenesDir = join(root, 'scenes');
  cpSync(new URL('../rules', import.meta.url).pathname, rulesDir, { recursive: true });
  cpSync(new URL('../scenes', import.meta.url).pathname, scenesDir, { recursive: true });
  const reloads: { rules: Rule[]; scenes: Scene[] }[] = [];
  const lib = new Library({
    rulesDir, scenesDir,
    context: () => ({ devices, vars: VARS, protected: ['Прихожая выключатель'] }),
    onReload: async (rules, scenes) => { reloads.push({ rules, scenes }); },
  });
  return { lib, rulesDir, scenesDir, reloads };
}

test('check: schema errors with paths, references as errors or warnings', () => {
  const { lib } = setup();
  const card = (patch: object) => ({ id: 'new', name: 'Новое', when: { all: [{ var: 'ac_running', is: true }] }, then: [{ notify: 'x' }], ...patch });
  assert.deepEqual(lib.check('rule', { card: card({}) }).issues, []);

  const bad = lib.check('rule', { card: card({ when: { all: [{ device: 'Санузел', attr: 'humidity', above: 60, for: '5 минут' }] } }) });
  assert.equal(bad.ok, false);
  assert.match(JSON.stringify(bad.issues), /when\.all\.0\.for.*Неверная длительность/);

  const refs = lib.check('rule', { card: card({
    when: { all: [{ device: 'Кухня', attr: 'humidity', above: 60 }, { device: 'Санузел', attr: 'lux', above: 1 }, { var: 'mood', is: 1 }, { var: 'mode', is: 'party' }] },
    then: [{ set: { device: 'Вытяжка', attr: 'brightness', to: 'on' } }, { set: { device: 'Прихожая выключатель', attr: 'toggle.1', to: 'on' } }, { scene: 'nope' }, { set_var: { var: 'anyone_home', to: false } }],
  }) });
  const issues = refs.issues.map((i) => `${i.path}: ${i.message}`);
  assert.ok(issues.some((t) => /when\.all\.2: нет переменной «mood»/.test(t)), issues.join('\n'));
  assert.ok(issues.some((t) => /«mode» не бывает «party»/.test(t)));
  assert.ok(issues.some((t) => /только power и toggle\.N/.test(t)));
  assert.ok(issues.some((t) => /нет сцены «nope»/.test(t)));
  assert.ok(issues.some((t) => /считается само/.test(t)));
  assert.ok(refs.warnings.some((w) => /«Кухня» сейчас нет в CUBE/.test(w)));
  assert.ok(refs.warnings.some((w) => /не присылает «lux»/.test(w)));
  assert.ok(refs.warnings.some((w) => /защищено/.test(w)));

  assert.match(lib.check('rule', { card: card({ id: 'heat-leak' }) }).issues[0]!.message, /уже занят/);
  assert.equal(lib.check('rule', { card: card({ id: 'heat-leak' }) }, 'heat-leak').ok, true, 'editing itself is fine');
  assert.match(lib.check('rule', { yaml: 'id: [' }).issues[0]!.message, /^YAML:/);
});

test('save: new file, edits keep the file, renames move the old one to .trash; reload each time', async () => {
  const { lib, rulesDir, reloads } = setup();
  const saved = await lib.save('rule', { card: { id: 'night-light', name: 'Ночник', when: { all: [{ time: { between: ['23:00', '07:00'] } }] }, then: [{ notify: 'ночь' }] } });
  assert.deepEqual(saved, { id: 'night-light', file: 'night-light.yaml', created: true });
  const text = readFileSync(join(rulesDir, 'night-light.yaml'), 'utf8');
  assert.match(text, /^id: night-light\nname: Ночник\nwhen:/, 'keys in a readable order');
  assert.ok(reloads.at(-1)!.rules.some((r) => r.id === 'night-light'));

  await lib.save('rule', { yaml: text.replace('Ночник', 'Ночник 2') }, 'night-light');
  assert.match(readFileSync(join(rulesDir, 'night-light.yaml'), 'utf8'), /Ночник 2/);

  await lib.save('rule', { yaml: text.replace('id: night-light', 'id: night-lamp') }, 'night-light');
  assert.ok(existsSync(join(rulesDir, 'night-lamp.yaml')));
  assert.ok(!existsSync(join(rulesDir, 'night-light.yaml')));
  assert.ok(readdirSync(join(rulesDir, '.trash')).some((f) => f.startsWith('night-light-')));
  await assert.rejects(lib.save('rule', { card: { id: 'x', name: 'x', when: { all: [] }, then: [] } }), /хотя бы одно условие/);
});

test('a broken file keeps the last good version running; delete goes to .trash', async () => {
  const { lib, rulesDir, reloads } = setup();
  lib.load();
  writeFileSync(join(rulesDir, 'heat-leak.yaml'), 'id: heat-leak\nname: [сломано\n');
  await lib.reload();
  assert.ok(reloads.at(-1)!.rules.some((r) => r.id === 'heat-leak'), 'still running');
  assert.equal(lib.errors[0]!.file, 'heat-leak.yaml');
  assert.equal(lib.files('rule').find((f) => f.file === 'heat-leak.yaml')!.error !== undefined, true);

  await lib.remove('rule', 'garland');
  assert.ok(!reloads.at(-1)!.rules.some((r) => r.id === 'garland'));
  assert.ok(readdirSync(join(rulesDir, '.trash')).some((f) => f.startsWith('garland-')));
  await assert.rejects(lib.remove('rule', 'garland'), /нет правила/);
});

test('editing a file by hand is picked up', async () => {
  const { lib, scenesDir, reloads } = setup();
  lib.load();
  lib.watch();
  try {
    await new Promise((r) => setTimeout(r, 250)); // macOS FSEvents can miss a write made right after watch() starts
    writeFileSync(join(scenesDir, 'movie.yaml'), 'id: movie\nname: Кино\ndo:\n  - all_off: {}\n');
    for (let i = 0; i < 60 &&!reloads.at(-1)?.scenes.some((s) => s.id === 'movie'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(reloads.at(-1)?.scenes.some((s) => s.id === 'movie'));
  } finally { lib.close(); }
});

test('toYaml orders keys and every template builds a valid card for the simulator', () => {
  assert.equal(toYaml('scene', { do: [{ all_off: {} }], name: 'N', id: 'n' }), 'id: n\nname: N\ndo:\n  - all_off: {}\n');
  for (const t of TEMPLATES) {
    const params: Record<string, string> = {};
    for (const p of t.params) {
      const opts = paramOptions(p, devices);
      params[p.key] = opts[0]?.value ?? String(p.default ?? '');
    }
    if (t.params.some((p) => (p.type === 'sensor' || p.type === 'switch') && !params[p.key])) continue; // no such device in the simulator
    const card = buildFromTemplate(t.id, params, devices);
    if (t.kind === 'scene') parseScene(card, t.id); else parseRule(card, t.id);
  }
  assert.deepEqual(paramOptions({ key: 'x', label: 'x', type: 'switch' }, devices).map((o) => o.value),
    ['Вытяжка|power', 'Прихожая выключатель|toggle.1', 'Гирлянда лоджии|power']);
  assert.throws(() => buildFromTemplate('humidity-fan', { fan: 'Вытяжка|power' }, devices), /не заполнено: Датчик влажности/);
});
