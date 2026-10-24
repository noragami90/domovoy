// Editor tab: list of rule and scene files, a form or YAML for the selected card, live checks,
// saving without a restart, deleting into .trash, and new cards from templates.
import { api, fill, h } from './dom.js';
import { renderForm } from './form.js';
import { renderDiagram } from './diagram.js';
import { createWhatIf } from './whatif.js';
import { showAi, tokens } from './ai.js';

const EMPTY = {
  rule: () => ({ id: '', name: '', when: { all: [] }, then: [] }),
  scene: () => ({ id: '', name: '', do: [] }),
};
const KIND_NAME = { rule: 'правило', scene: 'сцена' };

// "when.all.0.for" → "Условие 1 → держится": the check speaks in form terms, the raw path stays in the tooltip.
const KEY = {
  name: 'Название', description: 'Описание', cooldown: 'Пауза между срабатываниями', enabled: 'Включено', otherwise: 'Иначе', then: 'Тогда', do: 'действия',
  for: 'держится', after: 'через', days: 'дни', device: 'устройство', attr: 'что', var: 'переменная', is: 'значение',
  above: 'выше', below: 'ниже', to: 'значение', notify: 'текст', scene: 'сцена', above_baseline: 'выше обычного',
};
export function pathLabel(path) {
  const parts = path.split('.');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const n = /^\d+$/.test(parts[i + 1] ?? '') ? Number(parts[i + 1]) + 1 : null;
    if (n && (p === 'all' || p === 'any' || p === 'if')) { out.push(`условие ${n}`); i++; }
    else if (n && (p === 'then' || p === 'do')) { out.push(`действие ${n}`); i++; }
    else if (n && p === 'between') { out.push(n === 1 ? 'с' : 'до'); i++; }
    else if (['when', 'set', 'set_var', 'time'].includes(p)) continue; // wrapper keys the form does not show
    else out.push(/^\d+$/.test(p) ? `№${Number(p) + 1}` : KEY[p] ?? p);
  }
  const text = out.join(' → ');
  return /^[а-яё]/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
const humanWarning = (w) => w.replace(/^((?:when|then|do|otherwise)[\w.]*): /, (_, p) => `${pathLabel(p)}: `);

export function createEditor(root, { onError, toast }) {
  let lib = null;      // /api/library: files + devices, variables, scenes for the form
  let cur = null;      // { kind, originalId, raw, yaml, mode, dirty, check, fileError }
  let pending = null;  // what to open after "discard changes?"
  let timer = null;
  let seq = 0;
  let deleteArmed = false;

  const listBox = h('nav', { class: 'ed-list', 'aria-label': 'Правила и сцены' });
  const pane = h('section', { class: 'ed-pane' });
  root.replaceChildren(h('div', { class: 'editor' }, listBox, pane));

  async function load() {
    try { lib = await api('/api/library'); renderList(); } catch (e) { onError(e); }
  }

  // ── list ────────────────────────────────────────────────────────────────

  function item(kind, f) {
    const active = cur && cur.kind === kind && cur.originalId && cur.originalId === f.id;
    const off = kind === 'rule' && f.raw && f.raw.enabled === false;
    return h('button', { class: `ed-item${active ? ' on' : ''}`, onclick: () => guard(() => openFile(kind, f)) },
      h('span', { class: 'ed-item-name' }, f.name ?? f.file),
      h('span', { class: 'ed-item-meta' }, f.id ?? f.file, f.error ? h('span', { class: 'ed-bad' }, 'ошибка') : null, off ? h('span', { class: 'ed-off' }, 'выкл') : null));
  }

  function renderList() {
    fill(listBox, 
      h('div', { class: 'ed-tools' },
        h('button', { class: 'btn', onclick: () => guard(() => create('rule')) }, '+ Правило'),
        h('button', { class: 'btn', onclick: () => guard(() => create('scene')) }, '+ Сцена'),
        h('button', { class: 'btn', onclick: () => guard(showTemplates) }, 'Из шаблона'),
        h('button', { class: 'btn primary', onclick: () => guard(() => openAi()) }, 'Словами')),
      h('div', { class: 'ed-group' }, 'Правила'), lib.rules.map((f) => item('rule', f)),
      h('div', { class: 'ed-group' }, 'Сцены'), lib.scenes.length ? lib.scenes.map((f) => item('scene', f)) : h('p', { class: 'empty' }, 'Сцен пока нет.'),
      lib.errors.length ? h('div', { class: 'ed-errors' }, h('div', { class: 'ed-group' }, 'Не загружены'),
        lib.errors.map((e) => h('p', {}, h('b', {}, e.file), ` — ${e.error.split('\n').slice(0, 2).join(' ')}`))) : null);
  }

  // Unsaved changes: ask inline before leaving the card.
  function guard(next) {
    if (!cur?.dirty) return next();
    pending = next;
    renderPane();
  }

  function openFile(kind, f) {
    const raw = f.raw && typeof f.raw === 'object' ? structuredClone(f.raw) : EMPTY[kind]();
    cur = { kind, originalId: f.id, raw, yaml: f.yaml, mode: f.error ? 'yaml' : 'form', dirty: false, check: null, fileError: f.error };
    afterOpen();
  }

  function create(kind, raw, extra = {}) {
    cur = { kind, originalId: null, raw: raw ?? EMPTY[kind](), yaml: '', mode: extra.mode ?? 'form', dirty: true, check: null, ai: extra.ai ?? null };
    afterOpen();
  }

  function openAi(initial = '') {
    cur = null;
    renderList();
    void showAi(pane, {
      onError, initial,
      onDraft: (res, request) => create(res.kind, res.card, { mode: 'diagram', ai: { ...res, request } }),
    });
  }

  function afterOpen() {
    pending = null;
    deleteArmed = false;
    renderList();
    renderPane();
    schedule(0);
  }

  // ── checks ──────────────────────────────────────────────────────────────

  const body = () => ({
    kind: cur.kind,
    ...(cur.mode === 'yaml' ? { yaml: cur.yaml } : { card: cur.raw }),
    ...(cur.originalId ? { originalId: cur.originalId } : {}),
  });

  function schedule(delay = 350) {
    clearTimeout(timer);
    timer = setTimeout(() => void runCheck(), delay);
  }

  async function runCheck() {
    if (!cur) return;
    const my = ++seq;
    try {
      const res = await api('/api/library/check', body());
      if (my !== seq || !cur) return;
      cur.check = res;
      if (cur.mode === 'form') cur.yaml = res.yaml;
      renderCheck();
    } catch (e) { onError(e); }
  }

  const checkBox = h('div', { class: 'ed-check', 'aria-live': 'polite' });
  const diagramBox = h('div', { class: 'ed-diagram' });
  const saveBtn = h('button', { class: 'btn primary', onclick: () => void save() }, 'Сохранить');

  function renderCheck() {
    const c = cur?.check;
    saveBtn.disabled = !c?.ok || !cur.dirty;
    if (cur?.mode === 'diagram' && c) fill(diagramBox, renderDiagram(c.diagram));
    if (!c) return fill(checkBox, h('p', { class: 'muted' }, 'Проверяю…'));
    const rows = [
      ...c.issues.map((i) => h('li', { class: 'ed-issue' }, i.path ? h('span', { class: 'ed-path', title: i.path }, pathLabel(i.path)) : null, i.message)),
      ...c.warnings.map((w) => h('li', { class: 'ed-warn' }, humanWarning(w))),
    ];
    fill(checkBox, 
      c.ok ? h('p', { class: 'ed-ok' }, cur.dirty ? '✓ Карточка в порядке — можно сохранять' : '✓ Сохранено, правило работает') : h('p', { class: 'ed-bad-title' }, 'Нужно исправить:'),
      rows.length ? h('ul', { class: 'ed-rows' }, rows) : null);
  }

  // ── saving, deleting ────────────────────────────────────────────────────

  async function save() {
    if (!cur?.check?.ok) return;
    try {
      const res = await api('/api/library/save', body());
      toast(`Сохранено: «${cur.raw.name || res.id}» — уже работает, без перезапуска`, 'notice');
      await load();
      const f = (cur.kind === 'rule' ? lib.rules : lib.scenes).find((x) => x.id === res.id);
      if (f) openFile(cur.kind, f);
    } catch (e) { onError(e); }
  }

  async function remove() {
    if (!deleteArmed) { deleteArmed = true; renderPane(); setTimeout(() => { deleteArmed = false; if (cur) renderPane(); }, 4000); return; }
    try {
      await api('/api/library/delete', { kind: cur.kind, id: cur.originalId });
      toast(`Удалено: «${cur.raw.name || cur.originalId}» — файл в папке .trash`, 'notice');
      cur = null;
      await load();
      renderPane();
    } catch (e) { onError(e); }
  }

  // ── the editing pane ────────────────────────────────────────────────────

  async function setMode(mode) {
    if (mode === cur.mode) return;
    clearTimeout(timer);
    await runCheck();
    if (cur.mode === 'yaml') {
      if (!cur.check?.raw || typeof cur.check.raw !== 'object') { toast('Сначала исправь YAML: форма и схема открываются только для разбираемой карточки'); return; }
      cur.raw = structuredClone(cur.check.raw);
    }
    if (mode === 'yaml' && cur.check?.yaml) cur.yaml = cur.check.yaml;
    cur.mode = mode;
    renderPane();
    schedule(0);
  }

  function renderPane() {
    if (pending) {
      return fill(pane, h('div', { class: 'card ed-confirm' },
        h('p', {}, 'Есть несохранённые изменения.'),
        h('div', { class: 'ed-actions' },
          h('button', { class: 'btn', onclick: () => { pending = null; renderPane(); } }, 'Остаться'),
          h('button', { class: 'btn danger', onclick: () => { const next = pending; pending = null; cur = null; next(); } }, 'Выбросить изменения'))));
    }
    if (!cur) {
      return fill(pane, h('div', { class: 'ed-empty' },
        h('p', {}, 'Выбери правило или сцену в списке, создай новое — или начни с шаблона.'),
        h('p', { class: 'muted' }, 'Сохранённое начинает работать сразу, без перезапуска. Удалённое уходит в папку .trash.')));
    }
    const title = cur.originalId ? (cur.raw.name || cur.originalId) : `Новое: ${KIND_NAME[cur.kind]}`;
    const tabs = h('div', { class: 'segmented' },
      [['form', 'Форма'], ['diagram', 'Схема'], ['yaml', 'YAML']].map(([m, l]) => h('button', { class: `seg${cur.mode === m ? ' on' : ''}`, onclick: () => void setMode(m) }, l)));
    const actions = h('div', { class: 'ed-actions' }, tabs, saveBtn,
      cur.originalId ? h('button', { class: `btn ${deleteArmed ? 'danger' : ''}`, onclick: () => void remove() }, deleteArmed ? 'Точно удалить?' : 'Удалить') : null);
    let editorBody;
    if (cur.mode === 'yaml') {
      editorBody = h('textarea', { class: 'ed-yaml', spellcheck: 'false', 'aria-label': 'YAML карточки', oninput: (e) => { cur.yaml = e.target.value; cur.dirty = true; schedule(); } });
      editorBody.value = cur.yaml;
    } else if (cur.mode === 'diagram') {
      editorBody = diagramBox;
      fill(diagramBox, cur.check ? renderDiagram(cur.check.diagram) : h('p', { class: 'muted' }, 'Рисую схему…'));
    } else {
      editorBody = h('div', { class: 'ed-form' });
      renderForm(editorBody, cur.kind, cur.raw, lib.context, !cur.originalId, () => { cur.dirty = true; schedule(); });
    }
    fill(pane, 
      h('div', { class: 'ed-head' }, h('h2', { class: 'ed-title' }, title), actions),
      cur.fileError ? h('p', { class: 'ed-issue' }, 'Файл сейчас с ошибкой — работает прежняя версия. Исправь и сохрани.') : null,
      cur.ai ? aiBanner(cur.ai) : null,
      editorBody, checkBox,
      cur.kind === 'rule' ? whatIf().root : null);
    renderCheck();
  }

  // "What if" belongs to the open card; it runs the card as it is now (form or YAML).
  function whatIf() {
    cur.whatIf ??= createWhatIf({ onError, run: (hours) => api('/api/library/replay', { ...body(), hours }) });
    return cur.whatIf;
  }

  function aiBanner(ai) {
    return h('div', { class: 'ai-banner' },
      h('p', {}, h('b', {}, 'Черновик от Claude. '), ai.summary),
      ai.assumptions.length ? h('div', {}, h('span', { class: 'muted' }, 'Допущения:'), h('ul', { class: 'ai-assume' }, ai.assumptions.map((a) => h('li', {}, a)))) : null,
      h('p', { class: 'muted' }, `Проверь схему и «что было бы», поправь в форме, если нужно, и сохрани. ${ai.attempts > 1 ? `Попыток: ${ai.attempts}; ` : ''}${tokens(ai.usage)}.`),
      h('button', { class: 'btn', onclick: () => guard(() => openAi(ai.request)) }, 'Переписать просьбу'));
  }

  // ── templates ───────────────────────────────────────────────────────────

  async function showTemplates() {
    cur = null;
    renderList();
    let templates;
    try { templates = await api('/api/templates'); } catch (e) { return onError(e); }
    fill(pane, 
      h('div', { class: 'ed-head' }, h('h2', { class: 'ed-title' }, 'Шаблоны'), h('span', { class: 'muted' }, 'выбери — подставь свои устройства — проверь и сохрани')),
      h('div', { class: 'tpl-grid' }, templates.map((t) => h('button', { class: 'card tpl', onclick: () => templateForm(t) },
        h('span', { class: 'tpl-kind' }, t.kind === 'scene' ? 'сцена' : 'правило'),
        h('span', { class: 'tpl-name' }, t.name), h('span', { class: 'tpl-desc' }, t.description)))));
  }

  function templateForm(t) {
    const values = {};
    const fields = t.params.map((p) => {
      let control;
      if (p.type === 'sensor' || p.type === 'switch') {
        if (!p.options.length) return h('p', { class: 'ed-warn' }, `${p.label}: подходящих устройств в CUBE сейчас нет`);
        values[p.key] = p.options[0].value;
        control = h('select', { onchange: (e) => { values[p.key] = e.target.value; } }, p.options.map((o) => h('option', { value: o.value }, o.label)));
      } else {
        values[p.key] = String(p.default ?? '');
        control = h('input', { type: p.type === 'time' ? 'time' : 'text', value: values[p.key], oninput: (e) => { values[p.key] = e.target.value; } });
      }
      return h('label', { class: 'f-field' }, h('span', { class: 'f-label' }, p.label), control);
    });
    fill(pane, 
      h('div', { class: 'ed-head' }, h('h2', { class: 'ed-title' }, t.name), h('button', { class: 'btn', onclick: () => void showTemplates() }, '← Все шаблоны')),
      h('p', { class: 'muted' }, t.description),
      h('div', { class: 'ed-form' }, fields),
      h('div', { class: 'ed-actions' }, h('button', { class: 'btn primary', onclick: async () => {
        try {
          const res = await api('/api/templates/build', { id: t.id, params: values });
          create(res.kind, res.card);
        } catch (e) { onError(e); }
      } }, 'Создать карточку')));
  }

  return {
    async show() { await load(); if (!cur && !pending) renderPane(); },
  };
}
