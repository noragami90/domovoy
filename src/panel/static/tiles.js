// Device tiles in the NSPanel manner. A light or a plug: tap anywhere on the tile to switch it, «›» opens
// the device page. A two-gang switch: a key per channel. A sensor: the whole tile opens the device page.
// The tap target is a button stretched under the content, so the «›» link is not nested inside it.
import { attrLabel, h } from './dom.js';
import { deviceIcon, icon } from './icons.js';

const page = (d) => `#device/${encodeURIComponent(d.id)}`;
const go = (d) => h('a', { class: 'ns-go', href: page(d), 'aria-label': `Подробнее: ${d.name}` }, icon('chevron'));

function reading(d) {
  const find = (k) => d.attrs.find((a) => a.key === k);
  const temp = find('temperature'), hum = find('humidity'), watts = find('power_w');
  if (temp) return h('div', { class: 'ns-big' }, temp.text.replace(/\s*°C$/, '°'), hum ? h('small', {}, hum.text) : null);
  if (hum) return h('div', { class: 'ns-big' }, hum.text);
  if (watts && !d.attrs.some((a) => a.control === 'switch')) return h('div', { class: 'ns-big' }, watts.text);
  return null;
}

export function deviceTile(d, { control, act }) {
  const sw = d.attrs.filter((a) => a.control === 'switch');
  const open = d.attrs.find((a) => a.key === 'open');
  const alarm = d.attrs.some((a) => a.key === 'leak' && a.value === true);
  const ajar = open?.value === true;
  const multi = sw.length > 1;
  const onCount = sw.filter((a) => a.value === 'on').length;
  const on = sw.length === 1 && sw[0].value === 'on';
  const toggles = sw.length === 1 && d.online;
  const big = reading(d);
  const state = !d.online ? 'не в сети'
    : alarm ? 'Протечка!'
      : multi ? (onCount ? `включено ${onCount} из ${sw.length}` : 'всё выключено')
        : sw.length ? (on ? 'включено' : 'выключено')
          : open ? open.text
            : big ? '' : d.attrs.map((a) => a.text).join(' · ');
  const foot = h('div', { class: 'ns-foot' }, h('div', { class: 'ns-name' }, d.name),
    state ? h('div', { class: `ns-state${d.online ? '' : ' bad'}` }, state) : null);
  const tone = `${on ? ' on' : ''}${multi && onCount ? ' some-on' : ''}${ajar ? ' ajar' : ''}${alarm ? ' alarm' : ''}${d.online ? '' : ' offline'}`;
  const flip = (a) => control(d, a.key, a.value === 'on' ? 'off' : 'on');

  if (multi) {
    return h('article', { class: `ns-tile multi${tone}` },
      h('div', { class: 'ns-head' }, h('span', { class: 'ns-icon' }, icon(deviceIcon(d))), foot, go(d)),
      h('div', { class: 'ns-keys' }, sw.map((a) => {
        const lit = a.value === 'on';
        return h('button', {
          class: `ns-key${lit ? ' on' : ''}`, 'aria-pressed': String(lit), disabled: !d.online,
          'aria-label': `${d.name}, ${attrLabel(a.key)}: ${lit ? 'выключить' : 'включить'}`, onclick: act(() => flip(a)),
        }, icon('power'), h('span', { class: 'ns-key-name' }, attrLabel(a.key)), h('span', { class: 'ns-key-state' }, lit ? 'включён' : 'выключен'));
      })));
  }

  const tile = h('article', { class: `ns-tile${tone}` });
  const hit = toggles
    ? h('button', { class: 'ns-hit', 'aria-pressed': String(on), 'aria-label': `${d.name}: ${on ? 'выключить' : 'включить'}`,
      onclick: act(async () => { tile.classList.add('busy'); try { await flip(sw[0]); } finally { tile.classList.remove('busy'); } }) })
    : h('a', { class: 'ns-hit', href: page(d), 'aria-label': `${d.name}${state ? `, ${state}` : ''}: подробнее` });
  const top = h('div', { class: 'ns-top' }, h('span', { class: 'ns-icon' }, icon(deviceIcon(d))),
    toggles ? go(d) : h('span', { class: 'ns-go', 'aria-hidden': 'true' }, icon('chevron')));
  tile.append(...[hit, top, big, foot].filter(Boolean)); // append() would print a null as text
  return tile;
}
