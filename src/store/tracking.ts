import * as z from 'zod/v4';
import type { SQLInputValue } from 'node:sqlite';
import type { T3Tracking } from '../domain/types.js';
import { cleanField, safeUrl } from '../t3/thread.js';

const trackingSchema = z.object({
  link: z.string().nullable(),
  projectId: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  pullRequests: z.array(
    z.object({ url: z.string(), state: z.string().optional(), number: z.number().optional() }),
  ),
  syncedAt: z.number(),
});

/** cards.t3 列の JSON を検証して読む。NULL・JSON でない・形が違う場合は null（S8: 例外で全ツールを落とさない）。 */
export function parseTracking(value: SQLInputValue | undefined): T3Tracking | null {
  if (typeof value !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return null;
  }
  const parsed = trackingSchema.safeParse(json);
  if (!parsed.success) return null;
  // 保存済みの値も出力前に正規化し直す（旧バージョンが保存した改行入りの値を出さない。N4）
  const d = parsed.data;
  const field = (v: string | null): string | null => (v === null ? null : cleanField(v));
  return {
    link: d.link === null ? null : safeUrl(d.link),
    projectId: field(d.projectId),
    parentThreadId: field(d.parentThreadId),
    branch: field(d.branch),
    worktreePath: field(d.worktreePath),
    pullRequests: d.pullRequests.flatMap((p) => {
      const url = safeUrl(p.url);
      if (url === null) return [];
      return [{ url, ...(p.state !== undefined ? { state: cleanField(p.state) } : {}), ...(p.number !== undefined ? { number: p.number } : {}) }];
    }),
    syncedAt: d.syncedAt,
  };
}
