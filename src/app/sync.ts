import { detectDeviations, type Deviation, type UnknownThread } from '../domain/sync.js';
import { ok, type Result } from '../domain/types.js';
import { collectFromArgument, collectFromCli, type CollectOptions, type Collected } from '../t3/collect.js';
import type { AppDeps } from './card-add.js';

/** kanban_sync が返すずれの上限。超えた分は omittedDeviations に件数だけ返す。 */
export const MAX_REPORTED_DEVIATIONS = 200;

export interface SyncResult {
  deviations: Deviation[];
  omittedDeviations: number;
  unknown: UnknownThread[];
  updatedCards: number;
  source: Collected['source'];
  projectId: string | null;
  /** 形式が不正で捨てたスレッドの数（m5） */
  skippedThreads: number;
}

/**
 * kanban_sync の本体（D1）。ずれを判定し、追跡参照だけを更新する。列・ブロック・イベントは変えない。
 * threads があれば引数で、なければ T3 CLI で取得する。
 */
export async function syncBoard(
  deps: AppDeps,
  threads: readonly unknown[] | undefined,
  options: CollectOptions = {},
): Promise<Result<SyncResult>> {
  const { store, t3 } = deps;
  const { board, cards } = store.snapshot();
  let collected: Collected;
  if (threads !== undefined) {
    collected = collectFromArgument(threads, cards);
  } else {
    const r = await collectFromCli(t3, cards, options);
    if (!r.ok) return r;
    collected = r.value;
  }
  const analysis = detectDeviations({
    board,
    cards,
    projectThreads: collected.projectThreads,
    observations: collected.observations,
    callerThreadId: t3.currentThreadId(),
  });
  const updates = cards.flatMap((c) => {
    const obs = collected.observations.get(c.threadId);
    return obs?.kind === 'found' ? [{ threadId: c.threadId, thread: obs.thread }] : [];
  });
  // CLI を待つ間にサーバーが終了していたら書き込まない（S4）
  const updatedCards = store.isClosed() ? 0 : store.updateTracking(updates);
  return ok({
    // done に近い順に並んでいるので、上限を超えた分（主に unregistered）を件数だけ返す（N2）
    deviations: analysis.deviations.slice(0, MAX_REPORTED_DEVIATIONS),
    omittedDeviations: Math.max(0, analysis.deviations.length - MAX_REPORTED_DEVIATIONS),
    unknown: analysis.unknown,
    updatedCards,
    source: collected.source,
    projectId: collected.projectId,
    skippedThreads: collected.skippedThreads,
  });
}
