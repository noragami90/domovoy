// Durations in rule cards: "500ms", "30s", "5m", "1h", "1d", or combined "1h30m".
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;

export function parseDuration(text: string): number {
  const compact = text.replace(/\s+/g, '');
  if (!/^((\d+(?:\.\d+)?)(ms|s|m|h|d))+$/.test(compact)) throw new Error(`Неверная длительность: "${text}" (пример: 30s, 5m, 1h30m)`);
  let total = 0;
  for (const [, num, unit] of compact.matchAll(PART)) total += Number(num) * UNIT_MS[unit!]!;
  return total;
}

// Russian human form: "3 мин 50 с", "1 ч 5 мин", "2 д 3 ч".
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} мс`;
  const s = Math.round(ms / 1_000);
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3_600), m = Math.floor((s % 3_600) / 60), sec = s % 60;
  const parts = d ? [[d, 'д'], [h, 'ч']] : h ? [[h, 'ч'], [m, 'мин']] : m ? [[m, 'мин'], [sec, 'с']] : [[sec, 'с']];
  return parts.filter(([n], i) => i === 0 || n).map(([n, u]) => `${n} ${u}`).join(' ');
}
