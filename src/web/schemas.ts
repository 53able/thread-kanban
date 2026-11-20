// UI の POST の body のスキーマ。MCP の inputSchema（src/server.ts）と挙動をそろえる。
import * as z from 'zod/v4';
import { resolveThreadId } from '../app/thread-id.js';
import { ALL_COLUMNS, type Result } from '../domain/types.js';

/** to は ALL_COLUMNS で受け付ける（discarded はハンドラーで UI_DISCARD_NOT_ALLOWED にする）。reason に min(1) は付けない。 */
export const moveBodySchema = z.object({
  to: z.enum(ALL_COLUMNS),
  criteriaConfirmed: z.boolean().optional(),
  force: z.boolean().optional(),
  reason: z.string().optional(),
});

/** MCP と同じく min(1)、trim しない。 */
export const blockBodySchema = z.object({ reason: z.string().min(1) });

export const unblockBodySchema = z.object({ resolution: z.string().optional() });

/** boardId を付けると、DB ファイルやボードの行がまだなくても一覧に出す（basePath は表示名にだけ使う）。 */
export const registerDbBodySchema = z.object({
  path: z.string().min(1).max(4096),
  boardId: z.string().min(1).max(256).optional(),
  basePath: z.string().min(1).max(4096).optional(),
});

export const loginCodeBodySchema = z.object({});

/** パスの threadId を MCP の threadIdArg と同じく trim してから resolveThreadId に渡す。 */
export function threadIdFromPath(raw: string): Result<string> {
  const trimmed = raw.trim();
  return resolveThreadId(trimmed === '' ? undefined : trimmed, undefined);
}
