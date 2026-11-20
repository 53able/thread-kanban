// /api/* の fetch ラッパー。cookie（tk_<port>）は同一オリジンなので自動で付く。
// POST は Content-Type: application/json を付ける（ブラウザは同一オリジンの POST に Origin を付ける）。

import type {
  ApiFailure,
  BoardKey,
  BoardResponse,
  BoardsResponse,
  HealthResponse,
  MoveBody,
  MoveOption,
  MoveResponse,
  UiErrorCode,
  UiEvent,
} from './api-types.js';

export type ApiResult<T> = ({ ok: true } & T) | ApiFailure;

/** SQLITE_BUSY（503 BUSY）を再試行する回数と間隔。 */
const BUSY_RETRIES = 3;
const BUSY_RETRY_MS = 300;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<T>> {
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res =
        method === 'GET'
          ? await fetch(path, { method, credentials: 'same-origin', headers: { Accept: 'application/json' } })
          : await fetch(path, {
              method,
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify(body ?? {}),
            });
    } catch {
      return { ok: false, status: 0, code: 'NETWORK', message: 'サーバーに接続できません' };
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const obj = (json ?? {}) as Record<string, unknown>;
    if (res.ok && obj.ok === true) return obj as { ok: true } & T;
    // 再試行するのはロック待ち（BUSY）だけ。BOARD_UNAVAILABLE などはすぐに失敗として返す
    if (res.status === 503 && obj.code === 'BUSY' && attempt < BUSY_RETRIES) {
      await wait(BUSY_RETRY_MS * (attempt + 1));
      continue;
    }
    const failure: ApiFailure = {
      ok: false,
      status: res.status,
      code: typeof obj.code === 'string' ? (obj.code as UiErrorCode) : 'HTTP',
      message: typeof obj.message === 'string' ? obj.message : `HTTP ${res.status}`,
    };
    if (obj.details !== null && typeof obj.details === 'object') failure.details = obj.details as Record<string, unknown>;
    return failure;
  }
}

const enc = encodeURIComponent;
const cardPath = (key: BoardKey, threadId: string): string => `/api/boards/${enc(key)}/cards/${enc(threadId)}`;

export function getBoards(): Promise<ApiResult<Omit<BoardsResponse, 'ok'>>> {
  return request('GET', '/api/boards');
}

export function getBoard(key: BoardKey): Promise<ApiResult<Omit<BoardResponse, 'ok'>>> {
  return request('GET', `/api/boards/${enc(key)}`);
}

export function getCardEvents(key: BoardKey, threadId: string): Promise<ApiResult<{ events: UiEvent[] }>> {
  return request('GET', `${cardPath(key, threadId)}/events`);
}

export function getMoveOptions(key: BoardKey, threadId: string): Promise<ApiResult<{ options: MoveOption[] }>> {
  return request('GET', `${cardPath(key, threadId)}/move-options`);
}

export function postMove(key: BoardKey, threadId: string, body: MoveBody): Promise<ApiResult<Omit<MoveResponse, 'ok'>>> {
  return request('POST', `${cardPath(key, threadId)}/move`, body);
}

export function postBlock(key: BoardKey, threadId: string, reason: string): Promise<ApiResult<{ card: unknown }>> {
  return request('POST', `${cardPath(key, threadId)}/block`, { reason });
}

export function postUnblock(key: BoardKey, threadId: string, resolution?: string): Promise<ApiResult<{ card: unknown }>> {
  return request('POST', `${cardPath(key, threadId)}/unblock`, resolution === undefined ? {} : { resolution });
}

export type HealthResult = { kind: 'network' } | { kind: 'http'; status: number; body: Partial<HealthResponse> | null };

/** 切断時の判定用。cookie 付きで /api/health を呼ぶ（nonce は付けない）。 */
export async function getHealth(): Promise<HealthResult> {
  let res: Response;
  try {
    res = await fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    return { kind: 'network' };
  }
  let body: Partial<HealthResponse> | null = null;
  try {
    body = (await res.json()) as Partial<HealthResponse>;
  } catch {
    body = null;
  }
  return { kind: 'http', status: res.status, body };
}
