import type { T3Thread } from '../domain/sync.js';

/** CLI 呼び出し 1 本のタイムアウトの既定値（ミリ秒） */
export const DEFAULT_CALL_TIMEOUT_MS = 5_000;

export type T3FailureReason =
  | 'timeout'
  | 'invalid_output'
  | 'invalid_argument'
  | 'exit'
  | 'spawn'
  | 'output_too_large'
  | 'unavailable';

export interface T3Failure {
  reason: T3FailureReason;
  message: string;
}

export type ShowResult = { kind: 'found'; thread: T3Thread } | { kind: 'missing' } | ({ kind: 'error' } & T3Failure);
/** skipped: 形式が不正で捨てた要素の数 */
export type ListResult = { ok: true; threads: T3Thread[]; skipped: number } | ({ ok: false } & T3Failure);

export interface CallOptions {
  /** この呼び出しのタイムアウト（ミリ秒）。同時実行の上限による待ち時間を含む */
  timeoutMs?: number;
}

/** T3 Code への読み取り専用の窓口。失敗は例外ではなく結果型で返す。 */
export interface T3Gateway {
  /** T3 から読み取れるか（CLI のパスが設定されているか） */
  available(): boolean;
  /** 呼び出し元スレッドの ID（T3CODE_THREAD_ID）。なければ null */
  currentThreadId(): string | null;
  showThread(threadId: string, options?: CallOptions): Promise<ShowResult>;
  listThreads(projectId: string, options?: CallOptions): Promise<ListResult>;
  /** 実行中の CLI プロセスを全て終了させ、以後は呼び出さない */
  shutdown(): void;
}

/** T3 を使わない（CLI のパスがない）ときのゲートウェイ。 */
export function unavailableGateway(currentThreadId: string | null = null, message = 'T3CODE_CLI_PATH が設定されていません'): T3Gateway {
  const failure: T3Failure = { reason: 'unavailable', message };
  return {
    available: () => false,
    currentThreadId: () => currentThreadId,
    showThread: async () => ({ kind: 'error', ...failure }),
    listThreads: async () => ({ ok: false, ...failure }),
    shutdown: () => {},
  };
}
