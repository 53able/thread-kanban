// サーバーの JSON の形（src/domain と .omc/handoffs/web-ui-api-contract.md の写し）。
// ui/ はルートの tsconfig で型検査しないので、src/ からは import せずに形だけを写す。

export const BOARD_COLUMNS = ['inbox', 'ready', 'doing', 'review', 'done'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export type Column = BoardColumn | 'discarded';

export type ServiceClass = 'expedite' | 'fixed_date' | 'regular' | 'intangible';
export type WorkType = 'feature' | 'defect' | 'maintenance';
export type Size = 'XS' | 'S' | 'M' | 'L' | 'XL';

export type EventType = 'created' | 'moved' | 'updated' | 'blocked' | 'unblocked' | 'wip_violation' | 'configured';

export type ErrorCode =
  | 'WIP_LIMIT_EXCEEDED'
  | 'BLOCKED'
  | 'SKIP_NOT_ALLOWED'
  | 'CRITERIA_NOT_CONFIRMED'
  | 'EXPEDITE_LIMIT'
  | 'DUE_DATE_REQUIRED'
  | 'FORCE_REASON_REQUIRED'
  | 'THREAD_ID_REQUIRED'
  | 'CARD_NOT_FOUND'
  | 'SAME_COLUMN'
  | 'TERMINAL_COLUMN'
  | 'ALREADY_BLOCKED'
  | 'NOT_BLOCKED'
  | 'CARD_NOT_ACTIVE'
  | 'INVALID_ARGUMENT'
  | 'CHILD_THREAD'
  | 'T3_UNAVAILABLE';

/** UI 専用のエラーコード（MCP の ErrorCode には入らない）とトランスポート由来のもの。 */
export type UiErrorCode = ErrorCode | 'UI_DISCARD_NOT_ALLOWED' | 'BUSY' | 'BOARD_UNAVAILABLE' | 'NETWORK' | 'HTTP';

export interface T3PullRequest {
  url: string;
  state?: string;
  number?: number;
}

export interface T3TrackingView {
  link: string | null;
  projectId: string | null;
  parentThreadId: string | null;
  branch: string | null;
  worktreePath: string | null;
  pullRequests: T3PullRequest[];
  syncedAt: string;
}

export interface BoardCardView {
  cardId: number;
  threadId: string;
  title: string;
  type: WorkType;
  serviceClass: ServiceClass;
  dueDate: string | null;
  size: Size | null;
  externalRefs: string[];
  t3: T3TrackingView | null;
  daysInColumn: number;
  blocked: { reason: string; since: string; days: number } | null;
  overdue: boolean;
  stale: boolean;
  daysSinceLastEvent: number;
}

export interface BoardColumnView {
  column: Column;
  wipLimit: number | null;
  count: number;
  overLimit: boolean;
  entryCriteria: string[];
  cards: BoardCardView[];
}

export interface BoardView {
  boardId: string;
  staleDays: number;
  /** 右（done）から左（inbox）の順 */
  columns: BoardColumnView[];
  wipViolations: { column: Column; wipLimit: number; count: number }[];
  blocked: { threadId: string; column: Column; reason: string; days: number }[];
  overdue: { threadId: string; column: Column; dueDate: string }[];
  stale: { threadId: string; column: Column; daysSinceLastEvent: number }[];
  discardedCount: number;
}

export interface CardSummary {
  cardId: number;
  threadId: string;
  title: string;
  serviceClass: ServiceClass;
  blocked: boolean;
}

export interface NextRecommendation {
  action: 'complete_review' | 'resolve_blocker' | 'pull' | 'no_new_work';
  card: CardSummary | null;
  to: 'doing' | null;
  reason: string;
  idleReason: 'NO_CAPACITY' | 'READY_EMPTY' | null;
}

export type BoardKey = string;

export interface BoardSummary {
  key: BoardKey;
  boardId: string;
  label: string;
  dbPath: string;
  exists: boolean;
}

export interface BoardsResponse {
  ok: true;
  boards: BoardSummary[];
  defaultKey: BoardKey | null;
}

export interface BoardResponse {
  ok: true;
  key: BoardKey;
  label: string;
  /** null = DB ファイル未作成かボード行なし（空の状態を表示する） */
  board: BoardView | null;
  next: NextRecommendation | null;
  now: string;
  lastEventId: number;
  /** SSE の snapshot のみ: 取りこぼしたイベントが多すぎて events を送らなかった（トーストは 1 件にまとめる） */
  truncated?: boolean;
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
  actor: 'ui' | null;
  data: Record<string, unknown>;
}

export interface MoveOption {
  column: Column;
  allowed: boolean;
  code?: ErrorCode;
  needsCriteria: boolean;
  entryCriteria: string[];
  wip: 'ok' | 'exceeded' | 'expediteOver' | null;
  occupants?: unknown[];
}

export interface T3Action {
  tool: string;
  args: { action: 'settle' | 'unsettle'; threadId: string };
  reason: string;
}

export interface MoveBody {
  to: Column;
  criteriaConfirmed?: true;
  force?: true;
  reason?: string;
}

export interface MoveResponse {
  ok: true;
  card: unknown;
  from: Column;
  to: Column;
  direction: 'forward' | 'backward' | 'discard';
  violation: unknown;
  expediteOverLimit: boolean;
  t3Action: T3Action | null;
  notes?: string[];
  /** UI 専用: 書き込み後の最大のイベント id（MCP の structuredContent にはない）。読めなかったときは省略 */
  lastEventId?: number;
}

export interface HealthResponse {
  ok: true;
  version: string;
  authenticated: 'none' | 'valid';
  hmac?: string;
}

export interface ApiFailure {
  ok: false;
  status: number;
  code: UiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}
