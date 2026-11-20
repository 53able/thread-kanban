import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface LocationInput {
  env: Record<string, string | undefined>;
  cwd: string;
  homeDir?: string;
}

export interface Location {
  boardId: string;
  dbPath: string;
  /** boardId をどこから決めたか */
  boardIdSource: 'KANBAN_BOARD_ID' | 'git-common-dir' | 'cwd';
  /** boardId の元になったパス（git common dir または cwd）。KANBAN_BOARD_ID 指定時は null */
  basePath: string | null;
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** `git rev-parse --git-common-dir` の絶対パス。git リポジトリでなければ null。 */
export function gitCommonDir(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out === '') return null;
    return safeRealpath(isAbsolute(out) ? out : resolve(cwd, out));
  } catch {
    return null;
  }
}

function hashId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * ボード ID と DB パスを解決する。
 * - boardId: KANBAN_BOARD_ID → git common dir（worktree 間で共通）の絶対パスのハッシュ → cwd のハッシュ
 * - dbPath: KANBAN_DB_PATH → ~/.t3-kanban/<boardId>.db
 */
export function resolveLocation(input: LocationInput): Location {
  const { env, cwd } = input;
  let boardId: string;
  let boardIdSource: Location['boardIdSource'];
  let basePath: string | null = null;

  const explicit = env.KANBAN_BOARD_ID?.trim();
  if (explicit !== undefined && explicit !== '') {
    boardId = sanitize(explicit);
    boardIdSource = 'KANBAN_BOARD_ID';
  } else {
    const common = gitCommonDir(cwd);
    if (common !== null) {
      basePath = common;
      boardIdSource = 'git-common-dir';
    } else {
      basePath = safeRealpath(cwd);
      boardIdSource = 'cwd';
    }
    boardId = hashId(basePath);
  }

  const dbOverride = env.KANBAN_DB_PATH?.trim();
  const dbPath =
    dbOverride !== undefined && dbOverride !== ''
      ? resolve(cwd, dbOverride)
      : join(input.homeDir ?? homedir(), '.t3-kanban', `${boardId}.db`);

  return { boardId, dbPath, boardIdSource, basePath };
}
