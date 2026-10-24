import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandlers, findRules } from '../src/app.ts';
import { parseValue, TelegramBot } from '../src/telegram/bot.ts';
import { harness, MIN, open, ruleFile } from './helpers.ts';

function fakeTelegram(updates: unknown[] = []) {
  const calls: { method: string; body: any }[] = [];
  let served = false;
  let messageId = 100;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = url.split('/').pop()!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    // Real getUpdates long-polls; an instant empty answer would spin the loop without yielding.
    if (method === 'getUpdates' && served) await new Promise((r) => setTimeout(r, 20));
    const result = method === 'getUpdates' ? (served ? [] : ((served = true), updates)) : method === 'sendMessage' ? { message_id: ++messageId } : {};
    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('values typed in chat become booleans and numbers', () => {
  assert.equal(parseValue('on'), true);
  assert.equal(parseValue('выкл'), false);
  assert.equal(parseValue('21.5'), 21.5);
  assert.equal(parseValue('auto'), 'auto');
});

test('rules are found by id or by part of the name', async () => {
  const rules = [ruleFile('heat-leak'), ruleFile('bath-fan')];
  assert.deepEqual(findRules(rules, 'heat-leak').map((r) => r.id), ['heat-leak']);
  assert.deepEqual(findRules(rules, 'вытяжка').map((r) => r.id), ['bath-fan']);
  assert.deepEqual(findRules(rules, ''), []);
});

test('commands work only in allowed chats; strangers learn their chat id', async () => {
  const h = await harness([ruleFile('heat-leak'), ruleFile('bath-fan')]);
  const handlers = createHandlers(h.engine, h.store, { now: () => h.clock.now(), timezone: 'Asia/Tbilisi', link: () => ({ connected: true, since: 0 }) });
  const { fetchImpl } = fakeTelegram();
  const bot = new TelegramBot({ token: 'T', chats: [42], handlers, fetchImpl });

  assert.match(await bot.handle(7, '/rules'), /Ваш chat id: 7/);
  assert.match(await bot.handle(42, '/rules'), /Утечка тепла \(heat-leak\)/);
  assert.match(await bot.handle(42, '/why@domovoy_bot утечка'), /«Утечка тепла» \(heat-leak\)/);
  assert.match(await bot.handle(42, '/why'), /Какое правило\?/);
  assert.match(await bot.handle(42, '/status'), /CUBE: на связи\.[\s\S]*Кондиционер работает \(ac_running\): да[\s\S]*Устройств: 6, все в сети/);
  assert.match(await bot.handle(42, '/devices'), /Санузел \[temperatureAndHumiditySensor\] — temperature=24,1 °C, humidity=48%/);
  assert.match(await bot.handle(42, '/set ac_running off'), /Кондиционер работает \(ac_running\) = нет/);
  assert.match(await bot.handle(42, '/set nope 1'), /Нет переменной «nope»/);
});

test('/set changes what rules see', async () => {
  const h = await harness([ruleFile('heat-leak')], { acRunning: false });
  const handlers = createHandlers(h.engine, h.store, { now: () => h.clock.now(), timezone: 'Asia/Tbilisi', link: () => ({ connected: true, since: 0 }) });
  await h.report('Дверь лоджии', open);
  await h.advance(6 * MIN);
  assert.equal(h.notes.length, 0);
  await handlers.setVar('ac_running', true);
  await h.advance(0);
  assert.equal(h.notes.length, 1);
});

test('long polling answers messages and notifications reach every chat', async () => {
  const h = await harness([ruleFile('heat-leak')]);
  const handlers = createHandlers(h.engine, h.store, { now: () => h.clock.now(), timezone: 'Asia/Tbilisi', link: () => ({ connected: true, since: 0 }) });
  const { calls, fetchImpl } = fakeTelegram([{ update_id: 10, message: { chat: { id: 42 }, text: '/help' } }]);
  const bot = new TelegramBot({ token: 'T', chats: [42, 43], handlers, fetchImpl });
  const abort = new AbortController();
  const running = bot.run(abort.signal);
  while (!calls.some((c) => c.method === 'sendMessage')) await new Promise((r) => setTimeout(r, 5));
  abort.abort();
  await running;
  assert.match(calls.find((c) => c.method === 'sendMessage')!.body.text, /Команды:/);
  assert.equal(calls.filter((c) => c.method === 'getUpdates')[1]?.body.offset, 11);

  const r = await bot.messenger().send('x'.repeat(4500), { silent: true, ackId: 7 });
  const sent = calls.filter((c) => c.method === 'sendMessage').slice(1);
  assert.deepEqual(sent.map((c) => [c.body.chat_id, c.body.text.length, c.body.disable_notification]), [[42, 4000, true], [43, 4000, true]]);
  assert.equal(sent[0]!.body.reply_markup.inline_keyboard[0][0].callback_data, 'ack:7');
  assert.deepEqual(r.deliveries.map((d) => d.chat), [42, 43]);
  await bot.messenger().edit(r.deliveries, 'принято');
  const edits = calls.filter((c) => c.method === 'editMessageText');
  assert.deepEqual(edits.map((c) => [c.body.chat_id, c.body.message_id, c.body.reply_markup]), r.deliveries.map((d) => [d.chat, d.messageId, undefined]));
});

test('telegram: «Принял» under an urgent notification — only from allowed chats, every press answered', async () => {
  const acks: [number, string][] = [];
  const handlers = { ack: async (id: number, who: string) => { acks.push([id, who]); return acks.length === 1; } } as any;
  const press = (id: string, chat: number) => ({ id, data: 'ack:7', from: { first_name: 'Антон' }, message: { chat: { id: chat }, message_id: 5 } });
  const { calls, fetchImpl } = fakeTelegram();
  const bot = new TelegramBot({ token: 'T', chats: [42], handlers, fetchImpl });
  await bot.callback(press('q1', 42));
  await bot.callback(press('q2', 42));
  await bot.callback(press('q3', 99));
  assert.deepEqual(acks, [[7, 'Антон'], [7, 'Антон']]);
  assert.deepEqual(calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text), ['Принято', 'Уже принято', 'Этот чат не в списке']);
});

test('telegram: scenes, mode, /home and /away', async () => {
  const { sceneFile } = await import('./helpers.ts');
  const h = await harness([ruleFile('heat-leak')], { scenes: [sceneFile('away'), sceneFile('night')], people: { anton: { name: 'Антон', telegram: 42 } } });
  const handlers = createHandlers(h.engine, h.store, { now: () => h.clock.now(), timezone: 'Asia/Tbilisi', link: () => ({ connected: true, since: 0 }) });
  const { fetchImpl } = fakeTelegram();
  const bot = new TelegramBot({ token: 'T', chats: [42, 43], handlers, fetchImpl });
  assert.match(await bot.handle(42, '/scene'), /\/scene away — Ушёл\n\/scene night — Ночь/);
  assert.match(await bot.handle(42, '/scene ночь'), /Сцена «Ночь»:\n✓ Режим: Ночь\n✓ выключать нечего\n· уведомление: Лоджия открыта на ночь\. — пропущено/);
  assert.match(await bot.handle(42, '/mode'), /Режим: Ночь\.\nМожно:\nhome — Дома/);
  assert.equal(await bot.handle(42, '/mode дома'), 'Режим: Дома');
  assert.match(await bot.handle(42, '/mode party'), /Нет такого режима/);
  assert.equal(await bot.handle(42, '/away'), 'Антон: не дома');
  assert.equal(h.engine.varList().find((v) => v.name === 'home_anton')!.value, false);
  assert.match(await bot.handle(43, '/home'), /не привязан к человеку.*telegram: 43/);
  assert.equal(h.store.events({ kind: 'manual' })[0]!.text, 'Антон: ушёл (Telegram)');
});
