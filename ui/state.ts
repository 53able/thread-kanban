// UI の状態遷移を純粋な関数で書く（DOM に触れない。DOM テストと単体テストの両方から使う）。

import type { HealthResult } from './api.js';
import type {
  BoardColumnView,
  BoardResponse,
  BoardView,
  Column,
  MoveBody,
  MoveOption,
  T3Action,
  UiEvent,
} from './api-types.js';

// ---------------------------------------------------------------- ボード

/** 表示順（左の inbox から右の done）の列。BoardView.columns は右から左の順なので反転する。 */
export function displayColumns(board: BoardView): BoardColumnView[] {
  return [...board.columns].reverse();
}

export interface CardPosition {
  col: number;
  idx: number;
  column: Column;
}

export function findCard(board: BoardView, threadId: string): CardPosition | null {
  const cols = displayColumns(board);
  for (let col = 0; col < cols.length; col += 1) {
    const c = cols[col] as BoardColumnView;
    const idx = c.cards.findIndex((card) => card.threadId === threadId);
    if (idx >= 0) return { col, idx, column: c.column };
  }
  return null;
}

/** 要対応の件数。ブロック・期限超過・stale のどれかに当たるカードの枚数（重複は 1 枚と数える）。 */
export function attentionCount(board: BoardView): number {
  const ids = new Set<string>();
  for (const x of board.blocked) ids.add(x.threadId);
  for (const x of board.overdue) ids.add(x.threadId);
  for (const x of board.stale) ids.add(x.threadId);
  return ids.size;
}

export function wipOverCount(board: BoardView): number {
  return board.wipViolations.length;
}

// ---------------------------------------------------------------- snapshot の取り込み

export interface IngestResult {
  resp: BoardResponse;
  /** 前回から変わったカード（強調表示する） */
  changed: number[];
  /** 列が変わったカードがあるか（view transition を使うかの判定） */
  columnMoved: boolean;
}

function cardIndex(board: BoardView | null): Map<number, { column: Column; key: string }> {
  const map = new Map<number, { column: Column; key: string }>();
  if (board === null) return map;
  for (const col of board.columns) {
    for (const c of col.cards) {
      map.set(c.cardId, {
        column: col.column,
        key: JSON.stringify([col.column, c.title, c.blocked?.reason ?? null, c.overdue, c.stale, c.serviceClass, c.dueDate]),
      });
    }
  }
  return map;
}

export function ingestSnapshot(prev: BoardResponse | null, next: BoardResponse): IngestResult {
  if (prev === null || prev.key !== next.key) return { resp: next, changed: [], columnMoved: false };
  const before = cardIndex(prev.board);
  const after = cardIndex(next.board);
  const changed: number[] = [];
  let columnMoved = false;
  for (const [id, a] of after) {
    const b = before.get(id);
    if (b === undefined || b.key !== a.key) changed.push(id);
    if (b !== undefined && b.column !== a.column) columnMoved = true;
  }
  return { resp: next, changed, columnMoved };
}

export interface SnapshotGate {
  apply: BoardResponse | null;
  pending: BoardResponse | null;
}

/**
 * 届いた snapshot を取り込むか溜めるかを決める。ドラッグ中・つかんでいる間・モーダルの表示中（busy）は
 * 最新の 1 件だけを溜め、それ以外はすぐ取り込む。
 */
export function offerSnapshot(incoming: BoardResponse, busy: boolean): SnapshotGate {
  // 溜めていたものより incoming のほうが新しいので、どちらの場合も溜めていたものは捨てる
  if (busy) return { apply: null, pending: incoming };
  return { apply: incoming, pending: null };
}

/**
 * 移動の送信が成功した後に残す溜めた snapshot。watermark は書き込み後の最大のイベント id（POST の応答の lastEventId）。
 * snapshot の lastEventId が watermark 以上なら自分の移動を含むので残す（その後の別の操作で列が変わっていてもよい）。
 * それ未満は移動より前のものなので捨てる（取り込むと表示が移動前に戻る。呼び出し側は GET で取り直す）。
 */
export function pendingAfterMove(pending: BoardResponse | null, watermark: number): BoardResponse | null {
  if (pending === null) return null;
  return pending.lastEventId >= watermark ? pending : null;
}

/** busy が終わったときに、溜めていた snapshot を取り込む。 */
export function releaseSnapshot(pending: BoardResponse | null, busy: boolean): SnapshotGate {
  if (busy || pending === null) return { apply: null, pending };
  return { apply: pending, pending: null };
}

/** 溜めていた snapshot を取り込んだ後、つかんでいたカードの状態が変わっていれば知らせる文。 */
export function grabbedCardNotice(prev: BoardResponse | null, next: BoardResponse, threadId: string): string | null {
  if (prev?.board == null) return null;
  const before = findCard(prev.board, threadId);
  if (before === null) return null;
  const after = next.board === null ? null : findCard(next.board, threadId);
  if (after === null) return '操作中のカードがボードから消えました';
  if (after.column !== before.column) return `操作中のカードは別の操作で ${after.column} に移動しました`;
  const b = prev.board.columns.flatMap((c) => c.cards).find((c) => c.threadId === threadId);
  const a = next.board?.columns.flatMap((c) => c.cards).find((c) => c.threadId === threadId);
  if ((b?.blocked === null) !== (a?.blocked === null)) {
    return a?.blocked === null ? '操作中のカードのブロックが解除されました' : '操作中のカードがブロックされました';
  }
  return null;
}

// ---------------------------------------------------------------- 選択とフォーカス

export type FocusTarget = { kind: 'card'; threadId: string } | { kind: 'column'; column: Column };

/**
 * 新しいボードでの選択先。選択中のカードがあればそのまま（列が変わっても追従）、消えていれば
 * 前のボードでの位置をもとに同じ列の隣のカードへ、列が空なら列そのものへ移す。
 */
export function resolveSelection(prev: BoardView | null, next: BoardView, selected: string | null): FocusTarget | null {
  if (selected === null) return null;
  if (findCard(next, selected) !== null) return { kind: 'card', threadId: selected };
  const before = prev === null ? null : findCard(prev, selected);
  if (before === null) return null;
  const col = next.columns.find((c) => c.column === before.column);
  if (col === undefined) return null;
  if (col.cards.length === 0) return { kind: 'column', column: before.column };
  const idx = Math.min(before.idx, col.cards.length - 1);
  return { kind: 'card', threadId: (col.cards[idx] as BoardColumnView['cards'][number]).threadId };
}

export interface VRect {
  top: number;
  bottom: number;
}

function hasGeometry(r: VRect | undefined): r is VRect {
  return r !== undefined && r.bottom - r.top > 0;
}

/**
 * 矢印キーでの移動先（threadId）を返す。移動先がなければ null（呼び出し側は preventDefault しない）。
 * 論理的な位置（列の番号とカードの番号）を正とし、rects は列をまたぐときに縦の位置を合わせるためだけに使う。
 * rect がすべて 0 でも、同じ番号（範囲外なら末尾）のカードへ移る。←/→ は空の列を飛ばす。
 */
export function nextFocus(
  board: BoardView,
  current: string,
  key: string,
  rects?: Readonly<Record<string, VRect>>,
): string | null {
  const cols = displayColumns(board);
  const pos = findCard(board, current);
  if (pos === null) return null;
  const column = cols[pos.col] as BoardColumnView;
  if (key === 'ArrowUp') return pos.idx > 0 ? (column.cards[pos.idx - 1]?.threadId ?? null) : null;
  if (key === 'ArrowDown') return column.cards[pos.idx + 1]?.threadId ?? null;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const step = key === 'ArrowLeft' ? -1 : 1;
  for (let c = pos.col + step; c >= 0 && c < cols.length; c += step) {
    const target = cols[c] as BoardColumnView;
    if (target.cards.length === 0) continue;
    const cur = rects?.[current];
    if (hasGeometry(cur) && target.cards.every((card) => hasGeometry(rects?.[card.threadId]))) {
      const mid = (cur.top + cur.bottom) / 2;
      let best = target.cards[0] as BoardColumnView['cards'][number];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const card of target.cards) {
        const r = rects?.[card.threadId] as VRect;
        const d = Math.abs((r.top + r.bottom) / 2 - mid);
        if (d < bestDist) {
          best = card;
          bestDist = d;
        }
      }
      return best.threadId;
    }
    return (target.cards[Math.min(pos.idx, target.cards.length - 1)] as BoardColumnView['cards'][number]).threadId;
  }
  return null;
}

// ---------------------------------------------------------------- 送信前の表示更新と巻き戻し

function withCounts(col: BoardColumnView, cards: BoardColumnView['cards']): BoardColumnView {
  return { ...col, cards, count: cards.length, overLimit: col.wipLimit !== null && cards.length > col.wipLimit };
}

/** 送信前にカードを移動先の列の末尾へ移した表示を返す。巻き戻しは元の BoardResponse をそのまま使う。 */
export function applyOptimisticMove(resp: BoardResponse, threadId: string, to: Column): BoardResponse {
  const board = resp.board;
  if (board === null) return resp;
  const card = board.columns.flatMap((c) => c.cards).find((c) => c.threadId === threadId);
  if (card === undefined || !board.columns.some((c) => c.column === to)) return resp;
  const moved = { ...card, daysInColumn: 0 };
  const columns = board.columns.map((col) => {
    const rest = col.cards.filter((c) => c.threadId !== threadId);
    return withCounts(col, col.column === to ? [...rest, moved] : rest);
  });
  const wipViolations = columns
    .filter((c) => c.overLimit)
    .map((c) => ({ column: c.column, wipLimit: c.wipLimit as number, count: c.count }));
  const relocate = <T extends { threadId: string; column: Column }>(xs: T[]): T[] =>
    xs.map((x) => (x.threadId === threadId ? { ...x, column: to } : x));
  return {
    ...resp,
    board: {
      ...board,
      columns,
      wipViolations,
      blocked: relocate(board.blocked),
      overdue: relocate(board.overdue),
      stale: relocate(board.stale),
    },
  };
}

export type MoveStep = 'criteria' | 'wip';

/** ドロップ後に必要なダイアログの段（入場条件 → WIP 超過の順に、必要なものだけ）。 */
export function moveSteps(option: MoveOption): MoveStep[] {
  const steps: MoveStep[] = [];
  if (option.needsCriteria) steps.push('criteria');
  if (option.wip === 'exceeded') steps.push('wip');
  return steps;
}

/**
 * 送信する body。criteriaConfirmed は needsCriteria の列でだけ付け（イベントの data に記録されるため）、
 * force / reason は WIP 超過を強行するときだけ付ける。
 */
export function buildMoveBody(option: MoveOption, forceReason?: string): MoveBody {
  const body: MoveBody = { to: option.column };
  if (option.needsCriteria) body.criteriaConfirmed = true;
  if (option.wip === 'exceeded' && forceReason !== undefined) {
    body.force = true;
    body.reason = forceReason;
  }
  return body;
}

export type VerdictKind = 'current' | 'forbidden' | 'criteria' | 'wip' | 'expedite' | 'ok';

/** ドラッグ・つかみ中に列へ出す判定（禁止／入場条件あり／WIP 超過／expedite 超過（警告）／可）。 */
export function columnVerdicts(option: MoveOption | undefined): { kind: VerdictKind; label: string }[] {
  if (option === undefined) return [{ kind: 'current', label: '現在の列' }];
  if (!option.allowed) return [{ kind: 'forbidden', label: `禁止（${errorLabel(option.code)}）` }];
  const out: { kind: VerdictKind; label: string }[] = [];
  if (option.needsCriteria) out.push({ kind: 'criteria', label: '入場条件あり' });
  if (option.wip === 'exceeded') out.push({ kind: 'wip', label: 'WIP 超過' });
  if (option.wip === 'expediteOver') out.push({ kind: 'expedite', label: 'expedite 超過（警告）' });
  if (out.length === 0) out.push({ kind: 'ok', label: '可' });
  return out;
}

const ERROR_LABELS: Record<string, string> = {
  WIP_LIMIT_EXCEEDED: 'WIP 上限に達しています',
  BLOCKED: 'ブロック中は前進できません',
  SKIP_NOT_ALLOWED: '列の飛び越しはできません',
  CRITERIA_NOT_CONFIRMED: '入場条件の確認が必要です',
  EXPEDITE_LIMIT: 'expedite は同時 1 枚までです',
  FORCE_REASON_REQUIRED: '強行の理由が必要です',
  CARD_NOT_FOUND: 'カードが見つかりません',
  SAME_COLUMN: '同じ列です',
  TERMINAL_COLUMN: '終端の列からは移動できません',
  ALREADY_BLOCKED: 'すでにブロック中です',
  NOT_BLOCKED: 'ブロックされていません',
  CARD_NOT_ACTIVE: 'ボード上にないカードです',
  INVALID_ARGUMENT: '入力が不正です',
  UI_DISCARD_NOT_ALLOWED: 'UI からは破棄できません',
  NETWORK: 'サーバーに接続できません',
  BOARD_UNAVAILABLE: 'ボードを読み込めません',
};

/** リンクとして出してよい URL（http: / https: のみ）。それ以外は null。 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (url == null) return null;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function errorLabel(code: string | undefined): string {
  if (code === undefined) return '不可';
  return ERROR_LABELS[code] ?? code;
}

// ---------------------------------------------------------------- トースト

export interface SettleInfo {
  action: 'settle' | 'unsettle';
  threadId: string;
  link: string | null;
  instruction: string;
}

export interface Toast {
  id: number;
  text: string;
  /** settle / unsettle の通知は自動で消さない */
  persistent: boolean;
  settle?: SettleInfo;
}

export interface RecentItem {
  id: number;
  text: string;
}

export interface ToastState {
  visible: Toast[];
  /** モーダルの表示中に溜めたもの */
  held: Toast[];
  /** ヘッダーの「最近の更新」（新しい順） */
  recent: RecentItem[];
  nextId: number;
}

export const RECENT_LIMIT = 50;

export function emptyToasts(): ToastState {
  return { visible: [], held: [], recent: [], nextId: 1 };
}

export type ToastInput = Omit<Toast, 'id'>;

function actorLabel(e: UiEvent): string {
  return e.actor === 'ui' ? 'UI' : 'エージェント';
}

function cardLabel(e: UiEvent): string {
  const id = e.cardId === null ? '' : `#${e.cardId}`;
  return e.title === null || e.title === '' ? id : `${id}「${e.title}」`;
}

/** イベント 1 件をトーストの文にする（例:「#12 が review に移動（エージェント）」）。 */
export function eventText(e: UiEvent): string {
  const who = `（${actorLabel(e)}）`;
  const card = cardLabel(e);
  switch (e.type) {
    case 'moved':
      return e.fromColumn === null ? `${card} が ${e.toColumn ?? ''} に追加${who}` : `${card} が ${e.toColumn ?? ''} に移動${who}`;
    case 'created':
      return `${card} を登録${who}`;
    case 'updated':
      return `${card} を更新${who}`;
    case 'blocked':
      return `${card} がブロック中${typeof e.data.reason === 'string' ? `: ${e.data.reason}` : ''}${who}`;
    case 'unblocked':
      return `${card} のブロックを解除${who}`;
    case 'wip_violation':
      return `${card} が ${e.toColumn ?? ''} の WIP 上限を超えて移動${who}`;
    case 'configured':
      return `ボードの設定を変更${who}`;
  }
}

/** このタブが送った UI の操作。送信の直前に記録し、期限まで同じカードの actor: 'ui' のイベントをトーストにしない。 */
export interface OwnAction {
  threadId: string;
  expiresAt: number;
}

export const OWN_ACTION_TTL_MS = 10_000;

export function isOwnEvent(e: UiEvent, own: readonly OwnAction[], now: number): boolean {
  return e.actor === 'ui' && e.threadId !== null && own.some((o) => o.threadId === e.threadId && o.expiresAt >= now);
}

export function pruneOwnActions(own: readonly OwnAction[], now: number): OwnAction[] {
  return own.filter((o) => o.expiresAt >= now);
}

export interface EventsContext {
  /** 初回の接続（最初の snapshot より前）。トーストを出さない */
  initial: boolean;
  /** 再接続して取りこぼした分（最初の snapshot より前）。件数をまとめた 1 件にする */
  gap: boolean;
  own: readonly OwnAction[];
  now: number;
}

/** 新しいイベントからトーストを作る。 */
export function eventsToToasts(events: readonly UiEvent[], ctx: EventsContext): ToastInput[] {
  if (ctx.initial) return [];
  const others = events.filter((e) => !isOwnEvent(e, ctx.own, ctx.now));
  if (others.length === 0) return [];
  if (ctx.gap) return [{ text: `切断中に ${others.length} 件の更新`, persistent: false }];
  return others.map((e) => ({ text: eventText(e), persistent: false }));
}

/** トーストを出す。モーダルの表示中は溜めておく。「最近の更新」にも残す。 */
export function pushToasts(state: ToastState, inputs: readonly ToastInput[], modalOpen: boolean): ToastState {
  if (inputs.length === 0) return state;
  let nextId = state.nextId;
  const toasts = inputs.map((t) => ({ ...t, id: nextId++ }));
  const recent = [...toasts.map((t) => ({ id: t.id, text: t.text })).reverse(), ...state.recent].slice(0, RECENT_LIMIT);
  return modalOpen
    ? { ...state, held: [...state.held, ...toasts], recent, nextId }
    : { ...state, visible: [...state.visible, ...toasts], recent, nextId };
}

/** モーダルが閉じた後に、溜めたトーストを出す。自動で消えるものは件数をまとめて 1 件にする。 */
export function releaseHeldToasts(state: ToastState): ToastState {
  if (state.held.length === 0) return state;
  const persistent = state.held.filter((t) => t.persistent);
  const transient = state.held.filter((t) => !t.persistent);
  let nextId = state.nextId;
  const summary: Toast[] =
    transient.length === 0
      ? []
      : transient.length === 1
        ? [transient[0] as Toast]
        : [{ id: nextId++, text: `ダイアログの表示中に ${transient.length} 件の更新`, persistent: false }];
  return { ...state, visible: [...state.visible, ...persistent, ...summary], held: [], nextId };
}

export function dismissToast(state: ToastState, id: number): ToastState {
  return { ...state, visible: state.visible.filter((t) => t.id !== id) };
}

/** エージェントに貼り付ける指示文。 */
export function settleInstruction(action: T3Action): string {
  return `${action.tool} を action: "${action.args.action}", threadId: "${action.args.threadId}" で呼んでください（thread-kanban の UI でカードを移動したため。${action.reason}）`;
}

/** settle / unsettle が必要だという通知（自動で消えない）。 */
export function settleToast(action: T3Action, cardId: number | null, link: string | null): ToastInput {
  const label = cardId === null ? action.args.threadId : `#${cardId}`;
  const verb = action.args.action === 'settle' ? '完了（settle）' : '未完了に戻す（unsettle）';
  return {
    text: `T3 側は未反映: ${label} の T3 スレッドを${verb}してください`,
    persistent: true,
    settle: { action: action.args.action, threadId: action.args.threadId, link, instruction: settleInstruction(action) },
  };
}

// ---------------------------------------------------------------- 切断時の判定

export type DisconnectKind = 'unreachable' | 'valid' | 'forbidden' | 'no-cookie';

/** 切断時の /api/health の結果を 4 通りに分ける。 */
export function classifyDisconnect(result: HealthResult): DisconnectKind {
  if (result.kind === 'network') return 'unreachable';
  if (result.status === 403) return 'forbidden';
  if (result.status === 200 && result.body?.authenticated === 'none') return 'no-cookie';
  if (result.status === 200 && result.body?.authenticated === 'valid') return 'valid';
  return 'unreachable';
}

export type Banner = 'offline' | 'unavailable' | 'reauth' | null;

export const MAX_VALID_FAILURES = 5;
export const MAX_BACKOFF_MS = 10_000;
const BASE_BACKOFF_MS = 500;

export interface DisconnectDecision {
  banner: Banner;
  retry: boolean;
  validFailures: number;
}

/**
 * 判定の結果から、表示する案内と再試行するかを決める。
 * - 接続できない: 再試行（サーバーの再起動待ち）
 * - valid: 再試行。5 回続いたら「ボードを読み込めません」を出して自動の再試行をやめる
 * - 403 / cookie なし: 再試行をやめ、「新しい URL を開いてください」を出す
 */
export function decideDisconnect(kind: DisconnectKind, validFailures: number): DisconnectDecision {
  switch (kind) {
    case 'unreachable':
      return { banner: 'offline', retry: true, validFailures: 0 };
    case 'valid': {
      const n = validFailures + 1;
      return n >= MAX_VALID_FAILURES ? { banner: 'unavailable', retry: false, validFailures: n } : { banner: null, retry: true, validFailures: n };
    }
    case 'forbidden':
    case 'no-cookie':
      return { banner: 'reauth', retry: false, validFailures };
  }
}

export function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
}
