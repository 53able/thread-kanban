import { ok, type Card, type Result } from '../domain/types.js';
import type { KanbanStore } from '../store/sqlite.js';

export interface BlockArgs {
  store: KanbanStore;
  /** resolveThreadId で検証済みの threadId */
  threadId: string;
  input: { reason: string };
  /** block / unblock では使わない（move と同じ引数の形にそろえるため受け取る） */
  t3Available: boolean;
  /** 操作した主体。UI は 'ui'。MCP は指定しない */
  actor?: string | undefined;
}

export interface UnblockArgs extends Omit<BlockArgs, 'input'> {
  input: { resolution?: string | undefined };
}

export interface BlockResult {
  card: Card;
}

export interface UnblockResult {
  card: Card;
  /** ブロックされていた日数（小数第 2 位で丸める） */
  blockedDays: number;
}

/** kanban_card_block / UI の block の本体。 */
export function blockCard(args: BlockArgs): Result<BlockResult> {
  const { store, threadId, input, actor } = args;
  const result = store.blockCard(threadId, input.reason, actor !== undefined ? { actor } : undefined);
  if (!result.ok) return result;
  return ok({ card: result.value });
}

/** kanban_card_unblock / UI の unblock の本体。 */
export function unblockCard(args: UnblockArgs): Result<UnblockResult> {
  const { store, threadId, input, actor } = args;
  const result = store.unblockCard(threadId, input.resolution, actor !== undefined ? { actor } : undefined);
  if (!result.ok) return result;
  return ok({ card: result.value.card, blockedDays: Math.round(result.value.blockedDays * 100) / 100 });
}

/** MCP の structuredContent（ok を除く）と UI の JSON で共通の応答の形。 */
export interface BlockResponse {
  card: Card;
}

export interface UnblockResponse {
  card: Card;
  blockedDays: number;
}

export function toBlockResponse(r: BlockResult): BlockResponse {
  return { card: r.card };
}

export function toUnblockResponse(r: UnblockResult): UnblockResponse {
  return { card: r.card, blockedDays: r.blockedDays };
}
