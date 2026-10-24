// Rule diagram: conditions (with timers and what holds now) → actions; the "otherwise" branch below.
// The server builds the texts (POST /api/library/check → diagram); this only draws them.
import { clock, h } from './dom.js';

const STATUS = { ok: 'выполняется', waiting: 'ждёт', fail: 'не выполняется', unknown: 'не проверить' };

function actionNode(a, prefix) {
  return h('div', { class: 'dg-node dg-act' },
    h('div', { class: 'dg-text' }, prefix ? h('span', { class: 'dg-prefix' }, prefix) : null, a.text),
    a.when.length ? h('div', { class: 'dg-if' }, `если ${a.when.join(' и ')}`) : null);
}

function conditionNode(c) {
  return h('div', { class: `dg-node dg-cond st-${c.status}` },
    h('div', { class: 'dg-text' }, c.text),
    c.timer ? h('span', { class: 'dg-timer' }, `держится ${c.timer}`) : null,
    h('div', { class: 'dg-now' }, h('span', { class: 'dg-dot', 'aria-hidden': 'true' }), c.now));
}

export function renderDiagram(d) {
  if (!d) return h('p', { class: 'muted dg-empty' }, 'Схема появится, когда карточка пройдёт проверку формата.');
  if (d.kind === 'scene') {
    return h('div', { class: 'dg dg-scene' },
      h('div', { class: 'dg-head' }, 'По кнопке, команде или из правила — по порядку'),
      h('ol', { class: 'dg-steps' }, d.steps.map((s) => h('li', {}, actionNode(s)))));
  }
  const join = d.mode === 'all' ? 'все условия вместе' : 'любое из условий';
  return h('div', { class: 'dg' },
    h('div', { class: `dg-state st-${d.overall}` },
      h('span', { class: 'dg-dot', 'aria-hidden': 'true' }),
      d.enabled ? `Сейчас: ${STATUS[d.overall]}` : 'Правило выключено (enabled: false)',
      d.switch && !d.switch.enabled && d.enabled ? h('span', { class: 'dg-paused' }, ' · выключено в панели') : null,
      d.switch?.pausedUntil ? h('span', { class: 'dg-paused' }, ` · на паузе до ${clock(d.switch.pausedUntil)}`) : null,
      h('span', { class: 'muted' }, d.live ? ' · как в работающем правиле' : ' · по текущему состоянию дома')),
    h('div', { class: 'dg-flow' },
      h('div', { class: 'dg-col' },
        h('div', { class: 'dg-head' }, `Когда — ${join}`),
        d.conditions.map(conditionNode)),
      h('div', { class: 'dg-arrow', 'aria-hidden': 'true' },
        h('span', { class: 'dg-arrow-head' }, '➜')),
      h('div', { class: 'dg-col' },
        h('div', { class: 'dg-head' }, 'Тогда — один раз, когда условия стали выполняться'),
        d.then.map((a) => actionNode(a)),
        d.cooldown ? h('div', { class: 'dg-note' }, `Не чаще раза в ${d.cooldown}`) : null)),
    d.otherwise ? h('div', { class: 'dg-branch' },
      h('div', { class: 'dg-head' }, `Иначе — когда условия перестали выполняться${d.otherwise.after ? `, через ${d.otherwise.after}` : ''}`),
      d.otherwise.after ? h('div', { class: 'dg-note' }, 'Если условия вернутся раньше — «иначе» отменится.') : null,
      d.otherwise.do.map((a) => actionNode(a))) : null);
}
