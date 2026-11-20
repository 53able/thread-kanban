import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import * as api from './api.js';
import type { ApiFailure, BoardKey, BoardResponse, BoardSummary } from './api-types.js';
import * as platform from './platform.js';
import { openStream, type StreamHandle, type StreamHandlers } from './sse.js';
import { classifyDisconnect, decideDisconnect, ingestSnapshot, offerSnapshot, pendingAfterMove, releaseSnapshot, type Banner } from './state.js';
import { useRefState } from './use-ref-state.js';

/** 同じキーのボードに戻っても、前回の操作の応答は反映しない。 */
export interface BoardAction {
  readonly key: BoardKey;
  isCurrent(): boolean;
}

interface BoardSessionOptions {
  busy: boolean;
  isBusy(): boolean;
  onBoardChange(): void;
  onEvents: StreamHandlers['onEvents'];
  onTruncated(): void;
  onRelease(next: BoardResponse | null): void;
  onApply(previous: BoardResponse | null, next: BoardResponse, changed: readonly number[]): void;
}

export function parseHashKey(hash: string): BoardKey | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('board');
  return value === null || value === '' ? null : value;
}

/** ボード選択、読み込み、SSE と操作の応答が同じボードの表示に合流する場所。 */
export function useBoardSession(options: BoardSessionOptions) {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [key, setKey, keyRef] = useRefState<BoardKey | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [resp, setResp, respRef] = useRefState<BoardResponse | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const pending = useRef<BoardResponse | null>(null);
  const activation = useRef<{ key: BoardKey } | null>(null);
  const stream = useRef<StreamHandle | null>(null);
  const commitWaiters = useRef<(() => void)[]>([]);

  const selectBoard = (next: BoardKey): void => {
    if (next !== keyRef.current) setKey(next);
  };

  const beginAction = (): BoardAction | null => {
    const active = activation.current;
    if (active === null || active.key !== keyRef.current || respRef.current?.key !== active.key) return null;
    return { key: active.key, isCurrent: () => activation.current === active && keyRef.current === active.key };
  };

  const applySnapshot = (next: BoardResponse, animate: boolean): void => {
    const previous = respRef.current;
    const { changed, columnMoved } = ingestSnapshot(previous, next);
    options.onApply(previous, next, changed);
    if (!animate || !columnMoved) {
      setResp(next);
      return;
    }
    // 次の snapshot には即時に反映し、描画待ちの間に新しい snapshot が届いたらそちらを優先する。
    respRef.current = next;
    platform.startViewTransition(
      () => new Promise<void>((resolve) => {
        if (respRef.current !== next) {
          resolve();
          return;
        }
        commitWaiters.current.push(resolve);
        setResp(next);
      }),
    );
  };

  const onSnapshot = (next: BoardResponse): void => {
    const gate = offerSnapshot(next, options.isBusy());
    pending.current = gate.pending;
    if (next.truncated === true) options.onTruncated();
    if (gate.apply !== null) applySnapshot(gate.apply, true);
  };

  useEffect(() => {
    if (options.busy) return;
    const gate = releaseSnapshot(pending.current, false);
    pending.current = gate.pending;
    options.onRelease(gate.apply);
    if (gate.apply !== null) applySnapshot(gate.apply, true);
  }, [options.busy]);

  useLayoutEffect(() => {
    for (const resolve of commitWaiters.current.splice(0)) resolve();
  });

  const handleLoadFailure = async (r: ApiFailure, isCancelled: () => boolean = () => false): Promise<void> => {
    if (r.status === 403) {
      const decision = decideDisconnect(classifyDisconnect(await api.getHealth()), 0);
      if (isCancelled()) return;
      setBanner(decision.banner === 'reauth' ? 'reauth' : 'unavailable');
      return;
    }
    setBanner('unavailable');
  };

  const loadBoards = async (): Promise<void> => {
    const r = await api.getBoards();
    if (!r.ok) {
      await handleLoadFailure(r);
      return;
    }
    setBanner(null);
    setBoards(r.boards);
    setKey(parseHashKey(location.hash) ?? r.defaultKey ?? r.boards[0]?.key ?? null);
    setLoaded(true);
  };

  useEffect(() => {
    void loadBoards();
    const onHash = (): void => {
      const next = parseHashKey(location.hash);
      if (next !== null) selectBoard(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (key === null) return undefined;
    if (activation.current?.key !== key) {
      activation.current = { key };
      setResp(null);
      pending.current = null;
      options.onBoardChange();
    }
    let cancelled = false;
    let handle: StreamHandle | null = null;
    if (parseHashKey(location.hash) !== key) history.replaceState(null, '', `#board=${encodeURIComponent(key)}`);
    void (async () => {
      const r = await api.getBoard(key);
      if (cancelled) return;
      if (!r.ok) {
        await handleLoadFailure(r, () => cancelled);
        return;
      }
      setBanner(null);
      pending.current = null;
      applySnapshot(r, false);
      handle = openStream(key, r.lastEventId, { onEvents: options.onEvents, onSnapshot, onBanner: setBanner });
      stream.current = handle;
    })();
    return () => {
      cancelled = true;
      handle?.close();
      stream.current = null;
    };
  }, [key, reloadToken]);

  const retry = (): void => {
    setBanner(null);
    if (stream.current !== null) stream.current.retryNow();
    else if (!loaded) void loadBoards();
    else setReloadToken((n) => n + 1);
  };

  const refetchAfterMove = async (action: BoardAction, watermark: number): Promise<void> => {
    const r = await api.getBoard(action.key);
    if (!action.isCurrent() || !r.ok || r.lastEventId < watermark) return;
    // 取り直しの間に SSE で同じか新しい snapshot が届いていれば、そちらを優先する。
    const latest = pending.current ?? respRef.current;
    if (latest === null || r.lastEventId > latest.lastEventId) onSnapshot(r);
  };

  const reconcileMove = (action: BoardAction, watermark: number | undefined): void => {
    const before = pending.current;
    pending.current = watermark === undefined ? null : pendingAfterMove(before, watermark);
    if (watermark === undefined || (before !== null && pending.current === null)) void refetchAfterMove(action, watermark ?? 0);
  };

  return { boards, key, loaded, resp, banner, selectBoard, retry, beginAction, current: () => respRef.current, setResp, reconcileMove };
}
