// ボードの走査（読み取り専用）。~/.t3-kanban/*.db と登録された DB を開き、ボードごとに 1 件の BoardSummary を返す。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { KanbanReader } from '../store/sqlite.js';
import type { BoardKey, BoardSummary } from './types.js';

/** 走査の対象のディレクトリ（~/.t3-kanban） */
export function kanbanDir(homeDir: string): string {
  return join(homeDir, '.t3-kanban');
}

/**
 * DB のパスを `realpath(dirname(p)) + '/' + basename(p)` に正規化する。
 * ファイルがまだなくてもキーが変わらないように、先に dirname を作ってから realpath を通す（KanbanStore.open と同じ扱い）。
 * create: false ならディレクトリを作らない（なければ realpathSync が例外を投げる）。HTTP 経由の登録はこちら。
 */
export function normalizeDbPath(p: string, create = true): string {
  const abs = resolve(p);
  const dir = dirname(abs);
  if (create) mkdirSync(dir, { recursive: true });
  return join(realpathSync(dir), basename(abs));
}

export function boardKey(normalizedDbPath: string, boardId: string): BoardKey {
  return createHash('sha256').update(`${normalizedDbPath}\0${boardId}`).digest('hex').slice(0, 16);
}

/** 表示名: basename が .git なら親ディレクトリの名前、そうでなければ basename、base_path がなければ boardId。 */
export function boardLabel(basePath: string | null, boardId: string): string {
  if (basePath === null || basePath === '') return boardId;
  const name = basename(basePath);
  if (name === '.git') return basename(dirname(basePath)) || boardId;
  return name || boardId;
}

/** 既定のボード（CLI を起動したディレクトリのボード）。DB ファイルがまだなくても一覧に出す。 */
export interface DefaultBoard {
  dbPath: string;
  boardId: string;
  basePath: string | null;
}

export interface DiscoveryInput {
  homeDir: string;
  /** 登録済みの DB（正規化済み） */
  registered: readonly string[];
  defaultBoard?: DefaultBoard | undefined;
  /** POST /api/dbs で boardId 付きで登録された、まだないかもしれないボード（dbPath は正規化済み） */
  pending?: readonly DefaultBoard[];
}

export interface DiscoveryResult {
  boards: BoardSummary[];
  defaultKey: BoardKey | null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** ~/.t3-kanban 直下の「.db」で終わるファイル（-wal / -shm などは名前で除外される）。 */
function scanDir(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.db'))
    .map((n) => join(dir, n))
    .filter(isFile);
}

export function discoverBoards(input: DiscoveryInput): DiscoveryResult {
  const dir = kanbanDir(input.homeDir);
  const paths = new Set<string>();
  for (const p of scanDir(dir)) paths.add(normalizeDbPath(p));
  for (const p of input.registered) paths.add(p);

  const boards: BoardSummary[] = [];
  const seen = new Set<BoardKey>();
  for (const dbPath of [...paths].sort()) {
    if (!isFile(dbPath)) continue;
    for (const b of KanbanReader.listBoards(dbPath)) {
      const key = boardKey(dbPath, b.boardId);
      if (seen.has(key)) continue;
      seen.add(key);
      boards.push({ key, boardId: b.boardId, label: boardLabel(b.basePath, b.boardId), dbPath, exists: true });
    }
  }

  let defaultKey: BoardKey | null = null;
  if (input.defaultBoard !== undefined) {
    const d = input.defaultBoard;
    const dbPath = normalizeDbPath(d.dbPath);
    defaultKey = boardKey(dbPath, d.boardId);
    if (!seen.has(defaultKey)) {
      boards.push({ key: defaultKey, boardId: d.boardId, label: boardLabel(d.basePath, d.boardId), dbPath, exists: false });
    }
  }
  for (const p of input.pending ?? []) {
    const key = boardKey(p.dbPath, p.boardId);
    if (seen.has(key) || key === defaultKey) continue;
    seen.add(key);
    boards.push({ key, boardId: p.boardId, label: boardLabel(p.basePath, p.boardId), dbPath: p.dbPath, exists: false });
  }
  return { boards, defaultKey };
}

/** DB ファイルがあるか（Reader を開く前の確認） */
export function dbFileExists(p: string): boolean {
  return existsSync(p) && isFile(p);
}
