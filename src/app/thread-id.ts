import { fail, isValidThreadId, type Result } from '../domain/types.js';

/**
 * threadId の解決と検証（MCP と UI で共通）。
 * 省略時は defaultThreadId を使い、どちらもなければ THREAD_ID_REQUIRED、形式が不正なら INVALID_ARGUMENT（details.threadId）。
 */
export function resolveThreadId(threadId: string | undefined, defaultThreadId: string | undefined): Result<string> {
  const id = threadId ?? defaultThreadId;
  if (id === undefined || id === '') {
    return fail(
      'THREAD_ID_REQUIRED',
      'threadId を指定してください（または環境変数 KANBAN_THREAD_ID / T3CODE_THREAD_ID を設定してください）',
    );
  }
  if (!isValidThreadId(id)) {
    return fail('INVALID_ARGUMENT', 'threadId は英数字で始まり、英数字と . _ : - だけの 128 文字以内にしてください', {
      threadId: id.slice(0, 200),
    });
  }
  return { ok: true, value: id };
}
