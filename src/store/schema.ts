/** 2: cards.t3（T3 スレッドの追跡参照、JSON）を追加 */
export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  stale_days INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS columns (
  board_id TEXT NOT NULL REFERENCES boards(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  wip_limit INTEGER,
  entry_criteria TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (board_id, name)
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL REFERENCES boards(id),
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  service_class TEXT NOT NULL,
  due_date TEXT,
  size TEXT,
  external_refs TEXT NOT NULL DEFAULT '[]',
  t3 TEXT,
  column_name TEXT NOT NULL,
  column_entered_at INTEGER NOT NULL,
  blocked_reason TEXT,
  blocked_since INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  UNIQUE (board_id, thread_id)
);

CREATE INDEX IF NOT EXISTS cards_board_column ON cards (board_id, column_name);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL REFERENCES boards(id),
  card_id INTEGER REFERENCES cards(id),
  type TEXT NOT NULL,
  from_column TEXT,
  to_column TEXT,
  at INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS events_board_at ON events (board_id, at);
`;
