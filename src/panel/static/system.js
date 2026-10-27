// "Система" tab: CUBE address and token, Telegram chats, rooms and own names, protected devices and door
// sensors, backups, the engine log, and how to reach the panel from outside and from the phone's home screen.
// One column of sections of the same width, like a settings screen; chips on top jump to a section.
import { ago, api, clock, fill, h } from './dom.js';
import { icon } from './icons.js';

const size = (n) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
const SECTIONS = [['cube', 'CUBE'], ['telegram', 'Telegram'], ['rooms', 'Комнаты и имена'], ['devices', 'Устройства'], ['backups', 'Резервные копии'], ['access', 'Доступ'], ['log', 'Лог']];

// A section: an icon in a circle, the title and, on the right, how it is doing.
const section = (id, ic, title, status, ...body) => h('section', { class: 'card sys-card', id: `sys-${id}` },
  h('header', { class: 'sys-head' }, h('span', { class: 'sys-ic' }, icon(ic)), h('h3', { class: 'sys-title' }, title),
    status ? h('span', { class: `sys-pill ${status[0]}` }, status[1]) : null),
  ...body);
const sub = (text) => h('h4', { class: 'sys-sub' }, text);
const hint = (text) => h('p', { class: 'muted sys-hint' }, text);
const field = (label, ...rest) => h('div', { class: 'sys-field' }, h('span', { class: 'sys-label' }, label), ...rest);

export function createSystem(root, { onError, toast }) {
  let data = null;
  let armed = null;      // a two-step button waiting for the second press: 'restart', 'restore:<name>', 'chat:<id>'
  let restored = null;   // the result of the last restore (offers a restart)

  const run = (fn, ok) => async (...args) => {
    try { await fn(...args); if (ok) toast(ok, 'notice'); await load(); } catch (e) { onError(e); }
  };
  const twoStep = (key, label, confirm, fn, cls = 'btn') => h('button', {
    class: armed === key ? 'btn danger' : cls,
    onclick: () => {
      if (armed !== key) { armed = key; render(); setTimeout(() => { if (armed === key) { armed = null; render(); } }, 4000); return; }
      armed = null;
      void fn();
    },
  }, armed === key ? confirm : label);

  function cubeCard() {
    const c = data.cube;
    const url = h('input', { type: 'url', class: 'sys-input', value: c.url, disabled: c.urlFromEnv, 'aria-label': 'Адрес CUBE' });
    const t = c.token;
    return section('cube', 'cube', 'CUBE', c.connected ? ['ok', `на связи с ${clock(c.since)}`] : ['bad', 'нет связи'],
      !c.connected && c.detail ? h('p', { class: 'ed-issue sys-line' }, c.detail) : null,
      c.bridge ? hint([c.bridge.name, c.bridge.fw_version && `прошивка ${c.bridge.fw_version}`, c.bridge.ip].filter(Boolean).join(' · ')) : null,
      field('Адрес', url, c.urlFromEnv ? null : h('button', { class: 'btn', onclick: run(async () => { const r = await api('/api/system/cube', { url: url.value }); toast(`Подключаюсь: ${r.bridge.name ?? 'CUBE'}`, 'notice'); }) }, 'Подключить')),
      field('Токен', h('span', { class: 'sys-value' }, c.hasToken ? 'есть' : 'нет'),
        c.urlFromEnv ? null : h('button', { class: c.hasToken ? 'btn' : 'btn primary', disabled: t.state === 'waiting', onclick: run(() => api('/api/system/cube/token', {})) }, c.hasToken ? 'Получить новый' : 'Получить токен')),
      field('События', h('span', { class: 'sys-value' }, `${c.events}${c.lastEventAt ? `, последнее ${ago(c.lastEventAt)} назад` : ''} · переподключений: ${c.reconnects}`)),
      t.state === 'waiting' ? h('p', { class: 'sys-wait' }, `Открой веб-консоль CUBE (${c.url}) — там появится окно с запросом доступа для «domovoy». Нажми «Готово». Жду до ${clock(t.until)}.`) : null,
      t.state === 'done' ? h('p', { class: 'ed-ok' }, 'Токен получен и сохранён в .env — движок подключился.') : null,
      t.state === 'failed' ? h('p', { class: 'ed-issue' }, `Токен не получен: ${t.error}`) : null,
      c.urlFromEnv ? hint(`${c.simulator ? 'Сейчас это симулятор: адрес' : 'Адрес'} и токен заданы в docker-compose.yml (CUBE_URL, CUBE_TOKEN). Чтобы подключить настоящую CUBE, убери эти две строки и перезапусти — дальше адрес и токен задаются здесь.`) : null);
  }

  function telegramCard() {
    const t = data.telegram;
    const person = (chat) => h('select', {
      'aria-label': 'Чей чат', onchange: run(async (e) => {
        const before = t.people.find((p) => p.telegram === chat.id);
        if (before && before.id !== e.target.value) await api(`/api/system/people/${encodeURIComponent(before.id)}`, { chat: null });
        if (e.target.value) await api(`/api/system/people/${encodeURIComponent(e.target.value)}`, { chat: chat.id });
      }, 'Сохранено'),
    }, h('option', { value: '' }, 'чей — не указано'), t.people.map((p) => h('option', { value: p.id, selected: chat.person === p.id }, p.name)));
    return section('telegram', 'send', 'Telegram', t.enabled ? ['ok', t.bot ? `@${t.bot}` : 'бот на связи'] : ['bad', 'бот не подключён'],
      t.enabled ? null : hint('Создай бота у @BotFather и добавь строку TELEGRAM_BOT_TOKEN=… в файл .env рядом с config.yaml, затем перезапусти движок.'),
      sub('Чаты, которые получают уведомления и могут командовать'),
      t.chats.length ? h('ul', { class: 'sys-list' }, t.chats.map((c) => h('li', { class: 'sys-item' },
        h('code', {}, String(c.id)), person(c),
        t.fromEnv ? null : twoStep(`chat:${c.id}`, 'Убрать', 'Точно убрать?', run(() => api('/api/system/telegram/chat', { id: c.id, add: false }), 'Чат убран'))))) : hint('Пока ни одного.'),
      t.pending.length ? sub('Написали боту, но их нет в списке') : null,
      t.pending.length ? h('ul', { class: 'sys-list' }, t.pending.map((p) => h('li', { class: 'sys-item' },
        h('span', { class: 'sys-grow' }, `${p.name}${p.username ? ` (@${p.username})` : ''} · ${clock(p.at)}`),
        t.fromEnv ? null : h('button', { class: 'btn primary', onclick: run(() => api('/api/system/telegram/chat', { id: p.id, add: true }), 'Чат добавлен') }, 'Добавить')))) : null,
      t.fromEnv ? hint('Чаты заданы переменной TELEGRAM_CHATS — правь её в .env.') : t.enabled ? hint('Новый человек пишет боту /start — его чат появится здесь с кнопкой «Добавить».') : null);
  }

  function roomsCard() {
    const d = data.devices;
    const rooms = d.rooms;
    const add = h('input', { type: 'text', class: 'sys-input', placeholder: 'Новая комната, например «Кухня»', 'aria-label': 'Новая комната' });
    const roomSelect = (dev) => h('select', { 'aria-label': `Комната: ${dev.name}`, onchange: run((e) => api('/api/system/device', { cubeName: dev.cubeName, room: e.target.value || null }), 'Сохранено') },
      h('option', { value: '' }, 'без комнаты'), rooms.map((r) => h('option', { value: r, selected: dev.room === r }, r)));
    const move = (r, step, ic, label, off) => h('button', { class: 'btn icon', disabled: off, 'aria-label': `${label}: ${r}`, onclick: run(() => api('/api/system/rooms', { move: [r, step] })) }, icon(ic));
    return section('rooms', 'home', 'Комнаты и имена', ['', rooms.length ? `комнат: ${rooms.length}` : 'комнат нет'],
      hint('Свои имена видны в панели, ленте, Telegram и «Почему?». Правила ссылаются на имена из CUBE, поэтому переименование здесь их не ломает, а в приложении eWeLink ничего не меняется.'),
      sub('Комнаты — в этом порядке на главном и на планшете'),
      rooms.length ? h('ul', { class: 'sys-list' }, rooms.map((r, i) => h('li', { class: 'sys-room' },
        h('input', { type: 'text', class: 'sys-input', value: r, 'aria-label': `Название комнаты ${r}`, onchange: run((e) => api('/api/system/rooms', { rename: [r, e.target.value] }), 'Переименовано') }),
        move(r, -1, 'up', 'Выше', i === 0), move(r, 1, 'down', 'Ниже', i === rooms.length - 1),
        twoStep(`room:${r}`, 'Удалить', 'Точно удалить?', run(() => api('/api/system/rooms', { remove: r }), 'Комната удалена'))))) : hint('Комнат пока нет.'),
      h('div', { class: 'sys-add' }, add, h('button', { class: 'btn', onclick: run(async () => { if (add.value.trim()) await api('/api/system/rooms', { add: add.value }); }, 'Комната добавлена') }, 'Добавить')),
      sub('Устройства'),
      d.all.length ? h('ul', { class: 'sys-list' }, d.all.map((dev) => h('li', { class: 'sys-dev' },
        h('span', { class: 'sys-dev-name' },
          h('input', { type: 'text', class: 'sys-input', value: dev.label ?? '', placeholder: dev.cubeName, maxlength: '60', 'aria-label': `Имя в панели для ${dev.cubeName}`,
            onchange: run((e) => api('/api/system/device', { cubeName: dev.cubeName, label: e.target.value || null }), 'Имя сохранено') }),
          h('span', { class: 'muted sys-cube' }, `в CUBE: ${dev.cubeName}`)),
        roomSelect(dev)))) : hint('CUBE пока не вернула устройств.'));
  }

  function devicesCard() {
    const d = data.devices;
    const protectedNow = () => d.switches.filter((s) => s.protected).map((s) => s.cubeName);
    const count = protectedNow().length;
    return section('devices', 'shield', 'Устройства', ['', count ? `не управлять: ${count}` : 'все под управлением'],
      sub('Не управлять: движок, сцены и панель их не включают и не выключают'),
      d.switches.length ? h('ul', { class: 'sys-list' }, d.switches.map((s) => h('li', { class: 'sys-item' }, h('label', { class: 'sys-check' },
        h('input', { type: 'checkbox', checked: s.protected, onchange: run((e) => api('/api/system/protected', { devices: e.target.checked ? [...protectedNow(), s.cubeName] : protectedNow().filter((n) => n !== s.cubeName) }), 'Сохранено') }),
        s.name)))) : hint('Нет устройств, которыми можно управлять.'),
      sub('Датчики дверей и окон'),
      d.doors.length ? h('ul', { class: 'sys-list' }, d.doors.map((x) => h('li', { class: 'sys-item' },
        h('span', { class: 'sys-grow' }, h('b', {}, x.name), h('span', { class: 'muted' }, ` — сейчас ${x.open === null ? 'нет данных' : x.open ? 'открыта' : 'закрыта'}`)),
        h('select', { 'aria-label': `Как читать датчик ${x.name}`, onchange: run((e) => api('/api/system/doors', { device: x.cubeName, mode: e.target.value }), 'Сохранено, датчик перечитан') },
          h('option', { value: 'closed', selected: x.mode === 'closed' }, 'магнит рядом = закрыто'),
          h('option', { value: 'open', selected: x.mode === 'open' }, 'магнит рядом = открыто'))))) : hint('Датчиков дверей нет.'),
      d.doors.length ? hint('Если панель пишет «открыта», когда дверь закрыта, — переключи этот датчик.') : null);
  }

  function backupsCard() {
    const file = h('input', { type: 'file', class: 'sys-file', accept: '.gz,application/gzip', 'aria-label': 'Файл резервной копии' });
    const restoreFile = async () => {
      const f = file.files?.[0];
      if (!f) { toast('Выбери файл копии'); return; }
      const res = await fetch('/api/system/restore', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      restored = body;
    };
    const local = async (name) => { restored = await api('/api/system/restore-local', { name }); };
    const copies = data.backups.local;
    return section('backups', 'archive', 'Резервные копии', ['', copies.length ? `последняя ${clock(copies[0].ts)}` : 'копий нет'],
      h('div', { class: 'sys-actions' },
        h('a', { class: 'btn primary', href: '/api/system/backup?history=1', download: '' }, 'Скачать копию'),
        h('a', { class: 'btn', href: '/api/system/backup?history=0', download: '' }, 'Без истории (меньше)'),
        h('button', { class: 'btn', onclick: run(async () => { const r = await api('/api/system/backup', {}); toast(`Сделана копия: ${r.name}`, 'notice'); }) }, 'Сделать сейчас')),
      hint('В копии: config.yaml, правила, сцены и история. Ключи и токены из .env не входят — сохрани их отдельно. Копии ниже делаются сами раз в сутки и лежат на той же карте памяти; от её поломки спасёт только скачанная копия.'),
      restored ? h('div', { class: 'sys-restored' },
        h('p', { class: 'ed-ok' }, `Восстановлено: правил ${restored.rules}, сцен ${restored.scenes}${restored.configChanged ? ', настройки' : ''}. Прежние файлы отложены в .trash и *.before-restore-*.`),
        restored.history || restored.configChanged ? h('p', {}, 'История и часть настроек вернутся после перезапуска движка. ',
          twoStep('restart', 'Перезапустить сейчас', 'Точно перезапустить?', run(() => api('/api/system/restart', {}), 'Перезапускаюсь…'), 'btn primary')) : null) : null,
      sub('Копии на этом устройстве'),
      copies.length ? h('ul', { class: 'sys-list' }, copies.map((b) => h('li', { class: 'sys-item' },
        h('span', { class: 'sys-grow' }, `${clock(b.ts)} · ${size(b.size)}`),
        twoStep(`restore:${b.name}`, 'Восстановить', 'Точно вернуть?', run(() => local(b.name), 'Копия восстановлена'))))) : hint('Автоматических копий пока нет.'),
      sub('Из файла'),
      h('div', { class: 'sys-add' }, file, twoStep('restore:file', 'Восстановить', 'Точно? Текущие правила уйдут в .trash', run(restoreFile, 'Копия восстановлена'))));
  }

  function accessCard() {
    return section('access', 'globe', 'Доступ снаружи, иконка и планшет', null,
      sub('Снаружи — через Tailscale'),
      hint('Это личная сеть между твоими устройствами, без открытия портов на роутере. Пароль панели остаётся.'),
      h('ol', { class: 'sys-steps' },
        h('li', {}, 'Заведи бесплатный аккаунт на tailscale.com.'),
        h('li', {}, 'В веб-консоли CUBE открой «Дополнения» (Docker), установи tailscale/TailScale и запусти. Нужна версия CUBE 1.8 или новее.'),
        h('li', {}, 'Нажми «Go to TailScale», затем «Connect» и войди своим аккаунтом.'),
        h('li', {}, 'Поставь приложение Tailscale на телефон, войди тем же аккаунтом и включи.'),
        h('li', {}, 'На странице TailScale в CUBE виден адрес вида 100.x.y.z. Открой на телефоне http://100.x.y.z:<порт панели> — порт тот, что задан при запуске контейнера «Домового».')),
      hint('Шаги — по инструкции eWeLink для дополнения TailScale; названия кнопок сверь с интерфейсом своей CUBE. Если по адресу Tailscale открывается CUBE, а панель нет — проверь, что порт контейнера «Домового» опубликован на хосте. На Маке панель открыта только для этого компьютера (127.0.0.1) — снаружи она будет доступна, когда переедет на Pi.'),
      sub('Иконка на экран телефона'),
      hint('iPhone: открой панель в Safari → «Поделиться» → «На экран «Домой»». Android: Chrome → меню ⋮ → «Добавить на главный экран». Добавляй с адреса Tailscale — тогда иконка работает и дома, и снаружи.'),
      sub('Планшет на стене'),
      hint('Открой на планшете адрес панели с #tablet в конце (например http://<адрес>:<порт>/#tablet): те же экраны, что на главном, во весь экран и крупнее — листаются вбок. Подойдёт любой планшет или старый телефон с браузером. NSPanel Pro сама веб-страницы не открывает — по опыту сообщества, их показывают через установленный вручную Fully Kiosk Browser (неофициально).'),
      h('div', { class: 'sys-actions' }, h('a', { class: 'btn', href: '#tablet' }, 'Открыть режим планшета')));
  }

  function logCard() {
    const pre = h('pre', { class: 'sys-log' }, 'Загружаю…');
    const loadLog = async () => {
      try { const r = await api('/api/system/log'); pre.textContent = r.lines.join('\n') || 'Пусто.'; pre.scrollTop = pre.scrollHeight; } catch (e) { onError(e); }
    };
    void loadLog();
    return section('log', 'terminal', 'Лог движка', ['', `запущен ${clock(data.startedAt)}`],
      pre,
      h('div', { class: 'sys-actions' }, h('button', { class: 'btn', onclick: () => void loadLog() }, 'Обновить'),
        twoStep('restart', 'Перезапустить движок', 'Точно перезапустить?', run(() => api('/api/system/restart', {}), 'Перезапускаюсь…'))),
      hint('Перезапуск: движок останавливается, Docker запускает его снова (у контейнера должно быть restart: unless-stopped).'));
  }

  const jump = (id) => document.getElementById(`sys-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  function render() {
    if (!data) return;
    fill(root,
      h('div', { class: 'sys-page' },
        h('h2', { class: 'ed-title sys-page-title' }, 'Система'),
        h('nav', { class: 'sys-nav', 'aria-label': 'Разделы системы' }, SECTIONS.map(([id, label]) => h('button', { class: 'chip-btn', onclick: () => jump(id) }, label))),
        cubeCard(), telegramCard(), roomsCard(), devicesCard(), backupsCard(), accessCard(), logCard()));
  }

  async function load() {
    try { data = await api('/api/system'); render(); } catch (e) { onError(e); }
  }

  return {
    show: () => { restored = null; return load(); },
    refresh: () => {
      const typing = ['INPUT', 'SELECT'].includes(document.activeElement?.tagName) && root.contains(document.activeElement);
      return data && !typing && !armed ? load() : undefined;
    },
  };
}
