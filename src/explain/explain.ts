// Turns rule state and the journal into plain Russian: what the rule needs, what it sees now,
// when it last fired and why it did not fire recently.
import type { Value } from '../cube/normalize.ts';
import { formatDuration } from '../duration.ts';
import type { ItemResult } from '../engine/conditions.ts';
import { resultsText } from '../engine/actions.ts';
import type { Engine, JournalData } from '../engine/engine.ts';
import type { Rule } from '../rules/schema.ts';
import type { JournalEntry, Store } from '../store/db.ts';

const ATTR_LABEL: Record<string, string> = { humidity: 'влажность', temperature: 'температура', power_w: 'мощность', battery: 'батарея' };

// Feed line for a device state change: "Дверь лоджии: открыта", "Прихожая выключатель: канал 1 — включено".
export function changeText(device: string, attr: string, v: Value): string {
  if (attr === 'motion') return `${device}: ${v === true ? 'движение' : 'тихо'}`;
  if (attr === 'leak') return `${device}: ${v === true ? 'ПРОТЕЧКА' : 'сухо'}`;
  const channel = /^toggle\.(\w+)$/.exec(attr);
  if (channel) return `${device}: канал ${channel[1]} — ${formatValue(attr, v)}`;
  if (attr === 'open' || attr === 'power') return `${device}: ${formatValue(attr, v)}`;
  return `${device}: ${ATTR_LABEL[attr] ?? attr} — ${formatValue(attr, v)}`;
}
const MARK: Record<ItemResult['status'], string> = { ok: '✓', waiting: '⏳', fail: '✗', unknown: '?' };

const num = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');

export function formatValue(attr: string | undefined, v: Value | undefined): string {
  if (v === undefined || v === null) return 'нет данных';
  if (attr === 'open') return v === true ? 'открыта' : v === false ? 'закрыта' : String(v);
  if (attr === 'leak') return v === true ? 'протечка' : 'сухо';
  if (attr === 'power' || attr?.startsWith('toggle.')) return v === 'on' ? 'включено' : v === 'off' ? 'выключено' : String(v);
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  if (typeof v === 'number') {
    if (attr === 'humidity' || attr === 'battery') return `${num(v)}%`;
    if (attr === 'temperature') return `${num(v)} °C`;
    if (attr === 'power_w') return `${num(v)} Вт`;
    return num(v);
  }
  return String(v);
}

function subject(it: ItemResult, engine: Engine): string {
  if (it.kind === 'time') return 'Время';
  if (it.kind === 'var') return engine.varLabel(it.ref);
  const label = it.attr ? ATTR_LABEL[it.attr] : undefined;
  const who = engine.displayName(it.ref); // the panel's own name, whatever the card refers to
  return label ? `${who}, ${label}` : who;
}

// Variable values read better with their option labels: mode "away" → "ушёл".
const shown = (it: ItemResult, v: Value | undefined, engine: Engine) =>
  (it.kind === 'var' && v !== undefined ? engine.varText(it.ref, v) : null) ?? formatValue(it.attr, v);

function need(it: ItemResult, engine: Engine): string {
  const t = it.target;
  let text: string;
  switch (it.op) {
    case 'between': return String(t);
    case 'is': text = shown(it, t, engine); break;
    case 'not': text = `не ${formatValue(it.attr, t)}`; break;
    case 'above': text = `выше ${formatValue(it.attr, t)}`; break;
    case 'below': text = `ниже ${formatValue(it.attr, t)}`; break;
    default: {
      const b = it.baseline;
      const shift = b ? (b.relative ? `${num(b.amount)}%` : num(b.amount)) : '';
      const dir = it.op === 'above_baseline' ? 'выше' : 'ниже';
      text = b?.value != null && t !== null
        ? `${dir} обычной на ${shift}: порог ${formatValue(it.attr, t)} (обычно ${formatValue(it.attr, b.value)})`
        : `${dir} обычной на ${shift}`;
    }
  }
  return it.needForMs !== undefined ? `${text}, держится ${formatDuration(it.needForMs)}` : text;
}

// What a condition asks for, without the current value or the hold time: "Дверь лоджии: открыта".
export function requirementText(it: ItemResult, engine: Engine): string {
  return `${subject(it, engine)}: ${need({ ...it, needForMs: undefined }, engine)}`;
}

// The current value in a few words: "сейчас: закрыта", "уже 2 мин из 5 мин".
export function currentText(it: ItemResult, engine: Engine): string {
  if (it.reason) return itemText(it, engine);
  if (it.kind === 'time') return `сейчас ${it.value}`;
  const value = `сейчас: ${shown(it, it.value, engine)}`;
  return it.status === 'waiting' ? `${value} — уже ${formatDuration(it.trueForMs ?? 0)} из ${formatDuration(it.needForMs ?? 0)}` : value;
}

// The condition line without the status mark (the web panel shows the mark itself).
export function itemText(it: ItemResult, engine: Engine): string {
  const who = subject(it, engine);
  switch (it.reason) {
    case 'device_missing': return `${it.ref}: нет такого устройства в CUBE`;
    case 'device_ambiguous': return `${it.ref}: в CUBE несколько устройств с таким именем`;
    case 'offline': return `${it.ref}: не в сети`;
    case 'no_value': return `${who}: устройство не присылает «${it.attr}»`;
    case 'baseline_insufficient': {
      const b = it.baseline!;
      return `${who}: ${formatValue(it.attr, it.value)} — мало истории для обычного уровня (${b.samples} замеров из ${b.needed})`;
    }
    case 'var_missing': return `${it.ref}: такой переменной нет в настройках`;
    case 'no_window': return `${who}: окно не наступит (солнце не встаёт или не садится)`;
  }
  if (it.kind === 'time') return `${who}: ${it.value} ${it.status === 'ok' ? `— подходит (${it.target})` : `(нужно: ${it.target})`}`;
  let line = `${who}: ${shown(it, it.value, engine)}`;
  if (it.status === 'waiting') line += ` — уже ${formatDuration(it.trueForMs ?? 0)} из ${formatDuration(it.needForMs ?? 0)}`;
  else if (it.status === 'fail') line += ` (нужно: ${need(it, engine)})`;
  return line;
}

export function describeItem(it: ItemResult, engine: Engine): string {
  return `${MARK[it.reason ? 'unknown' : it.status]} ${itemText(it, engine)}`;
}

function clock(ts: number, now: number, tz: string): string {
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, ...o }).format(ts);
  const sameDay = fmt({ day: '2-digit', month: '2-digit' }) === new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(now);
  const time = fmt({ hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${fmt({ day: '2-digit', month: '2-digit' })} ${time}`;
}

const actionsText = (d: JournalData) => resultsText(d.actions);

// One history line per meaningful journal entry; noise (no change worth telling) returns null.
export function describeEntry(e: JournalEntry<JournalData>, engine: Engine): string | null {
  const d = e.data;
  switch (e.outcome) {
    case 'fired': return `сработало: ${actionsText(d)}`;
    case 'action_error': return `пыталось сработать, но: ${actionsText(d)}`;
    case 'cooldown': return `условие выполнилось, но пауза после прошлого раза — ещё ${formatDuration(d.cooldownLeftMs ?? 0)}`;
    case 'released': return 'условие перестало выполняться';
    case 'otherwise_scheduled': return `условие перестало выполняться — «иначе» через ${formatDuration(d.otherwiseInMs ?? 0)}`;
    case 'otherwise_done': return `выполнено «иначе»: ${actionsText(d)}`;
    case 'otherwise_cancelled': return 'условие вернулось — отложенное «иначе» отменено';
  }
  const missed = d.items.find((it) => it.wasTrueForMs !== undefined && it.needForMs !== undefined && it.wasTrueForMs < it.needForMs);
  if (missed) {
    return `${subject(missed, engine)}: держалось ${formatDuration(missed.wasTrueForMs!)}, а нужно ${formatDuration(missed.needForMs!)} — не сработало`;
  }
  const waiting = d.items.find((it) => it.status === 'waiting');
  if (waiting) return `${subject(waiting, engine)}: ${formatValue(waiting.attr, waiting.value)} — жду ${formatDuration(waiting.needForMs ?? 0)}`;
  return null;
}

export function explainRule(rule: Rule, engine: Engine, store: Store, now: number, tz: string): string {
  const snap = engine.snapshot(rule);
  const rt = engine.runtime(rule.id);
  const head = snap.overall === 'ok' ? 'выполняется' : snap.overall === 'waiting' ? 'ждёт' : 'не выполняется';
  const lines = [`«${rule.name}» (${rule.id})`, `Сейчас: ${head}${'any' in rule.when ? ' (достаточно одного условия)' : ''}.`];
  for (const it of snap.items) lines.push(`  ${describeItem(it, engine)}`);
  if (rt?.otherwiseDueAt) lines.push(`«Иначе» выполнится через ${formatDuration(rt.otherwiseDueAt - now)}.`);

  const last = store.lastJournal<JournalData>(rule.id, ['fired']);
  lines.push(last ? `Последний раз сработало: ${clock(last.ts, now, tz)}.` : 'Ещё не срабатывало.');

  const history = store.journal<JournalData>(rule.id, now - 86_400_000, 40)
    .map((e) => ({ e, text: describeEntry(e, engine) }))
    .filter((x): x is { e: JournalEntry<JournalData>; text: string } => x.text !== null)
    .slice(0, 8);
  if (history.length) {
    lines.push('За сутки:');
    for (const { e, text } of history) lines.push(`  • ${clock(e.ts, now, tz)} — ${text}`);
  }
  return lines.join('\n');
}
