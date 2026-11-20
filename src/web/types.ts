// UI サーバーの JSON の形（.omc/handoffs/web-ui-api-contract.md。フロントは ui/api-types.ts に同じ形を写している）。
import type { BoardView } from '../domain/metrics.js';
import type { NextRecommendation } from '../domain/next.js';
import type { Column, ErrorCode, EventType } from '../domain/types.js';

/** sha256(normalizedDbPath + "\0" + boardId) の先頭 16 hex */
export type BoardKey = string;

export interface BoardSummary {
  key: BoardKey;
  boardId: string;
  label: string;
  dbPath: string;
  /** DB ファイルがあり、その中にボードの行がある */
  exists: boolean;
}

export interface BoardResponse {
  ok: true;
  key: BoardKey;
  label: string;
  /** null = DB ファイル未作成かボード行なし */
  board: BoardView | null;
  next: NextRecommendation | null;
  now: string;
  lastEventId: number;
  /** SSE の snapshot だけに付く。取りこぼしたイベントが上限を超えて送らなかった（ないときは省略） */
  truncated?: true;
}

export interface UiEvent {
  id: number;
  cardId: number | null;
  threadId: string | null;
  title: string | null;
  type: EventType;
  fromColumn: Column | null;
  toColumn: Column | null;
  at: string;
  actor: string | null;
  data: Record<string, unknown>;
}

export interface MoveOccupant {
  cardId: number;
  threadId: string;
  title: string;
}

export interface MoveOption {
  column: Column;
  allowed: boolean;
  code?: ErrorCode;
  needsCriteria: boolean;
  entryCriteria: string[];
  wip: 'ok' | 'exceeded' | 'expediteOver' | null;
  occupants?: MoveOccupant[];
}

/** UI 専用のエラーコード（MCP の ErrorCode には入れない）。 */
export type UiOnlyErrorCode =
  | 'UI_DISCARD_NOT_ALLOWED'
  | 'BOARD_NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'PAYLOAD_TOO_LARGE'
  | 'BUSY'
  | 'BOARD_UNAVAILABLE'
  | 'LIMIT_EXCEEDED'
  | 'INTERNAL';
