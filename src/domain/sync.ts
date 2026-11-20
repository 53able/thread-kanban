import { columnIndex } from './rules.js';
import {
  ACTIVE_COLUMNS,
  BOARD_COLUMNS,
  type BoardConfig,
  type Card,
  type Column,
  type T3PullRequest,
  type T3Tracking,
} from './types.js';

/**
 * T3 のスレッドを正規化したもの。`undefined` は「取得元にその項目がなかった（不明）」を表す。
 * `thread list` には archived / pendingRequestCount / branch / worktreePath がないため、list 由来のスレッドではこれらが undefined になる。
 */
export interface T3Thread {
  threadId: string;
  projectId?: string | null;
  title?: string | null;
  link?: string | null;
  status?: string | null;
  settled?: boolean | null;
  archived?: boolean | null;
  snoozed?: boolean | null;
  pendingRequestCount?: number | null;
  blockedOnThreadWait?: boolean | null;
  parentThreadId?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  pullRequests?: T3PullRequest[];
}

/** カードのスレッドを T3 で確認した結果。 */
export type ThreadObservation =
  | { kind: 'found'; thread: T3Thread }
  | { kind: 'missing' }
  | { kind: 'unknown'; reason: string };

export const DEVIATION_KINDS = [
  'unregistered',
  't3_finished_card_open',
  't3_waiting_not_blocked',
  't3_waiting_on_thread',
  't3_failed_not_blocked',
  'started_without_pull',
  't3_active_card_done',
  't3_thread_missing',
  't3_open_card_done',
] as const;
export type DeviationKind = (typeof DEVIATION_KINDS)[number];

export interface SuggestedCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * 提案。`tool` / `args` は最初に呼ぶツール（呼ぶべきツールがなければ null）。
 * `followUp` は続けて呼ぶツール、`alternatives` は状況次第で代わりに呼ぶツール。実行はしない（D1）。
 */
export interface Suggestion {
  tool: string | null;
  args: Record<string, unknown> | null;
  followUp: SuggestedCall[];
  alternatives: SuggestedCall[];
  text: string;
}

export interface Deviation {
  kind: DeviationKind;
  threadId: string;
  cardId: number | null;
  column: Column | null;
  t3Status: string | null;
  message: string;
  suggestion: Suggestion;
}

export interface UnknownThread {
  threadId: string;
  reason: string;
}

/**
 * 個別取得（thread show）と t3_thread_missing の対象にする列。
 * done / discarded のカードは一覧に出たときだけ判定する。
 */
export const LOOKUP_COLUMNS: readonly Column[] = ACTIVE_COLUMNS;

/** R2: T3 の状態分類。 */
export const T3_FAILED_STATUSES: readonly string[] = ['failed', 'cancelled', 'rolled_back'];
export const T3_ACTIVE_STATUSES: readonly string[] = ['preparing', 'queued', 'starting', 'running'];

export interface T3StateClass {
  finished: boolean;
  waitingHuman: boolean;
  waitingThread: boolean;
  failed: boolean;
  active: boolean;
}

export function classifyThread(t: T3Thread): T3StateClass {
  const status = t.status ?? null;
  return {
    finished: t.settled === true || t.archived === true,
    waitingHuman: status === 'waiting' || (t.pendingRequestCount ?? 0) > 0,
    waitingThread: t.blockedOnThreadWait === true,
    failed: status !== null && T3_FAILED_STATUSES.includes(status),
    active: status !== null && T3_ACTIVE_STATUSES.includes(status),
  };
}

/** R10: ボードにない作業として報告する対象か（トップレベルで settle / archive / snooze されていない）。 */
export function isUnregisteredCandidate(t: T3Thread): boolean {
  return (
    (t.parentThreadId ?? null) === null && t.settled !== true && t.archived !== true && t.snoozed !== true
  );
}

/** 追跡参照の更新（R9）。取得元にない項目は以前の値を残す。T3 の状態は含めない。 */
export function mergeTracking(prev: T3Tracking | null, t: T3Thread, now: number): T3Tracking {
  const pick = <K extends 'link' | 'projectId' | 'parentThreadId' | 'branch' | 'worktreePath'>(key: K): string | null => {
    const v = t[key];
    return v !== undefined ? v : (prev?.[key] ?? null);
  };
  return {
    link: pick('link'),
    projectId: pick('projectId'),
    parentThreadId: pick('parentThreadId'),
    branch: pick('branch'),
    worktreePath: pick('worktreePath'),
    pullRequests: t.pullRequests !== undefined ? t.pullRequests : (prev?.pullRequests ?? []),
    syncedAt: now,
  };
}

/** syncedAt を除いて追跡参照が変わったか。 */
export function trackingChanged(prev: T3Tracking | null, next: T3Tracking): boolean {
  if (prev === null) return true;
  const strip = ({ syncedAt: _s, ...rest }: T3Tracking) => rest;
  return JSON.stringify(strip(prev)) !== JSON.stringify(strip(next));
}

export interface SyncInput {
  board: BoardConfig;
  cards: readonly Card[];
  /** プロジェクトのスレッド一覧（`thread list` または引数）。unregistered の判定に使う */
  projectThreads: readonly T3Thread[];
  /** カードの threadId ごとの確認結果 */
  observations: ReadonlyMap<string, ThreadObservation>;
  /** 呼び出し元スレッド（T3CODE_THREAD_ID）。状態による判定から外す（R3） */
  callerThreadId: string | null;
}

export interface SyncAnalysis {
  deviations: Deviation[];
  unknown: UnknownThread[];
}

const move = (threadId: string, to: Column): SuggestedCall => ({ tool: 'kanban_card_move', args: { threadId, to } });

/** T3 Code のエージェントが持つ MCP ツール。T3 CLI には settle がないため、サーバーは呼ばずに提案する */
export const T3_ORGANIZE_TOOL = 't3_thread_organize';
export type T3OrganizeAction = 'settle' | 'unsettle';
const t3Organize = (action: T3OrganizeAction, threadId: string): SuggestedCall => ({
  tool: T3_ORGANIZE_TOOL,
  args: { action, threadId },
});

export interface T3Action {
  tool: typeof T3_ORGANIZE_TOOL;
  args: { action: T3OrganizeAction; threadId: string };
  reason: string;
}

/**
 * カードの移動を T3 側（Not Done / Done の 2 状態）に反映する提案。
 * - inbox〜review → done / discarded: settle
 * - done → inbox〜review: unsettle
 * - それ以外（done → discarded、Not Done 内の移動）: null
 * isT3Thread はカードが T3 のスレッドと分かっているか（追跡参照があるか、T3 を使えるか）。
 */
export function t3ActionForMove(from: Column, to: Column, threadId: string, isT3Thread: boolean): T3Action | null {
  if (!isT3Thread) return null;
  const isDone = (c: Column): boolean => c === 'done' || c === 'discarded';
  let action: T3OrganizeAction | null = null;
  if (!isDone(from) && isDone(to)) action = 'settle';
  else if (from === 'done' && !isDone(to)) action = 'unsettle';
  if (action === null) return null;
  return {
    tool: T3_ORGANIZE_TOOL,
    args: { action, threadId },
    reason: `カードが ${from} から ${to} へ移ったため。T3 は Not Done / Done だけを持つ`,
  };
}

function suggestion(first: SuggestedCall | null, text: string, followUp: SuggestedCall[] = [], alternatives: SuggestedCall[] = []): Suggestion {
  return { tool: first?.tool ?? null, args: first?.args ?? null, followUp, alternatives, text };
}

/** card の列から done までの前進手順（1 列ずつ）。 */
function stepsToDone(card: Card): SuggestedCall[] {
  const from = columnIndex(card.column);
  return BOARD_COLUMNS.slice(from + 1).map((to) => move(card.threadId, to));
}

function doingHasRoom(board: BoardConfig, cards: readonly Card[], card: Card): boolean {
  if (card.serviceClass === 'expedite') return true;
  const limit = board.columns.find((c) => c.name === 'doing')?.wipLimit ?? null;
  if (limit === null) return true;
  return cards.filter((c) => c.id !== card.id && c.column === 'doing').length < limit;
}

function cardDeviation(
  card: Card,
  t: T3Thread,
  input: SyncInput,
): Omit<Deviation, 'threadId' | 'cardId' | 'column' | 't3Status'> | null {
  const s = classifyThread(t);
  // 待ち・異常終了のずれは doing / review にある未ブロックのカードだけ
  const unblockedInProgress = (card.column === 'doing' || card.column === 'review') && card.blocked === null;
  const status = t.status ?? 'unknown';

  // 完了したスレッドは他の判定をしない
  if (s.finished) {
    if (!LOOKUP_COLUMNS.includes(card.column)) return null;
    const [first, ...rest] = stepsToDone(card);
    return {
      kind: 't3_finished_card_open',
      message: `T3 のスレッドは${t.archived === true ? ' archive' : ' settle'} 済みですが、カードは ${card.column} にあります`,
      suggestion: suggestion(
        first ?? null,
        '退場条件を満たしていれば done へ 1 列ずつ進める。作業をやめたのなら discarded へ移す',
        rest,
        [move(card.threadId, 'discarded')],
      ),
    };
  }

  // done / discarded のカードは Done 側。T3 が Not Done のままなら settle を提案する
  if (card.column === 'done' || card.column === 'discarded') {
    if (s.active) {
      if (card.column !== 'done') return null;
      return {
        kind: 't3_active_card_done',
        message: `T3 のスレッドは進行中（status: ${status}）ですが、カードは done にあります`,
        suggestion: suggestion(move(card.threadId, 'review'), '作業が再開されたなら差し戻す'),
      };
    }
    return {
      kind: 't3_open_card_done',
      message: `カードは ${card.column} にありますが、T3 のスレッドは settle も archive もされていません（status: ${status}）`,
      suggestion: suggestion(t3Organize('settle', card.threadId), 'T3 のスレッドを settle する'),
    };
  }

  if (s.waitingHuman && unblockedInProgress) {
    const pending = t.pendingRequestCount ?? 0;
    return {
      kind: 't3_waiting_not_blocked',
      message: `T3 のスレッドは人の対応待ち（status: ${status}${pending > 0 ? `、未処理のリクエスト ${pending} 件` : ''}）ですが、カードはブロックされていません`,
      suggestion: suggestion(
        { tool: 'kanban_card_block', args: { threadId: card.threadId, reason: 'T3 スレッドが人の対応待ち' } },
        '待ちの理由を付けて kanban_card_block する。解消したら kanban_card_unblock',
      ),
    };
  }

  if (s.waitingThread && unblockedInProgress) {
    return {
      kind: 't3_waiting_on_thread',
      message: 'T3 のスレッドは他のスレッドの完了待ちですが、カードはブロックされていません',
      suggestion: suggestion(
        { tool: 'kanban_card_block', args: { threadId: card.threadId, reason: '他の T3 スレッドの完了待ち' } },
        '待っているスレッドを理由に書いて kanban_card_block する',
      ),
    };
  }

  if (s.failed && unblockedInProgress) {
    return {
      kind: 't3_failed_not_blocked',
      message: `T3 のスレッドが異常終了しています（status: ${status}）が、カードはブロックされていません`,
      suggestion: suggestion(
        { tool: 'kanban_card_block', args: { threadId: card.threadId, reason: `T3 スレッドが異常終了（${status}）` } },
        '原因を付けて kanban_card_block する',
      ),
    };
  }

  if (s.active && (card.column === 'inbox' || card.column === 'ready')) {
    if (!doingHasRoom(input.board, input.cards, card)) {
      return {
        kind: 'started_without_pull',
        message: `T3 のスレッドは進行中（status: ${status}）ですが、カードは ${card.column} にあり、doing は WIP 上限に達しています`,
        suggestion: suggestion(null, '新規着手を止め、進行中の作業を先に終える'),
      };
    }
    const steps = card.column === 'inbox' ? [move(card.threadId, 'ready'), move(card.threadId, 'doing')] : [move(card.threadId, 'doing')];
    const [first, ...rest] = steps;
    return {
      kind: 'started_without_pull',
      message: `T3 のスレッドは進行中（status: ${status}）ですが、カードは ${card.column} にあります`,
      suggestion: suggestion(
        first ?? null,
        card.column === 'inbox' ? 'ready を経由して doing へ pull する' : 'doing へ pull する',
        rest,
      ),
    };
  }

  return null;
}

/** 並び順の順位。done が 0 で左の列ほど大きく、unregistered（列なし）が最後（右の列から順に見る）。 */
function rank(d: Deviation): number {
  if (d.kind === 'unregistered' || d.column === null) return BOARD_COLUMNS.length + 1;
  // discarded は終端列。inbox の後、unregistered の前に並べる
  if (d.column === 'discarded') return BOARD_COLUMNS.length;
  return BOARD_COLUMNS.length - 1 - BOARD_COLUMNS.indexOf(d.column);
}

/**
 * ボードと T3 のずれ（smell）を判定する純粋関数（D1、D6、R2、R3、R10）。カードは変更しない。
 * - inbox〜review のカードは全てのずれ、done / discarded のカードは t3_active_card_done（done のみ）と t3_open_card_done の対象
 * - 呼び出し元スレッドのカードは状態による判定をしない（unregistered の対象には含める）
 * - observations が unknown のカードは判定せず unknown として返す
 */
export function detectDeviations(input: SyncInput): SyncAnalysis {
  const deviations: Deviation[] = [];
  const unknown: UnknownThread[] = [];

  for (const card of input.cards) {
    const obs = input.observations.get(card.threadId);
    if (obs === undefined) continue;
    const base = { threadId: card.threadId, cardId: card.id, column: card.column };
    if (obs.kind === 'unknown') {
      unknown.push({ threadId: card.threadId, reason: obs.reason });
      continue;
    }
    if (obs.kind === 'missing') {
      if (!LOOKUP_COLUMNS.includes(card.column)) continue;
      deviations.push({
        ...base,
        kind: 't3_thread_missing',
        t3Status: null,
        message: `threadId ${card.threadId} のスレッドが T3 に存在しません`,
        suggestion: suggestion(
          move(card.threadId, 'discarded'),
          'threadId が正しいか確認する。作業がなくなったのなら discarded へ移す',
        ),
      });
      continue;
    }
    if (input.callerThreadId !== null && card.threadId === input.callerThreadId) continue;
    const d = cardDeviation(card, obs.thread, input);
    if (d !== null) deviations.push({ ...base, ...d, t3Status: obs.thread.status ?? null });
  }

  const carded = new Set(input.cards.map((c) => c.threadId));
  const seen = new Set<string>();
  for (const t of input.projectThreads) {
    if (carded.has(t.threadId) || seen.has(t.threadId) || !isUnregisteredCandidate(t)) continue;
    seen.add(t.threadId);
    const args: Record<string, unknown> = { threadId: t.threadId };
    if (typeof t.title === 'string' && t.title !== '') args.title = t.title;
    deviations.push({
      kind: 'unregistered',
      threadId: t.threadId,
      cardId: null,
      column: null,
      t3Status: t.status ?? null,
      message: `T3 のスレッド${t.title ? ` ${JSON.stringify(t.title)} ` : ''}にカードがありません（ボードにない作業）`,
      suggestion: suggestion({ tool: 'kanban_card_add', args }, 'ボードに載せる作業なら kanban_card_add で登録する'),
    });
  }

  deviations.sort(
    (a, b) => rank(a) - rank(b) || (a.cardId ?? Number.MAX_SAFE_INTEGER) - (b.cardId ?? Number.MAX_SAFE_INTEGER),
  );
  return { deviations, unknown };
}
