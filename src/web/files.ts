// ~/.t3-kanban に置く UI 用のファイル（トークンと登録済み DB の一覧）。
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { kanbanDir } from './discovery.js';

export type Warn = (message: string) => void;

const TOKEN_FILE = 'ui-token';
const DBS_FILE = 'ui-dbs.json';

/** ~/.t3-kanban を作り、権限を 0700 にする（緩ければ直す）。 */
export function ensureKanbanDir(homeDir: string, warn: Warn = () => {}): string {
  const dir = kanbanDir(homeDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const mode = statSync(dir).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warn(`${dir} の権限が緩いため 0700 に変更します（${mode.toString(8)}）`);
      chmodSync(dir, 0o700);
    }
  }
  return dir;
}

/** 権限が 0600 より緩いファイルを警告して直す。 */
function tightenFile(path: string, warn: Warn): void {
  if (process.platform === 'win32') return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    warn(`${path} の権限が緩いため 0600 に変更します（${mode.toString(8)}）`);
    chmodSync(path, 0o600);
  }
}

function isLoose(path: string): boolean {
  if (process.platform === 'win32') return false;
  return (statSync(path).mode & 0o077) !== 0;
}

export function tokenPath(homeDir: string): string {
  return join(kanbanDir(homeDir), TOKEN_FILE);
}

function createToken(path: string): string | null {
  const token = randomBytes(32).toString('base64url');
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw e;
  }
  try {
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  return token;
}

/** 保存済みのトークンを返す。なければ作る（'wx' と 0600）。rotate か、権限が 0600 より緩ければ作り直す。 */
export function loadOrCreateToken(homeDir: string, options: { rotate?: boolean; warn?: Warn } = {}): string {
  const warn = options.warn ?? (() => {});
  ensureKanbanDir(homeDir, warn);
  const path = tokenPath(homeDir);
  if (options.rotate === true && existsSync(path)) unlinkSync(path);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!existsSync(path)) {
      const created = createToken(path);
      if (created !== null) return created;
    }
    if (isLoose(path)) {
      // 権限が緩い間に他のユーザーに読まれた可能性があるので、直すだけでなく作り直す
      warn(`${path} の権限が 0600 より緩いため、トークンを作り直します（開いているタブは新しい URL で開き直してください）`);
      unlinkSync(path);
      continue;
    }
    const token = readFileSync(path, 'utf8').trim();
    if (/^[A-Za-z0-9_-]{16,}$/.test(token)) return token;
    warn(`${path} の内容が不正なため作り直します`);
    unlinkSync(path);
  }
  throw new Error(`トークンを作成できません: ${path}`);
}

export function dbsPath(homeDir: string): string {
  return join(kanbanDir(homeDir), DBS_FILE);
}

/** 登録済み DB の一覧（正規化済みの絶対パス）。壊れていれば警告して空にする。 */
export function loadRegisteredDbs(homeDir: string, warn: Warn = () => {}): string[] {
  const path = dbsPath(homeDir);
  if (!existsSync(path)) return [];
  tightenFile(path, warn);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) return parsed as string[];
  } catch {
    // 下で警告する
  }
  warn(`${path} を読み取れないため無視します`);
  return [];
}

export function saveRegisteredDbs(homeDir: string, dbs: readonly string[], warn: Warn = () => {}): void {
  ensureKanbanDir(homeDir, warn);
  const path = dbsPath(homeDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(dbs, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
