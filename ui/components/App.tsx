// 画面全体の状態と操作。状態遷移の判定は ui/state.ts の純粋な関数に任せ、ここでは配線だけを行う。

import type { JSX, TargetedFocusEvent, TargetedKeyboardEvent, TargetedPointerEvent } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import * as api from '../api.js';
import type { ApiFailure, BoardCardView, BoardKey, BoardResponse, BoardSummary, Column, MoveOption, UiEvent } from '../api-types.js';
import * as platform from '../platform.js';
import { openStream, type StreamHandle } from '../sse.js';
import {
  OWN_ACTION_TTL_MS,
  applyOptimisticMove,
  buildMoveBody,
  classifyDisconnect,
  columnVerdicts,
  decideDisconnect,
  dismissToast,
  displayColumns,
  emptyToasts,
  errorLabel,
  eventsToToasts,
  findCard,
  grabbedCardNotice,
  ingestSnapshot,
  moveSteps,
  nextFocus,
  offerSnapshot,
  pendingAfterMove,
  pruneOwnActions,
  pushToasts,
  releaseHeldToasts,
  releaseSnapshot,
  resolveSelection,
  settleToast,
  type Banner,
  type OwnAction,
  type ToastInput,
  type ToastState,
  type VRect,
} from '../state.js';
import { Board, cardElementId, columnListId, type DragState, type GrabState } from './Board.js';
import { Drawer } from './Drawer.js';
import { BannerView, EmptyState, Header } from './Header.js';
import { MoveDialog, type MoveFlow } from './MoveDialog.js';
import { Toasts } from './Toasts.js';

const HIGHLIGHT_MS = 3000;
const AUTOSCROLL_EDGE_PX = 40;
const AUTOSCROLL_SPEED_PX = 8;
const NARROW_QUERY = '(max-width: 479.98px)';

export function parseHashKey(hash: string): BoardKey | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('board');
  return value === null || value === '' ? null : value;
}

/** useState と同じ値を ref にも持つ（SSE などの非同期のコールバックから最新の値を読むため）。 */
function useRefState<T>(initial: T): [T, (value: T) => void, { current: T }] {
  const [value, setValue] = useState<T>(initial);
  const ref = useRef<T>(initial);
  const set = (next: T): void => {
    ref.current = next;
    setValue(next);
  };
  return [value, set, ref];
}

function cardOf(resp: BoardResponse | null, threadId: string): BoardCardView | null {
  return resp?.board?.columns.flatMap((c) => c.cards).find((c) => c.threadId === threadId) ?? null;
}

function failureText(r: ApiFailure): string {
  return `${errorLabel(r.code)}（${r.message}）`;
}

export function App(): JSX.Element {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [key, setKey, keyRef] = useRefState<BoardKey | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [resp, setResp, respRef] = useRefState<BoardResponse | null>(null);
  const [selected, setSelected, selectedRef] = useRefState<string | null>(null);
  const [focusColumn, setFocusColumn] = useState<Column | null>(null);
  const [grab, setGrab, grabRef] = useRefState<GrabState | null>(null);
  const [drag, setDrag, dragRef] = useRefState<DragState | null>(null);
  const [flow, setFlow, flowRef] = useRefState<MoveFlow | null>(null);
  const [sending, setSending, sendingRef] = useRefState(false);
  const [drawer, setDrawer, drawerRef] = useRefState<string | null>(null);
  const [drawerEvents, setDrawerEvents] = useState<UiEvent[] | null>(null);
  const [drawerOptions, setDrawerOptions] = useState<MoveOption[] | null>(null);
  const [drawerPending, setDrawerPending] = useState(false);
  const [toasts, setToasts] = useState<ToastState>(emptyToasts);
  const [banner, setBanner] = useState<Banner>(null);
  const [highlighted, setHighlighted] = useState<ReadonlySet<number>>(new Set());
  const [narrow, setNarrow] = useState(false);
  const [activeColumn, setActiveColumn] = useState<Column | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const pendingRef = useRef<BoardResponse | null>(null);
  const rollbackRef = useRef<BoardResponse | null>(null);
  // 移動を始めたボード。送信はこのボードへ行い、応答の時点で別のボードを表示していれば結果を反映しない
  const moveKeyRef = useRef<BoardKey | null>(null);
  // ボードの世代。ボードを切り替えるたびに進め、非同期の応答は送信したときの世代と一致するときだけ反映する
  // （A → B → A と戻ったときに、最初の A の応答を反映しない）
  const genRef = useRef(0);
  const ownRef = useRef<OwnAction[]>([]);
  const interactionRef = useRef<string | null>(null);
  const streamRef = useRef<StreamHandle | null>(null);
  const commitWaiters = useRef<(() => void)[]>([]);
  const boardRef = useRef<HTMLDivElement>(null);
  const forceFocusRef = useRef(false);
  const seqRef = useRef(0);
  const shownKeyRef = useRef<BoardKey | null>(null);
  // ポインターでのドラッグを落とした直後の click（カードの onClick へ伝わる）を無視する
  const justDraggedRef = useRef(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoScroll = useRef<{ list: HTMLElement | null; speed: number; frame: number | null }>({
    list: null,
    speed: 0,
    frame: null,
  });

  const isModal = (): boolean => flowRef.current !== null;
  const isBusy = (): boolean =>
    dragRef.current !== null || grabRef.current !== null || flowRef.current !== null || sendingRef.current;
  const busy = drag !== null || grab !== null || flow !== null || sending;
  const modalOpen = flow !== null;

  const toast = (inputs: ToastInput[]): void => setToasts((s) => pushToasts(s, inputs, isModal()));

  /**
   * 操作の送信先。表示中の resp のキーで、選んでいるボード（key）と一致するときだけ返す。
   * 切り替えの途中（新しいボードをまだ取得していない）は null で、操作しない。
   */
  const actionKey = (): BoardKey | null => {
    const current = respRef.current;
    return current !== null && current.key === keyRef.current ? current.key : null;
  };

  const markOwnAction = (threadId: string): OwnAction => {
    const record: OwnAction = { threadId, expiresAt: Date.now() + OWN_ACTION_TTL_MS };
    ownRef.current = [...pruneOwnActions(ownRef.current, Date.now()), record];
    return record;
  };
  // 送信が失敗したら、その操作の記録だけを外す（同じカードの成功した操作の記録は残す）
  const unmarkOwnAction = (record: OwnAction): void => {
    ownRef.current = ownRef.current.filter((o) => o !== record);
  };

  // ------------------------------------------------------------ snapshot と events

  const applySnapshot = (next: BoardResponse, animate: boolean): void => {
    const prev = respRef.current;
    const ing = ingestSnapshot(prev, next);
    const sel = selectedRef.current;
    if (sel !== null && next.board !== null) {
      const target = resolveSelection(prev?.board ?? null, next.board, sel);
      if (target === null) setSelected(null);
      else if (target.kind === 'card') {
        if (target.threadId !== sel) setSelected(target.threadId);
      } else {
        setSelected(null);
        setFocusColumn(target.column);
      }
    }
    if (ing.changed.length > 0) {
      setHighlighted(new Set(ing.changed));
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlighted(new Set()), HIGHLIGHT_MS);
    }
    if (animate && ing.columnMoved) {
      // 次の snapshot が prev として読めるように ref はすぐに更新する。update は非同期に走るので、
      // その時点で ref が別のもの（後から届いた snapshot など）に変わっていれば何もしない
      respRef.current = next;
      platform.startViewTransition(
        () =>
          new Promise<void>((resolve) => {
            if (respRef.current !== next) {
              resolve();
              return;
            }
            commitWaiters.current.push(resolve);
            setResp(next);
          }),
      );
    } else {
      setResp(next);
    }
  };

  const onSnapshot = (next: BoardResponse): void => {
    const gate = offerSnapshot(next, isBusy());
    pendingRef.current = gate.pending;
    if (next.truncated === true) {
      // イベントを送らない配信なので、件数の分からない 1 件のトーストにして、開いている履歴を読み直す
      toast([{ text: '多数の更新がありました', persistent: false }]);
      const open = drawerRef.current;
      if (open !== null) void loadDrawerEvents(open);
    }
    if (gate.apply !== null) applySnapshot(gate.apply, true);
  };

  const loadDrawerEvents = async (threadId: string): Promise<void> => {
    const k = actionKey();
    if (k === null) return;
    const gen = genRef.current;
    const r = await api.getCardEvents(k, threadId);
    if (genRef.current === gen && drawerRef.current === threadId) setDrawerEvents(r.ok ? r.events : []);
  };

  const onEvents = (events: UiEvent[], info: { initial: boolean; gap: boolean }): void => {
    const now = Date.now();
    ownRef.current = pruneOwnActions(ownRef.current, now);
    toast(eventsToToasts(events, { ...info, own: ownRef.current, now }));
    const open = drawerRef.current;
    if (open !== null && events.some((e) => e.threadId === open)) void loadDrawerEvents(open);
  };

  // 操作が終わったら、溜めていた最新の snapshot を取り込む
  useEffect(() => {
    if (busy) return;
    const gate = releaseSnapshot(pendingRef.current, false);
    pendingRef.current = gate.pending;
    const thread = interactionRef.current;
    interactionRef.current = null;
    if (gate.apply === null) return;
    const ownMove = thread !== null && ownRef.current.some((o) => o.threadId === thread && o.expiresAt >= Date.now());
    if (thread !== null && !ownMove) {
      const notice = grabbedCardNotice(respRef.current, gate.apply, thread);
      if (notice !== null) toast([{ text: notice, persistent: false }]);
    }
    applySnapshot(gate.apply, true);
  }, [busy]);

  // モーダルが閉じたら、溜めていたトーストをまとめて出す
  useEffect(() => {
    if (!modalOpen) setToasts((s) => releaseHeldToasts(s));
  }, [modalOpen]);

  // ------------------------------------------------------------ 起動とボードの切り替え

  /** isCancelled: health を確かめている間に別のボードへ切り替えたら true（前のボードの案内を出さない）。 */
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
      const k = parseHashKey(location.hash);
      if (k !== null && k !== keyRef.current) setKey(k);
    };
    window.addEventListener('hashchange', onHash);
    const unwatch = platform.watchMedia(NARROW_QUERY, setNarrow);
    return () => {
      window.removeEventListener('hashchange', onHash);
      unwatch();
    };
  }, []);

  useEffect(() => {
    if (key === null) return undefined;
    if (shownKeyRef.current !== key) {
      // 別のボードに切り替えたら、前のボードの表示と操作の途中の状態をすぐに捨てる
      // （新しいボードの取得を待つ間や失敗したときに、前のボードのカードを操作させない）
      shownKeyRef.current = key;
      genRef.current += 1;
      setResp(null);
      setSelected(null);
      setFocusColumn(null);
      pendingRef.current = null;
      interactionRef.current = null;
      rollbackRef.current = null;
      moveKeyRef.current = null;
      setGrab(null);
      setDrag(null);
      setFlow(null);
      // 前のボードの送信は世代が変わったので結果を反映しない。新しいボードの操作を止めないように送信中も解除する
      setSending(false);
      setDrawerPending(false);
      setDrawer(null);
      setDrawerEvents(null);
      setDrawerOptions(null);
      setHighlighted(new Set());
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
      pendingRef.current = null;
      applySnapshot(r, false);
      handle = openStream(key, r.lastEventId, { onEvents, onSnapshot, onBanner: setBanner });
      streamRef.current = handle;
    })();
    return () => {
      cancelled = true;
      handle?.close();
      streamRef.current = null;
    };
  }, [key, reloadToken]);

  const onRetry = (): void => {
    setBanner(null);
    if (streamRef.current !== null) streamRef.current.retryNow();
    else if (!loaded) void loadBoards();
    else setReloadToken((n) => n + 1);
  };

  // ------------------------------------------------------------ フォーカス

  // 描画のたびに、フォーカスがボードの中か body にあれば選択中のカードへ戻す（commit を待つ view transition もここで解決する）
  useLayoutEffect(() => {
    for (const resolve of commitWaiters.current.splice(0)) resolve();
    const container = boardRef.current;
    const board = resp?.board ?? null;
    if (container === null || board === null) return;
    const active = document.activeElement;
    const inBoard = active === null || active === document.body || container.contains(active);
    if (!inBoard && !forceFocusRef.current) return;
    forceFocusRef.current = false;
    let target: HTMLElement | null = null;
    if (selected !== null) {
      const pos = findCard(board, selected);
      const card = cardOf(resp, selected);
      if (pos !== null && card !== null) {
        const shown = activeColumn ?? displayColumns(board)[0]?.column ?? null;
        if (narrow && pos.column !== shown) {
          setActiveColumn(pos.column);
          return;
        }
        target = document.getElementById(cardElementId(card.cardId));
      }
    } else if (focusColumn !== null) {
      target = document.getElementById(columnListId(focusColumn));
    }
    if (target !== null && target !== active) {
      platform.focus(target, { preventScroll: true });
      platform.scrollIntoView(target);
    }
  });

  // ------------------------------------------------------------ 移動

  /** 移動の前の snapshot を捨てたときに、移動を反映したボードを取り直す。 */
  const refetchAfterMove = async (k: BoardKey, gen: number, watermark: number): Promise<void> => {
    const r = await api.getBoard(k);
    if (genRef.current !== gen || !r.ok || r.lastEventId < watermark) return;
    // 取り直しの間に SSE で同じか新しい snapshot が届いていれば、そちらを優先する
    const latest = pendingRef.current ?? respRef.current;
    if (latest !== null && r.lastEventId <= latest.lastEventId) return;
    onSnapshot(r);
  };

  const send = async (k: BoardKey, threadId: string, cardId: number, link: string | null, option: MoveOption, reason: string | undefined): Promise<void> => {
    setSending(true);
    const gen = genRef.current;
    const own = markOwnAction(threadId);
    const r = await api.postMove(k, threadId, buildMoveBody(option, reason));
    if (genRef.current !== gen || keyRef.current !== k) {
      // 送信中に別のボードへ切り替えた（戻ってきた場合も含む）。前のボードの表示へ戻したりダイアログを出したりせず、
      // 送信中の状態（切り替えで解除済み。新しいボードの送信中かもしれない）にも触れない
      if (!r.ok) unmarkOwnAction(own);
      return;
    }
    if (r.ok) {
      // 溜めた snapshot は、自分の移動のイベント位置（応答の lastEventId）以上のものだけを取り込む。
      // 応答に lastEventId がなければ、溜めた snapshot が移動を含むか判定できないので捨てて取り直す
      const watermark = r.lastEventId;
      const before = pendingRef.current;
      pendingRef.current = watermark === undefined ? null : pendingAfterMove(before, watermark);
      setSending(false);
      platform.announce(`#${cardId} を ${option.column} へ移動しました`, 500);
      if (r.t3Action !== null) toast([settleToast(r.t3Action, cardId, link)]);
      if (watermark === undefined || (before !== null && pendingRef.current === null)) void refetchAfterMove(k, gen, watermark ?? 0);
      return;
    }
    // 失敗したら元に戻し、ダイアログで理由を示す
    unmarkOwnAction(own);
    if (rollbackRef.current !== null) setResp(rollbackRef.current);
    const card = cardOf(rollbackRef.current, threadId);
    setFlow({
      seq: ++seqRef.current,
      threadId,
      cardId,
      title: card?.title ?? '',
      option,
      steps: [],
      step: 'error',
      error: failureText(r),
    });
    setSending(false);
  };

  const startMove = (threadId: string, option: MoveOption): void => {
    // 送信中の移動と rollbackRef / sending を共有するので、重ねて始めない
    if (sendingRef.current) return;
    const k = actionKey();
    const current = respRef.current;
    const card = cardOf(current, threadId);
    if (k === null || current === null || card === null) return;
    if (!option.allowed) {
      const text = `#${card.cardId} は ${option.column} に移動できません: ${errorLabel(option.code)}`;
      platform.announce(text);
      toast([{ text, persistent: false }]);
      return;
    }
    interactionRef.current = threadId;
    rollbackRef.current = current;
    moveKeyRef.current = k;
    setResp(applyOptimisticMove(current, threadId, option.column));
    const steps = moveSteps(option);
    const first = steps[0];
    if (first === undefined) {
      void send(k, threadId, card.cardId, card.t3?.link ?? null, option, undefined);
      return;
    }
    setFlow({ seq: ++seqRef.current, threadId, cardId: card.cardId, title: card.title, option, steps, step: first });
  };

  const onAdvance = (): void => {
    const f = flowRef.current;
    if (f === null || f.step === 'error') return;
    const next = f.steps[f.steps.indexOf(f.step) + 1];
    if (next !== undefined) setFlow({ ...f, step: next });
  };

  const onConfirm = (reason: string | undefined): void => {
    const f = flowRef.current;
    const k = moveKeyRef.current;
    if (f === null || k === null || k !== actionKey()) return;
    const card = cardOf(rollbackRef.current, f.threadId);
    setSending(true);
    setFlow(null);
    void send(k, f.threadId, f.cardId, card?.t3?.link ?? null, f.option, reason);
  };

  const onCancelDialog = (): void => {
    const f = flowRef.current;
    if (f === null) return;
    setFlow(null);
    if (f.step !== 'error') {
      if (rollbackRef.current !== null) setResp(rollbackRef.current);
      platform.announce('移動を取り消しました');
    }
  };

  /** 移動先の判定。取得できなければ null、取得の間に別のボードへ切り替えたら 'stale'（呼び出し側は何もしない）。 */
  const fetchOptions = async (threadId: string): Promise<MoveOption[] | null | 'stale'> => {
    const k = actionKey();
    if (k === null) return null;
    const gen = genRef.current;
    const r = await api.getMoveOptions(k, threadId);
    if (genRef.current !== gen) return 'stale';
    return r.ok ? r.options : null;
  };

  // ------------------------------------------------------------ キーボード

  const startGrab = (threadId: string): void => {
    if (isBusy()) return;
    const board = respRef.current?.board;
    const pos = board == null ? null : findCard(board, threadId);
    const card = cardOf(respRef.current, threadId);
    if (pos === null || card === null) return;
    interactionRef.current = threadId;
    setGrab({ threadId, from: pos.col, target: pos.col, options: null });
    platform.announce(`#${card.cardId} をつかみました。←/→ で移動先の列、Space で確定、Esc で取り消し`);
    void fetchOptions(threadId).then((options) => {
      const g = grabRef.current;
      if (options === 'stale' || g === null || g.threadId !== threadId) return;
      if (options === null) {
        setGrab(null);
        platform.announce('移動先を確認できませんでした');
        return;
      }
      setGrab({ ...g, options });
    });
  };

  const cancelGrab = (): void => {
    setGrab(null);
    platform.announce('移動を取り消しました');
  };

  const dropGrab = (g: GrabState): void => {
    const board = respRef.current?.board;
    if (board == null) return;
    if (g.target === g.from) {
      cancelGrab();
      return;
    }
    if (g.options === null) {
      platform.announce('移動先を確認しています');
      return;
    }
    const column = displayColumns(board)[g.target]?.column;
    const option = g.options.find((o) => o.column === column);
    setGrab(null);
    if (option !== undefined) startMove(g.threadId, option);
  };

  const collectRects = (): Record<string, VRect> => {
    const rects: Record<string, VRect> = {};
    for (const col of respRef.current?.board?.columns ?? []) {
      for (const c of col.cards) {
        const r = platform.rect(document.getElementById(cardElementId(c.cardId)));
        rects[c.threadId] = { top: r.top, bottom: r.bottom };
      }
    }
    return rects;
  };

  const onCardKeyDown = (ev: TargetedKeyboardEvent<HTMLElement>, threadId: string): void => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    const board = respRef.current?.board;
    if (board == null) return;
    const g = grabRef.current;
    if (g !== null) {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        const cols = displayColumns(board);
        const target = g.target + (ev.key === 'ArrowLeft' ? -1 : 1);
        if (target < 0 || target >= cols.length) return;
        ev.preventDefault();
        setGrab({ ...g, target });
        const column = (cols[target] as (typeof cols)[number]).column;
        const verdict = target === g.from ? '現在の列' : g.options === null ? '確認中' : columnVerdicts(g.options.find((o) => o.column === column)).map((v) => v.label).join('・');
        platform.announce(`移動先: ${column}（${verdict}）`);
      } else if (ev.key === ' ') {
        ev.preventDefault();
        dropGrab(g);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        cancelGrab();
      }
      return;
    }
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown' || ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      const target = nextFocus(board, threadId, ev.key, collectRects());
      if (target === null) return;
      ev.preventDefault();
      setSelected(target);
      setFocusColumn(null);
      const pos = findCard(board, target);
      if (narrow && pos !== null) setActiveColumn(pos.column);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      openDrawer(threadId);
    } else if (ev.key === ' ') {
      ev.preventDefault();
      startGrab(threadId);
    }
  };

  // つかんだカードからフォーカスが外れたら取り消す（残すと snapshot を溜めたままになる）
  const onBoardFocusOut = (ev: TargetedFocusEvent<HTMLDivElement>): void => {
    const g = grabRef.current;
    if (g === null) return;
    const card = cardOf(respRef.current, g.threadId);
    const el = card === null ? null : document.getElementById(cardElementId(card.cardId));
    const next = ev.relatedTarget;
    if (el !== null && next instanceof Node && el.contains(next)) return;
    cancelGrab();
  };

  const onCardFocus = (threadId: string): void => {
    if (selectedRef.current !== threadId) setSelected(threadId);
    setFocusColumn(null);
  };

  const onColumnFocus = (column: Column): void => {
    const col = respRef.current?.board?.columns.find((c) => c.column === column);
    const first = col?.cards[0];
    if (first !== undefined) {
      setSelected(first.threadId);
      setFocusColumn(null);
    } else {
      setSelected(null);
      setFocusColumn(column);
    }
  };

  const onSelectTab = (column: Column): void => {
    setActiveColumn(column);
    const first = respRef.current?.board?.columns.find((c) => c.column === column)?.cards[0];
    setSelected(first?.threadId ?? null);
    setFocusColumn(first === undefined ? column : null);
  };

  // ------------------------------------------------------------ ポインターでのドラッグ

  const columnAt = (x: number, y: number): Column | null => {
    const el = platform.elementFromPoint(x, y);
    const col = el?.closest('[data-column]')?.getAttribute('data-column');
    return (col ?? null) as Column | null;
  };

  const stopAutoScroll = (): void => {
    const a = autoScroll.current;
    if (a.frame !== null) platform.cancelFrame(a.frame);
    autoScroll.current = { list: null, speed: 0, frame: null };
  };

  const updateAutoScroll = (x: number, y: number): void => {
    const el = platform.elementFromPoint(x, y);
    const list = el?.closest('[data-column]')?.querySelector<HTMLElement>('[role="listbox"]') ?? null;
    const a = autoScroll.current;
    if (list === null) {
      a.speed = 0;
      return;
    }
    const r = platform.rect(list);
    a.list = list;
    a.speed = y < r.top + AUTOSCROLL_EDGE_PX ? -AUTOSCROLL_SPEED_PX : y > r.bottom - AUTOSCROLL_EDGE_PX ? AUTOSCROLL_SPEED_PX : 0;
    if (a.speed !== 0 && a.frame === null) {
      const step = (): void => {
        const cur = autoScroll.current;
        if (cur.list === null || cur.speed === 0) {
          cur.frame = null;
          return;
        }
        cur.list.scrollTop += cur.speed;
        cur.frame = platform.requestFrame(step);
      };
      a.frame = platform.requestFrame(step);
    }
  };

  const finishDrag = (drop: boolean): void => {
    const d = dragRef.current;
    if (d === null) return;
    stopAutoScroll();
    setDrag(null);
    justDraggedRef.current = true;
    setTimeout(() => {
      justDraggedRef.current = false;
    }, 0);
    if (!drop) {
      platform.announce('移動を取り消しました');
      return;
    }
    const board = respRef.current?.board;
    const from = board == null ? null : findCard(board, d.threadId)?.column;
    if (d.over === null || d.over === from) return;
    if (d.options === null) {
      platform.announce('移動先を確認できませんでした');
      return;
    }
    const option = d.options.find((o) => o.column === d.over);
    if (option !== undefined) startMove(d.threadId, option);
  };

  const onHandlePointerDown = (ev: TargetedPointerEvent<HTMLElement>, threadId: string): void => {
    if (ev.button !== 0 || isBusy()) return;
    const card = cardOf(respRef.current, threadId);
    if (card === null) return;
    ev.preventDefault();
    ev.stopPropagation();
    const r = platform.rect(document.getElementById(cardElementId(card.cardId)));
    platform.setPointerCapture(ev.currentTarget, ev.pointerId);
    interactionRef.current = threadId;
    setSelected(threadId);
    setDrag({
      threadId,
      pointerId: ev.pointerId,
      x: ev.clientX,
      y: ev.clientY,
      offsetX: ev.clientX - r.left,
      offsetY: ev.clientY - r.top,
      width: r.width,
      height: r.height,
      over: null,
      options: null,
    });
    void fetchOptions(threadId).then((options) => {
      const d = dragRef.current;
      if (options !== 'stale' && d !== null && d.threadId === threadId) setDrag({ ...d, options });
    });
  };

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (d === null || e.pointerId !== d.pointerId) return;
      setDrag({ ...d, x: e.clientX, y: e.clientY, over: columnAt(e.clientX, e.clientY) });
      updateAutoScroll(e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId === dragRef.current?.pointerId) finishDrag(true);
    };
    const onCancel = (e: PointerEvent): void => {
      if (e.pointerId === dragRef.current?.pointerId) finishDrag(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finishDrag(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey, true);
      stopAutoScroll();
    };
  }, [dragging]);

  // ------------------------------------------------------------ ドロワー

  const openDrawer = (threadId: string): void => {
    setSelected(threadId);
    setDrawer(threadId);
    setDrawerEvents(null);
    setDrawerOptions(null);
    void loadDrawerEvents(threadId);
  };

  const onCardClick = (threadId: string): void => {
    if (justDraggedRef.current) return;
    openDrawer(threadId);
  };

  const closeDrawer = (): void => {
    if (grabRef.current !== null || dragRef.current !== null) return;
    setDrawer(null);
    forceFocusRef.current = true;
  };

  const runCardAction = async (k: BoardKey, threadId: string, action: () => Promise<{ ok: true } | ApiFailure>, done: string): Promise<void> => {
    setDrawerPending(true);
    const own = markOwnAction(threadId);
    const gen = genRef.current;
    const r = await action();
    if (genRef.current !== gen || keyRef.current !== k) {
      // 送信中に別のボードへ切り替えた。前のボードの結果は知らせない（送信中の表示は切り替えたときに解除済み。新しいボードの送信中を消さない）
      if (!r.ok) unmarkOwnAction(own);
      return;
    }
    setDrawerPending(false);
    if (r.ok) platform.announce(done);
    else {
      unmarkOwnAction(own);
      toast([{ text: failureText(r), persistent: false }]);
    }
    void loadDrawerEvents(threadId);
  };

  const onBlock = (reason: string): void => {
    const threadId = drawerRef.current;
    const k = actionKey();
    if (threadId === null || k === null) return;
    void runCardAction(k, threadId, () => api.postBlock(k, threadId, reason), 'ブロックしました');
  };

  const onUnblock = (): void => {
    const threadId = drawerRef.current;
    const k = actionKey();
    if (threadId === null || k === null) return;
    void runCardAction(k, threadId, () => api.postUnblock(k, threadId), 'ブロックを解除しました');
  };

  const onRequestOptions = (): void => {
    const threadId = drawerRef.current;
    if (threadId === null) return;
    setDrawerOptions(null);
    void fetchOptions(threadId).then((options) => {
      if (options !== 'stale' && drawerRef.current === threadId) setDrawerOptions(options ?? []);
    });
  };

  const onChooseOption = (option: MoveOption): void => {
    const threadId = drawerRef.current;
    if (threadId !== null) startMove(threadId, option);
  };

  // ------------------------------------------------------------ 描画

  const board = resp?.board ?? null;
  const drawerCard = drawer === null ? null : cardOf(resp, drawer);
  const drawerColumn = drawer === null || board === null ? null : (findCard(board, drawer)?.column ?? null);

  return (
    <>
      <Header
        boards={boards}
        currentKey={key}
        resp={resp}
        recent={toasts.recent}
        onSwitch={(k) => {
          if (k !== keyRef.current) setKey(k);
        }}
      />
      <BannerView banner={banner} onRetry={onRetry} />
      <main class="main">
        {resp === null ? (
          loaded && key === null ? (
            <EmptyState />
          ) : (
            <p class="loading">読み込んでいます…</p>
          )
        ) : board === null ? (
          <EmptyState />
        ) : (
          <div ref={boardRef} class="board-host" onFocusOut={onBoardFocusOut}>
            <Board
              board={board}
              selected={selected}
              grab={grab}
              drag={drag}
              highlighted={highlighted}
              narrow={narrow}
              activeColumn={activeColumn}
              onCardKeyDown={onCardKeyDown}
              onCardFocus={onCardFocus}
              onCardClick={onCardClick}
              onColumnFocus={onColumnFocus}
              onHandlePointerDown={onHandlePointerDown}
              onSelectTab={onSelectTab}
            />
          </div>
        )}
      </main>
      <Drawer
        threadId={drawer}
        card={drawerCard}
        column={drawerColumn}
        events={drawerEvents}
        options={drawerOptions}
        pending={drawerPending || sending}
        onClose={closeDrawer}
        onBlock={onBlock}
        onUnblock={onUnblock}
        onRequestOptions={onRequestOptions}
        onChooseOption={onChooseOption}
      />
      <MoveDialog flow={flow} onAdvance={onAdvance} onConfirm={onConfirm} onCancel={onCancelDialog} />
      <Toasts toasts={toasts.visible} onDismiss={(id) => setToasts((s) => dismissToast(s, id))} />
    </>
  );
}
