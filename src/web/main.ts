// `thread-kanban ui [--port N] [--db PATH]... [--open] [--rotate-token]` の入口。
// stdout には URL を 1 行だけ出す。ログはすべて stderr。
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { SERVER_VERSION } from '../server.js';
import { resolveLocation } from '../store/location.js';
import { boardKey, kanbanDir, normalizeDbPath } from './discovery.js';
import { ensureKanbanDir, loadOrCreateToken } from './files.js';
import { createUiServer, healthHmac } from './server.js';

const DEFAULT_PORT = 4777;
const PROBE_TIMEOUT_MS = 3000;

const log = (message: string): void => {
  process.stderr.write(`[thread-kanban ui] ${message}\n`);
};

function usage(): string {
  return 'usage: thread-kanban ui [--port N (default 4777)] [--db PATH]... [--open] [--rotate-token]';
}

interface Args {
  port: number;
  dbs: string[];
  open: boolean;
  rotateToken: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { port: DEFAULT_PORT, dbs: [], open: false, rotateToken: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} には値が必要です`);
      i += 1;
      return v;
    };
    if (a === '--port') {
      const v = value();
      const n = Number(v);
      if (!/^\d+$/.test(v) || n < 1 || n > 65535) throw new Error(`--port の値が不正です: ${v}`);
      args.port = n;
    } else if (a.startsWith('--port=')) {
      const v = a.slice('--port='.length);
      const n = Number(v);
      if (!/^\d+$/.test(v) || n < 1 || n > 65535) throw new Error(`--port の値が不正です: ${v}`);
      args.port = n;
    } else if (a === '--db') {
      args.dbs.push(value());
    } else if (a.startsWith('--db=')) {
      args.dbs.push(a.slice('--db='.length));
    } else if (a === '--open') {
      args.open = true;
    } else if (a === '--rotate-token') {
      args.rotateToken = true;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`不明な引数です: ${a}`);
    }
  }
  return args;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown> | null;
}

/** 127.0.0.1:<port> への HTTP 要求。接続できなければ null。 */
function httpCall(port: number, method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: string): Promise<HttpResult | null> {
  return new Promise((resolveCall) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers }, timeout: PROBE_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let parsed: Record<string, unknown> | null = null;
          try {
            const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            if (typeof v === 'object' && v !== null) parsed = v as Record<string, unknown>;
          } catch {
            parsed = null;
          }
          resolveCall({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on('error', () => resolveCall(null));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolveCall(null));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

type Challenge = { kind: 'verified' } | { kind: 'none' } | { kind: 'mismatch'; reason: string };

/**
 * cookie を付けずに nonce だけを送り、HMAC とバージョンで本物の UI サーバーか確かめる（トークンは送らない）。
 * HMAC には接続したポートを含めて検証するので、別のポートの本物のサーバーの応答を中継されても通らない。
 */
async function challenge(port: number, token: string): Promise<Challenge> {
  const nonce = randomBytes(16).toString('hex');
  const r = await httpCall(port, 'GET', `/api/health?nonce=${nonce}`, {});
  if (r === null) return { kind: 'none' };
  const hmac = r.body?.hmac;
  const remoteVersion = r.body?.version;
  if (r.status !== 200 || typeof hmac !== 'string') {
    return { kind: 'mismatch', reason: `ポート ${port} は thread-kanban の UI サーバー以外のプロセスが使っています` };
  }
  const expected = healthHmac(token, port, nonce);
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { kind: 'mismatch', reason: `ポート ${port} のサーバーのトークンが一致しません（別のユーザーか別の HOME のサーバーの可能性があります）` };
  }
  if (remoteVersion !== SERVER_VERSION) {
    return {
      kind: 'mismatch',
      reason: `ポート ${port} のサーバーのバージョン（${String(remoteVersion)}）がこの CLI（${SERVER_VERSION}）と違います。先に停止してください`,
    };
  }
  return { kind: 'verified' };
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => log(`ブラウザを開けません: ${e.message}`));
    child.unref();
  } catch (e) {
    log(`ブラウザを開けません: ${(e as Error).message}`);
  }
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(3));
  } catch (e) {
    log((e as Error).message);
    log(usage());
    return 1;
  }

  const homeDir = homedir();
  const cwd = process.cwd();
  // トークンを置くディレクトリは 0700（先に作っておく。normalizeDbPath も同じディレクトリを作るため）
  ensureKanbanDir(homeDir, log);
  const location = resolveLocation({ env: process.env, cwd, homeDir });
  const defaultBoard = { dbPath: location.dbPath, boardId: location.boardId, basePath: location.basePath };
  const defaultKey = boardKey(normalizeDbPath(location.dbPath), location.boardId);

  // --db と、~/.t3-kanban の外を指す KANBAN_DB_PATH（暗黙の登録）
  const dbs = args.dbs.map((p) => resolve(cwd, p));
  const scanDir = dirname(normalizeDbPath(resolve(kanbanDir(homeDir), 'probe.db')));
  const normalizedDefault = normalizeDbPath(location.dbPath);
  if (dirname(normalizedDefault) !== scanDir || !normalizedDefault.endsWith('.db')) dbs.push(normalizedDefault);

  if (args.rotateToken) {
    const running = await httpCall(args.port, 'GET', '/api/health', {});
    if (running !== null && typeof running.body?.version === 'string') {
      log(`ポート ${args.port} で UI サーバーが動いています。先に停止してから --rotate-token を実行してください`);
      return 1;
    }
  }
  const token = loadOrCreateToken(homeDir, { rotate: args.rotateToken, warn: log });
  if (args.rotateToken) log('トークンを作り直しました。開いているタブは新しい URL で開き直してください');

  // stdout の URL だけにトークンを含める。--open では使い捨てのログインコードを使い、トークンを argv に載せない
  const urlFor = (port: number): string =>
    `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}#board=${encodeURIComponent(defaultKey)}`;
  const openUrlFor = (port: number, code: string): string =>
    `http://127.0.0.1:${port}/?code=${encodeURIComponent(code)}#board=${encodeURIComponent(defaultKey)}`;

  try {
    const server = await createUiServer({
      homeDir,
      port: args.port,
      version: SERVER_VERSION,
      token,
      extraDbs: dbs,
      defaultBoard,
      log,
    });
    const url = urlFor(server.port);
    process.stdout.write(`${url}\n`);
    log(`listening on ${server.url}（board=${location.boardId} db=${location.dbPath}）`);
    if (args.open) openBrowser(openUrlFor(server.port, server.issueLoginCode()));
    const shutdown = (code: number): void => {
      void server.close().finally(() => process.exit(code));
    };
    process.on('SIGINT', () => shutdown(130));
    process.on('SIGTERM', () => shutdown(143));
    return -1;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
  }

  // ポートが使われている: 本物の UI サーバーなら、その URL を出して終わる
  const result = await challenge(args.port, token);
  if (result.kind !== 'verified') {
    log(result.kind === 'mismatch' ? result.reason : `ポート ${args.port} は使用中ですが応答がありません`);
    log(`--port <p> で別のポートを指定してください（${usage()}）`);
    return 1;
  }
  const headers = {
    Cookie: `tk_${args.port}=${token}`,
    Origin: `http://127.0.0.1:${args.port}`,
    'Content-Type': 'application/json',
  };
  // 既定のボードは boardId 付きで送り、DB がまだなくても #board=<key> が一覧に見つかるようにする。
  // HTTP 経由ではディレクトリを作らないので、--db の親ディレクトリはここで（ユーザー自身の指定として）作っておく
  const bodies = [
    ...dbs.map((p) => normalizeDbPath(p)).filter((p) => p !== normalizedDefault).map((path) => ({ path })),
    { path: normalizedDefault, boardId: location.boardId, ...(location.basePath === null ? {} : { basePath: location.basePath }) },
  ];
  for (const body of bodies) {
    const r = await httpCall(args.port, 'POST', '/api/dbs', headers, JSON.stringify(body));
    if (r === null || r.status !== 200) log(`DB を登録できません: ${body.path}（HTTP ${r?.status ?? '接続失敗'}）`);
  }
  const url = urlFor(args.port);
  process.stdout.write(`${url}\n`);
  log(`ポート ${args.port} で動いている UI サーバーを使います`);
  if (args.open) {
    const r = await httpCall(args.port, 'POST', '/api/login-code', headers, '{}');
    const code = r?.body?.code;
    if (r?.status === 200 && typeof code === 'string') openBrowser(openUrlFor(args.port, code));
    else log(`ログインコードを取得できないためブラウザを開きません（HTTP ${r?.status ?? '接続失敗'}）。stdout の URL を開いてください`);
  }
  return 0;
}

const code = await main();
if (code >= 0) process.exit(code);
