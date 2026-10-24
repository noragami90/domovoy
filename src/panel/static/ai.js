// "In words": a request in plain Russian → Claude drafts a card → it opens in the editor as a diagram.
import { AuthError, api, fill, h } from './dom.js';

const EXAMPLES = [
  'Если дверь лоджии открыта дольше 10 минут, а кондиционер работает — напомни в Telegram',
  'Когда в ванной влажность выше обычной — включи вытяжку, а через 10 минут после того, как станет нормально, выключи',
  'По будням с 7:00 до 8:00 включай свет в прихожей, если режим «дома»',
  'Сцена «Кино»: выключи всё, кроме гирлянды',
];

export const tokens = (u) => {
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')} тыс.` : String(n));
  const input = u.input + u.cacheRead + (u.cacheWrite ?? 0); // the API counts cached parts separately
  return `${k(input)} токенов на входе${u.cacheRead ? ` (из кэша ${k(u.cacheRead)})` : ''}, ${k(u.output)} на выходе`;
};

export async function showAi(pane, { onDraft, onError, initial = '' }) {
  let status;
  try { status = await api('/api/ai'); } catch (e) { return onError(e); }
  const head = h('div', { class: 'ed-head' }, h('h2', { class: 'ed-title' }, 'Правило словами'),
    status.enabled ? h('span', { class: 'muted' }, `черновик пишет Claude (${status.model}), сохраняешь ты`) : null);
  if (!status.enabled) {
    return fill(pane, head,
      h('p', {}, 'ИИ-черновики выключены: нужен ключ Claude API.'),
      h('p', { class: 'muted' }, status.hint),
      h('pre', { class: 'ai-code' }, 'ANTHROPIC_API_KEY=sk-ant-…'),
      h('p', { class: 'muted' }, 'Всё остальное — редактор, шаблоны, схема, «что было бы» — работает без ключа.'));
  }
  const text = h('textarea', { class: 'ai-text', rows: '4', maxlength: '1000', placeholder: 'Например: если дверь лоджии открыта дольше 10 минут — напомни', 'aria-label': 'Что должно происходить' });
  text.value = initial;
  const answer = h('div', { class: 'ai-answer', 'aria-live': 'polite' });
  const go = h('button', { class: 'btn primary', onclick: () => void submit() }, 'Сделать черновик');

  async function submit() {
    const request = text.value.trim();
    if (request.length < 5) { text.focus(); return; }
    go.disabled = true;
    fill(answer, h('p', { class: 'muted' }, 'Claude пишет черновик и проверяет его… обычно 10–40 секунд.'));
    try {
      const res = await api('/api/ai/draft', { text: request });
      if (res.question) {
        fill(answer, h('div', { class: 'ai-question' }, h('b', {}, 'Claude не стал делать черновик: '), res.question),
          h('p', { class: 'muted' }, 'Уточни просьбу и попробуй ещё раз.'));
      } else onDraft(res, request);
    } catch (e) {
      // Stays on screen (a toast would vanish before a long hint is read).
      if (e instanceof AuthError) { fill(answer); onError(e); } else fill(answer, h('p', { class: 'ed-issue ai-error' }, e.message));
    } finally { go.disabled = false; }
  }

  fill(pane, head,
    h('p', {}, 'Опиши обычными словами, что и когда должно происходить. Claude соберёт карточку из твоих устройств; она откроется схемой — проверь, прогони «что было бы» и сохрани.'),
    text,
    h('div', { class: 'ai-examples' }, h('span', { class: 'muted' }, 'Примеры:'),
      EXAMPLES.map((ex) => h('button', { class: 'btn ai-example', onclick: () => { text.value = ex; text.focus(); } }, ex))),
    h('div', { class: 'ed-actions' }, go),
    answer,
    h('p', { class: 'muted ai-privacy' }, 'В Claude уходят: просьба, названия устройств и их текущие значения, переменные и сцены. Устройствами ИИ не управляет — правило выполняет движок, и только после того, как ты его сохранишь.'));
  text.focus();
}
