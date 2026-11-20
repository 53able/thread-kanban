// SSE の接続。EventSource は自前で作り直す（onerror ですぐ close() し、ネイティブの自動再接続を止める）。
// 作り直すときは最後に受け取った id を ?lastEventId= に付ける。待ち時間は指数的に延ばし、上限は 10 秒。
// 切断のたびに /api/health の結果を classifyDisconnect で 4 通りに分けて、再試行するかを決める。

import { getHealth, type HealthResult } from './api.js';
import type { BoardKey, BoardResponse, UiEvent } from './api-types.js';
import { backoffMs, classifyDisconnect, decideDisconnect, type Banner } from './state.js';

export interface StreamHandlers {
  onEvents(events: UiEvent[], info: { initial: boolean; gap: boolean }): void;
  onSnapshot(resp: BoardResponse): void;
  onBanner(banner: Banner): void;
}

interface EventSourceLike {
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export interface StreamDeps {
  createEventSource: (url: string) => EventSourceLike;
  health: () => Promise<HealthResult>;
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
}

const defaultDeps: StreamDeps = {
  createEventSource: (url) => new EventSource(url),
  health: getHealth,
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface StreamHandle {
  close(): void;
  /** 「ボードを読み込めません」からの手動の再試行 */
  retryNow(): void;
}

export function streamUrl(key: BoardKey, lastEventId: number | null): string {
  const base = `/api/boards/${encodeURIComponent(key)}/stream`;
  return lastEventId === null ? base : `${base}?lastEventId=${lastEventId}`;
}

export function openStream(
  key: BoardKey,
  initialLastEventId: number | null,
  handlers: StreamHandlers,
  deps: StreamDeps = defaultDeps,
): StreamHandle {
  let lastEventId = initialLastEventId;
  let es: EventSourceLike | null = null;
  let timer: unknown = null;
  let attempt = 0;
  let validFailures = 0;
  let connections = 0;
  // 接続の世代。retryNow / close で進め、古い接続の health の結果を捨てる
  let generation = 0;
  let closed = false;

  const connect = (): void => {
    if (closed) return;
    timer = null;
    generation += 1;
    const gen = generation;
    const reconnect = connections > 0;
    connections += 1;
    let snapshotSeen = false;
    let received = false;
    // 失敗の回数と待ち時間は、この接続で最初のメッセージを受け取ってから戻す。
    // onopen では戻さない（接続は開くが配信に失敗して閉じる、を繰り返すときに 5 回で止まらず再接続し続けるため）
    const onFirstMessage = (): void => {
      if (received) return;
      received = true;
      attempt = 0;
      validFailures = 0;
    };
    const source = deps.createEventSource(streamUrl(key, lastEventId));
    es = source;
    source.onopen = () => {
      handlers.onBanner(null);
    };
    source.addEventListener('events', (ev) => {
      onFirstMessage();
      const data = JSON.parse(ev.data as string) as { events: UiEvent[] };
      for (const e of data.events) if (lastEventId === null || e.id > lastEventId) lastEventId = e.id;
      handlers.onEvents(data.events, { initial: !reconnect && !snapshotSeen, gap: reconnect && !snapshotSeen });
    });
    source.addEventListener('snapshot', (ev) => {
      onFirstMessage();
      const data = JSON.parse(ev.data as string) as BoardResponse;
      lastEventId = data.lastEventId;
      snapshotSeen = true;
      handlers.onSnapshot(data);
    });
    source.onerror = () => {
      source.close();
      if (es !== source || closed) return;
      es = null;
      void deps.health().then((result) => {
        if (closed || gen !== generation) return;
        const decision = decideDisconnect(classifyDisconnect(result), validFailures);
        validFailures = decision.validFailures;
        handlers.onBanner(decision.banner);
        if (!decision.retry) return;
        timer = deps.setTimer(connect, backoffMs(attempt));
        attempt += 1;
      });
    };
  };

  connect();

  return {
    close() {
      closed = true;
      generation += 1;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
      es?.close();
      es = null;
    },
    retryNow() {
      if (closed) return;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
      es?.close();
      es = null;
      attempt = 0;
      validFailures = 0;
      handlers.onBanner(null);
      connect();
    },
  };
}
