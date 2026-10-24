// Event feed: device changes, rule outcomes, manual actions, system events — newest first,
// filtered by kind and by one device or rule, grouped by day, with paging.
import { api, h } from './dom.js';

const KINDS = [['', 'Все'], ['device', 'Устройства'], ['rule', 'Правила'], ['manual', 'Вручную'], ['system', 'Система']];
const ICON = { device: '◉', rule: '⚙', manual: '✋', system: '⛁' };

export function createTimeline(root, { onError, refs }) {
  let kind = '';
  let ref = '';
  let items = [];
  let nextBefore = null;
  const list = h('ol', { class: 'feed' });
  const more = h('button', { class: 'btn more', onclick: () => load(true) }, 'Показать ещё');
  const select = h('select', { class: 'feed-ref', 'aria-label': 'Устройство или правило', onchange: (e) => { ref = e.target.value; load(false); } });
  const chips = h('div', { class: 'chips' }, KINDS.map(([k, label]) =>
    h('button', { class: `chip-btn${k === kind ? ' on' : ''}`, 'data-kind': k, onclick: () => { kind = k; renderChips(); load(false); } }, label)));
  root.replaceChildren(h('div', { class: 'feed-bar' }, chips, select), list, more);

  function renderChips() {
    for (const b of chips.children) b.className = `chip-btn${b.dataset.kind === kind ? ' on' : ''}`;
  }

  function renderRefs() {
    const options = [['', 'Все устройства и правила'], ...refs()];
    const current = select.value;
    select.replaceChildren(...options.map(([value, label]) => h('option', { value }, label)));
    select.value = options.some(([v]) => v === current) ? current : '';
  }

  function render() {
    list.replaceChildren();
    let day = '';
    for (const e of items) {
      const d = new Date(e.ts);
      const label = d.toDateString() === new Date().toDateString() ? 'Сегодня' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      if (label !== day) { day = label; list.append(h('li', { class: 'feed-day' }, label)); }
      list.append(h('li', { class: `feed-item ${e.kind}` },
        h('span', { class: 'feed-time' }, d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
        h('span', { class: 'feed-icon', 'aria-hidden': 'true' }, ICON[e.kind] ?? '•'),
        h('span', { class: 'feed-text' }, e.text)));
    }
    if (!items.length) list.append(h('li', { class: 'empty' }, 'Событий пока нет.'));
    more.hidden = nextBefore === null;
  }

  async function load(append) {
    const q = new URLSearchParams();
    if (kind) q.set('kind', kind);
    if (ref) q.set('ref', ref);
    if (append && nextBefore) q.set('before', String(nextBefore));
    try {
      const page = await api(`/api/timeline?${q}`);
      items = append ? [...items, ...page.events] : page.events;
      nextBefore = page.nextBefore;
      render();
    } catch (e) { onError(e); }
  }

  return {
    refresh() { renderRefs(); return load(false); },
  };
}
