import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KanbanReader, KanbanStore } from '../../src/store/sqlite.js';
import { manualClock, tempDir } from '../helpers/fixtures.js';

let dir: ReturnType<typeof tempDir>;
let path: string;
beforeEach(() => {
  dir = tempDir('kanban-reader-');
  path = join(dir.path, 'k.db');
});
afterEach(() => dir.cleanup());

function openStore(boardId = 'b1'): KanbanStore {
  return KanbanStore.open({ path, boardId, clock: manualClock() });
}

function seed(boardId = 'b1', threads = ['a', 'b']): void {
  const store = openStore(boardId);
  try {
    for (const t of threads) store.addCard({ threadId: t, title: `${boardId}:${t}` });
    store.moveCard(threads[0] as string, { to: 'ready' });
  } finally {
    store.close();
  }
}

function fileState(p: string): { mtimeMs: number; size: number } | null {
  if (!existsSync(p)) return null;
  const s = statSync(p);
  return { mtimeMs: s.mtimeMs, size: s.size };
}

function exerciseReader(): void {
  const reader = KanbanReader.open({ path, boardId: 'b1', busyTimeoutMs: 500 });
  try {
    expect(reader.snapshot()?.cards.length).toBeGreaterThan(0);
    reader.listCardEvents('a');
    reader.listEventsSince(0, 10);
    reader.maxEventId();
    reader.readSince(0, 10);
    reader.dataVersion();
  } finally {
    reader.close();
  }
}

/** v2 の DB（boards.base_path なし） */
const V2_BOARDS_SQL = `
CREATE TABLE boards (id TEXT PRIMARY KEY, stale_days INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE columns (board_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, wip_limit INTEGER,
  entry_criteria TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (board_id, name));
CREATE TABLE cards (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, thread_id TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT, type TEXT NOT NULL, service_class TEXT NOT NULL, due_date TEXT, size TEXT,
  external_refs TEXT NOT NULL DEFAULT '[]', t3 TEXT, column_name TEXT NOT NULL, column_entered_at INTEGER NOT NULL,
  blocked_reason TEXT, blocked_since INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL, UNIQUE (board_id, thread_id));
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL, card_id INTEGER, type TEXT NOT NULL,
  from_column TEXT, to_column TEXT, at INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}');
INSERT INTO boards VALUES ('v2board', 3, 1);
INSERT INTO columns VALUES ('v2board', 'inbox', 0, NULL, '[]'), ('v2board', 'ready', 1, 5, '[]'), ('v2board', 'doing', 2, 3, '[]'),
  ('v2board', 'review', 3, 2, '[]'), ('v2board', 'done', 4, NULL, '[]');
INSERT INTO cards (board_id, thread_id, title, type, service_class, column_name, column_entered_at, created_at, updated_at, last_event_at)
  VALUES ('v2board', 'old', '既存', 'feature', 'regular', 'doing', 1, 1, 1, 1);
INSERT INTO events (board_id, card_id, type, at) VALUES ('v2board', 1, 'created', 1);
PRAGMA user_version = 2;
`;

describe('KanbanReader: 書き込まないこと（受け入れ基準 9・10）', () => {
  it('open → 読み取り → close の前後で DB 本体の mtime とサイズが変わらず、-wal にフレームが増えない', () => {
    seed();
    const before = fileState(path);
    const walBefore = fileState(`${path}-wal`);
    exerciseReader();
    expect(fileState(path)).toEqual(before);
    const walAfter = fileState(`${path}-wal`);
    // 空の -wal が作られるのは許容する
    expect(walAfter === null || walAfter.size === (walBefore?.size ?? 0)).toBe(true);
  });

  it('別の接続が開いたまま（-wal にフレームがある）でも、読み取りで -wal も本体も変わらない', () => {
    seed();
    const writer = openStore();
    try {
      writer.addCard({ threadId: 'c', title: 'c' });
      const before = fileState(path);
      const walBefore = fileState(`${path}-wal`);
      expect(walBefore?.size ?? 0).toBeGreaterThan(0);
      exerciseReader();
      expect(fileState(path)).toEqual(before);
      expect(fileState(`${path}-wal`)?.size).toBe(walBefore?.size);
    } finally {
      writer.close();
    }
  });

  it('v2 の DB を開いても移行しない（base_path 列を足さず、user_version も変えない）', () => {
    const raw = new DatabaseSync(path);
    raw.exec(V2_BOARDS_SQL);
    raw.close();
    const before = fileState(path);
    const reader = KanbanReader.open({ path, boardId: 'v2board' });
    try {
      expect(reader.snapshot()?.cards.map((c) => c.threadId)).toEqual(['old']);
      expect(reader.maxEventId()).toBe(1);
    } finally {
      reader.close();
    }
    expect(fileState(path)).toEqual(before);
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      const cols = (check.prepare('PRAGMA table_info(boards)').all() as { name: string }[]).map((r) => r.name);
      expect(cols).not.toContain('base_path');
      expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    } finally {
      check.close();
    }
  });

  it('ボードの行がない・スキーマがない DB では snapshot が null で、ボードの行を作らない', () => {
    seed('other');
    const reader = KanbanReader.open({ path, boardId: 'b1' });
    try {
      expect(reader.snapshot()).toBeNull();
      expect(reader.readSince(0, 10)).toEqual({ snapshot: null, events: [], truncated: false, maxEventId: 0 });
    } finally {
      reader.close();
    }
    expect(KanbanReader.listBoards(path).map((b) => b.boardId)).toEqual(['other']);

    const empty = join(dir.path, 'empty.db');
    new DatabaseSync(empty).close();
    const r2 = KanbanReader.open({ path: empty, boardId: 'b1' });
    try {
      expect(r2.snapshot()).toBeNull();
      expect(r2.listEventsSince(0, 10)).toEqual({ events: [], truncated: false });
      expect(r2.listCardEvents('a')).toEqual([]);
      expect(r2.maxEventId()).toBe(0);
    } finally {
      r2.close();
    }
  });

  it('ファイルがなければ open は例外で、ファイルを作らない', () => {
    const missing = join(dir.path, 'missing.db');
    expect(() => KanbanReader.open({ path: missing, boardId: 'b1' })).toThrow();
    expect(existsSync(missing)).toBe(false);
  });

  it('close は 2 回呼んでもよく、close 後の読み取りは例外', () => {
    seed();
    const reader = KanbanReader.open({ path, boardId: 'b1' });
    reader.close();
    reader.close();
    expect(reader.isClosed()).toBe(true);
    expect(() => reader.snapshot()).toThrow();
    expect(() => reader.dataVersion()).toThrow();
  });
});

describe('KanbanReader.listBoards', () => {
  it('v2 の DB は basePath: null で一覧に出し、v3 の DB は base_path を返す', () => {
    const raw = new DatabaseSync(path);
    raw.exec(V2_BOARDS_SQL);
    raw.close();
    expect(KanbanReader.listBoards(path)).toEqual([{ boardId: 'v2board', basePath: null }]);

    const v3 = join(dir.path, 'v3.db');
    const store = KanbanStore.open({ path: v3, boardId: 'b3', clock: manualClock() });
    store.setBasePath('/repo/.git');
    store.close();
    expect(KanbanReader.listBoards(v3)).toEqual([{ boardId: 'b3', basePath: '/repo/.git' }]);
  });

  it('1 つの DB に 2 つのボードがあれば 2 件返す', () => {
    seed('b1');
    seed('b2');
    expect(KanbanReader.listBoards(path).map((b) => b.boardId).sort()).toEqual(['b1', 'b2']);
  });

  it('boards テーブルがない DB・SQLite でないファイル・存在しないファイルは空配列で、書き込まない', () => {
    const noBoards = join(dir.path, 'other.db');
    const raw = new DatabaseSync(noBoards);
    raw.exec('CREATE TABLE t (x)');
    raw.close();
    const before = fileState(noBoards);
    expect(KanbanReader.listBoards(noBoards)).toEqual([]);
    expect(fileState(noBoards)).toEqual(before);

    const text = join(dir.path, 'text.db');
    writeFileSync(text, 'not a database at all, just some text padding padding padding padding padding padding');
    expect(KanbanReader.listBoards(text)).toEqual([]);

    expect(KanbanReader.listBoards(join(dir.path, 'missing.db'))).toEqual([]);
    expect(existsSync(join(dir.path, 'missing.db'))).toBe(false);
  });
});

describe('KanbanReader: 読み取り', () => {
  it('複数ボードの DB で、自分のボードのカードとイベントだけを返す', () => {
    seed('b1', ['a', 'b']);
    seed('b2', ['a', 'x', 'y']);
    const r1 = KanbanReader.open({ path, boardId: 'b1' });
    const r2 = KanbanReader.open({ path, boardId: 'b2' });
    try {
      expect(r1.snapshot()?.cards.map((c) => c.title)).toEqual(['b1:a', 'b1:b']);
      expect(r2.snapshot()?.cards.map((c) => c.title)).toEqual(['b2:a', 'b2:x', 'b2:y']);
      expect(r1.snapshot()?.board.id).toBe('b1');
      const e1 = r1.listEventsSince(0, 100).events;
      const e2 = r2.listEventsSince(0, 100).events;
      expect(e1.every((e) => e.boardId === 'b1')).toBe(true);
      expect(e2.every((e) => e.boardId === 'b2')).toBe(true);
      // b1: created+moved ×2 + moved(ready) = 5、b2: 3 枚 ×2 + 1 = 7
      expect(e1).toHaveLength(5);
      expect(e2).toHaveLength(7);
      expect(r1.maxEventId()).toBe(e1.at(-1)?.id);
      expect(r2.maxEventId()).toBe(e2.at(-1)?.id);
      // 同じ threadId でもボードごとに別のカード
      expect(r1.listCardEvents('a').map((e) => e.type)).toEqual(['created', 'moved', 'moved']);
      expect(r2.listCardEvents('a').map((e) => e.type)).toEqual(['created', 'moved', 'moved']);
      expect(r1.listCardEvents('a').every((e) => e.boardId === 'b1')).toBe(true);
      expect(r1.listCardEvents('x')).toEqual([]);
    } finally {
      r1.close();
      r2.close();
    }
  });

  it('listCardEvents は id 昇順で、actor も data に入っている', () => {
    seed();
    const store = openStore();
    store.blockCard('b', '待ち', { actor: 'ui' });
    store.unblockCard('b', undefined, { actor: 'ui' });
    store.close();
    const reader = KanbanReader.open({ path, boardId: 'b1' });
    try {
      const events = reader.listCardEvents('b');
      expect(events.map((e) => e.type)).toEqual(['created', 'moved', 'blocked', 'unblocked']);
      expect(events.map((e) => e.id)).toEqual([...events.map((e) => e.id)].sort((x, y) => x - y));
      expect(events.at(-1)?.data.actor).toBe('ui');
    } finally {
      reader.close();
    }
  });

  it('listEventsSince は上限を超えると truncated: true で、先頭から limit 件を返す', () => {
    seed('b1', ['a', 'b', 'c']); // 7 件
    const reader = KanbanReader.open({ path, boardId: 'b1' });
    try {
      const all = reader.listEventsSince(0, 100);
      expect(all.truncated).toBe(false);
      expect(all.events).toHaveLength(7);
      const ids = all.events.map((e) => e.id);

      expect(reader.listEventsSince(0, 7)).toMatchObject({ truncated: false });
      const cut = reader.listEventsSince(0, 3);
      expect(cut.truncated).toBe(true);
      expect(cut.events.map((e) => e.id)).toEqual(ids.slice(0, 3));

      const tail = reader.listEventsSince(ids[4] as number, 3);
      expect(tail).toMatchObject({ truncated: false });
      expect(tail.events.map((e) => e.id)).toEqual(ids.slice(5));
      expect(reader.listEventsSince(ids.at(-1) as number, 3)).toEqual({ events: [], truncated: false });
    } finally {
      reader.close();
    }
  });

  it('readSince は snapshot・新しいイベント・最大 id を同じトランザクションで返す', () => {
    seed();
    const reader = KanbanReader.open({ path, boardId: 'b1' });
    try {
      const first = reader.readSince(0, 100);
      expect(first.snapshot?.cards).toHaveLength(2);
      expect(first.maxEventId).toBe(first.events.at(-1)?.id);
      expect(first.truncated).toBe(false);

      const store = openStore();
      store.moveCard('a', { to: 'doing' });
      store.close();

      const next = reader.readSince(first.maxEventId, 100);
      expect(next.events.map((e) => [e.type, e.toColumn])).toEqual([['moved', 'doing']]);
      expect(next.maxEventId).toBe(next.events[0]?.id);
      expect(next.snapshot?.cards.find((c) => c.threadId === 'a')?.column).toBe('doing');

      const truncated = reader.readSince(0, 2);
      expect(truncated.truncated).toBe(true);
      expect(truncated.maxEventId).toBe(next.maxEventId);
    } finally {
      reader.close();
    }
  });
});

describe('KanbanReader.dataVersion', () => {
  it('別の接続（素の DatabaseSync）が書き込むと値が変わり、読み取りだけでは変わらない', () => {
    seed();
    const reader = KanbanReader.open({ path, boardId: 'b1' });
    try {
      const v0 = reader.dataVersion();
      reader.snapshot();
      expect(reader.dataVersion()).toBe(v0);
      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE cards SET title = 'changed' WHERE thread_id = 'a'").run();
      raw.close();
      const v1 = reader.dataVersion();
      expect(v1).not.toBe(v0);
      expect(reader.snapshot()?.cards.find((c) => c.threadId === 'a')?.title).toBe('changed');
    } finally {
      reader.close();
    }
  });

  it('別の KanbanStore の接続で書き込んでも値が変わる', () => {
    seed();
    const store = openStore();
    const reader = KanbanReader.open({ path, boardId: 'b1' });
    try {
      const v0 = reader.dataVersion();
      store.moveCard('b', { to: 'ready' });
      const v1 = reader.dataVersion();
      expect(v1).not.toBe(v0);
      store.blockCard('a', '待ち');
      expect(reader.dataVersion()).not.toBe(v1);
      expect(reader.snapshot()?.cards.find((c) => c.threadId === 'a')?.blocked?.reason).toBe('待ち');
    } finally {
      reader.close();
      store.close();
    }
  });
});
