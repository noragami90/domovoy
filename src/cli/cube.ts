// Connection check against a real CUBE:
//   npm run cube -- info              bridge name and firmware (no token needed)
//   npm run cube -- token             get a token: confirm the pop-up in the CUBE web console; saved to .env
//   npm run cube -- devices           devices with the attribute names rules can use
//   npm run cube -- watch [seconds]   print live events (default 60 s)
// The address comes from --url, CUBE_URL or cube.url in config.yaml.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { CubeClient } from '../cube/client.ts';
import { flattenState, toDevice } from '../cube/normalize.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args.splice(i, 2)[1]; };

function cubeUrl(): string {
  const fromFlag = flag('url');
  if (fromFlag) return fromFlag;
  if (process.env.CUBE_URL) return process.env.CUBE_URL;
  const path = process.env.DOMOVOY_CONFIG ?? './config.yaml';
  if (existsSync(path)) {
    const url = YAML.parse(readFileSync(path, 'utf8'))?.cube?.url;
    if (url) return url;
  }
  throw new Error('Не знаю адрес CUBE: укажи --url http://<ip> или cube.url в config.yaml');
}

function saveToken(token: string): void {
  const path = '.env';
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => !l.startsWith('CUBE_TOKEN=')) : [];
  writeFileSync(path, [...lines.filter((l) => l.trim() !== ''), `CUBE_TOKEN=${token}`, ''].join('\n'), { mode: 0o600 });
}

async function main(): Promise<void> {
  const url = cubeUrl();
  const [cmd = 'info', arg] = args;
  const cube = new CubeClient(url, process.env.CUBE_TOKEN);

  if (cmd === 'info') {
    const info = await cube.bridgeInfo();
    console.log(`CUBE ${url}: ${info.name ?? '?'}, прошивка ${info.fw_version ?? '?'}, ip ${info.ip ?? '?'}`);
    return;
  }

  if (cmd === 'token') {
    console.log(`Запрашиваю токен у ${url}.\nОткрой веб-консоль CUBE в браузере — там появится окно подтверждения доступа. Нажми «Готово» (есть 5 минут).`);
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const token = await cube.requestToken('domovoy');
      if (token) {
        saveToken(token);
        console.log(`Готово: токен ${token.slice(0, 8)}… сохранён в .env (CUBE_TOKEN). Повторно выдать токен CUBE разрешит только после нового подтверждения.`);
        return;
      }
      process.stdout.write('.');
      await new Promise((r) => setTimeout(r, 3_000));
    }
    throw new Error('Подтверждение не пришло за 5 минут. Запусти команду ещё раз.');
  }

  if (cmd === 'devices') {
    const list = await cube.devices();
    console.log(`Устройств: ${list.length}\n`);
    for (const raw of list) {
      const d = toDevice(raw);
      console.log(`${d.name}  [${d.category}${d.model ? `, ${d.model}` : ''}]  ${d.online ? 'в сети' : 'НЕ В СЕТИ'}  id=${d.id}`);
      for (const [k, v] of Object.entries(d.attrs)) console.log(`    ${k} = ${JSON.stringify(v)}`);
    }
    console.log('\nВ правилах: device — имя как выше, attr — имя слева от «=».');
    return;
  }

  if (cmd === 'watch') {
    const seconds = Number(arg ?? 60);
    const names = new Map((await cube.devices()).map((d) => [d.serial_number, d.name]));
    const abort = new AbortController();
    setTimeout(() => abort.abort(), seconds * 1_000);
    console.log(`Слушаю события ${seconds} с — пощёлкай выключателем или подыши на датчик…`);
    await cube.events((e) => {
      const who = 'id' in e ? names.get(e.id) ?? e.id : e.device.name;
      const what = e.type === 'state' ? JSON.stringify(flattenState(e.state)) : e.type === 'online' ? `online=${e.online}` : e.type;
      console.log(`${new Date().toLocaleTimeString('ru-RU')}  ${who}: ${what}`);
    }, (s, detail) => console.log(`[поток ${s === 'connected' ? 'подключён' : `отключён${detail ? `: ${detail}` : ''}`}]`), abort.signal);
    return;
  }

  throw new Error(`Неизвестная команда «${cmd}». Есть: info, token, devices, watch`);
}

main().catch((err) => { console.error(`\nОшибка: ${(err as Error).message}`); process.exit(1); });
