import { columnIndex, summarize, type CardSummary } from './rules.js';
import { ACTIVE_COLUMNS, type BoardConfig, type Card, type ServiceClass } from './types.js';

export type NextAction = 'complete_review' | 'resolve_blocker' | 'pull' | 'no_new_work';

export interface NextRecommendation {
  action: NextAction;
  card: CardSummary | null;
  /** pull の場合の移動先 */
  to: 'doing' | null;
  reason: string;
  /** no_new_work の理由コード */
  idleReason: 'NO_CAPACITY' | 'READY_EMPTY' | null;
}

const CLASS_ORDER: Record<ServiceClass, number> = { expedite: 0, fixed_date: 1, regular: 2, intangible: 3 };

/** pull 順: expedite → fixed_date（期限の近い順）→ regular（ready 到着順）→ intangible。 */
export function comparePullOrder(a: Card, b: Card): number {
  const byClass = CLASS_ORDER[a.serviceClass] - CLASS_ORDER[b.serviceClass];
  if (byClass !== 0) return byClass;
  if (a.serviceClass === 'fixed_date') {
    const byDue = (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31');
    if (byDue !== 0) return byDue;
  }
  return a.columnEnteredAt - b.columnEnteredAt || a.id - b.id;
}

/** ready から pull できる候補を pull 順に並べて返す。 */
export function pullCandidates(cards: readonly Card[]): Card[] {
  const ready = cards.filter((c) => c.column === 'ready');
  const hasNonIntangible = ready.some((c) => c.serviceClass !== 'intangible');
  return ready
    .filter((c) => c.blocked === null)
    .filter((c) => !(hasNonIntangible && c.serviceClass === 'intangible'))
    .sort(comparePullOrder);
}

/**
 * 次の行動を 1 件推奨する（右から左に歩く）。
 * 1. review の完了支援 → 2. ブロッカー解消 → 3. doing に空きがあれば ready からクラス順に pull → 4. 新規着手しない
 */
export function recommendNext(board: BoardConfig, cards: readonly Card[]): NextRecommendation {
  const review = cards
    .filter((c) => c.column === 'review' && c.blocked === null)
    .sort((a, b) => CLASS_ORDER[a.serviceClass] - CLASS_ORDER[b.serviceClass] || a.columnEnteredAt - b.columnEnteredAt || a.id - b.id);
  const firstReview = review[0];
  if (firstReview !== undefined) {
    return {
      action: 'complete_review',
      card: summarize(firstReview),
      to: null,
      reason: 'review にあるカードの完了を支援する（done に近い作業を先に終わらせる）',
      idleReason: null,
    };
  }

  const blocked = cards
    .filter((c) => c.blocked !== null && ACTIVE_COLUMNS.includes(c.column))
    .sort(
      (a, b) =>
        columnIndex(b.column) - columnIndex(a.column) ||
        (a.blocked?.since ?? 0) - (b.blocked?.since ?? 0) ||
        a.id - b.id,
    );
  const firstBlocked = blocked[0];
  if (firstBlocked !== undefined) {
    return {
      action: 'resolve_blocker',
      card: summarize(firstBlocked),
      to: null,
      reason: `ブロック中のカードを解消する（理由: ${firstBlocked.blocked?.reason ?? ''}）`,
      idleReason: null,
    };
  }

  const candidates = pullCandidates(cards);
  const doingLimit = board.columns.find((c) => c.name === 'doing')?.wipLimit ?? null;
  const doingCount = cards.filter((c) => c.column === 'doing').length;
  const hasCapacity = doingLimit === null || doingCount < doingLimit;
  const pick = candidates.find((c) => hasCapacity || c.serviceClass === 'expedite');
  if (pick !== undefined) {
    const why =
      pick.serviceClass === 'expedite' && !hasCapacity
        ? 'expedite は WIP 上限を超えて着手できる'
        : `doing に空きがある（${doingCount}/${doingLimit ?? '∞'}）`;
    return {
      action: 'pull',
      card: summarize(pick),
      to: 'doing',
      reason: `${why}。ready から ${pick.serviceClass} のカードを pull する`,
      idleReason: null,
    };
  }

  if (!hasCapacity) {
    return {
      action: 'no_new_work',
      card: null,
      to: null,
      reason: `doing の WIP 上限に達している（${doingCount}/${doingLimit ?? '∞'}）ため新規着手しない。進行中の作業を進める`,
      idleReason: 'NO_CAPACITY',
    };
  }
  // ここに来るのは doing に空きがあり、ready にカードがない場合のみ
  // （ready にブロック中カードがあれば手前の resolve_blocker で返っている）。
  return {
    action: 'no_new_work',
    card: null,
    to: null,
    reason: 'ready に pull できるカードがないため新規着手しない',
    idleReason: 'READY_EMPTY',
  };
}
