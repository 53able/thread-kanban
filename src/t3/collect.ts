import { LOOKUP_COLUMNS, type T3Thread, type ThreadObservation } from '../domain/sync.js';
import { fail, ok, type Card, type Result } from '../domain/types.js';
import { DEFAULT_CALL_TIMEOUT_MS, type T3Gateway } from './gateway.js';
import { normalizeThreads } from './thread.js';

/** sync 全体の打ち切り時間。応答の組み立てを含めて 20 秒以内に返すため 19 秒にする */
export const SYNC_TOTAL_TIMEOUT_MS = 19_000;
export const SYNC_CONCURRENCY = 4;

export interface Collected {
  source: 'cli' | 'argument';
  projectId: string | null;
  projectThreads: T3Thread[];
  observations: Map<string, ThreadObservation>;
  /** 形式が不正で捨てたスレッドの数（m5） */
  skippedThreads: number;
}

export interface CollectOptions {
  perCallTimeoutMs?: number;
  totalTimeoutMs?: number;
  concurrency?: number;
  now?: () => number;
}

/** 個別取得（thread show）の対象。done / discarded は個別取得しない（list に出たものだけ判定する）。 */
function needsShow(card: Card): boolean {
  return LOOKUP_COLUMNS.includes(card.column);
}

/**
 * T3 CLI でカードのスレッドを確認する（R4）。
 * 1. 呼び出し元スレッドを show して projectId を得る
 * 2. そのプロジェクトを list する
 * 3. list に出ない inbox〜review のカードだけ show する（同時 concurrency 本、1 本 perCallTimeoutMs、全体 totalTimeoutMs）
 * 打ち切ったもの・失敗したものは unknown。show が「存在しない」を返したものだけ missing。
 */
export async function collectFromCli(gateway: T3Gateway, cards: readonly Card[], options: CollectOptions = {}): Promise<Result<Collected>> {
  const now = options.now ?? Date.now;
  const perCall = options.perCallTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const deadline = now() + (options.totalTimeoutMs ?? SYNC_TOTAL_TIMEOUT_MS);
  const concurrency = Math.max(1, options.concurrency ?? SYNC_CONCURRENCY);
  const budget = (): number => Math.min(perCall, deadline - now());

  if (!gateway.available()) {
    return fail('T3_UNAVAILABLE', 'T3 CLI（T3CODE_CLI_PATH）がなく、threads 引数もありません', { reason: 'unavailable' });
  }
  const caller = gateway.currentThreadId();
  if (caller === null) {
    return fail('T3_UNAVAILABLE', 'T3CODE_THREAD_ID がないため T3 のプロジェクトを決められません。threads 引数を渡してください', {
      reason: 'no_current_thread',
    });
  }
  const self = await gateway.showThread(caller, { timeoutMs: budget() });
  if (self.kind !== 'found') {
    return fail('T3_UNAVAILABLE', `呼び出し元スレッド ${caller} を T3 から取得できません`, {
      reason: self.kind === 'missing' ? 'current_thread_missing' : self.reason,
      ...(self.kind === 'error' ? { error: self.message } : {}),
    });
  }
  const projectId = self.thread.projectId ?? null;
  if (projectId === null) {
    return fail('T3_UNAVAILABLE', `呼び出し元スレッド ${caller} の projectId が分かりません`, { reason: 'no_project' });
  }
  const remaining = budget();
  const list = remaining > 0 ? await gateway.listThreads(projectId, { timeoutMs: remaining }) : null;
  if (list === null || !list.ok) {
    return fail('T3_UNAVAILABLE', 'T3 のスレッド一覧を取得できません', {
      reason: list === null ? 'deadline' : list.reason,
      ...(list !== null && !list.ok ? { error: list.message } : {}),
    });
  }

  const observations = new Map<string, ThreadObservation>();
  for (const t of list.threads) observations.set(t.threadId, { kind: 'found', thread: t });
  if (!observations.has(caller)) observations.set(caller, { kind: 'found', thread: self.thread });

  const targets = cards.filter((c) => needsShow(c) && !observations.has(c.threadId)).map((c) => c.threadId);
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < targets.length) {
      const id = targets[index] as string;
      index += 1;
      const timeoutMs = budget();
      if (timeoutMs <= 0) {
        observations.set(id, { kind: 'unknown', reason: 'deadline' });
        continue;
      }
      const r = await gateway.showThread(id, { timeoutMs });
      if (r.kind === 'found') observations.set(id, { kind: 'found', thread: r.thread });
      else if (r.kind === 'missing') observations.set(id, { kind: 'missing' });
      else observations.set(id, { kind: 'unknown', reason: r.reason });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

  return ok({ source: 'cli', projectId, projectThreads: list.threads, observations, skippedThreads: list.skipped });
}

/**
 * 引数で渡されたスレッド（`t3_thread_list` の threads など）で確認する（R14）。
 * 引数にない inbox〜review のカードは個別取得できないため unknown にする。
 */
export function collectFromArgument(threads: readonly unknown[], cards: readonly Card[]): Collected {
  const { threads: normalized, skipped } = normalizeThreads(threads);
  const observations = new Map<string, ThreadObservation>();
  for (const t of normalized) observations.set(t.threadId, { kind: 'found', thread: t });
  for (const c of cards) {
    if (needsShow(c) && !observations.has(c.threadId)) {
      observations.set(c.threadId, { kind: 'unknown', reason: 'not_in_threads_argument' });
    }
  }
  return { source: 'argument', projectId: null, projectThreads: normalized, observations, skippedThreads: skipped };
}
