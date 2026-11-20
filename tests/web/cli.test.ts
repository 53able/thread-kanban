// 受け入れ基準 1・13（--rotate-token）: ビルド済みの `thread-kanban ui` を子プロセスで起動する。
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KanbanStore } from '../../src/store/sqlite.js';
import { boardKey, normalizeDbPath } from '../../src/web/discovery.js';
import { healthHmac } from '../../src/web/server.js';
import { DIST_INDEX, manualClock, tempDir } from '../helpers/fixtures.js';
import { childEnv } from '../helpers/mcp.js';
import { httpRequest, UiClient } from './helpers.js';

let tmp: ReturnType<typeof tempDir>;
let home: string;
let cwd: string;
let children: ChildProcess[];
let fakes: Server[];

beforeEach(() => {
  tmp = tempDir('kanban-ui-cli-');
  home = join(tmp.path, 'home');
  cwd = join(tmp.path, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  children = [];
  fakes = [];
});

afterEach(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await Promise.all(fakes.map((f) => new Promise<void>((r) => f.close(() => r()))));
  tmp.cleanup();
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

interface Run {
  proc: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** 最初の 1 行（URL）か終了まで待つ */
  firstLine: Promise<string | null>;
  exit: Promise<number | null>;
}

function runUi(args: string[], env: Record<string, string> = {}): Run {
  const proc = spawn(process.execPath, [DIST_INDEX, 'ui', ...args], {
    cwd,
    env: childEnv({ HOME: home, KANBAN_BOARD_ID: 'cli-board', ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let out = '';
  let err = '';
  proc.stderr?.on('data', (c: Buffer) => {
    err += c.toString('utf8');
  });
  const exit = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
  const firstLine = new Promise<string | null>((resolve) => {
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
      if (out.includes('\n')) resolve(out.slice(0, out.indexOf('\n')));
    });
    void exit.then(() => resolve(out.includes('\n') ? out.slice(0, out.indexOf('\n')) : null));
  });
  return { proc, stdout: () => out, stderr: () => err, firstLine, exit };
}

function tokenFile(): string {
  return join(home, '.t3-kanban', 'ui-token');
}

function expectedKey(): string {
  return boardKey(normalizeDbPath(join(home, '.t3-kanban', 'cli-board.db')), 'cli-board');
}

async function stop(run: Run): Promise<void> {
  run.proc.kill('SIGTERM');
  await run.exit;
}

/** 偽のサーバー（受け取った要求の URL とヘッダーを記録する）。 */
async function fake(port: number, handler: (url: string, res: import('node:http').ServerResponse) => void): Promise<{ seen: { url: string; headers: IncomingHttpHeaders }[] }> {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    handler(req.url ?? '', res);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  fakes.push(server);
  return { seen };
}

describe('thread-kanban ui（受け入れ基準 1）', () => {
  it('URL を stdout に 1 行だけ出し、同じポートで動いていればチャレンジ応答の後に同じ URL を出して 0 で終わる', async () => {
    const port = await freePort();
    const extDb = join(tmp.path, 'ext', 'ext.db');
    const store = KanbanStore.open({ path: extDb, boardId: 'ext', clock: manualClock() });
    store.addCard({ threadId: 'x', title: 'x' });
    store.close();

    const first = runUi(['--port', String(port)]);
    const url = await first.firstLine;
    const token = readFileSync(tokenFile(), 'utf8').trim();
    expect(url).toBe(`http://127.0.0.1:${port}/?token=${token}#board=${expectedKey()}`);
    await new Promise((r) => setTimeout(r, 100));
    expect(first.stdout()).toBe(`${url}\n`);
    expect(statSync(tokenFile()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.t3-kanban')).mode & 0o777).toBe(0o700);

    const second = runUi(['--port', String(port), '--db', extDb]);
    expect(await second.exit).toBe(0);
    expect(second.stdout()).toBe(`${url}\n`);

    // --db は POST /api/dbs で登録され、ui-dbs.json（0600）にも残る
    const client = new UiClient(port, token);
    const boards = (await client.get('/api/boards')).json;
    expect(boards.boards.map((b: any) => b.boardId)).toEqual(expect.arrayContaining(['ext', 'cli-board']));
    expect(boards.defaultKey).toBe(expectedKey());
    const dbsFile = join(home, '.t3-kanban', 'ui-dbs.json');
    expect(JSON.parse(readFileSync(dbsFile, 'utf8'))).toEqual([normalizeDbPath(extDb)]);
    expect(statSync(dbsFile).mode & 0o777).toBe(0o600);

    // 受け入れ基準 13: 動いている間の --rotate-token は拒否する
    const rotate = runUi(['--port', String(port), '--rotate-token']);
    expect(await rotate.exit).toBe(1);
    expect(rotate.stdout()).toBe('');
    expect(readFileSync(tokenFile(), 'utf8').trim()).toBe(token);

    await stop(first);
    const rotated = runUi(['--port', String(port), '--rotate-token']);
    const newUrl = await rotated.firstLine;
    const newToken = readFileSync(tokenFile(), 'utf8').trim();
    expect(newToken).not.toBe(token);
    expect(newUrl).toBe(`http://127.0.0.1:${port}/?token=${newToken}#board=${expectedKey()}`);
    await stop(rotated);
  });

  it('別のプロセスがポートを使っていれば、理由と --port の使い方を出して 1 で終わる（トークンは送らない）', async () => {
    const port = await freePort();
    const f = await fake(port, (_url, res) => {
      res.writeHead(404);
      res.end('not found');
    });
    const run = runUi(['--port', String(port)]);
    expect(await run.exit).toBe(1);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toContain('--port');
    const token = readFileSync(tokenFile(), 'utf8').trim();
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]?.url).toMatch(/^\/api\/health\?nonce=[0-9a-f]+$/);
    expect(f.seen[0]?.headers.cookie).toBeUndefined();
    expect(JSON.stringify(f.seen)).not.toContain(token);
  });

  it('HMAC が一致しなければ 1 で終わる', async () => {
    const port = await freePort();
    await fake(port, (_url, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '0.1.0', authenticated: 'none', hmac: '0'.repeat(64) }));
    });
    const run = runUi(['--port', String(port)]);
    expect(await run.exit).toBe(1);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toContain('トークンが一致しません');
  });

  it('HMAC が一致してもバージョンが違えば 1 で終わる', async () => {
    const port = await freePort();
    const token = 'known-token-abcdefghijklmnop';
    mkdirSync(join(home, '.t3-kanban'), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile(), `${token}\n`, { mode: 0o600 });
    await fake(port, (url, res) => {
      const nonce = new URL(url, 'http://x').searchParams.get('nonce') ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '9.9.9', authenticated: 'none', hmac: healthHmac(token, port, nonce) }));
    });
    const run = runUi(['--port', String(port)]);
    expect(await run.exit).toBe(1);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toContain('9.9.9');
  });

  it('トークンファイルの権限が緩ければ警告してトークンを作り直し（0600）、~/.t3-kanban の外の KANBAN_DB_PATH は暗黙に登録する', async () => {
    const port = await freePort();
    mkdirSync(join(home, '.t3-kanban'), { recursive: true });
    writeFileSync(tokenFile(), 'loose-token-abcdefghijklmnop\n');
    chmodSync(tokenFile(), 0o644);
    const outside = join(tmp.path, 'elsewhere', 'board.db');
    const run = runUi(['--port', String(port)], { KANBAN_DB_PATH: outside });
    const url = await run.firstLine;
    const rotated = readFileSync(tokenFile(), 'utf8').trim();
    expect(rotated).not.toBe('loose-token-abcdefghijklmnop');
    expect(url).toContain(`token=${rotated}`);
    expect(run.stderr()).toContain('作り直します');
    expect(url).toContain(`#board=${boardKey(normalizeDbPath(outside), 'cli-board')}`);
    expect(statSync(tokenFile()).mode & 0o777).toBe(0o600);
    expect(run.stderr()).toContain('0600');
    expect(JSON.parse(readFileSync(join(home, '.t3-kanban', 'ui-dbs.json'), 'utf8'))).toEqual([normalizeDbPath(outside)]);
    await stop(run);
  });

  it('別のポートの本物のサーバーの応答を中継しても HMAC が一致せず 1 で終わる', async () => {
    const realPort = await freePort();
    const real = runUi(['--port', String(realPort)]);
    await real.firstLine;
    const relayPort = await freePort();
    const relay = await fake(relayPort, (url, res) => {
      // 受け取った nonce をそのまま本物のサーバーに渡し、応答を返す
      void httpRequest(realPort, url, { headers: { Host: `127.0.0.1:${realPort}` } }).then((r) => {
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(r.text);
      });
    });
    const run = runUi(['--port', String(relayPort)]);
    expect(await run.exit).toBe(1);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toContain('トークンが一致しません');
    expect(relay.seen).toHaveLength(1);
    await stop(real);
  });

  it('別のディレクトリ（まだ DB のないボード）から再利用すると、そのボードが exists: false で一覧に出る', async () => {
    const port = await freePort();
    const first = runUi(['--port', String(port)]);
    await first.firstLine;
    const token = readFileSync(tokenFile(), 'utf8').trim();
    const second = runUi(['--port', String(port)], { KANBAN_BOARD_ID: 'other-board' });
    expect(await second.exit).toBe(0);
    const otherKey = boardKey(normalizeDbPath(join(home, '.t3-kanban', 'other-board.db')), 'other-board');
    expect(second.stdout()).toBe(`http://127.0.0.1:${port}/?token=${token}#board=${otherKey}\n`);
    const boards = (await new UiClient(port, token).get('/api/boards')).json.boards;
    expect(boards).toEqual(expect.arrayContaining([expect.objectContaining({ key: otherKey, boardId: 'other-board', exists: false })]));
    // ~/.t3-kanban 直下の DB は走査で見つかるので ui-dbs.json には残さない
    expect(existsSync(join(home, '.t3-kanban', 'ui-dbs.json'))).toBe(false);
    await stop(first);
  });

  it('--open はトークンではなく使い捨てのログインコードで開く（起動時と再利用時）', async () => {
    const port = await freePort();
    const bin = join(tmp.path, 'bin');
    const record = join(tmp.path, 'opened.txt');
    mkdirSync(bin);
    for (const name of ['open', 'xdg-open']) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" >> '${record}'\n`, { mode: 0o755 });
    }
    const env = { PATH: `${bin}:${process.env.PATH ?? ''}` };
    const opened = async (n: number): Promise<string[]> => {
      for (let i = 0; i < 50; i += 1) {
        const lines = existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n') : [];
        if (lines.length >= n) return lines;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('ブラウザを開くコマンドが呼ばれません');
    };
    const first = runUi(['--port', String(port), '--open'], env);
    const url = await first.firstLine;
    const token = readFileSync(tokenFile(), 'utf8').trim();
    expect(url).toContain(`?token=${token}`);
    const second = runUi(['--port', String(port), '--open'], env);
    expect(await second.exit).toBe(0);
    const lines = await opened(2);
    for (const line of lines) {
      expect(line).not.toContain(token);
      expect(line).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?code=[A-Za-z0-9_-]+#board=${expectedKey()}$`));
      const path = new URL(line).pathname + new URL(line).search;
      const login = await httpRequest(port, path, { headers: { Host: `127.0.0.1:${port}` } });
      expect(login.status).toBe(302);
      expect(login.headers['set-cookie']?.[0]).toContain(`tk_${port}=${token}`);
      const again = await httpRequest(port, path, { headers: { Host: `127.0.0.1:${port}` } });
      expect(again.headers['set-cookie']).toBeUndefined();
    }
    await stop(first);
  });

  it('不明な引数は使い方を出して 1 で終わる', async () => {
    const run = runUi(['--bogus']);
    expect(await run.exit).toBe(1);
    expect(run.stderr()).toContain('usage: thread-kanban ui');
    expect(run.stdout()).toBe('');
  });
});
