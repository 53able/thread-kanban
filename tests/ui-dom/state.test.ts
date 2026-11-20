import { describe, expect, it } from 'vitest';
import {
  MAX_VALID_FAILURES,
  applyOptimisticMove,
  attentionCount,
  backoffMs,
  buildMoveBody,
  classifyDisconnect,
  columnVerdicts,
  decideDisconnect,
  emptyToasts,
  eventText,
  eventsToToasts,
  grabbedCardNotice,
  ingestSnapshot,
  moveSteps,
  nextFocus,
  offerSnapshot,
  pushToasts,
  releaseHeldToasts,
  releaseSnapshot,
  pendingAfterMove,
  resolveSelection,
  safeHttpUrl,
  settleToast,
  type DisconnectKind,
} from '../../ui/state.js';
import { boardResp, card, event, option } from './fixtures.js';

const board3 = boardResp({
  cards: {
    inbox: [card(1), card(2), card(3)],
    ready: [card(4)],
    doing: [],
    review: [card(5), card(6)],
  },
});

describe('nextFocus（論理的な位置で求める。rect がすべて 0 でも動く）', () => {
  const b = board3.board!;
  it('↑/↓ で列の中を移り、端では null', () => {
    expect(nextFocus(b, 't-1', 'ArrowDown')).toBe('t-2');
    expect(nextFocus(b, 't-2', 'ArrowUp')).toBe('t-1');
    expect(nextFocus(b, 't-1', 'ArrowUp')).toBeNull();
    expect(nextFocus(b, 't-3', 'ArrowDown')).toBeNull();
  });
  it('←/→ は隣の列の同じ番号（範囲外なら末尾）へ移り、空の列は飛ばす', () => {
    expect(nextFocus(b, 't-3', 'ArrowRight')).toBe('t-4');
    expect(nextFocus(b, 't-4', 'ArrowRight')).toBe('t-5');
    expect(nextFocus(b, 't-6', 'ArrowLeft')).toBe('t-4');
    expect(nextFocus(b, 't-1', 'ArrowLeft')).toBeNull();
    expect(nextFocus(b, 't-5', 'ArrowRight')).toBeNull();
  });
  it('rect がすべて 0 なら論理位置、rect があれば縦の位置が近いカード', () => {
    const zeros = Object.fromEntries(['t-1', 't-2', 't-3', 't-4', 't-5', 't-6'].map((t) => [t, { top: 0, bottom: 0 }]));
    expect(nextFocus(b, 't-2', 'ArrowRight', zeros)).toBe('t-4');
    const rects = { ...zeros, 't-4': { top: 0, bottom: 10 }, 't-5': { top: 0, bottom: 10 }, 't-6': { top: 100, bottom: 110 }, 't-3': { top: 95, bottom: 105 } };
    expect(nextFocus(b, 't-3', 'ArrowRight', rects)).toBe('t-4');
    expect(nextFocus(b, 't-6', 'ArrowLeft', rects)).toBe('t-4');
  });
  it('矢印以外は null', () => {
    expect(nextFocus(b, 't-1', 'Home')).toBeNull();
  });
});

describe('classifyDisconnect と decideDisconnect', () => {
  const cases: [Parameters<typeof classifyDisconnect>[0], DisconnectKind][] = [
    [{ kind: 'network' }, 'unreachable'],
    [{ kind: 'http', status: 200, body: { ok: true, version: '1', authenticated: 'valid' } }, 'valid'],
    [{ kind: 'http', status: 403, body: null }, 'forbidden'],
    [{ kind: 'http', status: 200, body: { ok: true, version: '1', authenticated: 'none' } }, 'no-cookie'],
  ];
  it.each(cases)('%j → %s', (input, kind) => {
    expect(classifyDisconnect(input)).toBe(kind);
  });
  it('接続できないときは再試行し、403 / cookie なしは再試行をやめて再認証の案内', () => {
    expect(decideDisconnect('unreachable', 3)).toEqual({ banner: 'offline', retry: true, validFailures: 0 });
    expect(decideDisconnect('forbidden', 0)).toMatchObject({ banner: 'reauth', retry: false });
    expect(decideDisconnect('no-cookie', 0)).toMatchObject({ banner: 'reauth', retry: false });
  });
  it('valid が 5 回続いたら「ボードを読み込めません」を出して自動の再試行をやめる', () => {
    let n = 0;
    for (let i = 1; i < MAX_VALID_FAILURES; i += 1) {
      const d = decideDisconnect('valid', n);
      expect(d).toEqual({ banner: null, retry: true, validFailures: i });
      n = d.validFailures;
    }
    expect(decideDisconnect('valid', n)).toEqual({ banner: 'unavailable', retry: false, validFailures: MAX_VALID_FAILURES });
  });
  it('待ち時間は指数的に延び、上限は 10 秒', () => {
    expect(backoffMs(0)).toBe(500);
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(10)).toBe(10_000);
  });
});

describe('イベントからトースト', () => {
  it('文の形（#12 が review に移動（エージェント））', () => {
    expect(eventText(event(1, { cardId: 12, title: null }))).toBe('#12 が review に移動（エージェント）');
    expect(eventText(event(1, { type: 'blocked', data: { reason: '待ち' }, actor: 'ui' }))).toBe('#1「カード1」 がブロック中: 待ち（UI）');
  });
  it('初回の接続ではトーストを出さない', () => {
    expect(eventsToToasts([event(1)], { initial: true, gap: false, own: [], now: 0 })).toEqual([]);
  });
  it('再接続時の取りこぼしは件数をまとめた 1 件にする', () => {
    expect(eventsToToasts([event(1), event(2), event(3)], { initial: false, gap: true, own: [], now: 0 })).toEqual([
      { text: '切断中に 3 件の更新', persistent: false },
    ]);
  });
  it('このタブが送った UI の操作（actor: ui、同じカード、期限内）はトーストにしない', () => {
    const own = [{ threadId: 't-1', expiresAt: 100 }];
    const events = [event(1, { actor: 'ui' }), event(2, { actor: 'ui', threadId: 't-2', cardId: 2 }), event(3, { actor: null })];
    const out = eventsToToasts(events, { initial: false, gap: false, own, now: 50 });
    expect(out.map((t) => t.text)).toEqual([eventText(events[1]!), eventText(events[2]!)]);
    expect(eventsToToasts([event(1, { actor: 'ui' })], { initial: false, gap: false, own, now: 200 })).toHaveLength(1);
  });
  it('モーダルの表示中は溜め、閉じた後に件数をまとめて出す（settle の通知は個別に残す）', () => {
    let s = pushToasts(emptyToasts(), [{ text: 'a', persistent: false }, { text: 'b', persistent: false }], true);
    const settle = settleToast({ tool: 't3_thread_organize', args: { action: 'settle', threadId: 't-1' }, reason: 'r' }, 1, null);
    s = pushToasts(s, [settle], true);
    expect(s.visible).toEqual([]);
    expect(s.held).toHaveLength(3);
    expect(s.recent.map((r) => r.text)).toEqual([settle.text, 'b', 'a']);
    s = releaseHeldToasts(s);
    expect(s.held).toEqual([]);
    expect(s.visible.map((t) => [t.text, t.persistent])).toEqual([
      [settle.text, true],
      ['ダイアログの表示中に 2 件の更新', false],
    ]);
  });
  it('settle の通知は自動で消えず、リンクと指示文を持つ', () => {
    const t = settleToast({ tool: 't3_thread_organize', args: { action: 'unsettle', threadId: 't-9' }, reason: 'r' }, 9, 'https://t3/x');
    expect(t.persistent).toBe(true);
    expect(t.settle).toMatchObject({ action: 'unsettle', threadId: 't-9', link: 'https://t3/x' });
    expect(t.settle?.instruction).toContain('t3_thread_organize');
    expect(t.settle?.instruction).toContain('"t-9"');
  });
});

describe('snapshot の取り込み', () => {
  it('busy の間は最新の 1 件だけを溜め、終わってから取り込む', () => {
    const a = boardResp({ lastEventId: 1 });
    const b = boardResp({ lastEventId: 2 });
    let g = offerSnapshot(a, true);
    expect(g).toEqual({ apply: null, pending: a });
    g = offerSnapshot(b, true);
    expect(g).toEqual({ apply: null, pending: b });
    expect(releaseSnapshot(g.pending, true)).toEqual({ apply: null, pending: b });
    expect(releaseSnapshot(g.pending, false)).toEqual({ apply: b, pending: null });
    expect(offerSnapshot(a, false)).toEqual({ apply: a, pending: null });
  });
  it('移動の成功後は、溜めた snapshot を lastEventId（自分の移動のイベント位置）で判定する', () => {
    const before = boardResp({ cards: { inbox: [card(1)] }, lastEventId: 5 });
    const after = boardResp({ cards: { ready: [card(1)] }, lastEventId: 6 });
    expect(pendingAfterMove(before, 6)).toBeNull();
    expect(pendingAfterMove(after, 6)).toBe(after);
    expect(pendingAfterMove(null, 6)).toBeNull();
  });
  it('自分の移動より後に別の操作で列が変わった snapshot も捨てない（レビュー 2026-11-20 の probe）', () => {
    // 初期の位置 10、自分の移動（inbox → ready）が 11、その後のエージェントの移動で doing にある snapshot が 12
    const later = boardResp({ cards: { doing: [card(1)] }, lastEventId: 12 });
    expect(pendingAfterMove(later, 11)).toBe(later);
  });
  it('変わったカードと、列の移動があったかを返す', () => {
    const before = boardResp({ cards: { doing: [card(1), card(2)] } });
    const after = boardResp({ cards: { doing: [card(2, { blocked: { reason: 'x', since: '', days: 0 } })], review: [card(1)], inbox: [card(3)] } });
    const r = ingestSnapshot(before, after);
    expect(r.changed.sort()).toEqual([1, 2, 3]);
    expect(r.columnMoved).toBe(true);
    expect(ingestSnapshot(null, after)).toEqual({ resp: after, changed: [], columnMoved: false });
  });
  it('つかんでいたカードの状態が変わっていれば知らせる', () => {
    const before = boardResp({ cards: { doing: [card(1)] } });
    expect(grabbedCardNotice(before, boardResp({ cards: { review: [card(1)] } }), 't-1')).toContain('review');
    expect(grabbedCardNotice(before, boardResp(), 't-1')).toContain('消えました');
    expect(grabbedCardNotice(before, before, 't-1')).toBeNull();
  });
});

describe('選択の追従', () => {
  it('列が変わっても同じカードを選んだまま、消えたら同じ列の隣、列が空なら列', () => {
    const before = boardResp({ cards: { doing: [card(1), card(2), card(3)] } }).board!;
    expect(resolveSelection(before, boardResp({ cards: { review: [card(2)] } }).board!, 't-2')).toEqual({ kind: 'card', threadId: 't-2' });
    expect(resolveSelection(before, boardResp({ cards: { doing: [card(1), card(3)] } }).board!, 't-2')).toEqual({ kind: 'card', threadId: 't-3' });
    expect(resolveSelection(before, boardResp({ cards: { doing: [card(1)] } }).board!, 't-3')).toEqual({ kind: 'card', threadId: 't-1' });
    expect(resolveSelection(before, boardResp().board!, 't-1')).toEqual({ kind: 'column', column: 'doing' });
  });
});

describe('移動の組み立て', () => {
  it('送信前に移動先の末尾へ移し、件数と WIP 超過を数え直す（元の値は変えない）', () => {
    const r = boardResp({ cards: { ready: [card(1)], review: [card(2), card(3)], doing: [card(4)] } });
    const moved = applyOptimisticMove(r, 't-4', 'review');
    const review = moved.board!.columns.find((c) => c.column === 'review')!;
    expect(review.cards.map((c) => c.cardId)).toEqual([2, 3, 4]);
    expect(review.overLimit).toBe(true);
    expect(moved.board!.wipViolations).toEqual([{ column: 'review', wipLimit: 2, count: 3 }]);
    expect(r.board!.columns.find((c) => c.column === 'doing')!.cards).toHaveLength(1);
  });
  it('criteriaConfirmed は needsCriteria の列でだけ、force / reason は WIP 超過の強行でだけ付ける', () => {
    expect(buildMoveBody(option('review'))).toEqual({ to: 'review' });
    expect(buildMoveBody(option('review', { needsCriteria: true, entryCriteria: ['a'] }))).toEqual({ to: 'review', criteriaConfirmed: true });
    expect(buildMoveBody(option('review', { wip: 'exceeded' }), '急ぎ')).toEqual({ to: 'review', force: true, reason: '急ぎ' });
    expect(buildMoveBody(option('review', { wip: 'ok' }), '急ぎ')).toEqual({ to: 'review' });
  });
  it('ダイアログの段は入場条件 → WIP の順に必要なものだけ', () => {
    expect(moveSteps(option('review'))).toEqual([]);
    expect(moveSteps(option('review', { needsCriteria: true, wip: 'exceeded' }))).toEqual(['criteria', 'wip']);
    expect(moveSteps(option('review', { wip: 'exceeded' }))).toEqual(['wip']);
    expect(moveSteps(option('review', { wip: 'expediteOver' }))).toEqual([]);
  });
  it('列の判定（禁止／入場条件あり／WIP 超過／expedite 超過（警告）／可）', () => {
    expect(columnVerdicts(undefined).map((v) => v.kind)).toEqual(['current']);
    expect(columnVerdicts(option('done', { allowed: false, code: 'SKIP_NOT_ALLOWED', wip: null })).map((v) => v.kind)).toEqual(['forbidden']);
    expect(columnVerdicts(option('review', { needsCriteria: true, wip: 'exceeded' })).map((v) => v.kind)).toEqual(['criteria', 'wip']);
    expect(columnVerdicts(option('review', { wip: 'expediteOver' })).map((v) => v.label)).toEqual(['expedite 超過（警告）']);
    expect(columnVerdicts(option('review')).map((v) => v.label)).toEqual(['可']);
  });
});

describe('要対応の件数', () => {
  it('ブロック・期限超過・stale のどれかに当たるカードの枚数（重複は 1 枚）', () => {
    const r = boardResp({
      cards: {
        doing: [card(1, { blocked: { reason: 'x', since: '', days: 1 }, stale: true }), card(2, { overdue: true, dueDate: '2026-01-01' })],
        review: [card(3)],
      },
    });
    expect(attentionCount(r.board!)).toBe(2);
  });
});

describe('リンクの検証', () => {
  it('http: と https: の URL だけを通す', () => {
    expect(safeHttpUrl('https://t3.example/t/1')).toBe('https://t3.example/t/1');
    expect(safeHttpUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,x')).toBeNull();
    expect(safeHttpUrl('/relative')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});
