// "Система" tab: CUBE address and token, Telegram chats, protected devices, door sensors,
// backups, the engine log, and how to reach the panel from outside and from the phone's home screen.
import { ago, api, clock, fill, h } from './dom.js';

const size = (n) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);
const card = (title, ...body) => h('section', { class: 'card sys-card' }, h('h3', { class: 'nt-h' }, title), ...body);

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

  // ── CUBE ──
  function cubeCard() {
    const c = data.cube;
    const status = c.connected ? `на связи с ${clock(c.since)}` : `нет связи${c.detail ? `: ${c.detail}` : ''}`;
    const url = h('input', { type: 'url', class: 'sys-input', value: c.url, disabled: c.urlFromEnv, 'aria-label': 'Адрес CUBE' });
    const t = c.token;
    return card('CUBE',
      h('p', { class: `sys-status ${c.connected ? 'ok' : 'bad'}` }, h('span', { class: 'dg-dot' }), status),
      c.bridge ? h('p', { class: 'muted sys-line' }, [c.bridge.name, c.bridge.fw_version && `прошивка ${c.bridge.fw_version}`, c.bridge.ip].filter(Boolean).join(' · ')) : null,
      h('div', { class: 'sys-row' }, h('span', { class: 'sys-label' }, 'Адрес'), url,
        c.urlFromEnv ? null : h('button', { class: 'btn', onclick: run(async () => { const r = await api('/api/system/cube', { url: url.value }); toast(`Подключаюсь: ${r.bridge.name ?? 'CUBE'}`, 'notice'); }) }, 'Проверить и подключить')),
      c.urlFromEnv ? h('p', { class: 'muted sys-hint' }, 'Адрес и токен заданы в docker-compose.yml (CUBE_URL, CUBE_TOKEN) — сейчас это симулятор. Чтобы подключить настоящую CUBE, убери эти две строки из docker-compose.yml и перезапусти; дальше адрес и токен задаются здесь.') : null,
      h('div', { class: 'sys-row' }, h('span', { class: 'sys-label' }, 'Токен'), h('span', {}, c.hasToken ? 'есть' : 'нет'),
        c.urlFromEnv ? null : h('button', { class: c.hasToken ? 'btn' : 'btn primary', disabled: t.state === 'waiting', onclick: run(() => api('/api/system/cube/token', {})) }, c.hasToken ? 'Получить новый' : 'Получить токен')),
      t.state === 'waiting' ? h('p', { class: 'sys-wait' }, `Открой веб-консоль CUBE (${c.url}) — там появится окно с запросом доступа для «domovoy». Нажми «Готово». Жду до ${clock(t.until)}.`) : null,
      t.state === 'done' ? h('p', { class: 'ed-ok' }, 'Токен получен и сохранён в .env — движок подключился.') : null,
      t.state === 'failed' ? h('p', { class: 'ed-issue' }, `Токен не получен: ${t.error}`) : null,
      h('p', { class: 'muted sys-line' }, `События: ${c.events}${c.lastEventAt ? `, последнее ${ago(c.lastEventAt)} назад` : ''} · переподключений: ${c.reconnects}${c.simulator ? ' · симулятор' : ''}`));
  }

  // ── Telegram ──
  function telegramCard() {
    const t = data.telegram;
    const person = (chat) => h('select', {
      'aria-label': 'Чей чат', onchange: run(async (e) => {
        const before = t.people.find((p) => p.telegram === chat.id);
        if (before && before.id !== e.target.value) await api(`/api/system/people/${encodeURIComponent(before.id)}`, { chat: null });
        if (e.target.value) await api(`/api/system/people/${encodeURIComponent(e.target.value)}`, { chat: chat.id });
      }, 'Сохранено'),
    }, h('option', { value: '' }, 'чей — не указано'), t.people.map((p) => h('option', { value: p.id, selected: chat.person === p.id }, p.name)));
    return card('Telegram',
      h('p', { class: `sys-status ${t.enabled ? 'ok' : 'bad'}` }, h('span', { class: 'dg-dot' }), t.enabled ? `бот ${t.bot ? `@${t.bot}` : ''} на связи` : 'бот не подключён'),
      t.enabled ? null : h('p', { class: 'muted sys-hint' }, 'Создай бота у @BotFather и добавь строку TELEGRAM_BOT_TOKEN=… в файл .env рядом с config.yaml, затем перезапусти движок.'),
      t.fromEnv ? h('p', { class: 'muted sys-hint' }, 'Чаты заданы переменной TELEGRAM_CHATS — правь её в .env.') : null,
      h('div', { class: 'sys-label' }, 'Чаты, которые получают уведомления и могут командовать'),
      t.chats.length ? h('ul', { class: 'sys-list' }, t.chats.map((c) => h('li', {},
        h('code', {}, String(c.id)), person(c),
        t.fromEnv ? null : twoStep(`chat:${c.id}`, 'Убрать', 'Точно убрать?', run(() => api('/api/system/telegram/chat', { id: c.id, add: false }), 'Чат убран'))))) : h('p', { class: 'muted' }, 'Пока ни одного.'),
      t.pending.length ? h('div', {}, h('div', { class: 'sys-label' }, 'Написали боту, но их нет в списке'),
        h('ul', { class: 'sys-list' }, t.pending.map((p) => h('li', {},
          h('span', {}, `${p.name}${p.username ? ` (@${p.username})` : ''} · ${clock(p.at)}`),
          t.fromEnv ? null : h('button', { class: 'btn primary', onclick: run(() => api('/api/system/telegram/chat', { id: p.id, add: true }), 'Чат добавлен') }, 'Добавить'))))) : null,
      t.enabled ? h('p', { class: 'muted sys-hint' }, 'Новый человек пишет боту /start — его чат появится здесь с кнопкой «Добавить».') : null);
  }

  // ── devices ──
  function devicesCard() {
    const d = data.devices;
    const protectedNow = () => d.switches.filter((s) => s.protected).map((s) => s.cubeName);
    return card('Устройства',
      h('div', { class: 'sys-label' }, 'Не управлять (движок, сцены и панель их не включают и не выключают)'),
      d.switches.length ? h('ul', { class: 'sys-list' }, d.switches.map((s) => h('li', {}, h('label', { class: 'nt-check' },
        h('input', { type: 'checkbox', checked: s.protected, onchange: run((e) => api('/api/system/protected', { devices: e.target.checked ? [...protectedNow(), s.cubeName] : protectedNow().filter((n) => n !== s.cubeName) }), 'Сохранено') }),
        s.name)))) : h('p', { class: 'muted' }, 'Нет устройств, которыми можно управлять.'),
      h('div', { class: 'sys-label' }, 'Датчики дверей и окон'),
      d.doors.length ? h('ul', { class: 'sys-list' }, d.doors.map((x) => h('li', {},
        h('span', {}, h('b', {}, x.name), h('span', { class: 'muted' }, ` — сейчас ${x.open === null ? 'нет данных' : x.open ? 'открыта' : 'закрыта'}`)),
        h('select', { 'aria-label': `Как читать датчик ${x.name}`, onchange: run((e) => api('/api/system/doors', { device: x.cubeName, mode: e.target.value }), 'Сохранено, датчик перечитан') },
          h('option', { value: 'closed', selected: x.mode === 'closed' }, 'магнит рядом = закрыто (обычно)'),
          h('option', { value: 'open', selected: x.mode === 'open' }, 'магнит рядом = открыто'))))) : h('p', { class: 'muted' }, 'Датчиков дверей нет.'),
      d.doors.length ? h('p', { class: 'muted sys-hint' }, 'Если панель пишет «открыта», когда дверь закрыта, — переключи этот датчик.') : null);
  }

  // ── rooms and own names ──
  function roomsCard() {
    const d = data.devices;
    const rooms = d.rooms;
    const add = h('input', { type: 'text', class: 'sys-input', placeholder: 'Новая комната, например «Кухня»', 'aria-label': 'Новая комната' });
    const roomSelect = (dev) => h('select', { 'aria-label': `Комната: ${dev.name}`, onchange: run((e) => api('/api/system/device', { cubeName: dev.cubeName, room: e.target.value || null }), 'Сохранено') },
      h('option', { value: '' }, 'без комнаты'), rooms.map((r) => h('option', { value: r, selected: dev.room === r }, r)));
    return card('Комнаты и имена',
      h('p', { class: 'muted sys-hint' }, 'Свои имена видны в панели, ленте, Telegram и «почему». Правила по-прежнему ссылаются на имена из CUBE — переименование здесь их не ломает, и в приложении eWeLink ничего не меняется.'),
      h('div', { class: 'sys-label' }, 'Комнаты (в этом порядке на «Обзоре» и планшете)'),
      rooms.length ? h('ul', { class: 'sys-list' }, rooms.map((r, i) => h('li', {},
        h('input', { type: 'text', class: 'sys-input sys-room', value: r, 'aria-label': `Название комнаты ${r}`, onchange: run((e) => api('/api/system/rooms', { rename: [r, e.target.value] }), 'Переименовано') }),
        h('span', { class: 'sys-row' },
          h('button', { class: 'btn icon', disabled: i === 0, 'aria-label': `Выше: ${r}`, onclick: run(() => api('/api/system/rooms', { move: [r, -1] })) }, '↑'),
          h('button', { class: 'btn icon', disabled: i === rooms.length - 1, 'aria-label': `Ниже: ${r}`, onclick: run(() => api('/api/system/rooms', { move: [r, 1] })) }, '↓'),
          twoStep(`room:${r}`, 'Удалить', 'Точно? Устройства останутся без комнаты', run(() => api('/api/system/rooms', { remove: r }), 'Комната удалена')))))) : h('p', { class: 'muted' }, 'Комнат пока нет.'),
      h('div', { class: 'sys-row' }, add, h('button', { class: 'btn', onclick: run(async () => { if (add.value.trim()) await api('/api/system/rooms', { add: add.value }); }, 'Комната добавлена') }, 'Добавить')),
      h('div', { class: 'sys-label' }, 'Устройства'),
      h('ul', { class: 'sys-list sys-devices' }, d.all.map((dev) => h('li', {},
        h('span', { class: 'sys-dev' },
          h('input', { type: 'text', class: 'sys-input', value: dev.label ?? '', placeholder: dev.cubeName, maxlength: '60', 'aria-label': `Имя в панели для ${dev.cubeName}`,
            onchange: run((e) => api('/api/system/device', { cubeName: dev.cubeName, label: e.target.value || null }), 'Имя сохранено') }),
          h('span', { class: 'muted sys-cube' }, `в CUBE: ${dev.cubeName}`)),
        roomSelect(dev)))));
  }

  // ── backups ──
  function backupsCard() {
    const file = h('input', { type: 'file', accept: '.gz,application/gzip', 'aria-label': 'Файл резервной копии' });
    const restoreFile = async () => {
      const f = file.files?.[0];
      if (!f) { toast('Выбери файл копии'); return; }
      const res = await fetch('/api/system/restore', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      restored = body;
    };
    const local = async (name) => { restored = await api('/api/system/restore-local', { name }); };
    return card('Резервные копии',
      h('div', { class: 'ed-actions' },
        h('a', { class: 'btn primary', href: '/api/system/backup?history=1', download: '' }, 'Скачать копию'),
        h('a', { class: 'btn', href: '/api/system/backup?history=0', download: '' }, 'Без истории (меньше)'),
        h('button', { class: 'btn', onclick: run(async () => { const r = await api('/api/system/backup', {}); toast(`Сделана копия: ${r.name}`, 'notice'); }) }, 'Сделать копию сейчас')),
      h('p', { class: 'muted sys-hint' }, 'В копии: config.yaml, правила, сцены и история. Ключи и токены из .env не входят — сохрани их отдельно. Копии ниже делаются сами раз в сутки и лежат на той же карте памяти; от её поломки спасёт только скачанная копия.'),
      restored ? h('div', { class: 'sys-restored' },
        h('p', { class: 'ed-ok' }, `Восстановлено: правил ${restored.rules}, сцен ${restored.scenes}${restored.configChanged ? ', настройки' : ''}. Прежние файлы отложены в .trash и *.before-restore-*.`),
        restored.history || restored.configChanged ? h('p', {}, 'История и часть настроек вернутся после перезапуска движка. ',
          twoStep('restart', 'Перезапустить сейчас', 'Точно перезапустить?', run(() => api('/api/system/restart', {}), 'Перезапускаюсь…'), 'btn primary')) : null) : null,
      data.backups.local.length ? h('ul', { class: 'sys-list' }, data.backups.local.map((b) => h('li', {},
        h('span', {}, `${clock(b.ts)} · ${size(b.size)}`),
        twoStep(`restore:${b.name}`, 'Восстановить', 'Точно вернуть эту копию?', run(() => local(b.name), 'Копия восстановлена'))))) : h('p', { class: 'muted' }, 'Автоматических копий пока нет.'),
      h('div', { class: 'sys-row' }, file, twoStep('restore:file', 'Восстановить из файла', 'Точно? Текущие правила уйдут в .trash', run(restoreFile, 'Копия восстановлена'))));
  }

  // ── reaching the panel ──
  function accessCard() {
    return card('Доступ из-за пределов дома и иконка на телефон',
      h('p', {}, 'Снаружи — через Tailscale: это личная сеть между твоими устройствами, без открытия портов на роутере. Пароль панели остаётся.'),
      h('ol', { class: 'sys-steps' },
        h('li', {}, 'Заведи бесплатный аккаунт на tailscale.com.'),
        h('li', {}, 'В веб-консоли CUBE открой «Дополнения» (Docker), установи tailscale/TailScale и запусти. Нужна версия CUBE 1.8 или новее.'),
        h('li', {}, 'Нажми «Go to TailScale», затем «Connect» и войди своим аккаунтом.'),
        h('li', {}, 'Поставь приложение Tailscale на телефон, войди тем же аккаунтом и включи.'),
        h('li', {}, 'На странице TailScale в CUBE виден адрес вида 100.x.y.z. Открой на телефоне http://100.x.y.z:<порт панели> — порт тот, что задан при запуске контейнера «Домового».')),
      h('p', { class: 'muted sys-hint' }, 'Шаги — по инструкции eWeLink для дополнения TailScale; названия кнопок сверь с интерфейсом своей CUBE. Если по адресу Tailscale открывается CUBE, а панель нет — проверь, что порт контейнера «Домового» опубликован на хосте. На Маке панель открыта только для этого компьютера (127.0.0.1) — снаружи она будет доступна, когда переедет на Pi.'),
      h('p', {}, h('b', {}, 'Иконка на экран телефона. '), 'iPhone: открой панель в Safari → «Поделиться» → «На экран «Домой»». Android: Chrome → меню ⋮ → «Добавить на главный экран». Добавляй с адреса Tailscale — тогда иконка работает и дома, и снаружи.'),
      h('p', {}, h('b', {}, 'Планшет на стене. '), 'Открой на планшете адрес панели с #tablet в конце (например http://<адрес>:<порт>/#tablet): крупные плитки по комнатам, режим, сцены, тревоги. Подойдёт любой планшет или старый телефон с браузером. NSPanel Pro сама веб-страницы не открывает — по опыту сообщества, их показывают через установленный вручную Fully Kiosk Browser (неофициально).'),
      h('a', { class: 'btn', href: '#tablet' }, 'Открыть режим планшета'));
  }

  function logCard() {
    const pre = h('pre', { class: 'sys-log' }, 'Загружаю…');
    const loadLog = async () => {
      try { const r = await api('/api/system/log'); pre.textContent = r.lines.join('\n') || 'Пусто.'; pre.scrollTop = pre.scrollHeight; } catch (e) { onError(e); }
    };
    void loadLog();
    return h('section', { class: 'card sys-card sys-wide' },
      h('div', { class: 'nt-bar' }, h('h3', { class: 'nt-h' }, 'Лог движка'), h('button', { class: 'btn', onclick: () => void loadLog() }, 'Обновить')),
      pre,
      h('div', { class: 'sys-row' }, h('span', { class: 'muted' }, `Движок запущен ${clock(data.startedAt)}`),
        twoStep('restart', 'Перезапустить движок', 'Точно перезапустить?', run(() => api('/api/system/restart', {}), 'Перезапускаюсь…'))),
      h('p', { class: 'muted sys-hint' }, 'Перезапуск: движок останавливается, Docker запускает его снова (если контейнер запущен с перезапуском — restart: unless-stopped).'));
  }

  function render() {
    if (!data) return;
    fill(root,
      h('div', { class: 'nt-head' }, h('h2', { class: 'ed-title' }, 'Система')),
      h('div', { class: 'sys-grid' }, cubeCard(), telegramCard(), roomsCard(), devicesCard(), backupsCard(), accessCard(), logCard()));
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
