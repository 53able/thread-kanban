import type { MoveDecision } from '../domain/rules.js';
import { t3ActionForMove, type T3Action } from '../domain/sync.js';
import { ok, type Card, type Result } from '../domain/types.js';
import type { KanbanStore, MoveCardInput } from '../store/sqlite.js';

export type MoveInput = Omit<MoveCardInput, 'actor'>;

export interface MoveArgs {
  store: KanbanStore;
  /** resolveThreadId で検証済みの threadId */
  threadId: string;
  input: MoveInput;
  /** T3 を使えるか（MCP は t3.available()、UI は false） */
  t3Available: boolean;
  /** 操作した主体。UI は 'ui'。MCP は指定しない */
  actor?: string | undefined;
}

export interface MoveResult {
  card: Card;
  decision: MoveDecision;
  /** 応答のテキストに添える補足（WIP 違反、expedite、T3 側の操作） */
  notes: string[];
  t3Action: T3Action | null;
}

/** kanban_card_move / UI の move の本体。 */
export function moveCard(args: MoveArgs): Result<MoveResult> {
  const { store, threadId, input, t3Available, actor } = args;
  const result = store.moveCard(threadId, { ...input, ...(actor !== undefined ? { actor } : {}) });
  if (!result.ok) return result;
  const { card, decision } = result.value;
  const notes = [
    decision.violation !== null
      ? `WIP 違反を記録しました（${decision.violation.column} 上限 ${decision.violation.limit}、理由: ${decision.violation.reason}）`
      : null,
    decision.expediteOverLimit ? 'expedite のため WIP 上限を超えて移動しました' : null,
  ].filter((x): x is string => x !== null);
  // ボード → T3 の反映。T3 CLI に settle はないので、エージェントへの提案として返す
  const t3Action = t3ActionForMove(decision.from, decision.to, card.threadId, card.t3 !== null || t3Available);
  if (t3Action !== null) {
    notes.push(`T3 側: ${t3Action.tool} で ${t3Action.args.action} する（T3 は Not Done / Done だけを持つ）`);
  }
  return ok({ card, decision, notes, t3Action });
}

/** MCP の structuredContent（ok を除く）と UI の JSON で共通の応答の形。 */
export interface MoveResponse {
  card: Card;
  from: MoveDecision['from'];
  to: MoveDecision['to'];
  direction: MoveDecision['direction'];
  violation: MoveDecision['violation'];
  expediteOverLimit: boolean;
  t3Action: T3Action | null;
}

export function toMoveResponse(r: MoveResult): MoveResponse {
  return {
    card: r.card,
    from: r.decision.from,
    to: r.decision.to,
    direction: r.decision.direction,
    violation: r.decision.violation,
    expediteOverLimit: r.decision.expediteOverLimit,
    t3Action: r.t3Action,
  };
}
