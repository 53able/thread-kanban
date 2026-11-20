// DOM テストと state の単体テストで使うボードの組み立て。
import type { BoardCardView, BoardColumn, BoardColumnView, BoardResponse, MoveOption, UiEvent } from '../../ui/api-types.js';

export const COLUMNS: BoardColumn[] = ['inbox', 'ready', 'doing', 'review', 'done'];
const LIMITS: Record<BoardColumn, number | null> = { inbox: null, ready: 5, doing: 3, review: 2, done: null };

export function card(cardId: number, extra: Partial<BoardCardView> = {}): BoardCardView {
  return {
    cardId,
    threadId: `t-${cardId}`,
    title: `カード${cardId}`,
    type: 'feature',
    serviceClass: 'regular',
    dueDate: null,
    size: null,
    externalRefs: [],
    t3: null,
    daysInColumn: 0,
    blocked: null,
    overdue: false,
    stale: false,
    daysSinceLastEvent: 0,
    ...extra,
  };
}

export interface BoardSpec {
  cards?: Partial<Record<BoardColumn, BoardCardView[]>>;
  criteria?: Partial<Record<BoardColumn, string[]>>;
  lastEventId?: number;
  key?: string;
}

/** BoardResponse を作る（columns は BoardView と同じ右から左の順）。 */
export function boardResp(spec: BoardSpec = {}): BoardResponse {
  const columns: BoardColumnView[] = [...COLUMNS].reverse().map((column) => {
    const cards = spec.cards?.[column] ?? [];
    const wipLimit = LIMITS[column];
    return {
      column,
      wipLimit,
      count: cards.length,
      overLimit: wipLimit !== null && cards.length > wipLimit,
      entryCriteria: spec.criteria?.[column] ?? [],
      cards,
    };
  });
  const all = columns.flatMap((c) => c.cards.map((x) => ({ x, column: c.column })));
  return {
    ok: true,
    key: spec.key ?? 'k1',
    label: 'repo',
    board: {
      boardId: 'default',
      staleDays: 3,
      columns,
      wipViolations: columns.filter((c) => c.overLimit).map((c) => ({ column: c.column, wipLimit: c.wipLimit as number, count: c.count })),
      blocked: all.filter((a) => a.x.blocked !== null).map((a) => ({ threadId: a.x.threadId, column: a.column, reason: a.x.blocked?.reason ?? '', days: 0 })),
      overdue: all.filter((a) => a.x.overdue).map((a) => ({ threadId: a.x.threadId, column: a.column, dueDate: a.x.dueDate ?? '' })),
      stale: all.filter((a) => a.x.stale).map((a) => ({ threadId: a.x.threadId, column: a.column, daysSinceLastEvent: a.x.daysSinceLastEvent })),
      discardedCount: 0,
    },
    next: null,
    now: '2026-11-20T00:00:00.000Z',
    lastEventId: spec.lastEventId ?? 10,
  };
}

export function option(column: BoardColumn, extra: Partial<MoveOption> = {}): MoveOption {
  return { column, allowed: true, needsCriteria: false, entryCriteria: [], wip: 'ok', ...extra };
}

export function event(id: number, extra: Partial<UiEvent> = {}): UiEvent {
  return {
    id,
    cardId: 1,
    threadId: 't-1',
    title: 'カード1',
    type: 'moved',
    fromColumn: 'doing',
    toColumn: 'review',
    at: '2026-11-20T00:00:00.000Z',
    actor: null,
    data: {},
    ...extra,
  };
}
