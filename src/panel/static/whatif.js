// "What if": the card being edited, run over the recorded history (POST /api/library/replay).
import { clock, fill, h } from './dom.js';

const plural = (n, [one, few, many]) => {
  const d = n % 10, dd = n % 100;
  return d === 1 && dd !== 11 ? one : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
};
const times = (n) => `${n} ${plural(n, ['раз', 'раза', 'раз'])}`;
const span = (ms) => {
  const days = Math.round(ms / 86_400_000);
  if (days >= 1) return days === 1 ? 'сутки' : `${days} ${plural(days, ['день', 'дня', 'дней'])}`;
  return ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} ч` : `${Math.max(1, Math.round(ms / 60_000))} мин`;
};

const MARK = { fired: 'fired', action_error: 'error', otherwise_done: 'other', cooldown: 'cool', otherwise_cancelled: 'other', released: 'other' };

function summary(r) {
  const c = r.counts;
  const fired = (c.fired ?? 0) + (c.action_error ?? 0);
  const parts = [fired ? `сработало бы ${times(fired)}` : 'ни разу не сработало бы'];
  if (c.otherwise_done) parts.push(`«иначе» — ${times(c.otherwise_done)}`);
  if (c.cooldown) parts.push(`${times(c.cooldown)} помешала пауза между срабатываниями`);
  const effects = [];
  if (r.notifications.length) effects.push(`уведомлений: ${r.notifications.length}`);
  if (r.writes.length) effects.push(`команд устройствам: ${r.writes.length}`);
  const tail = effects.join(', ');
  return `За ${span(r.to - r.from)} ${parts.join(', ')}.${tail ? ` ${tail.charAt(0).toUpperCase()}${tail.slice(1)}.` : ''}`;
}

function strip(r) {
  const total = Math.max(1, r.to - r.from);
  return h('div', { class: 'wi-strip', role: 'img', 'aria-label': 'Срабатывания на шкале времени' },
    r.entries.filter((e) => MARK[e.outcome] !== 'other' || e.outcome === 'otherwise_done').map((e) =>
      h('span', { class: `wi-mark wi-${MARK[e.outcome]}`, title: `${clock(e.ts)} — ${e.text}`, 'data-left': ((e.ts - r.from) / total * 100).toFixed(2) })),
    h('span', { class: 'wi-edge wi-from' }, clock(r.from)), h('span', { class: 'wi-edge wi-to' }, clock(r.to)));
}

export function renderResult(r) {
  if (r.missing.length) {
    return h('div', { class: 'wi-body' }, h('p', { class: 'ed-warn' }, `Нет истории для: ${r.missing.join(', ')}. Такого устройства или значения нет в CUBE, или его ещё ни разу не записали.`));
  }
  if (r.to <= r.from) return h('div', { class: 'wi-body' }, h('p', { class: 'muted' }, 'Истории пока нет — движок только начал её записывать.'));
  const shown = r.entries.filter((e) => e.outcome !== 'released' && e.outcome !== 'otherwise_cancelled').slice(-40).reverse();
  const body = h('div', { class: 'wi-body' },
    h('p', { class: 'wi-sum' }, summary(r)),
    r.limitedBy && r.from > r.requestedFrom ? h('p', { class: 'muted wi-limit' }, `История есть только с ${clock(r.from)}: «${r.limitedBy}» начали записывать тогда.`) : null,
    r.limitedBy && r.from <= r.requestedFrom ? h('p', { class: 'muted wi-limit' }, r.limitedBy) : null,
    strip(r),
    shown.length ? h('ul', { class: 'wi-list' }, shown.map((e) => h('li', { class: `wi-${MARK[e.outcome]}` }, h('time', {}, clock(e.ts)), e.text))) : null,
    h('p', { class: 'muted wi-note' }, 'Прогон по записанной истории: устройства и Telegram не трогаются. Действия самого правила меняют только копию дома в прогоне.'));
  // Positions are set from code: the page's CSP allows no inline styles.
  for (const m of body.querySelectorAll('.wi-mark')) m.style.left = `${m.dataset.left}%`;
  return body;
}

export function createWhatIf({ run, onError }) {
  let hours = 24;
  const out = h('div', { class: 'wi-out', 'aria-live': 'polite' });
  const seg = h('div', { class: 'segmented' });
  const go = async () => {
    fill(out, h('p', { class: 'muted' }, 'Прогоняю по истории…'));
    try { fill(out, renderResult(await run(hours))); } catch (e) { fill(out); onError(e); }
  };
  const drawSeg = () => fill(seg, [[24, 'За сутки'], [168, 'За неделю']].map(([v, l]) =>
    h('button', { class: `seg${hours === v ? ' on' : ''}`, onclick: () => { hours = v; drawSeg(); void go(); } }, l)));
  drawSeg();
  fill(out, h('button', { class: 'btn', onclick: () => void go() }, 'Прогнать по истории'));
  const root = h('section', { class: 'wi' },
    h('div', { class: 'wi-head' }, h('h3', { class: 'wi-title' }, 'Что было бы'), seg),
    h('p', { class: 'muted wi-lead' }, 'Как это правило вело бы себя на том, что уже происходило дома.'), out);
  return { root, run: go };
}
