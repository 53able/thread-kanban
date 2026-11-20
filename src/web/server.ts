// thread-kanban の Web UI サーバー（node:http だけを使う）。依存はすべて createUiServer の引数で渡す。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as z from 'zod/v4';
import { toBlockResponse, toUnblockResponse } from '../app/block.js';
import { toMoveResponse } from '../app/move.js';
import { systemClock, type Clock, type ErrorCode, type KanbanError } from '../domain/types.js';
import { discoverBoards, kanbanDir, normalizeDbPath, type DefaultBoard } from './discovery.js';
import { loadRegisteredDbs, saveRegisteredDbs } from './files.js';
import { blockBodySchema, loginCodeBodySchema, moveBodySchema, registerDbBodySchema, threadIdFromPath, unblockBodySchema } from './schemas.js';
import { BoardSession, BoardUnavailableError, isBusyError } from './session.js';
import type { BoardKey, BoardSummary, UiOnlyErrorCode } from './types.js';
import { boardResponse, cardsById, moveOptions, toUiEvent } from './views.js';

export interface UiServerOptions {
  homeDir: string;
  /** 静的ファイルの場所。既定は dist/web-static/ */
  staticDir?: string;
  clock?: Clock;
  pollMs?: number;
  rebuildIntervalMs?: number;
  keepaliveMs?: number;
  /** SSE のクライアントがいなくなってから Reader / Store を閉じるまで（ミリ秒） */
  idleCloseMs?: number;
  /** 1 回の配信で送るイベントの上限 */
  maxEvents?: number;
  port: number;
  host?: string;
  version: string;
  token: string;
  /** 追加で登録する DB（--db、KANBAN_DB_PATH）。ui-dbs.json に保存する */
  extraDbs?: readonly string[];
  defaultBoard?: DefaultBoard;
  log?: (message: string) => void;
  /** 要求ヘッダーを受け取り終えるまでの上限（ミリ秒）。既定は 10000 */
  headersTimeout?: number;
  /** 要求全体を受け取り終えるまでの上限（ミリ秒）。応答（SSE）の長さにはかからない。既定は 30000 */
  requestTimeout?: number;
  /** headersTimeout / requestTimeout を確かめる間隔（ミリ秒）。既定は Node の既定値 */
  connectionsCheckingInterval?: number;
}

export interface UiServer {
  url: string;
  port: number;
  /** 同時に受け付ける接続の上限 */
  readonly maxConnections: number;
  /** ブラウザを開くための使い捨てのログインコード（60 秒・1 回だけ）。トークンを argv に載せないために使う */
  issueLoginCode(): string;
  close(): Promise<void>;
}

/** /api/health の HMAC。ラベルと実際に待ち受けているポートを含めるので、別のポートのサーバーの応答を中継しても一致しない。 */
export function healthHmac(token: string, port: number, nonce: string): string {
  return createHmac('sha256', token).update(`thread-kanban-health\0${port}\0${nonce}`).digest('hex');
}

const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../web-static/', import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;
const COOKIE_MAX_AGE = 34_560_000;
const LOGIN_CODE_TTL_MS = 60_000;
/** POST /api/dbs で登録できる DB の上限（ui-dbs.json に保存するパスだけを数える） */
const MAX_REGISTERED_DBS = 100;
/** POST /api/dbs で boardId 付きで登録できる、まだないボードの上限 */
const MAX_PENDING_BOARDS = 100;
/** 同時に受け付ける接続の上限 */
const MAX_CONNECTIONS = 128;
/** 1 つのボードに同時につなげる SSE の上限 */
const MAX_SSE_CLIENTS_PER_BOARD = 20;
/** HTML と静的ファイルに付ける CSP。T3 Code のプレビューが iframe で開くので frame-ancestors は付けない */
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

type ApiErrorCode = ErrorCode | UiOnlyErrorCode;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: ApiErrorCode, message: string, details: Record<string, unknown> = {}): void {
  sendJson(res, status, { ok: false, code, message, details });
}

/** アプリ層の失敗（MCP の structuredContent と同じ形: details がなければ {}）。 */
function sendFailure(res: ServerResponse, error: KanbanError): void {
  sendError(res, statusOf(error.code), error.code, error.message, error.details ?? {});
}

function statusOf(code: ErrorCode): number {
  switch (code) {
    case 'INVALID_ARGUMENT':
    case 'THREAD_ID_REQUIRED':
    case 'FORCE_REASON_REQUIRED':
      return 400;
    case 'CARD_NOT_FOUND':
      return 404;
    default:
      return 409;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'リクエストが大きすぎます'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseBody<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.infer<S>> {
  const text = await readBody(req);
  let json: unknown;
  try {
    json = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'body を JSON として解釈できません');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'body が不正です', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }
  return parsed.data;
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'パスを解釈できません');
  }
}

export async function createUiServer(options: UiServerOptions): Promise<UiServer> {
  const clock = options.clock ?? systemClock;
  const staticDir = resolve(options.staticDir ?? DEFAULT_STATIC_DIR);
  const host = options.host ?? '127.0.0.1';
  const log = options.log ?? ((m: string) => process.stderr.write(`[thread-kanban ui] ${m}\n`));
  const { token, version, homeDir } = options;

  // 登録済みの DB（ui-dbs.json）に --db / KANBAN_DB_PATH を足して保存する。
  // ~/.t3-kanban 直下の .db は走査で見つかるので保存しない。
  const registered: string[] = loadRegisteredDbs(homeDir, log);
  const scanDir = dirname(normalizeDbPath(join(kanbanDir(homeDir), 'probe.db')));
  const isScanned = (p: string): boolean => dirname(p) === scanDir && p.endsWith('.db');
  const addRegistered = (normalized: readonly string[]): void => {
    const added = normalized.filter((p) => !registered.includes(p) && !isScanned(p));
    if (added.length > 0) {
      registered.push(...new Set(added));
      saveRegisteredDbs(homeDir, registered, log);
    }
  };
  // CLI を起動したユーザー自身の指定なので、ディレクトリがなければ作る
  addRegistered((options.extraDbs ?? []).map((p) => normalizeDbPath(p)));
  /** POST /api/dbs で boardId 付きで登録された、まだないかもしれないボード（メモリだけ） */
  const pending: DefaultBoard[] = [];

  let boards = new Map<BoardKey, BoardSummary>();
  let defaultKey: BoardKey | null = null;
  const refreshBoards = (): BoardSummary[] => {
    const result = discoverBoards({ homeDir, registered, defaultBoard: options.defaultBoard, pending });
    boards = new Map(result.boards.map((b) => [b.key, b]));
    defaultKey = result.defaultKey;
    return result.boards;
  };

  const sessions = new Map<BoardKey, BoardSession>();
  const sessionOptions = {
    clock,
    pollMs: options.pollMs ?? 500,
    rebuildIntervalMs: options.rebuildIntervalMs ?? 60_000,
    keepaliveMs: options.keepaliveMs ?? 15_000,
    idleCloseMs: options.idleCloseMs ?? 60_000,
    maxEvents: options.maxEvents ?? 500,
    log,
    onIdle: (s: BoardSession) => {
      if (sessions.get(s.entry.key) === s) sessions.delete(s.entry.key);
      s.close();
    },
  };

  const sessionFor = (key: BoardKey): BoardSession => {
    let entry = boards.get(key);
    if (entry === undefined) {
      refreshBoards();
      entry = boards.get(key);
    }
    if (entry === undefined) throw new HttpError(404, 'BOARD_NOT_FOUND', `ボード ${key} は見つかりません`);
    let session = sessions.get(key);
    if (session === undefined || session.isClosed()) {
      session = new BoardSession(entry, sessionOptions);
      sessions.set(key, session);
    } else {
      session.touch();
    }
    return session;
  };

  let port = 0;
  const allowedHosts = (): string[] => [`127.0.0.1:${port}`, `localhost:${port}`];
  const allowedOrigins = (): string[] => allowedHosts().map((h) => `http://${h}`);
  const cookieName = (): string => `tk_${port}`;

  // ------------------------------------------------------------ ログインコード

  const loginCodes = new Map<string, number>();
  const issueLoginCode = (): string => {
    const now = clock();
    for (const [c, expires] of loginCodes) if (expires <= now) loginCodes.delete(c);
    const code = randomBytes(24).toString('base64url');
    loginCodes.set(code, now + LOGIN_CODE_TTL_MS);
    return code;
  };
  /** 有効なら消費して true（1 回だけ使える）。 */
  const consumeLoginCode = (given: string): boolean => {
    for (const [c, expires] of loginCodes) {
      if (!safeEqual(c, given)) continue;
      loginCodes.delete(c);
      return expires > clock();
    }
    return false;
  };

  // ------------------------------------------------------------ 静的ファイル

  const serveStatic = (res: ServerResponse, pathname: string, head: boolean): void => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      sendError(res, 404, 'NOT_FOUND', '見つかりません');
      return;
    }
    const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    if (rel.includes('\0') || rel.split(/[\\/]/).includes('..')) {
      sendError(res, 404, 'NOT_FOUND', '見つかりません');
      return;
    }
    const file = resolve(join(staticDir, rel));
    if (!file.startsWith(staticDir + sep)) {
      sendError(res, 404, 'NOT_FOUND', '見つかりません');
      return;
    }
    let body: Buffer;
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      body = readFileSync(file);
    } catch {
      sendError(res, 404, 'NOT_FOUND', '見つかりません');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    });
    res.end(head ? undefined : body);
  };

  // ------------------------------------------------------------ API

  const health = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const cookie = parseCookies(req.headers.cookie).get(cookieName());
    if (cookie !== undefined && !safeEqual(cookie, token)) {
      sendError(res, 403, 'FORBIDDEN', 'トークンが一致しません');
      return;
    }
    const nonce = url.searchParams.get('nonce');
    sendJson(res, 200, {
      ok: true,
      version,
      authenticated: cookie === undefined ? 'none' : 'valid',
      ...(nonce !== null && nonce !== '' ? { hmac: healthHmac(token, port, nonce) } : {}),
    });
  };

  const requireCard = (session: BoardSession, rawThreadId: string) => {
    const id = threadIdFromPath(rawThreadId);
    if (!id.ok) return { error: id.error } as const;
    const { snapshot, lastEventId } = session.readSnapshot();
    const card = snapshot?.cards.find((c) => c.threadId === id.value);
    if (snapshot === null || card === undefined) {
      return {
        error: {
          code: 'CARD_NOT_FOUND' as const,
          message: `threadId ${id.value} のカードはありません。先に kanban_card_add で登録してください`,
          details: { threadId: id.value },
        },
      } as const;
    }
    return { threadId: id.value, card, snapshot, lastEventId } as const;
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL, segments: string[]): Promise<void> => {
    const method = req.method ?? 'GET';
    // segments[0] === 'api'
    if (segments[1] === 'boards' && segments.length === 2 && method === 'GET') {
      const list = refreshBoards();
      sendJson(res, 200, { ok: true, boards: list, defaultKey });
      return;
    }
    if (segments[1] === 'login-code' && segments.length === 2 && method === 'POST') {
      await parseBody(req, loginCodeBodySchema);
      sendJson(res, 200, { ok: true, code: issueLoginCode() });
      return;
    }
    if (segments[1] === 'dbs' && segments.length === 2 && method === 'POST') {
      const body = await parseBody(req, registerDbBodySchema);
      if (!isAbsolute(body.path) || !body.path.endsWith('.db')) {
        throw new HttpError(400, 'INVALID_ARGUMENT', 'path は「.db」で終わる絶対パスで指定してください');
      }
      // HTTP 経由ではディレクトリを作らない（親ディレクトリがなければ 400）
      let dbPath: string;
      try {
        dbPath = normalizeDbPath(body.path, false);
      } catch {
        throw new HttpError(400, 'INVALID_ARGUMENT', 'path の親ディレクトリがありません', { path: body.path });
      }
      if (!registered.includes(dbPath) && !isScanned(dbPath) && registered.length >= MAX_REGISTERED_DBS) {
        throw new HttpError(409, 'LIMIT_EXCEEDED', `登録できる DB は ${MAX_REGISTERED_DBS} 件までです`);
      }
      const addPending = body.boardId !== undefined && !pending.some((p) => p.dbPath === dbPath && p.boardId === body.boardId);
      if (addPending && pending.length >= MAX_PENDING_BOARDS) {
        throw new HttpError(409, 'LIMIT_EXCEEDED', `boardId 付きで登録できるボードは ${MAX_PENDING_BOARDS} 件までです`);
      }
      addRegistered([dbPath]);
      if (addPending && body.boardId !== undefined) {
        pending.push({ dbPath, boardId: body.boardId, basePath: body.basePath ?? null });
      }
      const list = refreshBoards().filter((b) => b.dbPath === dbPath);
      sendJson(res, 200, { ok: true, boards: list });
      return;
    }
    if (segments[1] !== 'boards' || segments[2] === undefined) throw new HttpError(404, 'NOT_FOUND', '見つかりません');
    const session = sessionFor(decodeSegment(segments[2]));

    if (segments.length === 3 && method === 'GET') {
      const { snapshot, lastEventId } = session.readSnapshot();
      sendJson(res, 200, boardResponse(session.entry.key, session.entry.label, snapshot, lastEventId, clock()));
      return;
    }
    if (segments.length === 4 && segments[3] === 'stream' && method === 'GET') {
      if (session.clientCount() >= MAX_SSE_CLIENTS_PER_BOARD) {
        throw new HttpError(503, 'BUSY', `1 つのボードに同時につなげるのは ${MAX_SSE_CLIENTS_PER_BOARD} 件までです`);
      }
      const raw = url.searchParams.get('lastEventId');
      const lastEventId = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
      // DB があるのに開けない・読めない（壊れたファイルなど）なら、接続を始める前に 503 BOARD_UNAVAILABLE。
      // SQLITE_BUSY なら接続を始める（配信は BUSY の間ポーリングで読み直す）
      try {
        session.readSnapshot();
      } catch (e) {
        if (!isBusyError(e)) throw e;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      session.addClient(res, lastEventId);
      return;
    }
    if (segments.length === 6 && segments[3] === 'cards' && segments[4] !== undefined) {
      const rawThreadId = decodeSegment(segments[4]);
      const action = segments[5];
      if (method === 'GET' && action === 'events') {
        const found = requireCard(session, rawThreadId);
        if ('error' in found) return sendFailure(res, found.error);
        const events = session.listCardEvents(found.threadId);
        const byId = cardsById(found.snapshot);
        sendJson(res, 200, { ok: true, events: events.map((e) => toUiEvent(e, byId)) });
        return;
      }
      if (method === 'GET' && action === 'move-options') {
        const found = requireCard(session, rawThreadId);
        if ('error' in found) return sendFailure(res, found.error);
        sendJson(res, 200, { ok: true, options: moveOptions(found.card, found.snapshot) });
        return;
      }
      if (method === 'POST' && action === 'move') {
        const input = await parseBody(req, moveBodySchema);
        if (input.to === 'discarded') {
          throw new HttpError(400, 'UI_DISCARD_NOT_ALLOWED', 'UI からは discarded へ移動できません。エージェントか MCP を経由してください');
        }
        const result = session.move(rawThreadId, input);
        if (!result.ok) return sendFailure(res, result.error);
        sendJson(res, 200, { ok: true, ...toMoveResponse(result.value), notes: result.value.notes, lastEventId: result.value.lastEventId });
        return;
      }
      if (method === 'POST' && action === 'block') {
        const input = await parseBody(req, blockBodySchema);
        const result = session.block(rawThreadId, input);
        if (!result.ok) return sendFailure(res, result.error);
        sendJson(res, 200, { ok: true, ...toBlockResponse(result.value), lastEventId: result.value.lastEventId });
        return;
      }
      if (method === 'POST' && action === 'unblock') {
        const input = await parseBody(req, unblockBodySchema);
        const result = session.unblock(rawThreadId, input);
        if (!result.ok) return sendFailure(res, result.error);
        sendJson(res, 200, { ok: true, ...toUnblockResponse(result.value), lastEventId: result.value.lastEventId });
        return;
      }
    }
    throw new HttpError(404, 'NOT_FOUND', '見つかりません');
  };

  /** /api/*（health を除く）の認証。順序: Host（呼び出し前に確認済み）→ cookie → Origin → Content-Type。 */
  const authorize = (req: IncomingMessage): void => {
    const cookie = parseCookies(req.headers.cookie).get(cookieName());
    if (cookie === undefined || !safeEqual(cookie, token)) throw new HttpError(403, 'FORBIDDEN', '認証が必要です');
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin === undefined || !allowedOrigins().includes(origin)) throw new HttpError(403, 'FORBIDDEN', 'Origin が一致しません');
      const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/json') {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type: application/json で送ってください');
      }
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const hostHeader = req.headers.host ?? '';
    if (!allowedHosts().includes(hostHeader.toLowerCase())) {
      sendError(res, 403, 'FORBIDDEN', 'Host が一致しません');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${hostHeader}`);
    const method = req.method ?? 'GET';
    const segments = url.pathname.split('/').filter((s) => s !== '');

    if (segments[0] === 'api') {
      if (segments[1] === 'health' && segments.length === 2) {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET で呼んでください');
        health(req, res, url);
        return;
      }
      authorize(req);
      await handleApi(req, res, url, segments);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET で呼んでください');
    if (url.pathname === '/' && (url.searchParams.has('token') || url.searchParams.has('code'))) {
      // 一致したときだけ cookie を設定する。どちらの場合もトークン・コードを外した URL へ移る（hash はブラウザが保持する）
      const headers: Record<string, string> = { Location: '/', 'Cache-Control': 'no-store' };
      const valid = url.searchParams.has('token')
        ? safeEqual(url.searchParams.get('token') ?? '', token)
        : consumeLoginCode(url.searchParams.get('code') ?? '');
      if (valid) {
        headers['Set-Cookie'] = `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
      }
      res.writeHead(302, headers);
      res.end();
      return;
    }
    serveStatic(res, url.pathname, method === 'HEAD');
  };

  // SSE は要求を受け取り終えた後も応答を続けるが、requestTimeout は要求の受信だけにかかるので切られない
  const server = createServer(
    {
      headersTimeout: options.headersTimeout ?? 10_000,
      requestTimeout: options.requestTimeout ?? 30_000,
      ...(options.connectionsCheckingInterval !== undefined ? { connectionsCheckingInterval: options.connectionsCheckingInterval } : {}),
    },
    (req, res) => {
      handle(req, res).catch((e: unknown) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (e instanceof HttpError) {
          sendError(res, e.status, e.code, e.message, e.details);
          return;
        }
        if (e instanceof BoardUnavailableError) {
          sendError(res, 503, 'BOARD_UNAVAILABLE', 'ボードを読み込めません（DB ファイルを開けない・読めない）');
          return;
        }
        if (isBusyError(e)) {
          sendError(res, 503, 'BUSY', 'DB がロックされています。少し待ってから再試行してください');
          return;
        }
        log(`内部エラー: ${(e as Error).stack ?? String(e)}`);
        sendError(res, 500, 'INTERNAL', '内部エラーが発生しました');
      });
    },
  );

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  port = (server.address() as AddressInfo).port;
  refreshBoards();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get maxConnections() {
      return server.maxConnections;
    },
    issueLoginCode,
    close: async () => {
      for (const s of sessions.values()) s.close();
      sessions.clear();
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    },
  };
}
