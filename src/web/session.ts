// 開いているボードごとの接続と配信。SSE のクライアントが何人いても Reader とポーリングは 1 本。
import type { ServerResponse } from 'node:http';
import type { Clock } from '../domain/types.js';
import { KanbanReader, KanbanStore } from '../store/sqlite.js';
import { boardLabel, dbFileExists } from './discovery.js';
import type { BoardResponse, BoardSummary } from './types.js';
import { boardResponse, cardsById, toUiEvent, type Snapshot } from './views.js';

export interface SessionOptions {
  clock: Clock;
  pollMs: number;
  rebuildIntervalMs: number;
  keepaliveMs: number;
  idleCloseMs: number;
  /** 1 回の配信で送るイベントの上限。超えたら snapshot だけを送る */
  maxEvents: number;
  log: (message: string) => void;
  onIdle: (session: BoardSession) => void;
}

interface SseClient {
  res: ServerResponse;
  /** このクライアントに送った最大のイベント id */
  cursor: number;
}

/**
 * ロック待ちの上限（ミリ秒）。書き込みは超えたら 503 にしてクライアントに再試行させる（HTTP の要求を長く止めない）。
 * 読み取りも同じ値にする（ポーリングは次の周期で読み直す）。
 */
const BUSY_TIMEOUT_MS = 500;

export function isBusyError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const errcode = (e as { errcode?: unknown }).errcode;
  if (typeof errcode === 'number' && (errcode & 0xff) === 5) return true;
  const message = (e as { message?: unknown }).message;
  return typeof message === 'string' && /SQLITE_BUSY|database is locked/i.test(message);
}

/** node:sqlite が投げた例外（errcode が数値、または code が ERR_SQLITE_ERROR）。 */
function isSqliteError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  return typeof (e as { errcode?: unknown }).errcode === 'number' || (e as { code?: unknown }).code === 'ERR_SQLITE_ERROR';
}

/**
 * DB の状態が原因の失敗。SQLite の例外と、保存されている JSON の列（cards.external_refs・events.data・
 * columns.entry_criteria）を JSON.parse できない SyntaxError（データの破損）。
 * それ以外（TypeError など）はプログラムの誤りなので、ここに含めず 500 INTERNAL にする。
 */
export function isBoardDataError(e: unknown): boolean {
  return isSqliteError(e) || e instanceof SyntaxError;
}

/**
 * DB ファイルはあるのに開けない・読めない（権限・壊れたファイルなど）。空のボードとは区別して 503 BOARD_UNAVAILABLE にする。
 * SQLITE_BUSY はこれに含めない（503 BUSY で再試行させる）。
 */
export class BoardUnavailableError extends Error {}

export class BoardSession {
  readonly entry: BoardSummary;
  private readonly options: SessionOptions;
  private reader: KanbanReader | null = null;
  private store: KanbanStore | null = null;
  private readonly clients = new Set<SseClient>();
  private lastVersion: number | null = null;
  /** Reader を開いた直後（まだポーリングで配信していない） */
  private readerFresh = false;
  /** 最後に出したエラーのログ（同じエラーが続く間は繰り返さない） */
  private lastError: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private rebuildTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(entry: BoardSummary, options: SessionOptions) {
    // label は配信のたびに base_path から更新するので複製して持つ
    this.entry = { ...entry };
    this.options = options;
    this.scheduleIdle();
  }

  /** 同じエラーが続く間は 1 回だけログに出す（状態が変わったら clearError で戻す）。 */
  private logError(message: string): void {
    if (message === this.lastError) return;
    this.lastError = message;
    this.options.log(message);
  }

  private clearError(): void {
    this.lastError = null;
  }

  /**
   * Reader（DB ファイルがまだなければ null）。開いたときの data_version を覚えておく。
   * ファイルがあるのに開けなければ BoardUnavailableError（次の呼び出しで開き直す）。
   */
  getReader(): KanbanReader | null {
    if (this.closed) return null;
    if (this.reader !== null) return this.reader;
    if (!dbFileExists(this.entry.dbPath)) return null;
    try {
      this.reader = KanbanReader.open({ path: this.entry.dbPath, boardId: this.entry.boardId, busyTimeoutMs: BUSY_TIMEOUT_MS });
      this.readerFresh = true;
    } catch (e) {
      const message = `Reader を開けません（${this.entry.dbPath}）: ${(e as Error).message}`;
      this.logError(message);
      throw new BoardUnavailableError(message);
    }
    return this.reader;
  }

  /**
   * DB の操作を実行し、SQLITE_BUSY 以外の DB の失敗（isBoardDataError）を BoardUnavailableError にする。
   * BUSY はそのまま投げて 503 BUSY にする。それ以外の例外もそのまま投げる（500 INTERNAL）。
   * BoardUnavailableError にするときは Reader を閉じて、次の呼び出しで開き直す（ファイルが置き換えられた場合など）。
   */
  private guard<T>(what: string, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (isBusyError(e) || !isBoardDataError(e)) throw e;
      this.dropReader();
      const message = `${what}（${this.entry.dbPath}）: ${(e as Error).message}`;
      this.logError(message);
      throw new BoardUnavailableError(message);
    }
  }

  /** キャッシュしている Reader を閉じて捨てる（次の getReader で開き直す）。 */
  private dropReader(): void {
    this.reader?.close();
    this.reader = null;
  }

  /** 書き込み用の接続。最初の POST で、DB にある boardId と渡された clock で開く。開けなければ BoardUnavailableError。 */
  getStore(): KanbanStore {
    if (this.store === null) {
      this.store = this.guard('Store を開けません', () =>
        KanbanStore.open({
          path: this.entry.dbPath,
          boardId: this.entry.boardId,
          clock: this.options.clock,
          busyTimeoutMs: BUSY_TIMEOUT_MS,
        }),
      );
    }
    return this.store;
  }

  /**
   * snapshot と最大のイベント id を同じ読み取りトランザクションで取る。
   * snapshot が null になるのは DB ファイルがない・ボードの行がないときだけ。開けない・読めないときは
   * BoardUnavailableError（SQLITE_BUSY はそのまま投げる）。
   */
  readSnapshot(): { snapshot: Snapshot; lastEventId: number } {
    const reader = this.getReader();
    if (reader === null) return { snapshot: null, lastEventId: 0 };
    const batch = this.guard('ボードを読めません', () => reader.readSince(Number.MAX_SAFE_INTEGER, 0));
    return { snapshot: batch.snapshot, lastEventId: batch.maxEventId };
  }

  /** カードのイベント（DB ファイルがなければ空）。読めなければ BoardUnavailableError（SQLITE_BUSY はそのまま投げる）。 */
  listCardEvents(threadId: string): ReturnType<KanbanReader['listCardEvents']> {
    const reader = this.getReader();
    if (reader === null) return [];
    return this.guard('カードのイベントを読めません', () => reader.listCardEvents(threadId));
  }

  /** 書き込みの直後の最大のイベント id（UI がどの snapshot まで古いかを判定する）。読めなければ undefined。 */
  lastEventIdAfterWrite(): number | undefined {
    try {
      return this.getReader()?.maxEventId();
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------ SSE

  addClient(res: ServerResponse, lastEventId: number | null): void {
    const client: SseClient = { res, cursor: lastEventId ?? 0 };
    this.clients.add(client);
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    res.on('close', () => this.removeClient(client));
    this.startLoops();
    // 接続したら、lastEventId より後のイベント（あれば）→ snapshot を送る
    this.deliver([client], lastEventId !== null);
  }

  private removeClient(client: SseClient): void {
    if (!this.clients.delete(client)) return;
    if (this.clients.size === 0) {
      this.stopLoops();
      this.scheduleIdle();
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  /** 書き込みの後にポーリングの 1 回分をすぐに実行する（配信の経路は 1 本だけ）。 */
  pollNow(): void {
    this.poll();
  }

  private startLoops(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => this.poll(), this.options.pollMs);
    this.rebuildTimer = setInterval(() => this.deliver([...this.clients], true), this.options.rebuildIntervalMs);
    this.keepaliveTimer = setInterval(() => {
      for (const c of this.clients) c.res.write(': keepalive\n\n');
    }, this.options.keepaliveMs);
  }

  private stopLoops(): void {
    for (const t of [this.pollTimer, this.rebuildTimer, this.keepaliveTimer]) if (t !== null) clearInterval(t);
    this.pollTimer = null;
    this.rebuildTimer = null;
    this.keepaliveTimer = null;
  }

  private scheduleIdle(): void {
    if (this.closed || this.clients.size > 0) return;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.clients.size === 0) this.options.onIdle(this);
    }, this.options.idleCloseMs);
  }

  /** SSE のない要求（GET / POST）でも使うので、その都度 idle の期限を延ばす。 */
  touch(): void {
    this.scheduleIdle();
  }

  private safeVersion(): number | null {
    try {
      return this.reader?.dataVersion() ?? null;
    } catch (e) {
      this.logError(`data_version を読めません: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * ファイルの出現と data_version の変化を見て、変わっていれば配信する。
   * 配信に成功したときだけ lastVersion を進める（読み取りに失敗したら次のポーリングで再試行する）。
   */
  private poll(): void {
    if (this.closed) return;
    try {
      if (this.getReader() === null) return;
    } catch {
      // 開けない（ログは getReader で出した）。開き直さずに接続を閉じ、クライアントの再接続（503 BOARD_UNAVAILABLE）に任せる
      this.closeClients([...this.clients]);
      return;
    }
    const version = this.safeVersion();
    if (version === null) return;
    if (this.readerFresh || version !== this.lastVersion) {
      if (this.deliver([...this.clients], true)) {
        this.readerFresh = false;
        this.lastVersion = version;
      }
    }
  }

  /**
   * 1 回の配信。新しいイベントと snapshot を同じ読み取りトランザクションで取り、events → snapshot の順に送る。
   * 取得の上限を超えたら snapshot だけを（truncated: true を付けて）送る。各クライアントには自分の cursor より後のイベントだけを送る（重複しない）。
   * withEvents が false（lastEventId なしの新しい接続）ならイベントは読まない。
   * SQLITE_BUSY で読めなければ false を返し、次のポーリングで全員に配信し直す（接続は保つ。送る相手がいなければ何もせず true）。
   * 開けない・BUSY 以外で読めない（壊れたファイルなど）ときは対象の接続を閉じ、クライアントの再接続（503 BOARD_UNAVAILABLE）に任せる。
   */
  private deliver(targets: SseClient[], withEvents: boolean): boolean {
    if (this.closed) return false;
    if (targets.length === 0) return true;
    const now = this.options.clock();
    let reader: KanbanReader | null;
    try {
      reader = this.getReader();
    } catch {
      // DB があるのに開けない
      this.closeClients(targets);
      return true;
    }
    let snapshot: Snapshot = null;
    let events: ReturnType<KanbanReader['readSince']>['events'] = [];
    let truncated = false;
    let maxEventId = 0;
    if (reader !== null) {
      try {
        const batch = withEvents
          ? reader.readSince(Math.min(...targets.map((t) => t.cursor)), this.options.maxEvents)
          : reader.readSince(Number.MAX_SAFE_INTEGER, 0);
        ({ snapshot, events, truncated, maxEventId } = batch);
        // 表示名は base_path から毎回組み直す（ボードの行がまだなければ一覧のときの表示名のまま）
        if (snapshot !== null) this.entry.label = boardLabel(reader.basePath(), this.entry.boardId);
      } catch (e) {
        if (isBusyError(e)) {
          this.logError(`ボードを読めません（${this.entry.dbPath}）: ${(e as Error).message}`);
          this.lastVersion = null;
          return false;
        }
        if (isBoardDataError(e)) {
          // 壊れたファイル・壊れた行など。Reader を閉じて次は開き直す（ファイルが置き換えられた場合など）
          this.logError(`ボードを読めません（${this.entry.dbPath}）: ${(e as Error).message}`);
          this.dropReader();
        } else {
          // プログラムの誤り。ポーリングのタイマーから呼ばれるので投げ直さず、スタックをログに出して接続を閉じる
          // （再接続の stream の事前の読み取りで同じ例外が 500 INTERNAL になる）
          this.logError(`内部エラー: ${(e as Error).stack ?? String(e)}`);
        }
        this.closeClients(targets);
        return true;
      }
    }
    this.clearError();
    const byId = cardsById(snapshot);
    const resp: BoardResponse = boardResponse(this.entry.key, this.entry.label, snapshot, maxEventId, now);
    if (truncated) resp.truncated = true;
    const snapshotMsg = `event: snapshot\nid: ${maxEventId}\ndata: ${JSON.stringify(resp)}\n\n`;
    for (const client of targets) {
      if (withEvents && !truncated) {
        const mine = events.filter((e) => e.id > client.cursor);
        const last = mine[mine.length - 1];
        if (last !== undefined) {
          const payload = JSON.stringify({ events: mine.map((e) => toUiEvent(e, byId)) });
          client.res.write(`event: events\nid: ${last.id}\ndata: ${payload}\n\n`);
        }
      }
      client.res.write(snapshotMsg);
      client.cursor = maxEventId;
    }
    return true;
  }

  /** 接続を閉じる（SSE のクライアントは再接続して、stream の 503 BOARD_UNAVAILABLE で状態を知る）。 */
  private closeClients(targets: SseClient[]): void {
    for (const client of targets) {
      this.removeClient(client);
      client.res.end();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopLoops();
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    this.reader?.close();
    this.store?.close();
    this.reader = null;
    this.store = null;
  }

  isClosed(): boolean {
    return this.closed;
  }
}
