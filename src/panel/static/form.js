// Form for a rule or scene card. It edits the raw card object in place (the same shape as YAML),
// so anything the form does not know (for example "if" on an action) is kept as it is.
import { attrLabel, h } from './dom.js';

const OPS = [['is', '='], ['not', '≠'], ['above', '>'], ['below', '<'], ['above_baseline', 'выше обычного на'], ['below_baseline', 'ниже обычного на']];
const BOOL_ATTRS = new Set(['open', 'leak', 'motion', 'detected']);
const DAYS = [['mon', 'пн'], ['tue', 'вт'], ['wed', 'ср'], ['thu', 'чт'], ['fri', 'пт'], ['sat', 'сб'], ['sun', 'вс']];
const ACTIONS = [['set', 'Включить / выключить'], ['notify', 'Уведомление'], ['set_var', 'Переменная'], ['all_off', 'Выключить всё'], ['scene', 'Сцена']];
const isSwitch = (a) => a === 'power' || /^toggle\.\w+$/.test(a);

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya' };
export function slug(text) {
  const latin = [...String(text).toLowerCase()].map((c) => TRANSLIT[c] ?? c).join('');
  return latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'card';
}

// ── small controls ─────────────────────────────────────────────────────────

const field = (label, control, hint) => h('label', { class: 'f-field' }, h('span', { class: 'f-label' }, label), control, hint ? h('span', { class: 'f-hint' }, hint) : null);

function select(options, value, onchange, extra = {}) {
  const opts = options.map(([v, l]) => h('option', { value: v }, l));
  if (value !== undefined && value !== '' && !options.some(([v]) => v === String(value))) opts.unshift(h('option', { value: String(value) }, `${value} (нет в CUBE)`));
  const el = h('select', { ...extra, onchange: (e) => onchange(e.target.value) }, opts);
  el.value = value === undefined ? '' : String(value);
  return el;
}

function input(value, onchange, extra = {}) {
  return h('input', { type: 'text', value: value ?? '', ...extra, oninput: (e) => onchange(e.target.value) });
}

// Typed value from a text box: numbers stay numbers, "true"/"false" become booleans.
function typed(text) {
  const t = String(text).trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && !Number.isNaN(Number(t.replace(',', '.'))) && /^-?[\d.,]+$/.test(t)) return Number(t.replace(',', '.'));
  return t;
}

function valueControl(kind, current, onchange) {
  if (kind === 'bool') return select([['true', 'да'], ['false', 'нет']], String(current ?? true), (v) => onchange(v === 'true'));
  if (kind === 'switch') return select([['on', 'вкл'], ['off', 'выкл']], current ?? 'on', onchange);
  if (Array.isArray(kind)) return select(kind.map((o) => [o.value, o.label]), current ?? kind[0]?.value, onchange);
  return input(current === undefined ? '' : String(current), (v) => onchange(typed(v)), { class: 'f-short', placeholder: 'значение' });
}

function varValueKind(ctx, name) {
  const v = ctx.vars.find((x) => x.name === name);
  if (v?.options) return v.options;
  if (typeof v?.value === 'boolean') return 'bool';
  return 'text';
}

function list(items, renderItem, onAdd, addLabel, rerender) {
  return h('div', { class: 'f-list' },
    items.map((item, i) => h('div', { class: 'f-row' }, renderItem(item, i),
      h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Убрать', onclick: () => { items.splice(i, 1); rerender(); } }, '✕'))),
    h('button', { class: 'btn add', type: 'button', onclick: () => { onAdd(); rerender(); } }, addLabel));
}

// ── conditions ─────────────────────────────────────────────────────────────

function conditionType(c) { return 'time' in c ? 'time' : 'var' in c ? 'var' : 'device'; }

function newCondition(type, ctx) {
  if (type === 'time') return { time: { between: ['sunset', '23:00'] } };
  if (type === 'var') { const v = ctx.vars[0]; return { var: v?.name ?? '', is: v?.options ? v.options[0].value : true }; }
  const d = ctx.devices[0];
  return { device: d?.name ?? '', attr: d?.attrs[0] ?? '', is: true };
}

function pointControl(point, onchange) {
  const m = /^(sunrise|sunset)?([+-].+)?$/.exec(point) ?? [];
  const base = m[1] ?? (/^\d\d:\d\d/.test(point) ? 'clock' : 'sunset');
  const shift = m[2] ?? '';
  const clock = base === 'clock' ? point : '07:00';
  const update = (b, c, s) => onchange(b === 'clock' ? c : `${b}${s}`);
  return h('span', { class: 'f-point' },
    select([['clock', 'время'], ['sunset', 'закат'], ['sunrise', 'восход']], base, (b) => update(b, clock, shift)),
    base === 'clock'
      ? h('input', { type: 'time', value: clock, onchange: (e) => update('clock', e.target.value, '') })
      : input(shift, (s) => update(base, clock, s), { class: 'f-tiny', placeholder: '−30m', title: 'Сдвиг: -30m, +1h' }));
}

function conditionRow(c, ctx, changed, rerender, conds, i) {
  const type = conditionType(c);
  const typeSel = select([['device', 'Устройство'], ['var', 'Переменная'], ['time', 'Время']], type, (t) => { conds[i] = newCondition(t, ctx); rerender(); });
  if (type === 'time') {
    const days = c.time.days ?? [];
    return h('div', { class: 'f-cond' }, typeSel, 'с', pointControl(c.time.between[0], (p) => { c.time.between[0] = p; changed(); }),
      'до', pointControl(c.time.between[1], (p) => { c.time.between[1] = p; changed(); }),
      h('span', { class: 'f-days' }, DAYS.map(([k, l]) => h('label', { class: 'f-day' },
        h('input', { type: 'checkbox', checked: days.includes(k), onchange: (e) => {
          const set = new Set(c.time.days ?? []);
          if (e.target.checked) set.add(k); else set.delete(k);
          if (set.size === 0 || set.size === 7) delete c.time.days; else c.time.days = DAYS.map(([d]) => d).filter((d) => set.has(d));
          changed();
        } }), l))));
  }
  const forBox = input(c.for ?? '', (v) => { if (v.trim()) c.for = v.trim(); else delete c.for; changed(); }, { class: 'f-tiny', placeholder: '5m', title: 'Держится: 30s, 5m, 1h' });
  if (type === 'var') {
    return h('div', { class: 'f-cond' }, typeSel,
      select(ctx.vars.map((v) => [v.name, v.label]), c.var, (v) => { c.var = v; const k = varValueKind(ctx, v); c.is = Array.isArray(k) ? k[0].value : k === 'bool' ? true : ''; rerender(); }),
      '=', valueControl(varValueKind(ctx, c.var), c.is, (v) => { c.is = v; changed(); }),
      h('span', { class: 'f-hint' }, 'держится'), forBox);
  }
  const dev = findDevice(ctx.devices, c.device);
  const op = OPS.find(([k]) => k in c)?.[0] ?? 'is';
  const value = c[op];
  const kind = (op === 'is' || op === 'not') ? (BOOL_ATTRS.has(c.attr) ? 'bool' : isSwitch(c.attr) ? 'switch' : 'text') : 'text';
  return h('div', { class: 'f-cond' }, typeSel,
    select(deviceOptions(ctx.devices), dev?.name ?? c.device, (v) => { c.device = v; const d = ctx.devices.find((x) => x.name === v); if (d && !d.attrs.includes(c.attr)) c.attr = d.attrs[0] ?? ''; rerender(); }),
    select((dev?.attrs ?? []).map((a) => [a, attrLabel(a)]), c.attr, (v) => { c.attr = v; rerender(); }),
    select(OPS, op, (v) => { const old = c[op]; delete c[op]; c[v] = v.endsWith('baseline') ? 15 : (v === 'above' || v === 'below') ? (typeof old === 'number' ? old : 0) : (old ?? true); rerender(); }),
    valueControl(kind, value, (v) => { c[op] = v; changed(); }),
    h('span', { class: 'f-hint' }, 'держится'), forBox);
}

// ── actions ────────────────────────────────────────────────────────────────

function actionType(a) { return ACTIONS.find(([k]) => k in a)?.[0] ?? 'notify'; }

// Cards store the CUBE name (d.name); the list shows the panel's own name. A card may also refer to
// a device by its own name or id — it is found either way.
const findDevice = (list, ref) => {
  const k = String(ref ?? '').trim().toLowerCase();
  return list.find((d) => [d.name, d.label, d.id].some((x) => x && x.trim().toLowerCase() === k));
};
const deviceOptions = (list) => list.map((d) => [d.name, d.label && d.label !== d.name ? `${d.label} (${d.name})` : d.name]);

function newAction(type, ctx) {
  if (type === 'set') { const d = ctx.devices.find((x) => x.attrs.some(isSwitch)); return { set: { device: d?.name ?? '', attr: d?.attrs.find(isSwitch) ?? 'power', to: 'on' } }; }
  if (type === 'set_var') { const v = ctx.vars.find((x) => !x.readonly); return { set_var: { var: v?.name ?? '', to: v?.options ? v.options[0].value : true } }; }
  if (type === 'all_off') return { all_off: {} };
  if (type === 'scene') return { scene: ctx.scenes[0]?.id ?? '' };
  return { notify: '' };
}

function actionRow(a, ctx, changed, rerender, actions, i) {
  const type = actionType(a);
  const typeSel = select(ACTIONS, type, (t) => { actions[i] = { ...newAction(t, ctx), ...(a.if ? { if: a.if } : {}) }; rerender(); });
  const note = a.if ? h('span', { class: 'f-note' }, 'есть условие «если» — правится в YAML') : null;
  if (type === 'notify') {
    const urgent = h('label', { class: 'f-day', title: 'Со звуком даже в тихие часы; повторяется, пока кто-нибудь не нажмёт «Принял»' },
      h('input', { type: 'checkbox', checked: a.urgent === true, onchange: (e) => { if (e.target.checked) a.urgent = true; else delete a.urgent; changed(); } }), 'срочно, до «Принял»');
    return h('div', { class: 'f-cond' }, typeSel, input(a.notify, (v) => { a.notify = v; changed(); }, { class: 'f-wide', placeholder: 'Текст уведомления' }), urgent, note);
  }
  if (type === 'scene') return h('div', { class: 'f-cond' }, typeSel, select(ctx.scenes.map((x) => [x.id, x.name]), a.scene, (v) => { a.scene = v; changed(); }), note);
  if (type === 'all_off') {
    return h('div', { class: 'f-cond' }, typeSel, h('span', { class: 'f-hint' }, 'кроме'),
      input((a.all_off?.except ?? []).join(', '), (v) => { const list = v.split(',').map((s) => s.trim()).filter(Boolean); a.all_off = list.length ? { except: list } : {}; changed(); }, { class: 'f-wide', placeholder: 'имена через запятую (необязательно)' }), note);
  }
  if (type === 'set_var') {
    return h('div', { class: 'f-cond' }, typeSel,
      select(ctx.vars.filter((v) => !v.readonly).map((v) => [v.name, v.label]), a.set_var.var, (v) => { a.set_var.var = v; const k = varValueKind(ctx, v); a.set_var.to = Array.isArray(k) ? k[0].value : k === 'bool' ? true : ''; rerender(); }),
      '=', valueControl(varValueKind(ctx, a.set_var.var), a.set_var.to, (v) => { a.set_var.to = v; changed(); }), note);
  }
  const devs = ctx.devices.filter((d) => d.attrs.some(isSwitch));
  const dev = findDevice(devs, a.set.device);
  return h('div', { class: 'f-cond' }, typeSel,
    select(deviceOptions(devs), dev?.name ?? a.set.device, (v) => { a.set.device = v; const d = devs.find((x) => x.name === v); a.set.attr = d?.attrs.find(isSwitch) ?? 'power'; rerender(); }),
    select((dev?.attrs ?? []).filter(isSwitch).map((x) => [x, attrLabel(x)]), a.set.attr, (v) => { a.set.attr = v; changed(); }),
    select([['on', 'включить'], ['off', 'выключить']], a.set.to, (v) => { a.set.to = v; changed(); }), note);
}

function actionsList(actions, ctx, changed, rerender) {
  return list(actions, (a, i) => actionRow(a, ctx, changed, rerender, actions, i), () => actions.push(newAction('set', ctx)), '+ действие', rerender);
}

// ── the whole card ─────────────────────────────────────────────────────────

// Cards whose id the user typed by hand (a new card's id follows its name until then).
const idTouched = new WeakSet();

function header(raw, isNew, changed) {
  if (!isNew) idTouched.add(raw);
  const idBox = input(raw.id, (v) => { idTouched.add(raw); raw.id = v.trim(); changed(); }, { class: 'f-mono', placeholder: 'latin-id' });
  return [
    field('Название', input(raw.name, (v) => { raw.name = v; if (!idTouched.has(raw)) { raw.id = slug(v); idBox.value = raw.id; } changed(); }, { class: 'f-wide', placeholder: 'Например: Вытяжка в санузле' })),
    field('id', idBox, 'латиница, цифры и дефис; имя файла'),
    field('Описание', h('textarea', { rows: 2, class: 'f-wide', oninput: (e) => { if (e.target.value.trim()) raw.description = e.target.value; else delete raw.description; changed(); } }, raw.description ?? '')),
  ];
}

export function renderForm(root, kind, raw, ctx, isNew, changed) {
  const rerender = () => { renderForm(root, kind, raw, ctx, isNew, changed); changed(); };
  const parts = [...header(raw, isNew, changed)];
  if (kind === 'scene') {
    raw.do ??= [];
    parts.push(h('h3', { class: 'f-section' }, 'Действия'), actionsList(raw.do, ctx, changed, rerender));
    return root.replaceChildren(...parts);
  }
  raw.when ??= { all: [] };
  raw.then ??= [];
  const mode = 'any' in raw.when ? 'any' : 'all';
  const conds = raw.when[mode];
  parts.push(
    field('Включено', h('input', { type: 'checkbox', checked: raw.enabled !== false, onchange: (e) => { if (e.target.checked) delete raw.enabled; else raw.enabled = false; changed(); } })),
    h('h3', { class: 'f-section' }, 'Когда ', select([['all', 'выполнены все условия'], ['any', 'выполнено любое условие']], mode, (m) => { raw.when = { [m]: conds }; rerender(); })),
    list(conds, (c, i) => conditionRow(c, ctx, changed, rerender, conds, i), () => conds.push(newCondition('device', ctx)), '+ условие', rerender),
    h('h3', { class: 'f-section' }, 'Тогда'),
    actionsList(raw.then, ctx, changed, rerender),
    h('h3', { class: 'f-section' },
      h('label', {}, h('input', { type: 'checkbox', checked: !!raw.otherwise, onchange: (e) => { if (e.target.checked) raw.otherwise = { do: [newAction('set', ctx)] }; else delete raw.otherwise; rerender(); } }),
        ' Иначе — когда условие перестало выполняться')),
  );
  if (raw.otherwise) {
    parts.push(field('Через', input(raw.otherwise.after ?? '', (v) => { if (v.trim()) raw.otherwise.after = v.trim(); else delete raw.otherwise.after; changed(); }, { class: 'f-tiny', placeholder: '10m' }), 'пусто — сразу'),
      actionsList(raw.otherwise.do, ctx, changed, rerender));
  }
  parts.push(field('Пауза между срабатываниями', input(raw.cooldown ?? '', (v) => { if (v.trim()) raw.cooldown = v.trim(); else delete raw.cooldown; changed(); }, { class: 'f-tiny', placeholder: '15m' }), 'необязательно'));
  root.replaceChildren(...parts);
}
