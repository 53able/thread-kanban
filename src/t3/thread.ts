import * as z from 'zod/v4';
import type { T3Thread } from '../domain/sync.js';
import { THREAD_ID_PATTERN, type T3PullRequest } from '../domain/types.js';

/** kanban_sync の threads 引数の件数上限（S1） */
export const MAX_THREADS_ARGUMENT = 500;
/** threads 引数の各要素の pullRequests の件数上限（S1） */
export const MAX_RAW_PULL_REQUESTS = 1000;
/** 正規化後に残す PR の件数（S1） */
export const MAX_PULL_REQUESTS = 50;
export const MAX_TITLE_LENGTH = 200;
export const MAX_FIELD_LENGTH = 512;
export const MAX_URL_LENGTH = 2048;

/**
 * T3 のスレッド 1 件（`thread list` の要素、`thread show` の thread、`t3_thread_list` ツールの threads 要素）。
 * threadId だけ必須（S2 の形式）。未知のキーは受け付けて無視する。
 */
export const rawThreadSchema = z.looseObject({
  threadId: z.string().regex(THREAD_ID_PATTERN),
  projectId: z.string().nullish(),
  title: z.string().nullish(),
  link: z.string().nullish(),
  status: z.string().nullish(),
  settled: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  snoozed: z.boolean().nullish(),
  pendingRequestCount: z.number().nullish(),
  blockedOnThreadWait: z.boolean().nullish(),
  parentThreadId: z.string().nullish(),
  branch: z.string().nullish(),
  worktreePath: z.string().nullish(),
  pullRequests: z.array(z.unknown()).nullish(),
  linkedPullRequest: z.unknown().optional(),
});
export type RawThread = z.infer<typeof rawThreadSchema>;

/**
 * kanban_sync の threads 引数。要素の形式違反は引数エラーにせず、正規化の段階で捨てて件数を返す（m5）。
 * 件数と pullRequests の長さだけはここで制限する（S1）。
 */
export const threadsArgumentSchema = z
  .array(
    z.looseObject({
      threadId: z.string().min(1).max(256),
      pullRequests: z.array(z.unknown()).max(MAX_RAW_PULL_REQUESTS).nullish(),
    }),
  )
  .max(MAX_THREADS_ARGUMENT);

export const showOutputSchema = z.looseObject({ thread: rawThreadSchema });

// 制御文字・改行・U+2028/U+2029（S3）
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** title: 制御文字を空白にして切り詰める。 */
export function cleanTitle(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').slice(0, MAX_TITLE_LENGTH);
}

/** branch / worktreePath / status / ID: 制御文字を除いて切り詰める。 */
export function cleanField(value: string): string {
  return value.replace(CONTROL_CHARS, '').slice(0, MAX_FIELD_LENGTH);
}

/** URL パーサが黙って取り除く空白・制御文字・双方向制御文字。含む URL は拒否する（N1）。 */
const URL_FORBIDDEN = /[\u0000-\u0020\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** http: / https: の URL だけ許可し、正規化した href を返す。空白・制御文字を含むもの、長すぎるものは null。 */
export function safeUrl(value: string): string | null {
  if (value.length > MAX_URL_LENGTH || URL_FORBIDDEN.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href.length > MAX_URL_LENGTH ? null : url.href;
  } catch {
    return null;
  }
}

function toPullRequest(value: unknown): T3PullRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const url = typeof v.url === 'string' ? safeUrl(v.url) : null;
  if (url === null) return null;
  const pr: T3PullRequest = { url };
  if (typeof v.state === 'string') pr.state = cleanField(v.state);
  if (typeof v.number === 'number') pr.number = v.number;
  return pr;
}

/** `url`（http/https）を持つ要素だけを PR として、重複を除いて先頭 MAX_PULL_REQUESTS 件まで使う。 */
function normalizePullRequests(raw: RawThread): T3PullRequest[] | undefined {
  const hasList = raw.pullRequests !== undefined && raw.pullRequests !== null;
  if (!hasList && !('linkedPullRequest' in raw)) return undefined;
  const out: T3PullRequest[] = [];
  const seen = new Set<string>();
  for (const v of [...(raw.pullRequests ?? []), raw.linkedPullRequest]) {
    if (out.length >= MAX_PULL_REQUESTS) break;
    const pr = toPullRequest(v);
    if (pr === null || seen.has(pr.url)) continue;
    seen.add(pr.url);
    out.push(pr);
  }
  return out;
}

/** undefined（取得元になかった）はそのまま、null は null、文字列は clean を通す。 */
function mapText(value: string | null | undefined, clean: (v: string) => string | null): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : clean(value);
}

/** 生のスレッドを T3Thread に正規化する。取得元にないキーは undefined のまま残す（不明を表す）。 */
export function normalizeThread(raw: RawThread): T3Thread {
  const fields: [keyof T3Thread, unknown][] = [
    ['projectId', mapText(raw.projectId, cleanField)],
    ['title', mapText(raw.title, cleanTitle)],
    ['link', mapText(raw.link, safeUrl)],
    ['status', mapText(raw.status, cleanField)],
    ['settled', raw.settled],
    ['archived', raw.archived],
    ['snoozed', raw.snoozed],
    ['pendingRequestCount', raw.pendingRequestCount],
    ['blockedOnThreadWait', raw.blockedOnThreadWait],
    ['parentThreadId', mapText(raw.parentThreadId, cleanField)],
    ['branch', mapText(raw.branch, cleanField)],
    ['worktreePath', mapText(raw.worktreePath, cleanField)],
    ['pullRequests', normalizePullRequests(raw)],
  ];
  const thread: T3Thread = { threadId: raw.threadId };
  for (const [key, value] of fields) {
    if (value !== undefined) Object.assign(thread, { [key]: value });
  }
  return thread;
}

/** 要素ごとに検証し、不正な要素は捨てて件数を返す（m5）。 */
export function normalizeThreads(values: readonly unknown[]): { threads: T3Thread[]; skipped: number } {
  const threads: T3Thread[] = [];
  let skipped = 0;
  for (const v of values) {
    const parsed = rawThreadSchema.safeParse(v);
    if (parsed.success) threads.push(normalizeThread(parsed.data));
    else skipped += 1;
  }
  return { threads, skipped };
}
