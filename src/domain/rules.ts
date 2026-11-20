import {
  ACTIVE_COLUMNS,
  BOARD_COLUMNS,
  DISCARDED,
  fail,
  ok,
  type BoardConfig,
  type Card,
  type Column,
  type Result,
  type ServiceClass,
} from './types.js';

export interface CardSummary {
  cardId: number;
  threadId: string;
  title: string;
  serviceClass: ServiceClass;
  blocked: boolean;
}

export function summarize(card: Card): CardSummary {
  return {
    cardId: card.id,
    threadId: card.threadId,
    title: card.title,
    serviceClass: card.serviceClass,
    blocked: card.blocked !== null,
  };
}

export function columnIndex(column: Column): number {
  return column === DISCARDED ? Number.POSITIVE_INFINITY : BOARD_COLUMNS.indexOf(column);
}

export function isActive(card: Card): boolean {
  return ACTIVE_COLUMNS.includes(card.column);
}

/** card 以外でボード上（inbox〜review）にある expedite カード。 */
function otherActiveExpedite(cards: readonly Card[], selfId: number | null): Card | undefined {
  return cards.find((c) => c.id !== selfId && c.serviceClass === 'expedite' && isActive(c));
}

function expediteLimit<T>(existing: Card): Result<T> {
  return fail('EXPEDITE_LIMIT', 'expedite のカードはボード上に同時 1 枚までです', { existing: summarize(existing) });
}

export interface MoveRequest {
  card: Card;
  to: Column;
  /** ボード上の全カード（移動対象を含んでよい） */
  cards: readonly Card[];
  board: BoardConfig;
  force?: boolean | undefined;
  reason?: string | undefined;
  criteriaConfirmed?: boolean | undefined;
}

export interface WipViolation {
  column: Column;
  limit: number;
  countBefore: number;
  reason: string;
  occupants: CardSummary[];
}

export interface MoveDecision {
  from: Column;
  to: Column;
  direction: 'forward' | 'backward' | 'discard';
  /** force で WIP を突破した場合の違反内容 */
  violation: WipViolation | null;
  /** expedite が WIP 上限を超えて入った場合 true */
  expediteOverLimit: boolean;
}

/**
 * 列移動のルールを判定する純粋関数。
 * 判定順: force/reason の整合 → 終端・同一列 → 飛び越し → ブロック → expedite 同時数 → 入場条件 → WIP。
 */
export function checkMove(req: MoveRequest): Result<MoveDecision> {
  const { card, to, cards, board } = req;
  const from = card.column;

  if (req.force === true && (req.reason === undefined || req.reason.trim() === '')) {
    return fail('FORCE_REASON_REQUIRED', 'force: true を指定する場合は reason が必須です');
  }
  if (from === DISCARDED) {
    return fail('TERMINAL_COLUMN', 'discarded は終端列のため移動できません', { from });
  }
  if (from === to) {
    return fail('SAME_COLUMN', `カードは既に ${to} にあります`, { from, to });
  }

  const direction: MoveDecision['direction'] =
    to === DISCARDED ? 'discard' : columnIndex(to) > columnIndex(from) ? 'forward' : 'backward';

  if (direction === 'forward' && columnIndex(to) !== columnIndex(from) + 1) {
    const next = BOARD_COLUMNS[columnIndex(from) + 1];
    return fail('SKIP_NOT_ALLOWED', `${from} から ${to} への飛び越しはできません。次の列は ${next} です`, {
      from,
      to,
      nextColumn: next,
    });
  }

  if (direction === 'forward' && card.blocked !== null) {
    return fail('BLOCKED', `ブロック中のカードは前進できません（理由: ${card.blocked.reason}）`, {
      blockedReason: card.blocked.reason,
      blockedSince: new Date(card.blocked.since).toISOString(),
    });
  }

  if (direction === 'discard') {
    return ok({ from, to, direction, violation: null, expediteOverLimit: false });
  }

  if (card.serviceClass === 'expedite' && !ACTIVE_COLUMNS.includes(from) && ACTIVE_COLUMNS.includes(to)) {
    const other = otherActiveExpedite(cards, card.id);
    if (other !== undefined) return expediteLimit(other);
  }

  const config = board.columns.find((c) => c.name === to);
  if (config !== undefined && config.entryCriteria.length > 0 && req.criteriaConfirmed !== true) {
    return fail(
      'CRITERIA_NOT_CONFIRMED',
      `${to} の入場条件を確認し、満たしている場合は criteriaConfirmed: true を指定してください`,
      { column: to, entryCriteria: [...config.entryCriteria] },
    );
  }

  let violation: WipViolation | null = null;
  let expediteOverLimit = false;
  const limit = config?.wipLimit ?? null;
  if (limit !== null) {
    const occupants = cards.filter((c) => c.id !== card.id && c.column === to);
    if (occupants.length + 1 > limit) {
      const summaries = occupants.map(summarize);
      if (card.serviceClass === 'expedite') {
        expediteOverLimit = true;
      } else if (req.force === true) {
        violation = {
          column: to,
          limit,
          countBefore: occupants.length,
          reason: (req.reason ?? '').trim(),
          occupants: summaries,
        };
      } else {
        return fail('WIP_LIMIT_EXCEEDED', `${to} の WIP 上限 ${limit} に達しています`, {
          column: to,
          limit,
          count: occupants.length,
          occupants: summaries,
          occupantThreadIds: summaries.map((s) => s.threadId),
        });
      }
    }
  }

  return ok({ from, to, direction, violation, expediteOverLimit });
}

export interface CardAttributes {
  serviceClass: ServiceClass;
  dueDate: string | null;
}

/**
 * 登録・更新後のカード属性がサービスクラスのポリシーを満たすかを判定する。
 * `self` は更新対象のカード（新規登録時は null）。
 */
export function checkClassPolicy(
  attrs: CardAttributes,
  cards: readonly Card[],
  self: Card | null,
): Result<null> {
  if (attrs.serviceClass === 'fixed_date' && (attrs.dueDate === null || attrs.dueDate === '')) {
    return fail('DUE_DATE_REQUIRED', 'fixed_date のカードには dueDate (YYYY-MM-DD) が必須です');
  }
  const selfActive = self === null ? true : isActive(self);
  if (attrs.serviceClass === 'expedite' && selfActive) {
    const other = otherActiveExpedite(cards, self?.id ?? null);
    if (other !== undefined) return expediteLimit(other);
  }
  return ok(null);
}
