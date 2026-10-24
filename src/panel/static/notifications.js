// Notifications tab: urgent ones waiting for «Принял», settings (quiet hours, repeats, batteries,
// silence), a test button and the journal of everything that was sent.
import { api, clock, fill, h } from './dom.js';

const FILTERS = [['all', 'Все'], ['urgent', 'Срочные'], ['pending', 'Ждут «Принял»']];

function badges(n) {
  return [
    n.urgent ? h('span', { class: 'nt-badge urgent' }, 'срочно') : null,
    n.quiet ? h('span', { class: 'nt-badge' }, 'без звука') : null,
    n.status === 'no_telegram' ? h('span', { class: 'nt-badge' }, 'только здесь') : null,
    n.status === 'failed' ? h('span', { class: 'nt-badge bad', title: n.error ?? '' }, 'не доставлено') : null,
    n.repeats ? h('span', { class: 'nt-badge' }, `повторов: ${n.repeats}`) : null,
  ];
}

export function createNotifications(root, { onError, toast }) {
  let filter = 'all';
  let items = [];
  let nextBefore = null;
  let data = null;
  let draft = null; // settings being edited

  const ack = async (id) => {
    try { await api(`/api/notifications/${id}/ack`, {}); toast('Принято', 'notice'); await load(); } catch (e) { onError(e); }
  };

  function row(n) {
    const pending = n.urgent && !n.ackedAt;
    return h('li', { class: `nt-row${pending ? ' pending' : ''}` },
      h('div', { class: 'nt-meta' }, h('time', {}, clock(n.ts)), h('span', { class: 'nt-source' }, n.source), badges(n)),
      h('div', { class: 'nt-text' }, n.text),
      n.ackedAt ? h('div', { class: 'nt-ack' }, `✓ Принял: ${n.ackedBy}, ${clock(n.ackedAt)}`) : null,
      pending ? h('button', { class: 'btn primary nt-ack-btn', onclick: () => void ack(n.id) }, 'Принял') : null);
  }

  function num(value, min, max, set) {
    return h('input', { type: 'number', class: 'f-tiny', min: String(min), max: String(max), value: String(value), oninput: (e) => set(Number(e.target.value)) });
  }

  function settingsCard() {
    const s = draft;
    const save = async () => {
      try { const r = await api('/api/notifications/settings', s); draft = structuredClone(r.settings); toast('Настройки уведомлений сохранены', 'notice'); await load(); } catch (e) { onError(e); }
    };
    const test = async (urgent) => {
      try { await api('/api/notifications/test', { urgent }); toast(urgent ? 'Срочное отправлено — нажми «Принял»' : 'Отправлено', 'notice'); await load(); } catch (e) { onError(e); }
    };
    return h('section', { class: 'card nt-settings' },
      h('h3', { class: 'nt-h' }, 'Настройки'),
      h('div', { class: 'nt-field' },
        h('label', { class: 'nt-check' }, h('input', { type: 'checkbox', checked: s.quiet.enabled, onchange: (e) => { s.quiet.enabled = e.target.checked; } }), 'Тихие часы'),
        h('span', { class: 'nt-inline' }, 'с', h('input', { type: 'time', value: s.quiet.from, oninput: (e) => { s.quiet.from = e.target.value; } }),
          'до', h('input', { type: 'time', value: s.quiet.to, oninput: (e) => { s.quiet.to = e.target.value; } })),
        h('p', { class: 'muted nt-hint' }, 'В это время обычные уведомления приходят без звука. Срочные звенят всегда.')),
      h('div', { class: 'nt-field' },
        h('span', { class: 'nt-label' }, 'Срочные'),
        h('span', { class: 'nt-inline' }, 'повторять каждые', num(s.repeat.everyMin, 1, 120, (v) => { s.repeat.everyMin = v; }), 'мин, не больше',
          num(s.repeat.max, 0, 100, (v) => { s.repeat.max = v; }), 'раз'),
        h('p', { class: 'muted nt-hint' }, 'Пока кто-нибудь не нажмёт «Принял» в Telegram или здесь. Срочным уведомление делает галочка «срочно» в правиле.')),
      h('div', { class: 'nt-field' },
        h('span', { class: 'nt-label' }, 'Батарейки'),
        h('span', { class: 'nt-inline' }, 'предупреждать ниже', num(s.battery.below, 1, 99, (v) => { s.battery.below = v; }), '%')),
      h('div', { class: 'nt-field' },
        h('label', { class: 'nt-check' }, h('input', { type: 'checkbox', checked: s.silence.enabled, onchange: (e) => { s.silence.enabled = e.target.checked; } }), 'Сообщать, если датчик молчит дольше обычного'),
        h('p', { class: 'muted nt-hint' }, 'Обычный интервал считается по истории замеров за три дня. Двери и выключатели присылают данные только при изменениях — за ними следит «не в сети» от CUBE.')),
      h('div', { class: 'ed-actions' },
        h('button', { class: 'btn primary', onclick: () => void save() }, 'Сохранить'),
        h('button', { class: 'btn', onclick: () => void test(false) }, 'Проверить обычное'),
        h('button', { class: 'btn', onclick: () => void test(true) }, 'Проверить срочное')));
  }

  function render() {
    const pending = items.filter((n) => n.urgent && !n.ackedAt);
    fill(root,
      h('div', { class: 'nt-head' }, h('h2', { class: 'ed-title' }, 'Уведомления'),
        h('span', { class: data.telegram ? 'nt-tg on' : 'nt-tg' }, data.telegram ? 'Telegram подключён' : 'Telegram не настроен — уведомления видны только здесь')),
      filter === 'all' && pending.length ? h('section', { class: 'nt-pending' },
        h('h3', { class: 'nt-h' }, 'Ждут «Принял»'), h('ul', { class: 'nt-list' }, pending.map(row))) : null,
      h('div', { class: 'nt-layout' },
        h('section', { class: 'nt-journal' },
          h('div', { class: 'nt-bar' }, h('h3', { class: 'nt-h' }, 'Журнал'),
            h('div', { class: 'segmented' }, FILTERS.map(([k, l]) => h('button', { class: `seg${filter === k ? ' on' : ''}`, onclick: () => { filter = k; void load(); } }, l)))),
          items.length ? h('ul', { class: 'nt-list' }, items.map(row)) : h('p', { class: 'empty' }, 'Пока ничего не отправлялось.'),
          nextBefore ? h('button', { class: 'btn more', onclick: () => void more() }, 'Показать ещё') : null),
        settingsCard()));
  }

  async function load() {
    try {
      data = await api(`/api/notifications?filter=${filter}`);
      items = data.items;
      nextBefore = data.nextBefore;
      draft ??= structuredClone(data.settings);
      render();
    } catch (e) { onError(e); }
  }

  async function more() {
    try {
      const r = await api(`/api/notifications?filter=${filter}&before=${nextBefore}`);
      items = [...items, ...r.items];
      nextBefore = r.nextBefore;
      render();
    } catch (e) { onError(e); }
  }

  return {
    show: () => { draft = null; return load(); },
    // A new notification while the tab is open: refresh the list, keep unsaved settings.
    refresh: () => {
      const typing = document.activeElement?.tagName === 'INPUT' && root.contains(document.activeElement);
      return data && !typing ? load() : undefined; // do not steal focus while a setting is being typed
    },
  };
}
