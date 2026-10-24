// Telegram bot over the plain Bot API (long polling, no extra libraries).
// Only chats listed in config may command the bot; notifications go to the same chats.
import type { Value } from '../cube/normalize.ts';
import type { Messenger } from '../notify/notifications.ts';
import type { Delivery } from '../store/db.ts';

export interface BotHandlers {
  rules(): string;
  why(query: string): string;
  status(): string;
  devices(): string;
  setVar(name: string, value: Value): Promise<string>;
  scenes(): string;
  scene(query: string, chatId: number): Promise<string>;
  mode(value: string, chatId: number): Promise<string>;
  presence(chatId: number, home: boolean): Promise<string>;
  ack?(id: number, who: string, chatId: number): Promise<boolean>; // the «Принял» button under an urgent notification
}

interface Update {
  update_id: number;
  message?: { chat: { id: number; first_name?: string; last_name?: string; username?: string; title?: string }; text?: string };
  callback_query?: { id: string; data?: string; from: { first_name?: string; username?: string }; message?: { chat: { id: number }; message_id: number } };
}

export interface BotOptions {
  token: string;
  chats: number[];
  handlers: BotHandlers;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

const HELP = [
  'Команды:',
  '/rules — правила и их состояние',
  '/why <правило> — почему сработало или нет',
  '/status — переменные и устройства не в сети',
  '/devices — устройства из CUBE',
  '/set <переменная> <значение> — например: /set ac_running on',
  '/scene <сцена> — запустить сцену; без названия — список',
  '/mode <режим> — режим дома; без значения — текущий',
  '/home, /away — я дома / я ушёл',
].join('\n');

export function parseValue(raw: string): Value {
  const s = raw.trim().toLowerCase();
  if (['on', 'true', 'да', 'вкл', '1', 'yes'].includes(s)) return true;
  if (['off', 'false', 'нет', 'выкл', '0', 'no'].includes(s)) return false;
  if (s !== '' && !Number.isNaN(Number(s))) return Number(s);
  return raw.trim();
}

export interface PendingChat { id: number; name: string; username: string | null; at: number }

export class TelegramBot {
  private readonly o: BotOptions;
  private readonly fetchImpl: typeof fetch;
  private offset = 0;
  private name: string | null = null;
  private readonly unknown = new Map<number, PendingChat>(); // wrote to the bot but not in the list yet

  constructor(o: BotOptions) {
    this.o = o;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  private async api<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.o.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const json = (await res.json().catch(() => null)) as { ok: boolean; result: T; description?: string } | null;
    if (!json?.ok) throw new Error(`Telegram ${method}: ${json?.description ?? `HTTP ${res.status}`}`);
    return json.result;
  }

  async sendTo(chatId: number, text: string): Promise<void> {
    for (let i = 0; i < text.length || i === 0; i += 4000) {
      await this.api('sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000), disable_web_page_preview: true });
    }
  }

  // Notifications to every allowed chat: quiet ones without sound, urgent ones with a «Принял» button.
  // Failures are collected, not thrown, so rules keep running.
  messenger(): Messenger {
    return {
      send: async (text, o) => {
        const deliveries: Delivery[] = [];
        const errors: string[] = [];
        for (const chat of this.o.chats) {
          try {
            const msg = await this.api<{ message_id: number }>('sendMessage', {
              chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true, disable_notification: o.silent,
              ...(o.ackId !== undefined ? { reply_markup: { inline_keyboard: [[{ text: 'Принял', callback_data: `ack:${o.ackId}` }]] } } : {}),
            });
            deliveries.push({ chat, messageId: msg.message_id });
          } catch (err) {
            errors.push(`${chat}: ${(err as Error).message}`);
            this.o.log?.(`Не отправил уведомление в ${chat}: ${(err as Error).message}`);
          }
        }
        return { deliveries, errors };
      },
      // Without reply_markup the inline keyboard disappears — the button is gone once accepted.
      edit: async (deliveries, text) => {
        for (const d of deliveries) {
          await this.api('editMessageText', { chat_id: d.chat, message_id: d.messageId, text: text.slice(0, 4000) })
            .catch((err) => this.o.log?.(`Не обновил сообщение в ${d.chat}: ${(err as Error).message}`));
        }
      },
    };
  }

  // «Принял» pressed: only in allowed chats; Telegram wants every callback answered.
  async callback(q: NonNullable<Update['callback_query']>): Promise<void> {
    const chat = q.message?.chat.id;
    const m = /^ack:(\d+)$/.exec(q.data ?? '');
    let answer = 'Не понял кнопку';
    if (chat === undefined || !this.o.chats.includes(chat)) answer = 'Этот чат не в списке';
    else if (m && this.o.handlers.ack) {
      const who = q.from.first_name || (q.from.username ? `@${q.from.username}` : 'Telegram');
      answer = (await this.o.handlers.ack(Number(m[1]), who, chat).catch(() => false)) ? 'Принято' : 'Уже принято';
    }
    await this.api('answerCallbackQuery', { callback_query_id: q.id, text: answer }).catch(() => {});
  }

  username(): string | null { return this.name; }
  chats(): number[] { return [...this.o.chats]; }
  pendingChats(): PendingChat[] { return [...this.unknown.values()].sort((a, b) => b.at - a.at); }

  // The panel added or removed a chat: applies at once.
  setChats(chats: number[]): void {
    this.o.chats.splice(0, this.o.chats.length, ...chats);
    for (const id of chats) this.unknown.delete(id);
  }

  // Errors become a reply, so a bad command never breaks the polling loop.
  async handle(chatId: number, text: string, from?: { name: string; username: string | null }): Promise<string> {
    if (!this.o.chats.includes(chatId)) {
      this.unknown.set(chatId, { id: chatId, name: from?.name ?? String(chatId), username: from?.username ?? null, at: Date.now() });
      if (this.unknown.size > 10) this.unknown.delete(this.pendingChats().at(-1)!.id);
    }
    try { return await this.route(chatId, text); } catch (err) { return `Ошибка: ${(err as Error).message}`; }
  }

  private async route(chatId: number, text: string): Promise<string> {
    const [rawCmd = '', ...rest] = text.trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@\w+$/, '');
    if (!this.o.chats.includes(chatId)) {
      this.o.log?.(`Telegram: написали из чата ${chatId}, его нет в списке telegram.chats`);
      return `Этот чат не в списке. Ваш chat id: ${chatId}. Добавь его в веб-панели: Система → Telegram → «Добавить».`;
    }
    const h = this.o.handlers;
    switch (cmd) {
      case '/start': case '/help': return HELP;
      case '/rules': return h.rules();
      case '/why': return h.why(rest.join(' '));
      case '/status': return h.status();
      case '/devices': return h.devices();
      case '/scene': case '/scenes': return rest.length ? h.scene(rest.join(' '), chatId) : h.scenes();
      case '/mode': return h.mode(rest.join(' '), chatId);
      case '/home': return h.presence(chatId, true);
      case '/away': return h.presence(chatId, false);
      case '/set': {
        if (rest.length < 2) return 'Формат: /set <переменная> <значение>, например /set ac_running on';
        return h.setVar(rest[0]!, parseValue(rest.slice(1).join(' ')));
      }
      default: return `Не понял. ${HELP}`;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.api<{ username: string }>('getMe', {})
      .then((me) => { this.name = me.username; this.o.log?.(`Telegram: бот @${me.username} на связи`); })
      .catch((err) => this.o.log?.(`Telegram: не получилось проверить бота — ${(err as Error).message}`));
    let backoff = 2_000;
    while (!signal.aborted) {
      try {
        const updates = await this.api<Update[]>(
          'getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, AbortSignal.any([signal, AbortSignal.timeout(35_000)]));
        backoff = 2_000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.callback_query) { await this.callback(u.callback_query); continue; }
          const msg = u.message;
          if (!msg?.text) continue;
          const c = msg.chat;
          const reply = await this.handle(c.id, msg.text, { name: c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(' ') || String(c.id)), username: c.username ?? null });
          await this.sendTo(msg.chat.id, reply).catch((err) => this.o.log?.(`Не ответил в ${msg.chat.id}: ${(err as Error).message}`));
        }
      } catch (err) {
        if (signal.aborted) return;
        this.o.log?.(`Telegram: ${(err as Error).message}; повтор через ${backoff / 1000} с`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }
}
