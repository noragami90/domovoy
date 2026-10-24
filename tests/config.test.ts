import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

const write = (text: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'domovoy-cfg-'));
  writeFileSync(join(dir, 'config.yaml'), text);
  return join(dir, 'config.yaml');
};

test('config: secrets from env, paths relative to the config file', () => {
  const path = write('cube: { url: "http://192.168.1.5" }\n');
  const cfg = loadConfig(path, { CUBE_TOKEN: 't', TELEGRAM_BOT_TOKEN: 'b' });
  assert.equal(cfg.cube.url, 'http://192.168.1.5');
  assert.equal(cfg.cubeToken, 't');
  assert.equal(cfg.telegramToken, 'b');
  assert.equal(cfg.rules_dir, join(path, '..', 'rules'));
  assert.deepEqual(cfg.telegram.chats, []);
});

test('config: CUBE_URL and TELEGRAM_CHATS override the file (for containers)', () => {
  const path = write('cube: { url: "http://192.168.1.5" }\ntelegram: { chats: [1] }\n');
  const cfg = loadConfig(path, { CUBE_URL: 'http://sim:8765', TELEGRAM_CHATS: '42, -100123, junk' });
  assert.equal(cfg.cube.url, 'http://sim:8765');
  assert.deepEqual(cfg.telegram.chats, [42, -100123]);
});

test('config: unknown keys and bad URLs are rejected', () => {
  assert.throws(() => loadConfig(write('cube: { url: "not a url" }\n'), {}), /настройки не прошли проверку/);
  assert.throws(() => loadConfig(write('cube: { url: "http://x" }\nextra: 1\n'), {}), /настройки не прошли проверку/);
});
