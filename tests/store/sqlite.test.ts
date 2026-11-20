import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBoardView, computeMetrics } from '../../src/domain/metrics.js';
import type { Column } from '../../src/domain/types.js';
import { KanbanStore } from '../../src/store/sqlite.js';
import { DAY, manualClock, T0, tempDir } from '../helpers/fixtures.js';

let dir: ReturnType<typeof tempDir>;
let clock: ReturnType<typeof manualClock>;
let store: KanbanStore;

beforeEach(() => {
  dir = tempDir();
  clock = manualClock();
  store = KanbanStore.open({ path: join(dir.path, 'k.db'), boardId: 'b1', clock });
});

afterEach(() => {
  store.close();
  dir.cleanup();
});

function add(threadId: string, extra: Record<string, unknown> = {}) {
  const r = store.addCard({ threadId, title: threadId, ...extra });
  if (!r.ok) throw new Error(r.error.code);
  return r.value.card;
}

function moveAlong(threadId: string, path: Column[]) {
  for (const to of path) {
    const r = store.moveCard(threadId, { to });
    if (!r.ok) throw new Error(`${threadId} → ${to}: ${r.error.code}`);
  }
}

describe('KanbanStore: 初期化', () => {
  it('WAL と busy_timeout が設定され、既定の WIP 上限を持つ', () => {
    const cfg = store.getBoardConfig();
    expect(cfg.columns.map((c) => [c.name, c.wipLimit])).toEqual([
      ['inbox', null],
      ['ready', 5],
      ['doing', 3],
      ['review', 2],
      ['done', null],
    ]);
    const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBeGreaterThan(0);
  });

  it('同じ DB を開き直しても設定とカードが残る', () => {
    add('t1');
    store.configure({ columns: [{ column: 'doing', wipLimit: 4 }] });
    store.close();
    store = KanbanStore.open({ path: join(dir.path, 'k.db'), boardId: 'b1', clock });
    expect(store.getCard('t1')?.title).toBe('t1');
    expect(store.getBoardConfig().columns.find((c) => c.name === 'doing')?.wipLimit).toBe(4);
  });
});

describe('KanbanStore: カード登録', () => {
  it('同じ threadId で 2 回 add してもカードは 1 枚', () => {
    const first = store.addCard({ threadId: 't1', title: '最初' });
    const second = store.addCard({ threadId: 't1', title: '二回目' });
    expect(first.ok && first.value.created).toBe(true);
    expect(second.ok && second.value.created).toBe(false);
    expect(second.ok && second.value.card.title).toBe('最初');
    expect(store.snapshot().cards).toHaveLength(1);
  });

  it('fixed_date で dueDate なしの登録は DUE_DATE_REQUIRED', () => {
    const r = store.addCard({ threadId: 't1', title: 'x', serviceClass: 'fixed_date' });
    expect(!r.ok && r.error.code).toBe('DUE_DATE_REQUIRED');
    expect(store.snapshot().cards).toHaveLength(0);
  });

  it('ボード上 2 枚目の expedite 登録は EXPEDITE_LIMIT', () => {
    add('e1', { serviceClass: 'expedite' });
    const r = store.addCard({ threadId: 'e2', title: 'x', serviceClass: 'expedite' });
    expect(!r.ok && r.error.code).toBe('EXPEDITE_LIMIT');
  });

  it('expedite が done になれば次の expedite を登録できる', () => {
    add('e1', { serviceClass: 'expedite' });
    moveAlong('e1', ['ready', 'doing', 'review', 'done']);
    expect(store.addCard({ threadId: 'e2', title: 'x', serviceClass: 'expedite' }).ok).toBe(true);
  });

  it('登録時に created と inbox への moved イベントを記録する', () => {
    add('t1');
    expect(store.listEvents().map((e) => [e.type, e.fromColumn, e.toColumn])).toEqual([
      ['created', null, null],
      ['moved', null, 'inbox'],
    ]);
  });
});

describe('KanbanStore: 移動', () => {
  function fillDoing() {
    for (const t of ['d1', 'd2', 'd3']) {
      add(t);
      moveAlong(t, ['ready', 'doing']);
    }
    add('x');
    moveAlong('x', ['ready']);
  }

  it('doing 上限 3 のとき 4 枚目の移動が拒否され、占有中 3 枚の threadId が返る', () => {
    fillDoing();
    const r = store.moveCard('x', { to: 'doing' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('WIP_LIMIT_EXCEEDED');
    expect(r.error.details?.occupantThreadIds).toEqual(['d1', 'd2', 'd3']);
    expect(store.getCard('x')?.column).toBe('ready');
  });

  it('force: true で reason なしは拒否、reason ありは成功し events に WIP 違反が 1 件記録される', () => {
    fillDoing();
    const noReason = store.moveCard('x', { to: 'doing', force: true });
    expect(!noReason.ok && noReason.error.code).toBe('FORCE_REASON_REQUIRED');
    expect(store.listEvents().filter((e) => e.type === 'wip_violation')).toHaveLength(0);

    const forced = store.moveCard('x', { to: 'doing', force: true, reason: '本番障害の調査' });
    expect(forced.ok).toBe(true);
    const violations = store.listEvents().filter((e) => e.type === 'wip_violation');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.data).toMatchObject({ column: 'doing', limit: 3, countBefore: 3, reason: '本番障害の調査' });
    expect(store.getCard('x')?.column).toBe('doing');
  });

  it('expedite は上限超過でも移動でき、違反は記録しない', () => {
    fillDoing();
    add('e1', { serviceClass: 'expedite' });
    moveAlong('e1', ['ready']);
    const r = store.moveCard('e1', { to: 'doing' });
    expect(r.ok && r.value.decision.expediteOverLimit).toBe(true);
    expect(store.listEvents().filter((e) => e.type === 'wip_violation')).toHaveLength(0);
    expect(store.snapshot().cards.filter((c) => c.column === 'doing')).toHaveLength(4);
  });

  it('ブロック中カードの前進は拒否され、列の WIP 件数に含まれる', () => {
    add('b');
    moveAlong('b', ['ready', 'doing']);
    expect(store.blockCard('b', '依存 API 待ち').ok).toBe(true);
    const r = store.moveCard('b', { to: 'review' });
    expect(!r.ok && r.error.code).toBe('BLOCKED');
    const { board, cards } = store.snapshot();
    const doing = buildBoardView(board, cards, clock()).columns.find((c) => c.column === 'doing');
    expect(doing?.count).toBe(1);
    expect(doing?.cards[0]?.blocked?.reason).toBe('依存 API 待ち');
  });

  it('inbox から doing への飛び越しは拒否、review から doing への差し戻しは成功、任意の列から discarded へ移動できる', () => {
    add('a');
    const skip = store.moveCard('a', { to: 'doing' });
    expect(!skip.ok && skip.error.code).toBe('SKIP_NOT_ALLOWED');
    moveAlong('a', ['ready', 'doing', 'review']);
    const back = store.moveCard('a', { to: 'doing' });
    expect(back.ok && back.value.decision.direction).toBe('backward');

    for (const [t, path] of [
      ['i', []],
      ['r', ['ready']],
      ['d', ['ready', 'doing']],
      ['v', ['ready', 'doing', 'review']],
      ['n', ['ready', 'doing', 'review', 'done']],
    ] as [string, Column[]][]) {
      store.configure({ columns: [{ column: 'doing', wipLimit: null }, { column: 'review', wipLimit: null }] });
      add(t);
      moveAlong(t, path);
      const r = store.moveCard(t, { to: 'discarded' });
      expect(r.ok, `${t} → discarded`).toBe(true);
    }
  });

  it('ブロック中カードを discarded にするとブロックも自動解除される', () => {
    add('b');
    store.blockCard('b', 'x');
    clock.advance(DAY);
    expect(store.moveCard('b', { to: 'discarded' }).ok).toBe(true);
    expect(store.getCard('b')?.blocked).toBeNull();
    const unblocked = store.listEvents().filter((e) => e.type === 'unblocked');
    expect(unblocked).toHaveLength(1);
    expect(unblocked[0]?.data).toMatchObject({ resolution: 'discarded', blockedDays: 1 });
  });

  it('入場条件を持つ列への移動は criteriaConfirmed なしで拒否され、条件一覧が返る', () => {
    store.configure({ columns: [{ column: 'review', entryCriteria: ['テストが通る', 'PR を作成した'] }] });
    add('a');
    moveAlong('a', ['ready', 'doing']);
    const r = store.moveCard('a', { to: 'review' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CRITERIA_NOT_CONFIRMED');
    expect(r.error.details?.entryCriteria).toEqual(['テストが通る', 'PR を作成した']);
    expect(store.moveCard('a', { to: 'review', criteriaConfirmed: true }).ok).toBe(true);
  });

  it('存在しない threadId は CARD_NOT_FOUND', () => {
    const r = store.moveCard('nope', { to: 'ready' });
    expect(!r.ok && r.error.code).toBe('CARD_NOT_FOUND');
  });
});

describe('KanbanStore: 更新・ブロック', () => {
  it('update は変更点を記録し、fixed_date への変更には dueDate が必要', () => {
    add('a');
    const bad = store.updateCard('a', { serviceClass: 'fixed_date' });
    expect(!bad.ok && bad.error.code).toBe('DUE_DATE_REQUIRED');
    const good = store.updateCard('a', { serviceClass: 'fixed_date', dueDate: '2026-02-01', externalRefs: ['PR#1'] });
    expect(good.ok && good.value.changed).toEqual(['serviceClass', 'dueDate', 'externalRefs']);
    expect(store.getCard('a')?.externalRefs).toEqual(['PR#1']);
  });

  it('update で expedite を 2 枚目にすることはできない', () => {
    add('e1', { serviceClass: 'expedite' });
    add('a');
    const r = store.updateCard('a', { serviceClass: 'expedite' });
    expect(!r.ok && r.error.code).toBe('EXPEDITE_LIMIT');
  });

  it('二重ブロックと未ブロックの解除はエラー、done のカードはブロックできない', () => {
    add('a');
    expect(store.blockCard('a', 'x').ok).toBe(true);
    const again = store.blockCard('a', 'y');
    expect(!again.ok && again.error.code).toBe('ALREADY_BLOCKED');
    clock.advance(2 * DAY);
    const un = store.unblockCard('a', '解消');
    expect(un.ok && un.value.blockedDays).toBe(2);
    const un2 = store.unblockCard('a');
    expect(!un2.ok && un2.error.code).toBe('NOT_BLOCKED');

    add('d');
    moveAlong('d', ['ready', 'doing', 'review', 'done']);
    const blockDone = store.blockCard('d', 'x');
    expect(!blockDone.ok && blockDone.error.code).toBe('CARD_NOT_ACTIVE');
  });
});

describe('KanbanStore: 注入した時計でのメトリクス', () => {
  it('ストアが記録したイベントからリード/サイクルタイムと WIP 違反件数を計算できる', () => {
    store.configure({ columns: [{ column: 'doing', wipLimit: 1 }] });
    clock.set(T0);
    add('a');
    add('b');
    clock.set(T0 + DAY);
    moveAlong('a', ['ready']);
    moveAlong('b', ['ready']);
    clock.set(T0 + 2 * DAY);
    moveAlong('a', ['doing']);
    store.moveCard('b', { to: 'doing', force: true, reason: '並行して進める' });
    clock.set(T0 + 3 * DAY);
    moveAlong('a', ['review', 'done']);
    clock.set(T0 + 5 * DAY);
    moveAlong('b', ['review', 'done']);

    const range = { from: T0, to: T0 + 7 * DAY - 1 };
    const m = computeMetrics(store.snapshot().cards, store.listEvents(range), range, T0 + 7 * DAY);
    expect(m.completed.map((c) => [c.threadId, c.leadTimeDays, c.cycleTimeDays])).toEqual([
      ['a', 3, 1],
      ['b', 5, 3],
    ]);
    expect(m.leadTime).toEqual({ count: 2, median: 4, p85: 5 });
    expect(m.wipViolations).toBe(1);
    expect(m.throughputWeekly).toEqual([{ weekStart: '2026-01-05', count: 2 }]);
  });

  it('board_get 相当のビューが stale・ブロック経過日数・期限超過を返す', () => {
    clock.set(T0);
    add('s');
    moveAlong('s', ['ready', 'doing']);
    add('blk', { serviceClass: 'fixed_date', dueDate: '2026-01-06' });
    store.blockCard('blk', '仕様確認待ち');
    clock.set(T0 + 4 * DAY);
    const { board, cards } = store.snapshot();
    const view = buildBoardView(board, cards, clock());
    expect(view.stale).toEqual([{ threadId: 's', column: 'doing', daysSinceLastEvent: 4 }]);
    expect(view.blocked).toEqual([{ threadId: 'blk', column: 'inbox', reason: '仕様確認待ち', days: 4 }]);
    expect(view.overdue).toEqual([{ threadId: 'blk', column: 'inbox', dueDate: '2026-01-06' }]);
  });
});
