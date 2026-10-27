// Home screens like the pages of the NSPanel: swipe left and right (or the arrows, the dots, the ← → keys),
// each screen a column of panels. «Настроить» opens a sheet to rename the screen, add, move and remove its
// panels, and add, move or delete screens. The layout is kept by the engine (POST /api/screens), so the phone
// and the wall tablet show the same screens; which screen is open is remembered in this browser.
import { api, fill, h } from './dom.js';
import { icon } from './icons.js';

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: not remembered */ } };
const swap = (list, i, j) => { [list[i], list[j]] = [list[j], list[i]]; };

export function createScreens({ pager, dots, prev, next, edit, dialog, catalogue, makePanel, onBuild, onError, toast }) {
  let layout = [];
  let key = null;
  let index = Number(read('domovoy.screen')) || 0;
  let draft = null;     // the layout being edited in the sheet
  let editing = 0;      // which screen the sheet edits
  let armed = null;     // a two-step button waiting for the second press
  let building = false; // the pager is being rebuilt: its scroll jumps are not the user's

  const width = () => Math.max(1, pager.clientWidth);
  const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

  function go(i, behavior = smooth()) {
    index = Math.max(0, Math.min(layout.length - 1, i));
    pager.scrollTo({ left: index * width(), behavior });
    marks();
  }

  function marks() {
    write('domovoy.screen', String(index));
    for (const [i, d] of [...dots.children].entries()) d.setAttribute('aria-current', i === index ? 'true' : 'false');
    prev.disabled = index === 0;
    next.disabled = index >= layout.length - 1;
  }

  // Chrome around the pager: the status bar on top, the tab dock below (none of them on the wall tablet).
  function measure() {
    const top = document.querySelector('.top');
    const dock = document.getElementById('tabs');
    const docked = dock && !dock.hidden && getComputedStyle(dock).display !== 'none';
    document.documentElement.style.setProperty('--top-h', `${top && getComputedStyle(top).display !== 'none' ? top.offsetHeight : 0}px`);
    document.documentElement.style.setProperty('--bottom-h', `${docked ? Math.max(0, Math.round(innerHeight - dock.getBoundingClientRect().top)) : 0}px`);
  }

  function panel(p) {
    const { title, body, cls = '' } = makePanel(p);
    return h('section', { class: `panel ${cls}`, 'data-panel': p }, title ? h('h3', { class: 'panel-title' }, title) : null, body);
  }

  function build(screens) {
    const next = JSON.stringify(screens);
    if (next === key) return false;
    key = next;
    layout = screens;
    const want = Math.min(index, screens.length - 1);
    building = true;
    // Devices of rooms that are on no screen show up after the room panels, so nothing gets lost.
    let spare = screens.findIndex((s) => s.panels.some((p) => p.startsWith('room:')));
    if (spare < 0) spare = screens.length - 1;
    fill(pager, screens.map((s, i) => h('section', { class: 'screen', 'aria-label': s.name },
      h('div', { class: 'screen-inner' },
        s.panels[0] === 'clock' ? null : h('h2', { class: 'screen-title' }, s.name),
        s.panels.map(panel),
        i === spare ? panel('unplaced') : null,
        s.panels.length ? null : h('div', { class: 'screen-empty' }, h('p', {}, 'Экран пустой.'),
          h('button', { class: 'btn primary', onclick: () => open(i) }, 'Добавить панели'))))));
    fill(dots, screens.map((s, i) => h('button', { class: 'pg-dot', 'aria-label': `Экран «${s.name}»`, title: s.name, onclick: () => go(i) })));
    index = want;
    measure();
    requestAnimationFrame(() => { building = false; go(want, 'auto'); });
    onBuild();
    return true;
  }

  pager.addEventListener('scroll', () => {
    if (building) return;
    const i = Math.round(pager.scrollLeft / width());
    if (i !== index && i < layout.length) { index = i; marks(); }
  }, { passive: true });
  addEventListener('resize', () => { measure(); go(index, 'auto'); });
  prev.addEventListener('click', () => go(index - 1));
  next.addEventListener('click', () => go(index + 1));
  edit.addEventListener('click', () => open(index));
  document.addEventListener('keydown', (e) => {
    const view = document.body.dataset.view;
    if ((view !== 'overview' && view !== 'tablet') || dialog.open || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
  });

  // ── the sheet: set up a screen ──

  function open(i) {
    draft = structuredClone(layout);
    editing = i;
    armed = null;
    sheet();
    if (!dialog.open) dialog.showModal();
  }

  async function save(nextLayout, done, before) {
    try {
      await api('/api/screens', { screens: nextLayout });
      draft = nextLayout;
      if (done) toast(done, 'notice');
    } catch (e) { onError(e); draft = structuredClone(layout); editing = before; index = before; } // stay where it was
    sheet();
  }

  const change = (fn, done) => () => { const before = editing; const n = structuredClone(draft); fn(n); index = editing; void save(n, done, before); };
  const twoStep = (id, label, confirm, fn, disabled = false) => h('button', {
    class: armed === id ? 'btn danger' : 'btn', disabled,
    onclick: () => {
      if (armed !== id) { armed = id; sheet(); setTimeout(() => { if (armed === id) { armed = null; sheet(); } }, 4000); return; }
      armed = null; fn();
    },
  }, armed === id ? confirm : label);
  const iconBtn = (ic, label, disabled, onclick) => h('button', { class: 'btn icon', 'aria-label': label, title: label, disabled, onclick }, icon(ic));

  function sheet() {
    if (!draft) return;
    editing = Math.min(editing, draft.length - 1);
    const s = draft[editing];
    const cat = catalogue();
    const label = (p) => cat.find((c) => c.id === p)?.label ?? (p.startsWith('room:') ? `Комната «${p.slice(5)}» — её больше нет` : p);
    const where = (p) => draft.findIndex((x) => x.panels.includes(p));
    const choices = cat.filter((c) => !s.panels.includes(c.id));
    const pick = h('select', { 'aria-label': 'Какую панель добавить' }, choices.map((c) => {
      const at = where(c.id);
      return h('option', { value: c.id }, at < 0 ? c.label : `${c.label} — перенести с «${draft[at].name}»`);
    }));
    const add = change((n) => {
      const p = pick.value;
      for (const x of n) x.panels = x.panels.filter((q) => q !== p);
      n[editing].panels.push(p);
    }, 'Панель добавлена');
    const last = draft.length - 1;
    fill(dialog,
      h('div', { class: 'sheet-head' },
        h('h2', { class: 'sheet-title' }, `Экран ${editing + 1} из ${draft.length}`),
        h('div', { class: 'sheet-steps' },
          iconBtn('left', 'Предыдущий экран', editing === 0, () => { editing -= 1; armed = null; go(editing); sheet(); }),
          iconBtn('chevron', 'Следующий экран', editing === last, () => { editing += 1; armed = null; go(editing); sheet(); }),
          iconBtn('x', 'Закрыть', false, () => dialog.close()))),
      h('label', { class: 'sheet-field' }, h('span', { class: 'sys-label' }, 'Название'),
        h('input', { type: 'text', class: 'sys-input', value: s.name, maxlength: '30',
          onchange: (e) => { const name = e.target.value.trim(); if (name) change((n) => { n[editing].name = name; }, 'Название сохранено')(); } })),
      h('h3', { class: 'sys-sub' }, 'Панели на этом экране — сверху вниз'),
      s.panels.length ? h('ul', { class: 'sys-list' }, s.panels.map((p, i) => h('li', { class: 'sheet-row' },
        h('span', { class: 'sheet-label' }, label(p)),
        iconBtn('up', `Выше: ${label(p)}`, i === 0, change((n) => swap(n[editing].panels, i, i - 1))),
        iconBtn('down', `Ниже: ${label(p)}`, i === s.panels.length - 1, change((n) => swap(n[editing].panels, i, i + 1))),
        iconBtn('x', `Убрать: ${label(p)}`, false, change((n) => { n[editing].panels.splice(i, 1); }, 'Панель убрана'))))) : h('p', { class: 'muted sys-hint' }, 'Пока пусто — добавь панель ниже.'),
      choices.length ? h('div', { class: 'sys-add' }, pick, h('button', { class: 'btn primary', onclick: add }, 'Добавить')) : h('p', { class: 'muted sys-hint' }, 'Все панели уже на этом экране.'),
      h('h3', { class: 'sys-sub' }, 'Экран'),
      h('div', { class: 'sys-actions' },
        h('button', { class: 'btn', disabled: editing === 0, onclick: change((n) => { swap(n, editing, editing - 1); editing -= 1; }) }, 'Сдвинуть левее'),
        h('button', { class: 'btn', disabled: editing === last, onclick: change((n) => { swap(n, editing, editing + 1); editing += 1; }) }, 'Сдвинуть правее'),
        h('button', { class: 'btn', disabled: draft.length >= 10, onclick: change((n) => { n.splice(editing + 1, 0, { name: `Экран ${n.length + 1}`, panels: [] }); editing += 1; }, 'Экран добавлен') }, 'Новый экран'),
        twoStep('delete', 'Удалить экран', 'Точно удалить?', change((n) => { n.splice(editing, 1); editing = Math.max(0, editing - 1); }, 'Экран удалён'), draft.length === 1)),
      h('p', { class: 'muted sys-hint' }, 'Устройства из комнат, которых нет ни на одном экране, видны в панели «Ещё не на экранах».'),
      h('div', { class: 'sheet-foot' },
        twoStep('reset', 'Вернуть как было', 'Точно вернуть?', async () => {
          try { await api('/api/screens', { reset: true }); toast('Экраны как по умолчанию', 'notice'); dialog.close(); } catch (e) { onError(e); }
        }),
        h('button', { class: 'btn primary', onclick: () => dialog.close() }, 'Готово')));
  }

  return {
    build,
    measure,
    open: () => open(index),
    // After a save the layout comes back with the state; the open sheet follows it.
    sync() { if (dialog.open && draft && JSON.stringify(draft) !== key) { draft = structuredClone(layout); sheet(); } },
  };
}
