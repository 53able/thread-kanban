import { summarize } from '../domain/rules.js';
import { mergeTracking, type T3Thread } from '../domain/sync.js';
import { fail, ok, type Card, type Clock, type Result } from '../domain/types.js';
import type { AddCardInput, KanbanStore } from '../store/sqlite.js';
import type { T3Gateway } from '../t3/gateway.js';

export interface AppDeps {
  store: KanbanStore;
  t3: T3Gateway;
  clock: Clock;
}

export type CardAddInput = Omit<AddCardInput, 'title' | 't3'> & {
  title?: string | undefined;
  asWorkItem?: boolean | undefined;
};

/** T3 からスレッドを取得できず title で登録したときの理由（m3） */
export interface T3Warning {
  reason: string;
  message: string;
}

export interface CardAddResult {
  card: Card;
  created: boolean;
  t3Warning: T3Warning | null;
}

/**
 * kanban_card_add の本体。
 * - 登録済みなら列・属性は変えず、T3 から取得できれば追跡参照だけ更新する（R13。子スレッド判定はしない）
 * - 未登録なら T3 で確認し、子スレッドは CHILD_THREAD（asWorkItem で登録可）。title がなければスレッド名を使う
 */
export async function addCard(deps: AppDeps, input: CardAddInput): Promise<Result<CardAddResult>> {
  const { store, t3, clock } = deps;
  const { threadId, title, asWorkItem, ...rest } = input;

  const existing = store.getCard(threadId);
  if (existing !== null) {
    let warning: T3Warning | null = null;
    if (t3.available()) {
      const shown = await t3.showThread(threadId);
      if (shown.kind === 'found') store.updateTracking([{ threadId, thread: shown.thread }]);
      else warning = shown.kind === 'missing' ? { reason: 'missing', message: `スレッド ${threadId} は T3 に存在しません` } : { reason: shown.reason, message: shown.message };
    }
    return ok({ card: store.getCard(threadId) ?? existing, created: false, t3Warning: warning });
  }

  let resolvedTitle = title;
  let warning: T3Warning | null = t3.available() ? null : { reason: 'unavailable', message: 'T3CODE_CLI_PATH が設定されていません' };
  let thread: T3Thread | null = null;
  if (t3.available()) {
    const shown = await t3.showThread(threadId);
    if (shown.kind === 'found') {
      const parentThreadId = shown.thread.parentThreadId ?? null;
      if (parentThreadId !== null && asWorkItem !== true) {
        const parent = store.getCard(parentThreadId);
        return fail(
          'CHILD_THREAD',
          `スレッド ${threadId} は ${parentThreadId} から委譲された子スレッドです。親カードのタスクとして扱います（独立した作業項目なら asWorkItem: true）`,
          { threadId, parentThreadId, parentCard: parent === null ? null : summarize(parent) },
        );
      }
      resolvedTitle ??= shown.thread.title ?? undefined;
      thread = shown.thread;
    } else if (shown.kind === 'missing') {
      warning = { reason: 'missing', message: `スレッド ${threadId} は T3 に存在しません` };
    } else {
      warning = { reason: shown.reason, message: `T3 からスレッドを取得できません: ${shown.message}` };
    }
  }
  if (resolvedTitle === undefined || resolvedTitle.trim() === '') {
    return fail('INVALID_ARGUMENT', `title を指定してください（T3 のスレッド名を使えません: ${warning?.message ?? 'スレッド名が空です'}）`, {
      threadId,
      ...(warning !== null ? { t3Reason: warning.reason } : {}),
    });
  }
  const result = store.addCard({
    threadId,
    title: resolvedTitle,
    ...rest,
    ...(thread !== null ? { t3: mergeTracking(null, thread, clock()) } : {}),
  });
  if (!result.ok) return result;
  // CLI がない環境で title を指定した通常の登録は警告にしない
  const t3Warning = t3.available() ? warning : null;
  return ok({ ...result.value, t3Warning });
}
