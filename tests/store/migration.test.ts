import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/store/schema.js';
import { KanbanStore } from '../../src/store/sqlite.js';
import { T0, manualClock, tempDir } from '../helpers/fixtures.js';

/** SCHEMA_VERSION 1 の cards（t3 列なし）。他のテーブルは v1 と v2 で同じ。 */
const V1_SQL = `
CREATE TABLE boards (id TEXT PRIMARY KEY, stale_days INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE columns (
  board_id TEXT NOT NULL REFERENCES boards(id), name TEXT NOT NULL, position INTEGER NOT NULL,
  wip_limit INTEGER, entry_criteria TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (board_id, name));
CREATE TABLE cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL REFERENCES boards(id), thread_id TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT, type TEXT NOT NULL, service_class TEXT NOT NULL, due_date TEXT, size TEXT,
  external_refs TEXT NOT NULL DEFAULT '[]', column_name TEXT NOT NULL, column_entered_at INTEGER NOT NULL,
  blocked_reason TEXT, blocked_since INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL, UNIQUE (board_id, thread_id));
CREATE INDEX cards_board_column ON cards (board_id, column_name);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, board_id TEXT NOT NULL REFERENCES boards(id), card_id INTEGER REFERENCES cards(id),
  type TEXT NOT NULL, from_column TEXT, to_column TEXT, at INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}');
CREATE INDEX events_board_at ON events (board_id, at);
INSERT INTO boards VALUES ('b1', 3, ${T0});
INSERT INTO columns VALUES ('b1', 'inbox', 0, NULL, '[]'), ('b1', 'ready', 1, 5, '[]'), ('b1', 'doing', 2, 4, '[]'),
  ('b1', 'review', 3, 2, '[]'), ('b1', 'done', 4, NULL, '[]');
INSERT INTO cards (board_id, thread_id, title, type, service_class, column_name, column_entered_at, created_at, updated_at, last_event_at)
  VALUES ('b1', 'old-thread', '既存カード', 'feature', 'regular', 'doing', ${T0}, ${T0}, ${T0}, ${T0});
INSERT INTO events (board_id, card_id, type, at) VALUES ('b1', 1, 'created', ${T0});
PRAGMA user_version = 1;
`;

let dir: ReturnType<typeof tempDir>;
let path: string;
beforeEach(() => {
  dir = tempDir('kanban-mig-');
  path = join(dir.path, 'k.db');
});
afterEach(() => dir.cleanup());

function inspect(): { columns: string[]; userVersion: number } {
  const db = new DatabaseSync(path);
  try {
    const columns = (db.prepare('PRAGMA table_info(cards)').all() as { name: string }[]).map((r) => r.name);
    const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    return { columns, userVersion };
  } finally {
    db.close();
  }
}

function open(): KanbanStore {
  return KanbanStore.open({ path, boardId: 'b1', clock: manualClock() });
}

describe('スキーマ移行（R7、受け入れ基準 11）', () => {
  it('v1 の DB を開くと t3 列が追加され、既存カード・設定・イベントが残る', () => {
    const raw = new DatabaseSync(path);
    raw.exec(V1_SQL);
    raw.close();
    expect(inspect().columns).not.toContain('t3');

    const store = open();
    try {
      const card = store.getCard('old-thread');
      expect(card).toMatchObject({ title: '既存カード', column: 'doing', t3: null });
      expect(store.getBoardConfig().columns.find((c) => c.name === 'doing')?.wipLimit).toBe(4);
      expect(store.listEvents()).toHaveLength(1);
    } finally {
      store.close();
    }
    expect(inspect()).toEqual({ columns: expect.arrayContaining(['t3']), userVersion: SCHEMA_VERSION });
  });

  it('同じ DB を 2 回開いても失敗しない（列は 1 つだけ）', () => {
    const raw = new DatabaseSync(path);
    raw.exec(V1_SQL);
    raw.close();
    open().close();
    const store = open();
    store.close();
    expect(inspect().columns.filter((c) => c === 't3')).toHaveLength(1);
  });

  it('user_version を 1 に戻した v2 の DB を開いても失敗せず、user_version は下げない', () => {
    const first = open();
    first.addCard({ threadId: 't', title: 'v2 のカード' });
    first.close();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 1');
    raw.close();

    const store = open();
    expect(store.getCard('t')?.title).toBe('v2 のカード');
    store.close();
    expect(inspect().userVersion).toBe(SCHEMA_VERSION);

    const bump = new DatabaseSync(path);
    bump.exec('PRAGMA user_version = 9');
    bump.close();
    open().close();
    expect(inspect().userVersion).toBe(9);
  });

  it('新規 DB は CREATE TABLE の時点で t3 列を持つ', () => {
    open().close();
    expect(inspect()).toEqual({ columns: expect.arrayContaining(['t3']), userVersion: SCHEMA_VERSION });
  });
});

describe('KanbanStore.updateTracking（R9）', () => {
  it('追跡参照だけを書き換え、列・ブロック・イベントは変えない。中身が変わったカードだけ数える', () => {
    const clock = manualClock();
    const store = KanbanStore.open({ path, boardId: 'b1', clock });
    try {
      store.addCard({ threadId: 'a', title: 'a' });
      store.moveCard('a', { to: 'ready' });
      store.blockCard('a', '待ち');
      const before = store.getCard('a');
      const events = store.listEvents().length;
      const thread = { threadId: 'a', link: 'https://l/a', projectId: 'P', branch: 'b', pullRequests: [] };
      clock.advance(1000);
      expect(store.updateTracking([{ threadId: 'a', thread }, { threadId: 'no-card', thread: { threadId: 'no-card' } }])).toBe(1);
      const after = store.getCard('a');
      expect(after?.t3).toEqual({ link: 'https://l/a', projectId: 'P', parentThreadId: null, branch: 'b', worktreePath: null, pullRequests: [], syncedAt: T0 + 1000 });
      expect(after?.column).toBe(before?.column);
      expect(after?.blocked).toEqual(before?.blocked);
      expect(after?.lastEventAt).toBe(before?.lastEventAt);
      expect(after?.updatedAt).toBe(T0 + 1000);
      expect(store.listEvents()).toHaveLength(events);

      clock.advance(1000);
      expect(store.updateTracking([{ threadId: 'a', thread }])).toBe(0);
      expect(store.getCard('a')?.t3?.syncedAt).toBe(T0 + 2000);
      expect(store.getCard('a')?.updatedAt).toBe(T0 + 1000);
    } finally {
      store.close();
    }
  });
});

describe('KanbanStore.updateTracking（m7）', () => {
  it('トランザクション内で最新のカードを読み直してマージする（呼び出し前の古い値で上書きしない）', () => {
    const store = KanbanStore.open({ path, boardId: 'b1', clock: manualClock() });
    try {
      store.addCard({ threadId: 'a', title: 'a' });
      store.updateTracking([{ threadId: 'a', thread: { threadId: 'a', branch: 'first', link: 'https://l/a' } }]);
      // 別のプロセスが branch を更新した後に、branch を含まない（list 由来の）更新が来る
      const other = KanbanStore.open({ path, boardId: 'b1', clock: manualClock() });
      other.updateTracking([{ threadId: 'a', thread: { threadId: 'a', branch: 'second' } }]);
      other.close();
      store.updateTracking([{ threadId: 'a', thread: { threadId: 'a', pullRequests: [{ url: 'https://g/pull/1' }] } }]);
      expect(store.getCard('a')?.t3).toMatchObject({ branch: 'second', link: 'https://l/a', pullRequests: [{ url: 'https://g/pull/1' }] });
    } finally {
      store.close();
    }
  });

  it('更新が空ならトランザクションを開始しない（他プロセスが書き込みロック中でも待たない）', () => {
    const store = KanbanStore.open({ path, boardId: 'b1', clock: manualClock(), busyTimeoutMs: 50 });
    const locker = new DatabaseSync(path);
    locker.exec('BEGIN IMMEDIATE');
    try {
      expect(store.updateTracking([])).toBe(0);
      expect(() => store.updateTracking([{ threadId: 'a', thread: { threadId: 'a' } }])).toThrow();
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
      store.close();
    }
  });
});

describe('t3 列の検証（S8）', () => {
  it('t3 列の JSON が壊れている・形が違う場合は null として扱い、ツールの読み取りを落とさない', () => {
    const store = KanbanStore.open({ path, boardId: 'b1', clock: manualClock() });
    try {
      for (const id of ['broken', 'wrong-shape', 'bad-pr', 'good']) store.addCard({ threadId: id, title: id });
      const raw = new DatabaseSync(path);
      const set = raw.prepare('UPDATE cards SET t3 = ? WHERE thread_id = ?');
      set.run('{not json', 'broken');
      set.run(JSON.stringify({ link: 1, syncedAt: 'x' }), 'wrong-shape');
      set.run(JSON.stringify({ link: null, projectId: null, parentThreadId: null, branch: null, worktreePath: null, pullRequests: [{ nope: 1 }], syncedAt: 1 }), 'bad-pr');
      set.run(JSON.stringify({ link: 'https://l', projectId: 'p', parentThreadId: null, branch: null, worktreePath: null, pullRequests: [], syncedAt: 1 }), 'good');
      raw.close();
      expect(store.getCard('broken')?.t3).toBeNull();
      expect(store.getCard('wrong-shape')?.t3).toBeNull();
      expect(store.getCard('bad-pr')?.t3).toBeNull();
      expect(store.getCard('good')?.t3).toMatchObject({ link: 'https://l/', projectId: 'p' });
      expect(store.snapshot().cards).toHaveLength(4);
    } finally {
      store.close();
    }
  });
});

describe('close 後（S4）', () => {
  it('close は 2 回呼んでもよく、close 後は書き込まない', () => {
    const store = KanbanStore.open({ path, boardId: 'b1', clock: manualClock() });
    store.addCard({ threadId: 'a', title: 'a' });
    store.close();
    store.close();
    expect(store.isClosed()).toBe(true);
    expect(() => store.updateTracking([{ threadId: 'a', thread: { threadId: 'a', branch: 'x' } }])).toThrow();
    const reopened = KanbanStore.open({ path, boardId: 'b1', clock: manualClock() });
    expect(reopened.getCard('a')?.t3).toBeNull();
    reopened.close();
  });
});
