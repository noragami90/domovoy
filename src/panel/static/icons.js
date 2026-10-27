// Line icons in the NSPanel manner (24×24, round caps), and which icon a device, a scene or a mode gets.
const PATHS = {
  light: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z',
  temp: 'M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0zM12 11v6',
  door: 'M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M4 21h16M14 12h.01',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  motion: 'M13 4a1.5 1.5 0 1 0 0 .01M9 21l2-6 3 3v3M7 12l3-4 4 2 3 3M10 8l-1 5',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  fan: 'M12 12c0-4 1-8 4-8 2 0 3 2 1.5 4S13 11 12 12zm0 0c4 0 8 1 8 4 0 2-2 3-4 1.5S13 13 12 12zm0 0c0 4-1 8-4 8-2 0-3-2-1.5-4S11 13 12 12zm0 0c-4 0-8-1-8-4 0-2 2-3 4-1.5S11 11 12 12z',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18',
  power: 'M12 3v8M7.5 6.5a7 7 0 1 0 9 0',
  chevron: 'M9 5l7 7-7 7',
  play: 'M8 5.5v13l10.5-6.5z',
  home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  away: 'M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M10 16l4-4-4-4M14 12H4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  suitcase: 'M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M4 7h16v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 12h16',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4',
  shield: 'M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  battery: 'M3 8h15v8H3zM21 11v2M6 11v2',
  signal: 'M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0M12 19h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6z',
  rules: 'M4 6h10M4 12h16M4 18h8M17 4l3 2-3 2',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5',
  send: 'M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z',
  archive: 'M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  x: 'M6 6l12 12M18 6 6 18',
  left: 'M15 5l-7 7 7 7',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  plus: 'M12 5v14M5 12h14',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
};

export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'ic');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', PATHS[name] ?? PATHS.power);
  s.append(p);
  return s;
}

export function deviceIcon(d) {
  const keys = d.attrs.map((a) => a.key);
  if (keys.includes('leak')) return 'drop';
  if (keys.includes('open')) return 'door';
  if (keys.includes('motion') || keys.includes('detected')) return 'motion';
  if (keys.includes('temperature') || keys.includes('humidity')) return 'temp';
  const text = `${d.name} ${d.cubeName ?? ''} ${d.category ?? ''}`;
  if (/вытяж|вентил|fan/i.test(text)) return 'fan';
  if (/гирлянд|garland|led strip/i.test(text)) return 'sparkle';
  if (/розетк|plug|socket/i.test(text)) return 'plug';
  if (d.attrs.some((a) => a.control === 'switch')) return 'light';
  return 'plug';
}

const BY_WORD = [[/^home$|дома/i, 'home'], [/away|ушёл|ушел/i, 'away'], [/night|ноч/i, 'moon'], [/vacation|отпуск/i, 'suitcase'], [/movie|кино|фильм/i, 'film']];
export const sceneIcon = (s) => BY_WORD.find(([re]) => re.test(s.id) || re.test(s.name))?.[1] ?? 'play';
export const modeIcon = (o) => BY_WORD.find(([re]) => re.test(o.value) || re.test(o.label))?.[1] ?? 'shield';
