import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY, manualClock, T0, tempDir } from '../helpers/fixtures.js';
import { KanbanReader, KanbanStore } from '../../src/store/sqlite.js';
import { resolveLocation } from '../../src/store/location.js';
import { boardKey, normalizeDbPath } from '../../src/web/discovery.js';
import { healthHmac, type UiServer, type UiServerOptions } from '../../src/web/server.js';
import { httpRequest, sleep, startMcp, startUi, TOKEN, UiClient, VERSION, type SseClient } from './helpers.js';

let tmp: ReturnType<typeof tempDir>;
let home: string;
let clock: ReturnType<typeof manualClock>;
let server: UiServer | null;
let streams: SseClient[];

beforeEach(() => {
  tmp = tempDir('kanban-ui-');
  home = join(tmp.path, 'home');
  mkdirSync(join(home, '.t3-kanban'), { recursive: true });
  clock = manualClock(T0);
  server = null;
  streams = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of streams) s.close();
  await server?.close();
  tmp.cleanup();
});

function dbPathOf(name: string): string {
  return join(home, '.t3-kanban', `${name}.db`);
}

function keyOf(dbPath: string, boardId: string): string {
  return boardKey(normalizeDbPath(dbPath), boardId);
}

/** b1 のボード: a（doing）、b（ready）、c（inbox）。doing の WIP は 1。 */
function seed(dbPath = dbPathOf('b1'), boardId = 'b1'): string {
  const store = KanbanStore.open({ path: dbPath, boardId, clock });
  try {
    store.configure({ columns: [{ column: 'doing', wipLimit: 1 }] });
    for (const t of ['a', 'b', 'c']) store.addCard({ threadId: t, title: `card ${t}` });
    store.moveCard('a', { to: 'ready' });
    store.moveCard('a', { to: 'doing' });
    store.moveCard('b', { to: 'ready' });
  } finally {
    store.close();
  }
  return keyOf(dbPath, boardId);
}

async function start(options: Partial<UiServerOptions> = {}): Promise<UiClient> {
  const r = await startUi({ homeDir: home, clock, ...options });
  server = r.server;
  return r.client;
}

function track(s: SseClient): SseClient {
  streams.push(s);
  return s;
}

function eventCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n);
  } finally {
    db.close();
  }
}

function fileState(p: string): { mtimeMs: number; size: number } | null {
  if (!existsSync(p)) return null;
  const s = statSync(p);
  return { mtimeMs: s.mtimeMs, size: s.size };
}

/** SQLITE_BUSY と判定される例外（一時的なロック）。 */
function busyError(): Error {
  return Object.assign(new Error('database is locked'), { errcode: 5 });
}

/** node:sqlite が投げる形の例外（BUSY 以外）。 */
function sqliteError(message: string, errcode: number): Error {
  return Object.assign(new Error(message), { errcode, code: 'ERR_SQLITE_ERROR' });
}

/** 最新のイベントの data を JSON として読めない値にする（行の破損）。 */
function corruptLatestEventData(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("UPDATE events SET data = '{not json' WHERE id = (SELECT MAX(id) FROM events)");
  } finally {
    db.close();
  }
}

function columnOf(snapshot: any, threadId: string): string | undefined {
  for (const col of snapshot.board?.columns ?? []) if (col.cards.some((c: any) => c.threadId === threadId)) return col.column;
  return undefined;
}

describe('認証（受け入れ基準 8）', () => {
  it('cookie がない・Host が違う要求は 403、localhost:<port> は通す', async () => {
    seed();
    const c = await start();
    const noCookie = await httpRequest(c.port, '/api/boards', { headers: { Host: `127.0.0.1:${c.port}` } });
    expect(noCookie.status).toBe(403);
    const badCookie = await httpRequest(c.port, '/api/boards', {
      headers: { Host: `127.0.0.1:${c.port}`, Cookie: `tk_${c.port}=wrong` },
    });
    expect(badCookie.status).toBe(403);
    const otherPortCookie = await httpRequest(c.port, '/api/boards', {
      headers: { Host: `127.0.0.1:${c.port}`, Cookie: `tk_1=${TOKEN}` },
    });
    expect(otherPortCookie.status).toBe(403);
    const badHost = await httpRequest(c.port, '/api/boards', { headers: { ...c.baseHeaders, Host: `evil.example:${c.port}` } });
    expect(badHost.status).toBe(403);
    const badHostPort = await httpRequest(c.port, '/api/boards', { headers: { ...c.baseHeaders, Host: '127.0.0.1:1' } });
    expect(badHostPort.status).toBe(403);
    const local = await httpRequest(c.port, '/api/boards', { headers: { ...c.baseHeaders, Host: `localhost:${c.port}` } });
    expect(local.status).toBe(200);
    const ok = await c.get('/api/boards');
    expect(ok.status).toBe(200);
    expect(ok.headers['referrer-policy']).toBe('no-referrer');
    expect(noCookie.headers['referrer-policy']).toBe('no-referrer');
  });

  it('SSE も cookie がなければ 403', async () => {
    const key = seed();
    const c = await start();
    const r = await httpRequest(c.port, `/api/boards/${key}/stream`, { headers: { Host: `127.0.0.1:${c.port}` } });
    expect(r.status).toBe(403);
  });

  it('POST の判定順は Host → cookie → Origin → Content-Type', async () => {
    const key = seed();
    const c = await start();
    const path = c.card(key, 'c', 'move');
    const eventsBefore = eventCount(dbPathOf('b1'));
    const body = JSON.stringify({ to: 'ready' });
    const origin = `http://127.0.0.1:${c.port}`;
    // cookie なし + Content-Type が JSON でない → 403（415 ではない）
    const r1 = await httpRequest(c.port, path, {
      method: 'POST',
      headers: { Host: `127.0.0.1:${c.port}`, Origin: origin, 'Content-Type': 'text/plain' },
      body,
    });
    expect(r1.status).toBe(403);
    // Origin なし → 403
    const r2 = await httpRequest(c.port, path, { method: 'POST', headers: { ...c.baseHeaders, 'Content-Type': 'application/json' }, body });
    expect(r2.status).toBe(403);
    // Origin 違い → 403
    const r3 = await httpRequest(c.port, path, {
      method: 'POST',
      headers: { ...c.baseHeaders, Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body,
    });
    expect(r3.status).toBe(403);
    // Origin 違い + text/plain → 403（Origin が先）
    const r4 = await httpRequest(c.port, path, {
      method: 'POST',
      headers: { ...c.baseHeaders, Origin: 'http://evil.example', 'Content-Type': 'text/plain' },
      body,
    });
    expect(r4.status).toBe(403);
    // Origin 一致 + text/plain → 415
    const r5 = await httpRequest(c.port, path, { method: 'POST', headers: { ...c.baseHeaders, Origin: origin, 'Content-Type': 'text/plain' }, body });
    expect(r5.status).toBe(415);
    // Host 違い（cookie も Origin も正しい）→ 403
    const r6 = await httpRequest(c.port, path, {
      method: 'POST',
      headers: { ...c.baseHeaders, Host: `evil.example:${c.port}`, Origin: origin, 'Content-Type': 'application/json' },
      body,
    });
    expect(r6.status).toBe(403);
    expect(eventCount(dbPathOf('b1'))).toBe(eventsBefore);
    // すべて揃えば通る（Content-Type に charset が付いてもよい）
    const r7 = await httpRequest(c.port, path, {
      method: 'POST',
      headers: { ...c.baseHeaders, Origin: `http://localhost:${c.port}`, 'Content-Type': 'application/json; charset=utf-8' },
      body,
    });
    expect(r7.status).toBe(200);
    expect(r7.json.ok).toBe(true);
  });

  it('/api/health: cookie なしは none（nonce に HMAC と version）、一致は valid、不一致だけ 403。トークンも DB の情報も含めない', async () => {
    seed();
    const c = await start();
    const none = await httpRequest(c.port, '/api/health?nonce=abc123', { headers: { Host: `127.0.0.1:${c.port}` } });
    expect(none.status).toBe(200);
    expect(none.json).toEqual({
      ok: true,
      version: VERSION,
      authenticated: 'none',
      hmac: healthHmac(TOKEN, c.port, 'abc123'),
    });
    // ラベルとポートを含める（nonce だけの HMAC とも、別のポートの HMAC とも一致しない）
    expect(none.json.hmac).toBe(createHmac('sha256', TOKEN).update(`thread-kanban-health\0${c.port}\0abc123`).digest('hex'));
    expect(none.json.hmac).not.toBe(createHmac('sha256', TOKEN).update('abc123').digest('hex'));
    expect(none.json.hmac).not.toBe(healthHmac(TOKEN, c.port + 1, 'abc123'));
    const valid = await c.get('/api/health');
    expect(valid.status).toBe(200);
    expect(valid.json).toEqual({ ok: true, version: VERSION, authenticated: 'valid' });
    const wrong = await httpRequest(c.port, '/api/health?nonce=x', {
      headers: { Host: `127.0.0.1:${c.port}`, Cookie: `tk_${c.port}=wrong` },
    });
    expect(wrong.status).toBe(403);
    for (const r of [none, valid, wrong]) {
      expect(r.text).not.toContain(TOKEN);
      expect(r.text).not.toContain('.db');
    }
    const badHost = await httpRequest(c.port, '/api/health', { headers: { Host: 'evil.example' } });
    expect(badHost.status).toBe(403);
  });

  it('GET /?token= は cookie を設定して / へ 302。トークンが違えば cookie を設定しない', async () => {
    const c = await start();
    const r = await httpRequest(c.port, `/?token=${TOKEN}`, { headers: { Host: `127.0.0.1:${c.port}` } });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['set-cookie']).toEqual([
      `tk_${c.port}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`,
    ]);
    const wrong = await httpRequest(c.port, '/?token=nope', { headers: { Host: `127.0.0.1:${c.port}` } });
    expect(wrong.status).toBe(302);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('静的ファイルは認証なしで配信し、パストラバーサル（エンコード含む）は 404', async () => {
    const c = await start();
    const host = { Host: `127.0.0.1:${c.port}` };
    const index = await httpRequest(c.port, '/', { headers: host });
    expect(index.status).toBe(200);
    expect(index.headers['referrer-policy']).toBe('no-referrer');
    for (const p of [
      '/../package.json',
      '/%2e%2e/package.json',
      '/..%2fpackage.json',
      '/%2e%2e%2f%2e%2e%2fpackage.json',
      '/..%5cpackage.json',
      '/foo/../../package.json',
      '/%00index.html',
      '/missing.js',
      '/%E0%A4%A',
    ]) {
      const r = await httpRequest(c.port, p, { headers: host });
      expect(r.status, p).toBe(404);
      expect(r.text).not.toContain('"name": "thread-kanban"');
    }
  });
});

describe('ビルド成果物（受け入れ基準 15）', () => {
  it('/ → バンドルされた JS → CSS を 200 と正しい MIME で返す', async () => {
    const c = await start();
    const host = { Host: `127.0.0.1:${c.port}` };
    const index = await httpRequest(c.port, '/', { headers: host });
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    const js = index.text.match(/<script[^>]+src="([^"]+)"/)?.[1];
    const css = index.text.match(/<link[^>]+href="([^"]+\.css)"/)?.[1];
    expect(js).toBe('/app.js');
    expect(css).toBe('/app.css');
    const jsRes = await httpRequest(c.port, js as string, { headers: host });
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(jsRes.text.length).toBeGreaterThan(1000);
    const cssRes = await httpRequest(c.port, css as string, { headers: host });
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers['content-type']).toBe('text/css; charset=utf-8');
  });
});

describe('API', () => {
  it('ボードの一覧・ボード・カードのイベント・move-options', async () => {
    const key = seed();
    const c = await start();
    const boards = await c.get('/api/boards');
    expect(boards.json.boards).toEqual([
      { key, boardId: 'b1', label: 'b1', dbPath: normalizeDbPath(dbPathOf('b1')), exists: true },
    ]);
    expect(boards.json.defaultKey).toBeNull();

    const board = await c.get(`/api/boards/${key}`);
    expect(board.status).toBe(200);
    expect(board.json).toMatchObject({ ok: true, key, label: 'b1', now: new Date(T0).toISOString(), lastEventId: 10 });
    expect(columnOf(board.json, 'a')).toBe('doing');
    expect(board.json.next.action).toBe('no_new_work');
    expect(board.json.board.discardedCount).toBe(0);

    const events = await c.get(c.card(key, 'a', 'events'));
    expect(events.json.events.map((e: any) => [e.type, e.toColumn])).toEqual([
      ['created', null],
      ['moved', 'inbox'],
      ['moved', 'ready'],
      ['moved', 'doing'],
    ]);
    expect(events.json.events[0]).toMatchObject({ threadId: 'a', title: 'card a', actor: null, at: new Date(T0).toISOString() });

    const options = await c.get(c.card(key, 'b', 'move-options'));
    expect(options.json.options).toEqual([
      { column: 'inbox', allowed: true, needsCriteria: false, entryCriteria: [], wip: 'ok' },
      {
        column: 'doing',
        allowed: true,
        needsCriteria: false,
        entryCriteria: [],
        wip: 'exceeded',
        occupants: [{ cardId: 1, threadId: 'a', title: 'card a' }],
      },
      { column: 'review', allowed: false, code: 'SKIP_NOT_ALLOWED', needsCriteria: false, entryCriteria: [], wip: null },
      { column: 'done', allowed: false, code: 'SKIP_NOT_ALLOWED', needsCriteria: false, entryCriteria: [], wip: null },
    ]);
  });

  it('未知のボードは 404 BOARD_NOT_FOUND、未知のカードは 404 CARD_NOT_FOUND、不正な body は 400 INVALID_ARGUMENT', async () => {
    const key = seed();
    const c = await start();
    const unknown = await c.get('/api/boards/0000000000000000');
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ ok: false, code: 'BOARD_NOT_FOUND' });
    expect(typeof unknown.json.message).toBe('string');
    const noCard = await c.get(c.card(key, 'zzz', 'move-options'));
    expect(noCard.status).toBe(404);
    expect(noCard.json.code).toBe('CARD_NOT_FOUND');
    const bad = await c.post(c.card(key, 'c', 'move'), { to: 'nowhere' });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('INVALID_ARGUMENT');
    const notJson = await httpRequest(c.port, c.card(key, 'c', 'move'), {
      method: 'POST',
      headers: { ...c.baseHeaders, Origin: `http://127.0.0.1:${c.port}`, 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(notJson.status).toBe(400);
    expect(notJson.json.code).toBe('INVALID_ARGUMENT');
  });

  it('discarded への移動は 400 UI_DISCARD_NOT_ALLOWED で、DB は変わらない（受け入れ基準 7）', async () => {
    const key = seed();
    const c = await start();
    const before = eventCount(dbPathOf('b1'));
    const r = await c.post(c.card(key, 'c', 'move'), { to: 'discarded' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ ok: false, code: 'UI_DISCARD_NOT_ALLOWED' });
    expect(eventCount(dbPathOf('b1'))).toBe(before);
    const board = await c.get(`/api/boards/${key}`);
    expect(columnOf(board.json, 'c')).toBe('inbox');
  });

  it('unblock は空の body を受け付ける', async () => {
    const key = seed();
    const c = await start();
    expect((await c.post(c.card(key, 'c', 'block'), { reason: '待ち' })).json.ok).toBe(true);
    const r = await c.post(c.card(key, 'c', 'unblock'), {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, blockedDays: 0 });
  });

  it('move / block / unblock の応答に書き込み後の lastEventId（UI 専用）を付ける', async () => {
    const key = seed();
    const c = await start();
    const moved = await c.post(c.card(key, 'c', 'move'), { to: 'ready' });
    expect(moved.json).toMatchObject({ ok: true, to: 'ready', lastEventId: 11 });
    const blocked = await c.post(c.card(key, 'c', 'block'), { reason: '待ち' });
    expect(blocked.json).toMatchObject({ ok: true, lastEventId: 12 });
    const unblocked = await c.post(c.card(key, 'c', 'unblock'), {});
    expect(unblocked.json).toMatchObject({ ok: true, lastEventId: 13 });
    expect((await c.get(`/api/boards/${key}`)).json.lastEventId).toBe(13);
  });

  it('DB はあるが開けないときは GET も SSE も 503 BOARD_UNAVAILABLE（空のボードにしない）', async () => {
    const key = seed();
    const logs: string[] = [];
    const c = await start({ log: (m) => logs.push(m) });
    const spy = vi.spyOn(KanbanReader, 'open').mockImplementation(() => {
      throw new Error('unable to open database file');
    });
    const r = await c.get(`/api/boards/${key}`);
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ ok: false, code: 'BOARD_UNAVAILABLE' });
    const stream = await c.get(`/api/boards/${key}/stream`);
    expect(stream.status).toBe(503);
    expect(stream.json).toMatchObject({ ok: false, code: 'BOARD_UNAVAILABLE' });
    const events = await c.get(c.card(key, 'a', 'events'));
    expect(events.status).toBe(503);
    expect(logs.some((m) => m.includes('unable to open database file'))).toBe(true);
    spy.mockRestore();
    const ok = await c.get(`/api/boards/${key}`);
    expect(ok.status).toBe(200);
    expect(columnOf(ok.json, 'a')).toBe('doing');
  });

  it('DB はあるが読めないときは GET が 503 BOARD_UNAVAILABLE', async () => {
    const key = seed();
    const c = await start();
    const spy = vi.spyOn(KanbanReader.prototype, 'readSince').mockImplementation(() => {
      throw sqliteError('file is not a database', 26);
    });
    const r = await c.get(`/api/boards/${key}`);
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ ok: false, code: 'BOARD_UNAVAILABLE' });
    spy.mockRestore();
    expect((await c.get(`/api/boards/${key}`)).status).toBe(200);
  });

  it('壊れた DB ファイル（開けるが読めない）は GET も SSE も 503 BOARD_UNAVAILABLE（SSE を 200 で黙って開いたままにしない）', async () => {
    const bad = dbPathOf('broken');
    writeFileSync(bad, Buffer.from('this is not a sqlite database file, just garbage bytes '.repeat(200)));
    const c = await start();
    const key = (await c.post('/api/dbs', { path: bad, boardId: 'x' })).json.boards[0].key;
    const r = await c.get(`/api/boards/${key}`);
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ ok: false, code: 'BOARD_UNAVAILABLE' });
    const stream = await c.get(`/api/boards/${key}/stream`);
    expect(stream.status).toBe(503);
    expect(stream.json).toMatchObject({ ok: false, code: 'BOARD_UNAVAILABLE' });
  });

  it('Store を開けない（BUSY 以外。例: SQLITE_READONLY）POST は 503 BOARD_UNAVAILABLE', async () => {
    const key = seed();
    const c = await start();
    vi.spyOn(KanbanStore, 'open').mockImplementation(() => {
      throw Object.assign(new Error('attempt to write a readonly database'), { errcode: 8, code: 'ERR_SQLITE_ERROR' });
    });
    const r = await c.post(c.card(key, 'c', 'move'), { to: 'ready' });
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ ok: false, code: 'BOARD_UNAVAILABLE' });
    vi.restoreAllMocks();
    expect((await c.post(c.card(key, 'c', 'move'), { to: 'ready' })).status).toBe(200);
  });

  it('カードのイベントを読めない（BUSY 以外）は 503 BOARD_UNAVAILABLE、BUSY は 503 BUSY', async () => {
    const key = seed();
    const c = await start();
    const spy = vi.spyOn(KanbanReader.prototype, 'listCardEvents').mockImplementation(() => {
      throw sqliteError('database disk image is malformed', 11);
    });
    const r = await c.get(c.card(key, 'a', 'events'));
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ ok: false, code: 'BOARD_UNAVAILABLE' });
    spy.mockImplementation(() => {
      throw busyError();
    });
    const busy = await c.get(c.card(key, 'a', 'events'));
    expect(busy.status).toBe(503);
    expect(busy.json.code).toBe('BUSY');
    spy.mockRestore();
    expect((await c.get(c.card(key, 'a', 'events'))).status).toBe(200);
  });

  it('読み取りの SQLite 以外の例外（TypeError など）は 503 にせず 500 INTERNAL でスタックをログに出す', async () => {
    const key = seed();
    const logs: string[] = [];
    const c = await start({ log: (m) => logs.push(m) });
    vi.spyOn(KanbanReader.prototype, 'readSince').mockImplementation(() => {
      throw new TypeError('bug in reader');
    });
    const r = await c.get(`/api/boards/${key}`);
    expect(r.status).toBe(500);
    expect(r.json).toMatchObject({ ok: false, code: 'INTERNAL' });
    expect(logs.some((m) => m.includes('内部エラー') && m.includes('TypeError: bug in reader') && m.includes('    at '))).toBe(true);
    const stream = await c.get(`/api/boards/${key}/stream`);
    expect(stream.status).toBe(500);
  });

  it('保存されたイベントの JSON が壊れていれば（データの破損）カードのイベントは 503 BOARD_UNAVAILABLE', async () => {
    const key = seed();
    corruptLatestEventData(dbPathOf('b1'));
    const c = await start();
    const r = await c.get(c.card(key, 'b', 'events'));
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ ok: false, code: 'BOARD_UNAVAILABLE' });
  });

  it('BUSY 以外の読み取り失敗のあとは Reader を閉じ、次の要求で開き直す（ファイルの置き換えに追従する）', async () => {
    const key = seed();
    const c = await start();
    expect((await c.get(`/api/boards/${key}`)).status).toBe(200);
    const readSince = vi.spyOn(KanbanReader.prototype, 'readSince').mockImplementationOnce(() => {
      throw sqliteError('database disk image is malformed', 11);
    });
    expect((await c.get(`/api/boards/${key}`)).status).toBe(503);
    const open = vi.spyOn(KanbanReader, 'open');
    expect((await c.get(`/api/boards/${key}`)).status).toBe(200);
    expect(open).toHaveBeenCalledTimes(1);
    readSince.mockImplementationOnce(() => {
      throw busyError();
    });
    expect((await c.get(`/api/boards/${key}`)).status).toBe(503);
    expect((await c.get(`/api/boards/${key}`)).status).toBe(200);
    // BUSY では開き直さない
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('書き込みそのものの BUSY 以外の SQLite の失敗（例: SQLITE_READONLY）は 503 BOARD_UNAVAILABLE、それ以外の例外は 500', async () => {
    const key = seed();
    const c = await start();
    const spy = vi.spyOn(KanbanStore.prototype, 'moveCard').mockImplementation(() => {
      throw sqliteError('attempt to write a readonly database', 8);
    });
    const r = await c.post(c.card(key, 'c', 'move'), { to: 'ready' });
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ ok: false, code: 'BOARD_UNAVAILABLE' });
    spy.mockImplementation(() => {
      throw new TypeError('bug in store');
    });
    expect((await c.post(c.card(key, 'c', 'move'), { to: 'ready' })).status).toBe(500);
    spy.mockRestore();
    expect((await c.post(c.card(key, 'c', 'move'), { to: 'ready' })).status).toBe(200);
  });

  it('board: null は DB ファイルがない・ボードの行がないときだけ', async () => {
    seed();
    const c = await start();
    const missingFile = await c.post('/api/dbs', { path: dbPathOf('nofile'), boardId: 'x' });
    const missingRow = await c.post('/api/dbs', { path: dbPathOf('b1'), boardId: 'other' });
    for (const key of [missingFile.json.boards[0].key, missingRow.json.boards.find((b: any) => b.boardId === 'other').key]) {
      const r = await c.get(`/api/boards/${key}`);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ ok: true, board: null, lastEventId: 0 });
    }
  });

  it('SQLITE_BUSY は 503 BUSY', async () => {
    const key = seed();
    const c = await start();
    const locker = new DatabaseSync(dbPathOf('b1'));
    locker.exec('PRAGMA busy_timeout = 0');
    locker.exec('BEGIN IMMEDIATE');
    try {
      const r = await c.post(c.card(key, 'c', 'move'), { to: 'ready' });
      expect(r.status).toBe(503);
      expect(r.json.code).toBe('BUSY');
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }
    const retry = await c.post(c.card(key, 'c', 'move'), { to: 'ready' });
    expect(retry.status).toBe(200);
  });
});

describe('走査と表示で書き込まない（受け入れ基準 9・10）', () => {
  const V2_SQL = `
CREATE TABLE boards (id TEXT PRIMARY KEY, stale_days INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE columns (board_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, wip_limit INTEGER,
  entry_criteria TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (board_id, name));
CREATE TABLE cards (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, thread_id TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT, type TEXT NOT NULL, service_class TEXT NOT NULL, due_date TEXT, size TEXT,
  external_refs TEXT NOT NULL DEFAULT '[]', t3 TEXT, column_name TEXT NOT NULL, column_entered_at INTEGER NOT NULL,
  blocked_reason TEXT, blocked_since INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL, UNIQUE (board_id, thread_id));
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, card_id INTEGER, type TEXT NOT NULL,
  from_column TEXT, to_column TEXT, at INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}');
INSERT INTO boards VALUES ('v2board', 3, 1);
INSERT INTO columns VALUES ('v2board', 'inbox', 0, NULL, '[]'), ('v2board', 'ready', 1, 5, '[]'), ('v2board', 'doing', 2, 3, '[]'),
  ('v2board', 'review', 3, 2, '[]'), ('v2board', 'done', 4, NULL, '[]');
INSERT INTO cards (board_id, thread_id, title, type, service_class, column_name, column_entered_at, created_at, updated_at, last_event_at)
  VALUES ('v2board', 'old', '既存', 'feature', 'regular', 'doing', 1, 1, 1, 1);
INSERT INTO events (board_id, card_id, type, at) VALUES ('v2board', 1, 'created', 1);
PRAGMA user_version = 2;
`;

  it('一覧: 複数ボードの DB は 2 件、v2 は boardId の表示名、boards のない .db と -wal / -shm は出さない、表示名は base_path から', async () => {
    seed(dbPathOf('multi'), 'm1');
    const s2 = KanbanStore.open({ path: dbPathOf('multi'), boardId: 'm2', clock });
    s2.setBasePath('/work/repo/.git');
    s2.close();
    const s3 = KanbanStore.open({ path: dbPathOf('plain'), boardId: 'p1', clock });
    s3.setBasePath('/work/project');
    s3.close();
    const v2 = new DatabaseSync(dbPathOf('legacy'));
    v2.exec(V2_SQL);
    v2.close();
    new DatabaseSync(dbPathOf('empty')).close();
    const other = new DatabaseSync(dbPathOf('other'));
    other.exec('CREATE TABLE x (a INTEGER)');
    other.close();

    const before = Object.fromEntries(['multi', 'plain', 'legacy'].map((n) => [n, fileState(dbPathOf(n))]));
    const c = await start();
    const r = await c.get('/api/boards');
    const summary = r.json.boards.map((b: any) => [b.boardId, b.label, b.exists]).sort();
    expect(summary).toEqual([
      ['m1', 'm1', true],
      ['m2', 'repo', true],
      ['p1', 'project', true],
      ['v2board', 'v2board', true],
    ]);
    for (const b of r.json.boards) expect(b.dbPath.endsWith('.db')).toBe(true);
    for (const n of ['multi', 'plain', 'legacy']) expect(fileState(dbPathOf(n)), n).toEqual(before[n]);

    // v2 のボードを開いて監視しても移行しない
    const legacyKey = r.json.boards.find((b: any) => b.boardId === 'v2board').key;
    const s = track(c.stream(legacyKey));
    await s.waitFor(() => s.snapshots().length >= 1);
    await sleep(150);
    expect(columnOf(s.snapshots()[0], 'old')).toBe('doing');
    expect(fileState(dbPathOf('legacy'))).toEqual(before.legacy);
    const check = new DatabaseSync(dbPathOf('legacy'), { readOnly: true });
    const cols = (check.prepare('PRAGMA table_info(boards)').all() as { name: string }[]).map((x) => x.name);
    check.close();
    expect(cols).not.toContain('base_path');
  });

  it('--db のパスは realpath(dirname) で正規化して重複を除く', async () => {
    const real = join(tmp.path, 'real');
    mkdirSync(real);
    symlinkSync(real, join(tmp.path, 'link'));
    seed(join(real, 'ext.db'), 'ext');
    const c = await start({ extraDbs: [join(tmp.path, 'link', 'ext.db'), join(real, 'ext.db'), join(real, '.', 'ext.db')] });
    const r = await c.get('/api/boards');
    expect(r.json.boards.filter((b: any) => b.boardId === 'ext')).toHaveLength(1);
  });

  it('ボードを開いて監視・閲覧している間は DB 本体も -wal も変わらず、最初の POST でもボードの行は増えない', async () => {
    const key = seed();
    const path = dbPathOf('b1');
    const before = fileState(path);
    const walBefore = fileState(`${path}-wal`);
    const c = await start({ rebuildIntervalMs: 50 });
    await c.get('/api/boards');
    await c.get(`/api/boards/${key}`);
    await c.get(c.card(key, 'a', 'events'));
    await c.get(c.card(key, 'b', 'move-options'));
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 3);
    expect(fileState(path)).toEqual(before);
    const walAfter = fileState(`${path}-wal`);
    expect(walAfter === null || walAfter.size === (walBefore?.size ?? 0)).toBe(true);

    expect((await c.post(c.card(key, 'c', 'move'), { to: 'ready' })).json.ok).toBe(true);
    const db = new DatabaseSync(path, { readOnly: true });
    const boards = (db.prepare('SELECT id FROM boards').all() as { id: string }[]).map((x) => x.id);
    db.close();
    expect(boards).toEqual(['b1']);
  });
});

describe('SSE の配信（受け入れ基準 2・3・4・11）', () => {
  it('接続するとすぐ snapshot、lastEventId 付きならその後のイベント → snapshot', async () => {
    const key = seed();
    const c = await start();
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    expect(s.messages[0]?.event).toBe('snapshot');
    expect(s.messages[0]?.id).toBe('10');
    expect(s.messages[0]?.data.lastEventId).toBe(10);

    const s2 = track(c.stream(key, 8));
    await s2.waitFor(() => s2.snapshots().length >= 1);
    expect(s2.messages.map((m) => m.event)).toEqual(['events', 'snapshot']);
    expect(s2.messages[0]?.id).toBe('10');
    expect(s2.events().map((e) => e.id)).toEqual([9, 10]);
  });

  it('MCP（別の接続）の更新が 1.5 秒以内に actor なしのイベントと新しいボードで届く', async () => {
    const key = seed();
    const c = await start({ pollMs: 500 });
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    const mcp = await startMcp(dbPathOf('b1'), 'b1', clock);
    try {
      const started = Date.now();
      const r = await mcp.call('kanban_card_move', { threadId: 'c', to: 'ready' });
      expect(r.isError).toBeFalsy();
      await s.waitFor(() => s.events().some((e) => e.threadId === 'c' && e.type === 'moved'), 1500);
      await s.waitFor(() => columnOf(s.snapshots().at(-1), 'c') === 'ready', 1500);
      expect(Date.now() - started).toBeLessThan(1500);
      const ev = s.events().find((e) => e.threadId === 'c');
      expect(ev).toMatchObject({ type: 'moved', fromColumn: 'inbox', toColumn: 'ready', actor: null, title: 'card c', cardId: 3 });
      // events → snapshot の順
      const idx = s.messages.findIndex((m) => m.event === 'events');
      expect(s.messages[idx + 1]?.event).toBe('snapshot');
    } finally {
      await mcp.close();
    }
  });

  it('UI の操作は、ほかのクライアントにも 1.5 秒以内に 1 回だけ届く（data.actor = "ui"）', async () => {
    const key = seed();
    const c = await start({ pollMs: 10_000 }); // 定期ポーリングに頼らず、書き込み直後のポーリングで届くこと
    const a = track(c.stream(key));
    const b = track(c.stream(key));
    await a.waitFor(() => a.snapshots().length >= 1);
    await b.waitFor(() => b.snapshots().length >= 1);
    const started = Date.now();
    const r = await c.post(c.card(key, 'b', 'move'), { to: 'doing', force: true, reason: '急ぎ' });
    expect(r.json.ok).toBe(true);
    for (const s of [a, b]) {
      await s.waitFor(() => s.events().length >= 2, 1500);
      expect(Date.now() - started).toBeLessThan(1500);
    }
    await sleep(200);
    for (const s of [a, b]) {
      const evs = s.events();
      expect(evs.map((e) => e.type)).toEqual(['moved', 'wip_violation']);
      expect(new Set(evs.map((e) => e.id)).size).toBe(evs.length);
      // 受け入れ基準 11: 自動で記録される wip_violation にも actor が付く
      for (const e of evs) {
        expect(e.actor).toBe('ui');
        expect(e.data.actor).toBe('ui');
      }
      expect(columnOf(s.snapshots().at(-1), 'b')).toBe('doing');
    }
  });

  it('MCP 経由のイベントには actor が付かず、UI の block / unblock には付く（受け入れ基準 11）', async () => {
    const key = seed();
    const c = await start();
    await c.post(c.card(key, 'c', 'block'), { reason: '待ち' });
    await c.post(c.card(key, 'c', 'unblock'), { resolution: '解消' });
    const mcp = await startMcp(dbPathOf('b1'), 'b1', clock);
    try {
      await mcp.call('kanban_card_block', { threadId: 'c', reason: 'agent' });
    } finally {
      await mcp.close();
    }
    const evs = (await c.get(c.card(key, 'c', 'events'))).json.events;
    expect(evs.map((e: any) => [e.type, e.actor])).toEqual([
      ['created', null],
      ['moved', null],
      ['blocked', 'ui'],
      ['unblocked', 'ui'],
      ['blocked', null],
    ]);
    expect(evs[4].data.actor).toBeUndefined();
  });

  it('DB に変化がなくても rebuildIntervalMs ごとに組み直し、stale の境界を越えると stale: true が届く（events は送らない）', async () => {
    const key = seed();
    const c = await start({ rebuildIntervalMs: 80 });
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    const card = (snap: any) => snap.board.columns.find((col: any) => col.column === 'doing').cards[0];
    expect(card(s.snapshots()[0]).stale).toBe(false);
    clock.advance(4 * DAY);
    await s.waitFor(() => card(s.snapshots().at(-1)).stale === true, 1500);
    expect(s.snapshots().at(-1).now).toBe(new Date(T0 + 4 * DAY).toISOString());
    expect(s.messages.filter((m) => m.event === 'events')).toEqual([]);
  });

  it('取得の上限を超えたら snapshot だけを送る', async () => {
    const key = seed();
    const c = await start({ maxEvents: 2 });
    const s = track(c.stream(key, 1));
    await s.waitFor(() => s.snapshots().length >= 1);
    expect(s.messages.map((m) => m.event)).toEqual(['snapshot']);
    expect(s.snapshots()[0].truncated).toBe(true);
    // 上限を超えていなければ truncated は付けない
    const all = s.snapshots()[0].lastEventId as number;
    const s2 = track(c.stream(key, all - 1));
    await s2.waitFor(() => s2.snapshots().length >= 1);
    expect(s2.messages.map((m) => m.event)).toEqual(['events', 'snapshot']);
    expect('truncated' in s2.snapshots()[0]).toBe(false);
  });

  it('15 秒ごとの keepalive（間隔は差し替え）', async () => {
    const key = seed();
    const c = await start({ keepaliveMs: 30 });
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    await sleep(150);
    expect(s.comments).toBeGreaterThan(0);
  });
});

describe('再接続（受け入れ基準 13）', () => {
  it('再起動後も同じトークンなら lastEventId 付きで取りこぼしを受け取り、--db で登録したボードも残る', async () => {
    const key = seed();
    const extPath = join(tmp.path, 'ext', 'ext.db');
    const extKey = seed(extPath, 'ext');
    const first = await start({ extraDbs: [extPath] });
    const port = first.port;
    const s1 = track(first.stream(key));
    await s1.waitFor(() => s1.snapshots().length >= 1);
    const last = s1.snapshots()[0].lastEventId as number;
    s1.close();
    await server?.close();
    server = null;

    const store = KanbanStore.open({ path: dbPathOf('b1'), boardId: 'b1', clock });
    store.moveCard('c', { to: 'ready' });
    store.close();

    const second = await start({ port });
    expect(second.port).toBe(port);
    const boards = (await second.get('/api/boards')).json.boards.map((b: any) => b.key);
    expect(boards).toContain(extKey);
    const s2 = track(second.stream(key, last));
    await s2.waitFor(() => s2.snapshots().length >= 1);
    expect(s2.messages.map((m) => m.event)).toEqual(['events', 'snapshot']);
    expect(s2.events().map((e) => [e.threadId, e.toColumn])).toEqual([['c', 'ready']]);
  });

  it('トークンを変えると古い cookie の health は 403、cookie がなければ authenticated: none', async () => {
    const c = await start({ token: 'rotated-token-abcdefghijkl' });
    const old = new UiClient(c.port, TOKEN);
    expect((await old.get('/api/health')).status).toBe(403);
    const none = await httpRequest(c.port, '/api/health', { headers: { Host: `127.0.0.1:${c.port}` } });
    expect(none.json.authenticated).toBe('none');
  });
});

describe('DB がまだないボード（受け入れ基準 13a）', () => {
  it('シンボリックリンク経由の homeDir でも、ファイルができると同じキーのまま空の表示からボードの表示に切り替わる', async () => {
    const realHome = join(tmp.path, 'real-home');
    mkdirSync(realHome);
    const linkHome = join(tmp.path, 'link-home');
    symlinkSync(realHome, linkHome);
    const location = resolveLocation({ env: { KANBAN_BOARD_ID: 'fresh' }, cwd: tmp.path, homeDir: linkHome });
    const r = await startUi({
      homeDir: linkHome,
      clock,
      defaultBoard: { dbPath: location.dbPath, boardId: location.boardId, basePath: location.basePath },
    });
    server = r.server;
    const c = r.client;
    const before = (await c.get('/api/boards')).json;
    const key = before.defaultKey as string;
    expect(before.boards).toEqual([expect.objectContaining({ key, boardId: 'fresh', exists: false })]);
    expect(existsSync(location.dbPath)).toBe(false);

    const empty = await c.get(`/api/boards/${key}`);
    expect(empty.json).toMatchObject({ ok: true, key, board: null, next: null, lastEventId: 0 });
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    expect(s.snapshots()[0].board).toBeNull();

    // MCP は実体のパスで作る（どちらのパスでもキーは同じになる）
    const mcp = await startMcp(join(realHome, '.t3-kanban', 'fresh.db'), 'fresh', clock);
    try {
      await mcp.call('kanban_card_add', { threadId: 'n1', title: 'new' });
      await s.waitFor(() => columnOf(s.snapshots().at(-1), 'n1') === 'inbox', 1500);
      expect(s.snapshots().at(-1).key).toBe(key);
      const after = (await c.get('/api/boards')).json;
      expect(after.defaultKey).toBe(key);
      expect(after.boards).toEqual([expect.objectContaining({ key, boardId: 'fresh', exists: true })]);
    } finally {
      await mcp.close();
    }
  });
});

describe('ログインコード（--open でトークンを argv に載せない）', () => {
  it('GET /?code= は 1 回だけ cookie を設定して / へ 302。使用済み・期限切れ・不明なコードは cookie なしで 302', async () => {
    const c = await start();
    const host = { Host: `127.0.0.1:${c.port}` };
    const code = server!.issueLoginCode();
    expect(code).not.toContain(TOKEN);
    const r = await httpRequest(c.port, `/?code=${encodeURIComponent(code)}`, { headers: host });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/');
    expect(r.headers['set-cookie']).toEqual([`tk_${c.port}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`]);
    const reused = await httpRequest(c.port, `/?code=${encodeURIComponent(code)}`, { headers: host });
    expect(reused.status).toBe(302);
    expect(reused.headers['set-cookie']).toBeUndefined();

    const expired = server!.issueLoginCode();
    clock.advance(60_001);
    const late = await httpRequest(c.port, `/?code=${encodeURIComponent(expired)}`, { headers: host });
    expect(late.status).toBe(302);
    expect(late.headers['set-cookie']).toBeUndefined();

    const unknown = await httpRequest(c.port, '/?code=nope', { headers: host });
    expect(unknown.status).toBe(302);
    expect(unknown.headers['set-cookie']).toBeUndefined();
  });

  it('POST /api/login-code は cookie と Origin が必要で、返したコードでログインできる', async () => {
    const c = await start();
    const noCookie = await httpRequest(c.port, '/api/login-code', {
      method: 'POST',
      headers: { Host: `127.0.0.1:${c.port}`, Origin: `http://127.0.0.1:${c.port}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(noCookie.status).toBe(403);
    const badOrigin = await httpRequest(c.port, '/api/login-code', {
      method: 'POST',
      headers: { ...c.baseHeaders, Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(badOrigin.status).toBe(403);
    const r = await c.post('/api/login-code', {});
    expect(r.status).toBe(200);
    expect(typeof r.json.code).toBe('string');
    const login = await httpRequest(c.port, `/?code=${encodeURIComponent(r.json.code)}`, { headers: { Host: `127.0.0.1:${c.port}` } });
    expect(login.headers['set-cookie']?.[0]).toContain(`tk_${c.port}=${TOKEN}`);
  });
});

describe('応答ヘッダー', () => {
  it('HTML と静的ファイルに CSP（frame-ancestors なし）と nosniff を付ける', async () => {
    const c = await start();
    for (const p of ['/', '/app.js', '/app.css']) {
      const r = await httpRequest(c.port, p, { headers: { Host: `127.0.0.1:${c.port}` } });
      expect(r.status, p).toBe(200);
      expect(r.headers['content-security-policy'], p).toBe(
        "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
      );
      expect(r.headers['content-security-policy']).not.toContain('frame-ancestors');
      expect(r.headers['x-content-type-options'], p).toBe('nosniff');
    }
    // ビルドした index.html にインラインのスクリプトとスタイルがない（CSP で止まらない）
    const index = (await httpRequest(c.port, '/', { headers: { Host: `127.0.0.1:${c.port}` } })).text;
    expect(index).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(index).not.toMatch(/<style\b/);
    expect(index).not.toMatch(/\son[a-z]+=/i);
  });
});

describe('POST /api/dbs の制限', () => {
  it('「.db」で終わる絶対パスだけを受け付け、親ディレクトリがなければ 400 で作らない', async () => {
    const c = await start();
    expect((await c.post('/api/dbs', { path: 'relative/x.db' })).status).toBe(400);
    expect((await c.post('/api/dbs', { path: join(tmp.path, 'x.sqlite') })).status).toBe(400);
    const missing = join(tmp.path, 'no-such-dir', 'x.db');
    const r = await c.post('/api/dbs', { path: missing });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('INVALID_ARGUMENT');
    expect(existsSync(join(tmp.path, 'no-such-dir'))).toBe(false);
  });

  it('boardId を付けると DB がまだなくても exists: false のボードとして一覧に出し、応答のキーは boards', async () => {
    const c = await start();
    const dir = join(tmp.path, 'other-repo');
    mkdirSync(dir);
    const dbPath = join(dir, 'pending.db');
    const r = await c.post('/api/dbs', { path: dbPath, boardId: 'pend', basePath: '/work/other-repo' });
    expect(r.status).toBe(200);
    const key = keyOf(dbPath, 'pend');
    expect(r.json.board).toBeUndefined();
    expect(r.json.boards).toEqual([expect.objectContaining({ key, boardId: 'pend', label: 'other-repo', exists: false })]);
    expect(existsSync(dbPath)).toBe(false);
    const list = (await c.get('/api/boards')).json.boards;
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ key, exists: false })]));
    const board = await c.get(`/api/boards/${key}`);
    expect(board.json).toMatchObject({ ok: true, key, board: null });

    // ファイルができれば exists: true に切り替わる（キーは同じ）
    seed(dbPath, 'pend');
    const after = (await c.get('/api/boards')).json.boards.filter((b: any) => b.key === key);
    expect(after).toEqual([expect.objectContaining({ key, exists: true })]);
  });

  it('登録済みの DB が 100 件あれば、新しいパスは 409 LIMIT_EXCEEDED（登録済みのパスは 200）', async () => {
    const existing = Array.from({ length: 100 }, (_, i) => normalizeDbPath(join(tmp.path, `r${i}.db`)));
    writeFileSync(join(home, '.t3-kanban', 'ui-dbs.json'), JSON.stringify(existing), { mode: 0o600 });
    const c = await start();
    const r = await c.post('/api/dbs', { path: join(tmp.path, 'one-more.db') });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('LIMIT_EXCEEDED');
    expect((await c.post('/api/dbs', { path: existing[0] })).status).toBe(200);
  });

  it('走査するディレクトリ直下の .db は保存しないので、登録が 100 件でも受け付ける', async () => {
    const existing = Array.from({ length: 100 }, (_, i) => normalizeDbPath(join(tmp.path, `r${i}.db`)));
    writeFileSync(join(home, '.t3-kanban', 'ui-dbs.json'), JSON.stringify(existing), { mode: 0o600 });
    const c = await start();
    const r = await c.post('/api/dbs', { path: dbPathOf('scanned'), boardId: 'b1' });
    expect(r.status).toBe(200);
  });

  it('boardId 付きのまだないボードは 100 件まで（同じ組は 1 件、101 件目は 409 LIMIT_EXCEEDED）', async () => {
    const c = await start();
    const dir = join(tmp.path, 'pending-repo');
    mkdirSync(dir);
    const dbPath = join(dir, 'p.db');
    for (let i = 0; i < 100; i += 1) {
      expect((await c.post('/api/dbs', { path: dbPath, boardId: `b${i}` })).status).toBe(200);
    }
    expect((await c.post('/api/dbs', { path: dbPath, boardId: 'b0' })).status).toBe(200);
    const pendingKeys = (await c.get('/api/boards')).json.boards.filter((b: any) => b.exists === false);
    expect(pendingKeys).toHaveLength(100);
    const r = await c.post('/api/dbs', { path: dbPath, boardId: 'b100' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('LIMIT_EXCEEDED');
  });
});

describe('サーバーのタイムアウトと接続数', () => {
  it('requestTimeout を過ぎても SSE は切れずに keepalive と snapshot が届き、maxConnections を設定する', async () => {
    const key = seed();
    const c = await start({ keepaliveMs: 50, requestTimeout: 300, headersTimeout: 200, connectionsCheckingInterval: 50 });
    expect(server?.maxConnections).toBe(128);
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    await sleep(1000);
    const comments = s.comments;
    const store = KanbanStore.open({ path: dbPathOf('b1'), boardId: 'b1', clock });
    try {
      store.moveCard('c', { to: 'ready' });
    } finally {
      store.close();
    }
    await s.waitFor((m) => m.some((x) => x.event === 'snapshot' && columnOf(x.data, 'c') === 'ready'));
    await sleep(150);
    expect(s.comments).toBeGreaterThan(comments);
  });
});

describe('SSE の上限と配信の再試行', () => {
  it('1 つのボードの SSE は 20 件まで、21 件目は 503 BUSY', async () => {
    const key = seed();
    const c = await start();
    const opened = Array.from({ length: 20 }, () => track(c.stream(key)));
    await Promise.all(opened.map((s) => s.waitFor(() => s.snapshots().length >= 1)));
    const r = await c.get(`/api/boards/${key}/stream`);
    expect(r.status).toBe(503);
    expect(r.json.code).toBe('BUSY');
  });

  it('一時的なロック（SQLITE_BUSY）で読めなかった変更は、接続を保ったまま rebuild を待たず次のポーリングで届く', async () => {
    const key = seed();
    const c = await start();
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    await sleep(100);
    const spy = vi.spyOn(KanbanReader.prototype, 'readSince').mockImplementationOnce(() => {
      throw busyError();
    });
    const store = KanbanStore.open({ path: dbPathOf('b1'), boardId: 'b1', clock });
    store.moveCard('c', { to: 'ready' });
    store.close();
    await s.waitFor(() => columnOf(s.snapshots().at(-1), 'c') === 'ready', 1000);
    expect(spy).toHaveBeenCalled();
    expect(s.ended).toBe(false);
  });

  it('接続中に BUSY 以外の読み取り失敗（壊れたファイルなど）が起きたら SSE を閉じ、再接続は 503 BOARD_UNAVAILABLE', async () => {
    const key = seed();
    const c = await start();
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    vi.spyOn(KanbanReader.prototype, 'readSince').mockImplementation(() => {
      throw sqliteError('file is not a database', 26);
    });
    const store = KanbanStore.open({ path: dbPathOf('b1'), boardId: 'b1', clock });
    store.moveCard('c', { to: 'ready' });
    store.close();
    await s.waitForEnd(1000);
    const again = await c.get(`/api/boards/${key}/stream`);
    expect(again.status).toBe(503);
    expect(again.json.code).toBe('BOARD_UNAVAILABLE');
  });

  it('stream の事前の読み取りが SQLITE_BUSY なら 503 にせず接続を始め、ポーリングで snapshot を届ける', async () => {
    const key = seed();
    const c = await start();
    vi.spyOn(KanbanReader.prototype, 'readSince')
      .mockImplementationOnce(() => {
        throw busyError();
      })
      .mockImplementationOnce(() => {
        throw busyError();
      });
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1, 1000);
    expect(columnOf(s.snapshots()[0], 'a')).toBe('doing');
    expect(s.ended).toBe(false);
  });

  it('事前の読み取りは通るが配信の読み取り（readSince(cursor)）が壊れた行で失敗したら、SSE を閉じて次は Reader を開き直す', async () => {
    const key = seed();
    corruptLatestEventData(dbPathOf('b1'));
    const logs: string[] = [];
    const c = await start({ log: (m) => logs.push(m) });
    const s = track(c.stream(key, 0));
    await s.waitForEnd(1000);
    expect(s.messages).toHaveLength(0);
    expect(logs.some((m) => m.includes('ボードを読めません'))).toBe(true);
    expect(logs.some((m) => m.includes('内部エラー'))).toBe(false);
    const open = vi.spyOn(KanbanReader, 'open');
    // 事前の読み取り（イベントを読まない）は通るので 200 で開き、配信でまた閉じる（再接続の回数の上限はクライアントが数える）
    const again = track(c.stream(key, 0));
    await again.waitForEnd(1000);
    expect(again.status).toBe(200);
    expect(open).toHaveBeenCalled();
  });

  it('配信の読み取りで SQLite 以外の例外（TypeError など）が起きたら、スタックをログに出して SSE を閉じる', async () => {
    const key = seed();
    const logs: string[] = [];
    const c = await start({ log: (m) => logs.push(m) });
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    vi.spyOn(KanbanReader.prototype, 'readSince').mockImplementation(() => {
      throw new TypeError('bug in reader');
    });
    const store = KanbanStore.open({ path: dbPathOf('b1'), boardId: 'b1', clock });
    store.moveCard('c', { to: 'ready' });
    store.close();
    await s.waitForEnd(1000);
    expect(logs.some((m) => m.includes('内部エラー') && m.includes('TypeError: bug in reader'))).toBe(true);
  });

  it('ファイルが現れたのに開けないときは、そのポーリングで Reader を 1 回だけ開こうとして SSE を閉じる', async () => {
    const c = await start();
    const key = (await c.post('/api/dbs', { path: dbPathOf('later'), boardId: 'b1' })).json.boards[0].key;
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    expect(s.snapshots()[0].board).toBeNull();
    const spy = vi.spyOn(KanbanReader, 'open').mockImplementation(() => {
      throw new Error('unable to open database file');
    });
    seed(dbPathOf('later'), 'b1');
    await s.waitForEnd(1000);
    await sleep(100);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('同じ読み取りエラーはログに 1 回だけ出し、回復した後の失敗はまた出す', async () => {
    const key = seed();
    const logs: string[] = [];
    const c = await start({ log: (m) => logs.push(m) });
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    const locked = (): void => {
      vi.spyOn(KanbanReader.prototype, 'readSince').mockImplementation(() => {
        throw busyError();
      });
    };
    const moveTo = (to: 'ready' | 'inbox'): void => {
      const store = KanbanStore.open({ path: dbPathOf('b1'), boardId: 'b1', clock });
      store.moveCard('c', { to });
      store.close();
    };
    locked();
    moveTo('ready');
    await sleep(300);
    expect(logs.filter((m) => m.includes('database is locked'))).toHaveLength(1);
    expect(s.snapshots()).toHaveLength(1);
    vi.restoreAllMocks();
    await s.waitFor(() => columnOf(s.snapshots().at(-1), 'c') === 'ready', 1000);
    locked();
    moveTo('inbox');
    await sleep(300);
    expect(logs.filter((m) => m.includes('database is locked'))).toHaveLength(2);
    expect(s.ended).toBe(false);
  });

  it('lastEventId なしの新しい接続ではイベントを読まない（readSince の上限は 0）', async () => {
    const key = seed();
    const c = await start();
    const spy = vi.spyOn(KanbanReader.prototype, 'readSince');
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    expect(spy.mock.calls[0]).toEqual([Number.MAX_SAFE_INTEGER, 0]);
    expect(s.messages.map((m) => m.event)).toEqual(['snapshot']);
  });

  it('配信のたびに表示名を boards.base_path から組み直す', async () => {
    const key = seed();
    const c = await start();
    const s = track(c.stream(key));
    await s.waitFor(() => s.snapshots().length >= 1);
    expect(s.snapshots()[0].label).toBe('b1');
    const store = KanbanStore.open({ path: dbPathOf('b1'), boardId: 'b1', clock });
    store.setBasePath('/work/renamed-repo');
    store.close();
    await s.waitFor(() => s.snapshots().at(-1).label === 'renamed-repo', 1000);
    expect((await c.get(`/api/boards/${key}`)).json.label).toBe('renamed-repo');
  });
});
