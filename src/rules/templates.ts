// Ready-made cards from the apartment's scenarios: pick devices from lists, get a card to review and save.
import type { Device } from '../cube/normalize.ts';

export type ParamType = 'sensor' | 'switch' | 'number' | 'duration' | 'time' | 'text';
export interface Param { key: string; label: string; type: ParamType; attrs?: string[]; default?: string | number }
export interface Template {
  id: string; name: string; description: string; kind: 'rule' | 'scene';
  params: Param[];
  build(p: Record<string, string>): Record<string, unknown>;
}
export interface ParamOption { value: string; label: string }

// A switch parameter's value is "<device>|<attr>" (power or a channel).
const target = (v: string) => {
  const [device, attr] = v.split('|');
  return { device: device!, attr: attr || 'power' };
};
const num = (v: string) => Number(String(v).replace(',', '.'));

export const TEMPLATES: Template[] = [
  {
    id: 'leak', name: 'Протечка', kind: 'rule',
    description: 'Датчик протечки сработал — уведомить и выключить прибор (стиральную или посудомоечную машину).',
    params: [
      { key: 'sensor', label: 'Датчик протечки', type: 'sensor', attrs: ['leak'] },
      { key: 'appliance', label: 'Что выключить', type: 'switch' },
    ],
    build: (p) => ({
      name: `Протечка: ${p.sensor}`, description: 'Сделано из шаблона «Протечка».',
      when: { all: [{ device: p.sensor, attr: 'leak', is: true }] },
      then: [{ notify: `Протечка: ${p.sensor}!`, urgent: true }, { set: { ...target(p.appliance!), to: 'off' } }],
    }),
  },
  {
    id: 'humidity-fan', name: 'Вытяжка по влажности', kind: 'rule',
    description: 'Влажность выше обычной — включить вытяжку, после спада — выключить с задержкой.',
    params: [
      { key: 'sensor', label: 'Датчик влажности', type: 'sensor', attrs: ['humidity'] },
      { key: 'fan', label: 'Вытяжка', type: 'switch' },
      { key: 'rise', label: 'На сколько пунктов выше обычной', type: 'number', default: 15 },
      { key: 'after', label: 'Выключить через', type: 'duration', default: '10m' },
    ],
    build: (p) => ({
      name: `Вытяжка: ${p.sensor}`, description: 'Сделано из шаблона «Вытяжка по влажности».',
      when: { all: [{ device: p.sensor, attr: 'humidity', above_baseline: num(p.rise!) }] },
      then: [{ set: { ...target(p.fan!), to: 'on' } }],
      otherwise: { after: p.after, do: [{ set: { ...target(p.fan!), to: 'off' } }] },
    }),
  },
  {
    id: 'presence-light', name: 'Свет по присутствию', kind: 'rule',
    description: 'Есть человек и темно — свет; ушёл — выключить через несколько минут. Для датчика присутствия или движения.',
    params: [
      { key: 'sensor', label: 'Датчик присутствия или движения', type: 'sensor', attrs: ['detected', 'motion'] },
      { key: 'light', label: 'Свет', type: 'switch' },
      { key: 'after', label: 'Выключить через', type: 'duration', default: '5m' },
    ],
    build: (p) => ({
      name: `Свет по присутствию: ${p.sensor}`, description: 'Сделано из шаблона «Свет по присутствию».',
      when: { all: [{ device: p.sensor, attr: p.sensorAttr ?? 'detected', is: true }, { time: { between: ['sunset-30m', 'sunrise+30m'] } }] },
      then: [{ set: { ...target(p.light!), to: 'on' } }],
      otherwise: { after: p.after, do: [{ set: { ...target(p.light!), to: 'off' } }] },
    }),
  },
  {
    id: 'door-ac', name: 'Дверь открыта при кондиционере', kind: 'rule',
    description: 'Дверь или окно открыты дольше N минут, а кондиционер работает — напомнить.',
    params: [
      { key: 'door', label: 'Датчик двери', type: 'sensor', attrs: ['open'] },
      { key: 'minutes', label: 'Через сколько напомнить', type: 'duration', default: '5m' },
    ],
    build: (p) => ({
      name: `Утечка тепла: ${p.door}`, description: 'Сделано из шаблона «Дверь открыта при кондиционере».',
      when: { all: [{ device: p.door, attr: 'open', is: true, for: p.minutes }, { var: 'ac_running', is: true }] },
      then: [{ notify: `Закрой: ${p.door} — кондиционер работает.` }],
      cooldown: '15m',
    }),
  },
  {
    id: 'sunset-light', name: 'Свет по закату', kind: 'rule',
    description: 'Включить с заката до нужного часа (гирлянда, подсветка), только в режиме «дома».',
    params: [
      { key: 'light', label: 'Что включать', type: 'switch' },
      { key: 'until', label: 'До скольки', type: 'time', default: '23:30' },
    ],
    build: (p) => ({
      name: `По закату: ${target(p.light!).device}`, description: 'Сделано из шаблона «Свет по закату».',
      when: { all: [{ time: { between: ['sunset', p.until] } }, { var: 'mode', is: 'home' }] },
      then: [{ set: { ...target(p.light!), to: 'on' } }],
      otherwise: { do: [{ set: { ...target(p.light!), to: 'off' } }] },
    }),
  },
  {
    id: 'door-light', name: 'Свет при открытии двери', kind: 'rule',
    description: 'Открыл шкаф или гардеробную — свет, закрыл — выключить.',
    params: [
      { key: 'door', label: 'Датчик двери', type: 'sensor', attrs: ['open'] },
      { key: 'light', label: 'Свет', type: 'switch' },
    ],
    build: (p) => ({
      name: `Свет при открытии: ${p.door}`, description: 'Сделано из шаблона «Свет при открытии двери».',
      when: { all: [{ device: p.door, attr: 'open', is: true }] },
      then: [{ set: { ...target(p.light!), to: 'on' } }],
      otherwise: { do: [{ set: { ...target(p.light!), to: 'off' } }] },
    }),
  },
  {
    id: 'too-cold', name: 'Холодно в комнате', kind: 'rule',
    description: 'Температура ниже порога дольше 15 минут — уведомить.',
    params: [
      { key: 'sensor', label: 'Датчик температуры', type: 'sensor', attrs: ['temperature'] },
      { key: 'below', label: 'Ниже скольки градусов', type: 'number', default: 18 },
    ],
    build: (p) => ({
      name: `Холодно: ${p.sensor}`, description: 'Сделано из шаблона «Холодно в комнате».',
      when: { all: [{ device: p.sensor, attr: 'temperature', below: num(p.below!), for: '15m' }] },
      then: [{ notify: `${p.sensor}: холоднее ${p.below} °C.` }],
      cooldown: '3h',
    }),
  },
  {
    id: 'power-watch', name: 'Прибор работает слишком долго', kind: 'rule',
    description: 'Розетка со счётчиком потребляет больше N Вт дольше заданного времени — уведомить (утюг, обогреватель).',
    params: [
      { key: 'plug', label: 'Розетка со счётчиком', type: 'sensor', attrs: ['power_w'] },
      { key: 'watts', label: 'Больше скольки ватт', type: 'number', default: 500 },
      { key: 'minutes', label: 'Дольше скольки', type: 'duration', default: '2h' },
    ],
    build: (p) => ({
      name: `Долго работает: ${p.plug}`, description: 'Сделано из шаблона «Прибор работает слишком долго».',
      when: { all: [{ device: p.plug, attr: 'power_w', above: num(p.watts!), for: p.minutes }] },
      then: [{ notify: `${p.plug} потребляет больше ${p.watts} Вт уже ${p.minutes}.` }],
      cooldown: '1h',
    }),
  },
  {
    id: 'scene-leave', name: 'Сцена «Ушёл»', kind: 'scene',
    description: 'Режим «ушёл», выключить всё и предупредить про открытую дверь.',
    params: [{ key: 'door', label: 'Какую дверь проверить', type: 'sensor', attrs: ['open'] }],
    build: (p) => ({
      name: 'Ушёл', description: 'Сделано из шаблона «Сцена «Ушёл»».',
      do: [
        { set_var: { var: 'mode', to: 'away' } },
        { all_off: {} },
        { notify: `${p.door}: осталась открытой.`, if: [{ device: p.door, attr: 'open', is: true }] },
      ],
    }),
  },
];

// Choices for device parameters, from what CUBE reports right now. Values are CUBE names (cards keep
// working when the panel's own name changes); labels are what the panel shows.
export function paramOptions(param: Param, devices: Device[]): ParamOption[] {
  if (param.type === 'switch') {
    return devices.flatMap((d) => Object.keys(d.attrs).filter((a) => /^(power|toggle\.\w+)$/.test(a)).map((a) => ({
      value: `${d.cubeName ?? d.name}|${a}`, label: a === 'power' ? d.name : `${d.name} — канал ${a.slice(7)}`,
    })));
  }
  if (param.type === 'sensor') {
    return devices.filter((d) => param.attrs?.some((a) => a in d.attrs)).map((d) => ({ value: d.cubeName ?? d.name, label: d.name }));
  }
  return [];
}

// Card from a template; fills "sensorAttr" for templates that accept several kinds of sensors.
export function buildFromTemplate(id: string, params: Record<string, string>, devices: Device[]): Record<string, unknown> {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`нет шаблона «${id}»`);
  const p: Record<string, string> = {};
  for (const param of t.params) {
    const v = params[param.key] ?? (param.default !== undefined ? String(param.default) : '');
    if (!v) throw new Error(`не заполнено: ${param.label}`);
    p[param.key] = v;
  }
  const sensor = t.params.find((x) => x.type === 'sensor' && x.attrs && x.attrs.length > 1);
  if (sensor) {
    const dev = devices.find((d) => (d.cubeName ?? d.name) === p[sensor.key] || d.name === p[sensor.key]);
    p.sensorAttr = sensor.attrs!.find((a) => dev && a in dev.attrs) ?? sensor.attrs![0]!;
  }
  const card = t.build(p);
  const slug = `${t.id}-${Date.now().toString(36).slice(-4)}`;
  return { id: slug, ...card };
}
