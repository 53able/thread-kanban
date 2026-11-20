export const BOARD_COLUMNS = ['inbox', 'ready', 'doing', 'review', 'done'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const DISCARDED = 'discarded' as const;
export const ALL_COLUMNS = [...BOARD_COLUMNS, DISCARDED] as const;
export type Column = (typeof ALL_COLUMNS)[number];

export const SERVICE_CLASSES = ['expedite', 'fixed_date', 'regular', 'intangible'] as const;
export type ServiceClass = (typeof SERVICE_CLASSES)[number];

export const WORK_TYPES = ['feature', 'defect', 'maintenance'] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;
export type Size = (typeof SIZES)[number];

/** 進行中とみなす列（stale 判定の対象）。 */
export const IN_PROGRESS_COLUMNS: readonly Column[] = ['doing', 'review'];
/** ボード上で生きている（done / discarded 以外の）列。 */
export const ACTIVE_COLUMNS: readonly Column[] = ['inbox', 'ready', 'doing', 'review'];

export const DEFAULT_WIP_LIMITS: Readonly<Record<BoardColumn, number | null>> = {
  inbox: null,
  ready: 5,
  doing: 3,
  review: 2,
  done: null,
};

export const DEFAULT_STALE_DAYS = 3;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface ColumnConfig {
  name: BoardColumn;
  position: number;
  wipLimit: number | null;
  entryCriteria: string[];
}

export interface BoardConfig {
  id: string;
  staleDays: number;
  columns: ColumnConfig[];
}

export interface Blocker {
  reason: string;
  since: number;
}

export interface T3PullRequest {
  url: string;
  state?: string;
  number?: number;
}

/** カードに保存する T3 スレッドの追跡参照（詳細を T3 側で見るためのリンク）。 */
export interface T3Tracking {
  link: string | null;
  projectId: string | null;
  parentThreadId: string | null;
  branch: string | null;
  worktreePath: string | null;
  pullRequests: T3PullRequest[];
  /** 最後に T3 から取得した時刻（ミリ秒） */
  syncedAt: number;
}

export interface Card {
  id: number;
  boardId: string;
  threadId: string;
  title: string;
  description: string | null;
  type: WorkType;
  serviceClass: ServiceClass;
  /** YYYY-MM-DD（UTC の日付として扱う） */
  dueDate: string | null;
  size: Size | null;
  externalRefs: string[];
  /** T3 スレッドの追跡参照（R9）。T3 の状態は保存しない */
  t3: T3Tracking | null;
  column: Column;
  columnEnteredAt: number;
  blocked: Blocker | null;
  createdAt: number;
  updatedAt: number;
  lastEventAt: number;
}

export const EVENT_TYPES = [
  'created',
  'moved',
  'updated',
  'blocked',
  'unblocked',
  'wip_violation',
  'configured',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface KanbanEvent {
  id: number;
  boardId: string;
  cardId: number | null;
  type: EventType;
  fromColumn: Column | null;
  toColumn: Column | null;
  at: number;
  data: Record<string, unknown>;
}

export const ERROR_CODES = [
  'WIP_LIMIT_EXCEEDED',
  'BLOCKED',
  'SKIP_NOT_ALLOWED',
  'CRITERIA_NOT_CONFIRMED',
  'EXPEDITE_LIMIT',
  'DUE_DATE_REQUIRED',
  'FORCE_REASON_REQUIRED',
  'THREAD_ID_REQUIRED',
  'CARD_NOT_FOUND',
  'SAME_COLUMN',
  'TERMINAL_COLUMN',
  'ALREADY_BLOCKED',
  'NOT_BLOCKED',
  'CARD_NOT_ACTIVE',
  'INVALID_ARGUMENT',
  'CHILD_THREAD',
  'T3_UNAVAILABLE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface KanbanError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: KanbanError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: ErrorCode, message: string, details?: Record<string, unknown>): Result<T> {
  return details === undefined ? { ok: false, error: { code, message } } : { ok: false, error: { code, message, details } };
}

/** threadId / projectId として受け付ける形式（S2）。先頭は英数字、全体 128 文字まで。 */
export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidThreadId(value: string): boolean {
  return THREAD_ID_PATTERN.test(value);
}

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();
