import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { checkClassPolicy, checkMove, type MoveDecision } from '../domain/rules.js';
import { mergeTracking, trackingChanged, type T3Thread } from '../domain/sync.js';
import { parseTracking } from './tracking.js';
import {
  BOARD_COLUMNS,
  DAY_MS,
  DEFAULT_STALE_DAYS,
  DEFAULT_WIP_LIMITS,
  DISCARDED,
  fail,
  ok,
  systemClock,
  type BoardColumn,
  type BoardConfig,
  type Card,
  type Clock,
  type Column,
  type EventType,
  type KanbanEvent,
  type Result,
  type ServiceClass,
  type Size,
  type T3Tracking,
  type WorkType,
} from '../domain/types.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export interface StoreOptions {
  path: string;
  boardId: string;
  clock?: Clock;
  /** 他プロセスがロック中のときに待つ最大時間（ミリ秒） */
  busyTimeoutMs?: number;
}

export interface AddCardInput {
  threadId: string;
  title: string;
  description?: string | undefined;
  type?: WorkType | undefined;
  serviceClass?: ServiceClass | undefined;
  dueDate?: string | undefined;
  size?: Size | undefined;
  externalRefs?: string[] | undefined;
  t3?: T3Tracking | undefined;
}

export interface UpdateCardInput {
  title?: string | undefined;
  description?: string | null | undefined;
  type?: WorkType | undefined;
  serviceClass?: ServiceClass | undefined;
  dueDate?: string | null | undefined;
  size?: Size | null | undefined;
  externalRefs?: string[] | undefined;
}

export interface MoveCardInput {
  to: Column;
  force?: boolean | undefined;
  reason?: string | undefined;
  criteriaConfirmed?: boolean | undefined;
}

export interface ConfigureInput {
  columns?: { column: BoardColumn; wipLimit?: number | null | undefined; entryCriteria?: string[] | undefined }[] | undefined;
  staleDays?: number | undefined;
}

type Row = Record<string, SQLInputValue>;

function rowToCard(r: Row): Card {
  return {
    id: Number(r.id),
    boardId: String(r.board_id),
    threadId: String(r.thread_id),
    title: String(r.title),
    description: r.description === null ? null : String(r.description),
    type: String(r.type) as WorkType,
    serviceClass: String(r.service_class) as ServiceClass,
    dueDate: r.due_date === null ? null : String(r.due_date),
    size: r.size === null ? null : (String(r.size) as Size),
    externalRefs: JSON.parse(String(r.external_refs)) as string[],
    t3: parseTracking(r.t3),
    column: String(r.column_name) as Column,
    columnEnteredAt: Number(r.column_entered_at),
    blocked:
      r.blocked_since === null ? null : { reason: String(r.blocked_reason), since: Number(r.blocked_since) },
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastEventAt: Number(r.last_event_at),
  };
}

function rowToEvent(r: Row): KanbanEvent {
  return {
    id: Number(r.id),
    boardId: String(r.board_id),
    cardId: r.card_id === null ? null : Number(r.card_id),
    type: String(r.type) as EventType,
    fromColumn: r.from_column === null ? null : (String(r.from_column) as Column),
    toColumn: r.to_column === null ? null : (String(r.to_column) as Column),
    at: Number(r.at),
    data: JSON.parse(String(r.data)) as Record<string, unknown>,
  };
}

/**
 * SQLite（node:sqlite）によるボードの永続化。
 * 書き込みは全て BEGIN IMMEDIATE で直列化し、読み取り→判定→書き込みを 1 トランザクションで行う。
 * これにより複数の MCP サーバープロセスが同じ DB を使っても WIP 上限の確認と移動が原子的になる。
 */
export class KanbanStore {
  readonly boardId: string;
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private closed = false;

  private constructor(db: DatabaseSync, options: StoreOptions) {
    this.db = db;
    this.boardId = options.boardId;
    this.path = options.path;
    this.clock = options.clock ?? systemClock;
  }

  static open(options: StoreOptions): KanbanStore {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    const timeout = options.busyTimeoutMs ?? 10_000;
    const db = new DatabaseSync(options.path, { timeout });
    db.exec(`PRAGMA busy_timeout = ${timeout}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    const store = new KanbanStore(db, options);
    store.init();
    return store;
  }

  /** 2 回呼んでもよい。close 後の読み書きは例外にする（S4: 終了後に書き込まない）。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  isClosed(): boolean {
    return this.closed;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('KanbanStore は閉じられています');
  }

  private init(): void {
    const now = this.clock();
    this.immediate(() => {
      this.db.exec(SCHEMA_SQL);
      this.migrate();
      this.db
        .prepare('INSERT OR IGNORE INTO boards (id, stale_days, created_at) VALUES (?, ?, ?)')
        .run(this.boardId, DEFAULT_STALE_DAYS, now);
      const insertColumn = this.db.prepare(
        'INSERT OR IGNORE INTO columns (board_id, name, position, wip_limit, entry_criteria) VALUES (?, ?, ?, ?, ?)',
      );
      BOARD_COLUMNS.forEach((name, position) => {
        insertColumn.run(this.boardId, name, position, DEFAULT_WIP_LIMITS[name], '[]');
      });
      return ok(null);
    });
  }

  /**
   * 既存 DB の移行（R7）。列の有無で判定するので何度実行しても同じ結果になる。
   * user_version は下げない（旧バージョンのプロセスが 1 に戻しても、列があれば問題ない）。
   */
  private migrate(): void {
    const columns = (this.db.prepare('PRAGMA table_info(cards)').all() as Row[]).map((r) => String(r.name));
    if (!columns.includes('t3')) this.db.exec('ALTER TABLE cards ADD COLUMN t3 TEXT');
    const current = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    this.db.exec(`PRAGMA user_version = ${Math.max(current, SCHEMA_VERSION)}`);
  }

  /** BEGIN IMMEDIATE で書き込みロックを取ってから fn を実行する。失敗結果や例外ならロールバック。 */
  private immediate<T>(fn: () => Result<T>): Result<T> {
    this.ensureOpen();
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = fn();
      if (result.ok) {
        this.db.exec('COMMIT');
        committed = true;
      }
      return result;
    } finally {
      if (!committed) this.db.exec('ROLLBACK');
    }
  }

  /** 読み取り専用の一貫したスナップショット。 */
  private read<T>(fn: () => T): T {
    this.ensureOpen();
    this.db.exec('BEGIN');
    try {
      return fn();
    } finally {
      this.db.exec('COMMIT');
    }
  }

  private loadConfig(): BoardConfig {
    const board = this.db.prepare('SELECT stale_days FROM boards WHERE id = ?').get(this.boardId) as Row;
    const columns = (
      this.db.prepare('SELECT * FROM columns WHERE board_id = ? ORDER BY position').all(this.boardId) as Row[]
    ).map((r) => ({
      name: String(r.name) as BoardColumn,
      position: Number(r.position),
      wipLimit: r.wip_limit === null ? null : Number(r.wip_limit),
      entryCriteria: JSON.parse(String(r.entry_criteria)) as string[],
    }));
    return { id: this.boardId, staleDays: Number(board.stale_days), columns };
  }

  private loadCards(): Card[] {
    return (
      this.db.prepare('SELECT * FROM cards WHERE board_id = ? ORDER BY id').all(this.boardId) as Row[]
    ).map(rowToCard);
  }

  private loadCard(threadId: string): Card | null {
    const r = this.db.prepare('SELECT * FROM cards WHERE board_id = ? AND thread_id = ?').get(this.boardId, threadId) as
      | Row
      | undefined;
    return r === undefined ? null : rowToCard(r);
  }

  private notFound<T>(threadId: string): Result<T> {
    return fail('CARD_NOT_FOUND', `threadId ${threadId} のカードはありません。先に kanban_card_add で登録してください`, {
      threadId,
    });
  }

  private insertEvent(
    cardId: number | null,
    type: EventType,
    from: Column | null,
    to: Column | null,
    at: number,
    data: Record<string, unknown> = {},
  ): void {
    this.db
      .prepare('INSERT INTO events (board_id, card_id, type, from_column, to_column, at, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.boardId, cardId, type, from, to, at, JSON.stringify(data));
    if (cardId !== null) {
      this.db.prepare('UPDATE cards SET last_event_at = ? WHERE id = ?').run(at, cardId);
    }
  }

  getBoardConfig(): BoardConfig {
    return this.read(() => this.loadConfig());
  }

  snapshot(): { board: BoardConfig; cards: Card[] } {
    return this.read(() => ({ board: this.loadConfig(), cards: this.loadCards() }));
  }

  getCard(threadId: string): Card | null {
    return this.read(() => this.loadCard(threadId));
  }

  listEvents(range?: { from: number; to: number }): KanbanEvent[] {
    const rows =
      range === undefined
        ? this.db.prepare('SELECT * FROM events WHERE board_id = ? ORDER BY at, id').all(this.boardId)
        : this.db
            .prepare('SELECT * FROM events WHERE board_id = ? AND at <= ? ORDER BY at, id')
            .all(this.boardId, range.to);
    return (rows as Row[]).map(rowToEvent);
  }

  /** メトリクス用に、カードと to 以前のイベントを同一スナップショットで返す。 */
  metricsSource(to: number): { cards: Card[]; events: KanbanEvent[] } {
    return this.read(() => ({ cards: this.loadCards(), events: this.listEvents({ from: 0, to }) }));
  }

  configure(input: ConfigureInput): Result<BoardConfig> {
    const now = this.clock();
    return this.immediate(() => {
      for (const c of input.columns ?? []) {
        if (c.wipLimit !== undefined) {
          this.db
            .prepare('UPDATE columns SET wip_limit = ? WHERE board_id = ? AND name = ?')
            .run(c.wipLimit, this.boardId, c.column);
        }
        if (c.entryCriteria !== undefined) {
          this.db
            .prepare('UPDATE columns SET entry_criteria = ? WHERE board_id = ? AND name = ?')
            .run(JSON.stringify(c.entryCriteria), this.boardId, c.column);
        }
      }
      if (input.staleDays !== undefined) {
        this.db.prepare('UPDATE boards SET stale_days = ? WHERE id = ?').run(input.staleDays, this.boardId);
      }
      this.insertEvent(null, 'configured', null, null, now, { ...input });
      return ok(this.loadConfig());
    });
  }

  addCard(input: AddCardInput): Result<{ card: Card; created: boolean }> {
    const now = this.clock();
    return this.immediate<{ card: Card; created: boolean }>(() => {
      const existing = this.loadCard(input.threadId);
      if (existing !== null) return ok({ card: existing, created: false });

      const serviceClass = input.serviceClass ?? 'regular';
      const dueDate = input.dueDate ?? null;
      const policy = checkClassPolicy({ serviceClass, dueDate }, this.loadCards(), null);
      if (!policy.ok) return policy;

      const info = this.db
        .prepare(
          `INSERT INTO cards (board_id, thread_id, title, description, type, service_class, due_date, size,
             external_refs, t3, column_name, column_entered_at, created_at, updated_at, last_event_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox', ?, ?, ?, ?)`,
        )
        .run(
          this.boardId,
          input.threadId,
          input.title,
          input.description ?? null,
          input.type ?? 'feature',
          serviceClass,
          dueDate,
          input.size ?? null,
          JSON.stringify(input.externalRefs ?? []),
          input.t3 === undefined ? null : JSON.stringify(input.t3),
          now,
          now,
          now,
          now,
        );
      const cardId = Number(info.lastInsertRowid);
      this.insertEvent(cardId, 'created', null, null, now, { threadId: input.threadId });
      this.insertEvent(cardId, 'moved', null, 'inbox', now);
      return ok({ card: this.loadCard(input.threadId) as Card, created: true });
    });
  }

  /**
   * T3 のスレッドからカードの追跡参照を更新する（R9）。列・ブロック・イベントは変えない。
   * 追跡参照の中身（syncedAt 以外）が変わったカードだけ updated_at を進める。存在しない threadId は無視する。
   * 戻り値は中身が変わったカードの数。
   */
  updateTracking(updates: readonly { threadId: string; thread: T3Thread }[]): number {
    if (updates.length === 0) return 0;
    const now = this.clock();
    const r = this.immediate(() => {
      const withUpdatedAt = this.db.prepare('UPDATE cards SET t3 = ?, updated_at = ? WHERE id = ?');
      const syncedOnly = this.db.prepare('UPDATE cards SET t3 = ? WHERE id = ?');
      let changed = 0;
      for (const u of updates) {
        // トランザクション内で最新のカードを読み直してマージする（m7）
        const card = this.loadCard(u.threadId);
        if (card === null) continue;
        const next = mergeTracking(card.t3, u.thread, now);
        if (trackingChanged(card.t3, next)) {
          changed += 1;
          withUpdatedAt.run(JSON.stringify(next), now, card.id);
        } else {
          syncedOnly.run(JSON.stringify(next), card.id);
        }
      }
      return ok(changed);
    });
    return r.ok ? r.value : 0;
  }

  updateCard(threadId: string, patch: UpdateCardInput): Result<{ card: Card; changed: string[] }> {
    const now = this.clock();
    return this.immediate(() => {
      const card = this.loadCard(threadId);
      if (card === null) return this.notFound(threadId);

      const next = {
        title: patch.title ?? card.title,
        description: patch.description === undefined ? card.description : patch.description,
        type: patch.type ?? card.type,
        serviceClass: patch.serviceClass ?? card.serviceClass,
        dueDate: patch.dueDate === undefined ? card.dueDate : patch.dueDate,
        size: patch.size === undefined ? card.size : patch.size,
        externalRefs: patch.externalRefs ?? card.externalRefs,
      };
      const policy = checkClassPolicy(next, this.loadCards(), card);
      if (!policy.ok) return policy;

      const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
        (k) => JSON.stringify(next[k]) !== JSON.stringify(card[k]),
      );
      if (changed.length > 0) {
        this.db
          .prepare(
            `UPDATE cards SET title = ?, description = ?, type = ?, service_class = ?, due_date = ?, size = ?,
               external_refs = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            next.title,
            next.description,
            next.type,
            next.serviceClass,
            next.dueDate,
            next.size,
            JSON.stringify(next.externalRefs),
            now,
            card.id,
          );
        this.insertEvent(card.id, 'updated', null, null, now, {
          changed,
          before: Object.fromEntries(changed.map((k) => [k, card[k]])),
          after: Object.fromEntries(changed.map((k) => [k, next[k]])),
        });
      }
      return ok({ card: this.loadCard(threadId) as Card, changed });
    });
  }

  moveCard(threadId: string, input: MoveCardInput): Result<{ card: Card; decision: MoveDecision }> {
    const now = this.clock();
    return this.immediate(() => {
      const card = this.loadCard(threadId);
      if (card === null) return this.notFound(threadId);
      const decided = checkMove({
        card,
        to: input.to,
        cards: this.loadCards(),
        board: this.loadConfig(),
        force: input.force,
        reason: input.reason,
        criteriaConfirmed: input.criteriaConfirmed,
      });
      if (!decided.ok) return decided;
      const decision = decided.value;

      this.db
        .prepare('UPDATE cards SET column_name = ?, column_entered_at = ?, updated_at = ? WHERE id = ?')
        .run(decision.to, now, now, card.id);
      this.insertEvent(card.id, 'moved', decision.from, decision.to, now, {
        direction: decision.direction,
        force: input.force === true,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.criteriaConfirmed === true ? { criteriaConfirmed: true } : {}),
        ...(decision.expediteOverLimit ? { expediteOverLimit: true } : {}),
      });
      if (decision.violation !== null) {
        this.insertEvent(card.id, 'wip_violation', decision.from, decision.to, now, { ...decision.violation });
      }
      if (decision.to === DISCARDED && card.blocked !== null) {
        this.db.prepare('UPDATE cards SET blocked_reason = NULL, blocked_since = NULL WHERE id = ?').run(card.id);
        this.insertEvent(card.id, 'unblocked', null, null, now, {
          resolution: 'discarded',
          blockedDays: (now - card.blocked.since) / DAY_MS,
        });
      }
      return ok({ card: this.loadCard(threadId) as Card, decision });
    });
  }

  blockCard(threadId: string, reason: string): Result<Card> {
    const now = this.clock();
    return this.immediate(() => {
      const card = this.loadCard(threadId);
      if (card === null) return this.notFound(threadId);
      if (card.column === 'done' || card.column === DISCARDED) {
        return fail('CARD_NOT_ACTIVE', `${card.column} のカードはブロックできません`, { column: card.column });
      }
      if (card.blocked !== null) {
        return fail('ALREADY_BLOCKED', `カードは既にブロック中です（理由: ${card.blocked.reason}）`, {
          blockedReason: card.blocked.reason,
          blockedSince: new Date(card.blocked.since).toISOString(),
        });
      }
      this.db
        .prepare('UPDATE cards SET blocked_reason = ?, blocked_since = ?, updated_at = ? WHERE id = ?')
        .run(reason, now, now, card.id);
      this.insertEvent(card.id, 'blocked', card.column, card.column, now, { reason });
      return ok(this.loadCard(threadId) as Card);
    });
  }

  unblockCard(threadId: string, resolution?: string): Result<{ card: Card; blockedDays: number }> {
    const now = this.clock();
    return this.immediate(() => {
      const card = this.loadCard(threadId);
      if (card === null) return this.notFound(threadId);
      if (card.blocked === null) return fail('NOT_BLOCKED', 'カードはブロックされていません');
      const blockedDays = (now - card.blocked.since) / DAY_MS;
      this.db
        .prepare('UPDATE cards SET blocked_reason = NULL, blocked_since = NULL, updated_at = ? WHERE id = ?')
        .run(now, card.id);
      this.insertEvent(card.id, 'unblocked', card.column, card.column, now, {
        reason: card.blocked.reason,
        blockedDays,
        ...(resolution !== undefined ? { resolution } : {}),
      });
      return ok({ card: this.loadCard(threadId) as Card, blockedDays });
    });
  }
}
