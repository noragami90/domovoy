// Line chart in plain SVG: values over the chosen range, plus dashed lines from rules
// ("обычно", "порог …"). Hover shows the nearest reading.
import { UNIT, num } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 640, H = 220, L = 44, R = 12, T = 12, B = 26;

function s(tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

function tickTime(ts, rangeMs) {
  const d = new Date(ts);
  return rangeMs > 86_400_000
    ? d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
    : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function renderChart(container, data, rangeMs) {
  const unit = UNIT[data.attr] ?? '';
  const end = Date.now();
  const start = end - rangeMs;
  const values = [...data.points.map((p) => p[1]), ...data.lines.map((l) => l.value)];
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `График: ${data.device}` });
  if (!data.points.length) {
    svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart-empty' }, 'Нет данных за этот период'));
    container.replaceChildren(svg);
    return;
  }
  let lo = Math.min(...values), hi = Math.max(...values);
  if (hi - lo < 1) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const x = (ts) => L + ((ts - start) / (end - start)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  for (const v of [lo + pad, (lo + hi) / 2, hi - pad]) {
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'chart-grid' }));
    svg.append(s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'chart-tick' }, `${num(v)}${unit.trim() === '%' ? '%' : ''}`));
  }
  for (const ts of [start, (start + end) / 2, end]) {
    svg.append(s('text', { x: x(ts), y: H - 8, 'text-anchor': ts === start ? 'start' : ts === end ? 'end' : 'middle', class: 'chart-tick' }, tickTime(ts, end - start)));
  }
  for (const line of data.lines) {
    svg.append(s('line', { x1: L, x2: W - R, y1: y(line.value), y2: y(line.value), class: line.label === 'обычно' ? 'chart-base' : 'chart-limit' }));
    svg.append(s('text', { x: W - R - 4, y: y(line.value) - 5, 'text-anchor': 'end', class: line.label === 'обычно' ? 'chart-base-label' : 'chart-limit-label' }, `${line.label}: ${num(line.value)}${unit}`));
  }
  const pts = data.points.map(([ts, v]) => [x(ts), y(v)]);
  const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
  svg.append(s('path', { d: `${d}L${pts.at(-1)[0].toFixed(1)},${H - B}L${pts[0][0].toFixed(1)},${H - B}Z`, class: 'chart-area' }));
  svg.append(s('path', { d, class: 'chart-line' }));

  const dot = s('circle', { r: 4, class: 'chart-dot', visibility: 'hidden' });
  const tip = s('text', { class: 'chart-tip', visibility: 'hidden' });
  const hit = s('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' });
  hit.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const mx = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - mx) < Math.abs(pts[best][0] - mx)) best = i;
    const [px, py] = pts[best];
    const [ts, v] = data.points[best];
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
    tip.textContent = `${tickTime(ts, 0)} — ${num(v)}${unit}`;
    tip.setAttribute('x', Math.min(Math.max(px, L + 60), W - R - 60));
    tip.setAttribute('y', Math.max(py - 10, T + 12));
    tip.setAttribute('text-anchor', 'middle');
    tip.setAttribute('visibility', 'visible');
  });
  hit.addEventListener('mouseleave', () => { dot.setAttribute('visibility', 'hidden'); tip.setAttribute('visibility', 'hidden'); });
  svg.append(dot, tip, hit);
  container.replaceChildren(svg);
}
