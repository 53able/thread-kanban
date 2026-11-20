// 画面の操作・選択・フォーカスと、ボードのセッションをつなぐ。

import type { JSX, TargetedFocusEvent, TargetedKeyboardEvent, TargetedPointerEvent } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import * as api from '../api.js';
import type { ApiFailure, BoardCardView, BoardResponse, Column, MoveOption, UiEvent } from '../api-types.js';
import * as platform from '../platform.js';
import { useBoardSession, type BoardAction } from '../board-session.js';
import { useRefState } from '../use-ref-state.js';
import {
  OWN_ACTION_TTL_MS,
  applyOptimisticMove,
  buildMoveBody,
  columnVerdicts,
  dismissToast,
  displayColumns,
  emptyToasts,
  errorLabel,
  eventsToToasts,
  findCard,
  grabbedCardNotice,
  moveSteps,
  nextFocus,
  pruneOwnActions,
  pushToasts,
  releaseHeldToasts,
  resolveSelection,
  settleToast,
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

function cardOf(resp: BoardResponse | null, threadId: string): BoardCardView | null {
  return resp?.board?.columns.flatMap((c) => c.cards).find((c) => c.threadId === threadId) ?? null;
}

function failureText(r: ApiFailure): string {
  return `${errorLabel(r.code)}（${r.message}）`;
}

export function App(): JSX.Element {
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
  const [highlighted, setHighlighted] = useState<ReadonlySet<number>>(new Set());
  const [narrow, setNarrow] = useState(false);
  const [activeColumn, setActiveColumn] = useState<Column | null>(null);
  const rollbackRef = useRef<BoardResponse | null>(null);
  const moveActionRef = useRef<BoardAction | null>(null);
  const ownRef = useRef<OwnAction[]>([]);
  const interactionRef = useRef<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const forceFocusRef = useRef(false);
  const seqRef = useRef(0);
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

  const { boards, key, loaded, resp, banner, selectBoard, retry, beginAction, current, setResp, reconcileMove } =
    useBoardSession({ busy, isBusy, onBoardChange, onEvents, onTruncated, onRelease, onApply });

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

  function onApply(prev: BoardResponse | null, next: BoardResponse, changed: readonly number[]): void {
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
    if (changed.length > 0) {
      setHighlighted(new Set(changed));
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlighted(new Set()), HIGHLIGHT_MS);
    }
  }

  function onTruncated(): void {
    // イベントを送らない配信なので、件数の分からない 1 件のトーストにして、開いている履歴を読み直す
    toast([{ text: '多数の更新がありました', persistent: false }]);
    const open = drawerRef.current;
    if (open !== null) void loadDrawerEvents(open);
  }

  const loadDrawerEvents = async (threadId: string): Promise<void> => {
    const action = beginAction();
    if (action === null) return;
    const r = await api.getCardEvents(action.key, threadId);
    if (action.isCurrent() && drawerRef.current === threadId) setDrawerEvents(r.ok ? r.events : []);
  };

  function onEvents(events: UiEvent[], info: { initial: boolean; gap: boolean }): void {
    const now = Date.now();
    ownRef.current = pruneOwnActions(ownRef.current, now);
    toast(eventsToToasts(events, { ...info, own: ownRef.current, now }));
    const open = drawerRef.current;
    if (open !== null && events.some((e) => e.threadId === open)) void loadDrawerEvents(open);
  }

  function onRelease(next: BoardResponse | null): void {
    const thread = interactionRef.current;
    interactionRef.current = null;
    if (next === null) return;
    const ownMove = thread !== null && ownRef.current.some((o) => o.threadId === thread && o.expiresAt >= Date.now());
    if (thread !== null && !ownMove) {
      const notice = grabbedCardNotice(current(), next, thread);
      if (notice !== null) toast([{ text: notice, persistent: false }]);
    }
  }

  // モーダルが閉じたら、溜めていたトーストをまとめて出す
  useEffect(() => {
    if (!modalOpen) setToasts((s) => releaseHeldToasts(s));
  }, [modalOpen]);

  function onBoardChange(): void {
    setSelected(null);
    setFocusColumn(null);
    interactionRef.current = null;
    rollbackRef.current = null;
    moveActionRef.current = null;
    setGrab(null);
    setDrag(null);
    setFlow(null);
    setSending(false);
    setDrawerPending(false);
    setDrawer(null);
    setDrawerEvents(null);
    setDrawerOptions(null);
    setHighlighted(new Set());
  }

  useEffect(() => platform.watchMedia(NARROW_QUERY, setNarrow), []);

  // ------------------------------------------------------------ フォーカス

  // 描画のたびに、フォーカスがボードの中か body にあれば選択中のカードへ戻す
  useLayoutEffect(() => {
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

  const send = async (action: BoardAction, threadId: string, cardId: number, link: string | null, option: MoveOption, reason: string | undefined): Promise<void> => {
    setSending(true);
    const own = markOwnAction(threadId);
    const r = await api.postMove(action.key, threadId, buildMoveBody(option, reason));
    if (!action.isCurrent()) {
      // 送信中に別のボードへ切り替えた（戻ってきた場合も含む）。前のボードの表示へ戻したりダイアログを出したりせず、
      // 送信中の状態（切り替えで解除済み。新しいボードの送信中かもしれない）にも触れない
      if (!r.ok) unmarkOwnAction(own);
      return;
    }
    if (r.ok) {
      setSending(false);
      platform.announce(`#${cardId} を ${option.column} へ移動しました`, 500);
      if (r.t3Action !== null) toast([settleToast(r.t3Action, cardId, link)]);
      reconcileMove(action, r.lastEventId);
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
    const action = beginAction();
    const snapshot = current();
    const card = cardOf(snapshot, threadId);
    if (action === null || snapshot === null || card === null) return;
    if (!option.allowed) {
      const text = `#${card.cardId} は ${option.column} に移動できません: ${errorLabel(option.code)}`;
      platform.announce(text);
      toast([{ text, persistent: false }]);
      return;
    }
    interactionRef.current = threadId;
    rollbackRef.current = snapshot;
    moveActionRef.current = action;
    setResp(applyOptimisticMove(snapshot, threadId, option.column));
    const steps = moveSteps(option);
    const first = steps[0];
    if (first === undefined) {
      void send(action, threadId, card.cardId, card.t3?.link ?? null, option, undefined);
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
    const action = moveActionRef.current;
    if (f === null || action === null || !action.isCurrent()) return;
    const card = cardOf(rollbackRef.current, f.threadId);
    setSending(true);
    setFlow(null);
    void send(action, f.threadId, f.cardId, card?.t3?.link ?? null, f.option, reason);
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
    const action = beginAction();
    if (action === null) return null;
    const r = await api.getMoveOptions(action.key, threadId);
    if (!action.isCurrent()) return 'stale';
    return r.ok ? r.options : null;
  };

  // ------------------------------------------------------------ キーボード

  const startGrab = (threadId: string): void => {
    if (isBusy()) return;
    const board = current()?.board;
    const pos = board == null ? null : findCard(board, threadId);
    const card = cardOf(current(), threadId);
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
    const board = current()?.board;
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
    for (const col of current()?.board?.columns ?? []) {
      for (const c of col.cards) {
        const r = platform.rect(document.getElementById(cardElementId(c.cardId)));
        rects[c.threadId] = { top: r.top, bottom: r.bottom };
      }
    }
    return rects;
  };

  const onCardKeyDown = (ev: TargetedKeyboardEvent<HTMLElement>, threadId: string): void => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    const board = current()?.board;
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
    const card = cardOf(current(), g.threadId);
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
    const col = current()?.board?.columns.find((c) => c.column === column);
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
    const first = current()?.board?.columns.find((c) => c.column === column)?.cards[0];
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
    const board = current()?.board;
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
    const card = cardOf(current(), threadId);
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

  const runCardAction = async (action: BoardAction, threadId: string, request: () => Promise<{ ok: true } | ApiFailure>, done: string): Promise<void> => {
    setDrawerPending(true);
    const own = markOwnAction(threadId);
    const r = await request();
    if (!action.isCurrent()) {
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
    const action = beginAction();
    if (threadId === null || action === null) return;
    void runCardAction(action, threadId, () => api.postBlock(action.key, threadId, reason), 'ブロックしました');
  };

  const onUnblock = (): void => {
    const threadId = drawerRef.current;
    const action = beginAction();
    if (threadId === null || action === null) return;
    void runCardAction(action, threadId, () => api.postUnblock(action.key, threadId), 'ブロックを解除しました');
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
        onSwitch={selectBoard}
      />
      <BannerView banner={banner} onRetry={retry} />
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
