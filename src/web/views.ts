// ストアの値を UI の JSON に変換する純粋関数。判定ロジックは domain の関数をそのまま使う。
import { buildBoardView } from '../domain/metrics.js';
import { recommendNext } from '../domain/next.js';
import { checkMove } from '../domain/rules.js';
import { BOARD_COLUMNS, type BoardConfig, type Card, type KanbanEvent } from '../domain/types.js';
import type { BoardKey, BoardResponse, MoveOccupant, MoveOption, UiEvent } from './types.js';

export type Snapshot = { board: BoardConfig; cards: Card[] } | null;

export function toUiEvent(e: KanbanEvent, cardsById: ReadonlyMap<number, Card>): UiEvent {
  const card = e.cardId === null ? undefined : cardsById.get(e.cardId);
  const actor = e.data.actor;
  return {
    id: e.id,
    cardId: e.cardId,
    threadId: card?.threadId ?? null,
    title: card?.title ?? null,
    type: e.type,
    fromColumn: e.fromColumn,
    toColumn: e.toColumn,
    at: new Date(e.at).toISOString(),
    actor: typeof actor === 'string' ? actor : null,
    data: e.data,
  };
}

export function cardsById(snapshot: Snapshot): Map<number, Card> {
  return new Map((snapshot?.cards ?? []).map((c) => [c.id, c]));
}

export function boardResponse(key: BoardKey, label: string, snapshot: Snapshot, lastEventId: number, now: number): BoardResponse {
  return {
    ok: true,
    key,
    label,
    board: snapshot === null ? null : buildBoardView(snapshot.board, snapshot.cards, now),
    next: snapshot === null ? null : recommendNext(snapshot.board, snapshot.cards),
    now: new Date(now).toISOString(),
    lastEventId,
  };
}

function occupantsOf(details: Record<string, unknown> | undefined): MoveOccupant[] {
  const raw = details?.occupants;
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    const r = o as { cardId: number; threadId: string; title: string };
    return { cardId: r.cardId, threadId: r.threadId, title: r.title };
  });
}

/**
 * move-options: 現在の列と discarded を除く各列について、checkMove を criteriaConfirmed: true, force: false で呼んで変換する。
 * - 成功で expediteOverLimit → allowed, wip: 'expediteOver' / 成功 → allowed, wip: 'ok'
 * - WIP_LIMIT_EXCEEDED → allowed, wip: 'exceeded'（強行すれば移動できる）、occupants は details から
 * - それ以外の失敗 → allowed: false, code, wip: null
 */
export function moveOptions(card: Card, snapshot: NonNullable<Snapshot>): MoveOption[] {
  const { board, cards } = snapshot;
  return BOARD_COLUMNS.filter((column) => column !== card.column).map((column) => {
    const entryCriteria = [...(board.columns.find((c) => c.name === column)?.entryCriteria ?? [])];
    const base = { column, needsCriteria: entryCriteria.length > 0, entryCriteria };
    const r = checkMove({ card, to: column, cards, board, criteriaConfirmed: true, force: false });
    if (r.ok) return { ...base, allowed: true, wip: r.value.expediteOverLimit ? 'expediteOver' : 'ok' };
    if (r.error.code === 'WIP_LIMIT_EXCEEDED') {
      return { ...base, allowed: true, wip: 'exceeded', occupants: occupantsOf(r.error.details) };
    }
    return { ...base, allowed: false, code: r.error.code, wip: null };
  });
}
