// The "Система" tab:
//   GET  /api/system                 CUBE link, Telegram chats, protected devices, door sensors, local backups
//   GET  /api/system/log             last lines of the engine log
//   GET  /api/system/backup?history=1  download a backup file
//   POST /api/system/telegram/chat   {"id": 123, "add": true}
//   POST /api/system/people/:id      {"chat": 123 | null}
//   POST /api/system/protected       {"devices": ["Кондиционер"]}
//   POST /api/system/doors           {"device": "Дверь лоджии", "mode": "closed" | "open"}  (device — the CUBE name)
//   POST /api/system/device          {"cubeName": "…", "label": "Свет в прихожей" | null, "room": "Прихожая" | null}
//   POST /api/system/rooms           {"add": "…"} | {"rename": ["old", "new"]} | {"remove": "…"} | {"move": ["…", -1 | 1]}
//   POST /api/system/cube            {"url": "http://192.168.1.20"}
//   POST /api/system/cube/token      ask CUBE for a token (confirm in its web console within 5 minutes)
//   POST /api/system/backup          make a local copy now
//   POST /api/system/restore         the backup file as the request body (application/octet-stream)
//   POST /api/system/restore-local   {"name": "domovoy-….backup.gz"}
//   POST /api/system/restart
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SystemControl } from '../system/control.ts';
import { HttpError, json, readJson, readRaw, SECURITY } from './http.ts';

const MAX_BACKUP = 200 * 1_048_576;

export async function systemRoute(req: IncomingMessage, res: ServerResponse, path: string, url: URL, sys: SystemControl): Promise<void> {
  try {
    if (req.method === 'GET') {
      if (path === '/api/system') return json(res, 200, sys.overview());
      if (path === '/api/system/log') return json(res, 200, { lines: sys.logTail() });
      if (path === '/api/system/backup') {
        const { name, data } = sys.backupFile(url.searchParams.get('history') !== '0');
        res.writeHead(200, {
          'content-type': 'application/gzip', 'content-length': String(data.length), 'cache-control': 'no-store', ...SECURITY,
          'content-disposition': `attachment; filename="domovoy-backup.gz"; filename*=UTF-8''${encodeURIComponent(name)}`,
        });
        return void res.end(data);
      }
      throw new HttpError(404, 'не найдено');
    }
    if (req.method !== 'POST') throw new HttpError(405, 'метод не поддерживается');
    if (path === '/api/system/restore') {
      const result = await sys.restore(await readRaw(req, MAX_BACKUP));
      return json(res, 200, { ok: true, ...result });
    }
    const body = await readJson(req);
    if (path === '/api/system/telegram/chat') {
      sys.setChat(Number(body.id), body.add !== false);
      return json(res, 200, { ok: true });
    }
    const person = /^\/api\/system\/people\/([^/]+)$/.exec(path);
    if (person) {
      sys.linkPerson(decodeURIComponent(person[1]!), body.chat === null || body.chat === undefined ? null : Number(body.chat));
      return json(res, 200, { ok: true });
    }
    if (path === '/api/system/protected') {
      if (!Array.isArray(body.devices) || body.devices.some((d) => typeof d !== 'string')) throw new HttpError(400, 'devices: список имён');
      sys.setProtected(body.devices as string[]);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/system/doors') {
      if (typeof body.device !== 'string' || (body.mode !== 'closed' && body.mode !== 'open')) throw new HttpError(400, 'нужны device и mode: closed или open');
      await sys.setDoor(body.device, body.mode);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/system/device') {
      if (typeof body.cubeName !== 'string') throw new HttpError(400, 'нужен cubeName');
      const pick = (v: unknown) => (v === undefined ? undefined : typeof v === 'string' ? v : null);
      sys.setDeviceMeta(body.cubeName, { label: pick(body.label), room: pick(body.room) });
      return json(res, 200, { ok: true });
    }
    if (path === '/api/system/rooms') {
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const pair = Array.isArray(body.rename) && body.rename.length === 2 ? [String(body.rename[0]), String(body.rename[1])] as [string, string] : undefined;
      const move = Array.isArray(body.move) && (body.move[1] === 1 || body.move[1] === -1) ? [String(body.move[0]), body.move[1]] as [string, -1 | 1] : undefined;
      sys.editRooms({ add: str(body.add), rename: pair, remove: str(body.remove), move });
      return json(res, 200, { ok: true });
    }
    if (path === '/api/system/cube') {
      if (typeof body.url !== 'string') throw new HttpError(400, 'нужен url');
      return json(res, 200, { ok: true, bridge: await sys.setCubeUrl(body.url) });
    }
    if (path === '/api/system/cube/token') { sys.requestToken(); return json(res, 200, { ok: true }); }
    if (path === '/api/system/backup') return json(res, 200, { ok: true, name: sys.backupNow() });
    if (path === '/api/system/restore-local') {
      if (typeof body.name !== 'string') throw new HttpError(400, 'нужно имя копии');
      return json(res, 200, { ok: true, ...await sys.restoreLocal(body.name) });
    }
    if (path === '/api/system/restart') {
      json(res, 200, { ok: true });
      return sys.restart();
    }
    throw new HttpError(404, 'не найдено');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, (err as Error).message);
  }
}
