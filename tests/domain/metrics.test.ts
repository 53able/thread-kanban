import { describe, expect, it } from 'vitest';
import { buildBoardView, computeMetrics, median, percentile } from '../../src/domain/metrics.js';
import type { Card, Column, EventType, KanbanEvent } from '../../src/domain/types.js';
import { DAY, HOUR, makeBoard, makeCard, T0 } from '../helpers/fixtures.js';

// T0 = 2026-01-05T00:00:00Z（月曜）
let eventId = 1;
function ev(cardId: number | null, type: EventType, at: number, from: Column | null = null, to: Column | null = null): KanbanEvent {
  return { id: eventId++, boardId: 'b', cardId, type, fromColumn: from, toColumn: to, at, data: {} };
}

/** カードの列移動を時刻付きで列挙する。最初の要素は inbox 到着。 */
function path(cardId: number, steps: [Column, number][]): KanbanEvent[] {
  const out: KanbanEvent[] = [];
  let prev: Column | null = null;
  for (const [col, at] of steps) {
    out.push(ev(cardId, 'moved', at, prev, col));
    prev = col;
  }
  return out;
}

const cards: Card[] = [
  makeCard({ id: 1, threadId: 'A', column: 'done' }),
  makeCard({ id: 2, threadId: 'B', column: 'done', type: 'defect', dueDate: '2026-01-08' }),
  makeCard({ id: 3, threadId: 'C', column: 'done', type: 'defect', serviceClass: 'fixed_date', dueDate: '2026-01-09' }),
  makeCard({ id: 4, threadId: 'D', column: 'done' }),
  makeCard({ id: 5, threadId: 'E', column: 'discarded' }),
  makeCard({ id: 6, threadId: 'F', column: 'doing', blocked: { reason: 'x', since: T0 + 12 * DAY } }),
];

const events: KanbanEvent[] = [
  ...path(1, [['inbox', T0], ['ready', T0 + DAY], ['doing', T0 + 2 * DAY], ['review', T0 + 3 * DAY], ['done', T0 + 4 * DAY]]),
  ...path(2, [['inbox', T0], ['ready', T0 + DAY], ['doing', T0 + DAY + 12 * HOUR], ['review', T0 + 2 * DAY], ['done', T0 + 3 * DAY]]),
  ...path(3, [['inbox', T0 + DAY], ['ready', T0 + 2 * DAY], ['doing', T0 + 3 * DAY], ['review', T0 + 5 * DAY], ['done', T0 + 9 * DAY]]),
  ...path(4, [['inbox', T0], ['ready', T0 + DAY], ['doing', T0 + 2 * DAY], ['review', T0 + 5 * DAY + 12 * HOUR], ['done', T0 + 6 * DAY]]),
  ev(4, 'blocked', T0 + 3 * DAY),
  ev(4, 'unblocked', T0 + 5 * DAY),
  ...path(5, [['inbox', T0], ['discarded', T0 + 2 * DAY]]),
  ev(5, 'blocked', T0 + DAY),
  ev(5, 'unblocked', T0 + 2 * DAY),
  ...path(6, [['inbox', T0 + DAY], ['ready', T0 + 2 * DAY], ['doing', T0 + 3 * DAY]]),
  ev(6, 'wip_violation', T0 + 3 * DAY, 'ready', 'doing'),
  ev(6, 'blocked', T0 + 12 * DAY),
  ev(6, 'wip_violation', T0 + 20 * DAY, 'ready', 'doing'), // 期間外
];

const range = { from: T0, to: T0 + 14 * DAY - 1 };
const now = T0 + 13 * DAY;

describe('computeMetrics（固定タイムスタンプ）', () => {
  const m = computeMetrics(cards, events, range, now);

  it('リードタイム（inbox 入り〜done）の中央値と 85 パーセンタイル', () => {
    // A=4, B=3, C=8, D=6 → [3,4,6,8]
    expect(m.leadTime).toEqual({ count: 4, median: 5, p85: 8 });
  });

  it('サイクルタイム（doing 入り〜done）の中央値と 85 パーセンタイル', () => {
    // A=2, B=1.5, C=6, D=4 → [1.5,2,4,6]
    expect(m.cycleTime).toEqual({ count: 4, median: 3, p85: 6 });
  });

  it('完了カードごとのリード/サイクルタイム', () => {
    expect(m.completed.map((c) => [c.threadId, c.leadTimeDays, c.cycleTimeDays])).toEqual([
      ['B', 3, 1.5],
      ['A', 4, 2],
      ['D', 6, 4],
      ['C', 8, 6],
    ]);
  });

  it('週次スループット（月曜始まり UTC、0 件の週も含む）', () => {
    expect(m.throughputWeekly).toEqual([
      { weekStart: '2026-01-05', count: 3 },
      { weekStart: '2026-01-12', count: 1 },
    ]);
  });

  it('ブロック件数と延べブロック日数（未解除は now で打ち切る）', () => {
    // D 2 日 + E 1 日 + F（12 日目〜now=13 日目）1 日
    expect(m.blocks).toEqual({ count: 3, totalBlockedDays: 4 });
  });

  it('期限遵守率', () => {
    // B: 期限 1/8 に完了 → 遵守、C: 期限 1/9 → 1/14 完了で超過
    expect(m.dueDate).toEqual({ total: 2, met: 1, rate: 0.5 });
  });

  it('failure demand 比率（type=defect）', () => {
    expect(m.failureDemand).toEqual({ defects: 2, total: 4, ratio: 0.5 });
  });

  it('破棄件数と WIP 違反件数（期間外は数えない）', () => {
    expect(m.discarded).toBe(1);
    expect(m.wipViolations).toBe(1);
  });

  it('CFD が日別・列別の件数を返す', () => {
    expect(m.cfd).toHaveLength(14);
    expect(m.cfd[0]).toEqual({ date: '2026-01-05', inbox: 4, ready: 0, doing: 0, review: 0, done: 0, discarded: 0 });
    expect(m.cfd[1]).toEqual({ date: '2026-01-06', inbox: 3, ready: 2, doing: 1, review: 0, done: 0, discarded: 0 });
    expect(m.cfd[6]).toEqual({ date: '2026-01-11', inbox: 0, ready: 0, doing: 1, review: 1, done: 3, discarded: 1 });
    expect(m.cfd[13]).toEqual({ date: '2026-01-18', inbox: 0, ready: 0, doing: 1, review: 0, done: 4, discarded: 1 });
  });

  it('期間外に完了したカードは数えない', () => {
    const late = computeMetrics(cards, events, { from: T0 + 7 * DAY, to: T0 + 14 * DAY - 1 }, now);
    expect(late.completed.map((c) => c.threadId)).toEqual(['C']);
    expect(late.throughputWeekly).toEqual([{ weekStart: '2026-01-12', count: 1 }]);
  });

  it('データがなければ null を返す', () => {
    const empty = computeMetrics([], [], range, now);
    expect(empty.leadTime).toEqual({ count: 0, median: null, p85: null });
    expect(empty.dueDate.rate).toBeNull();
    expect(empty.failureDemand.ratio).toBeNull();
  });
});

describe('統計関数', () => {
  it('median', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('percentile は nearest-rank 法', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 0.85)).toBe(9);
    expect(percentile([7], 0.85)).toBe(7);
  });
});

describe('buildBoardView', () => {
  const t = T0 + 10 * DAY;
  const board = makeBoard({ doing: { wipLimit: 1 } });
  const view = buildBoardView(board, [
    makeCard({ id: 1, threadId: 'stale', column: 'doing', lastEventAt: t - 3 * DAY }),
    makeCard({ id: 2, threadId: 'fresh', column: 'doing', lastEventAt: t - 2 * DAY }),
    makeCard({ id: 3, threadId: 'blk', column: 'review', blocked: { reason: '回答待ち', since: t - 36 * HOUR }, lastEventAt: t - 36 * HOUR }),
    makeCard({ id: 4, threadId: 'late', column: 'ready', dueDate: '2026-01-14' }),
    makeCard({ id: 5, threadId: 'today', column: 'ready', dueDate: '2026-01-15' }),
    makeCard({ id: 6, threadId: 'done-late', column: 'done', dueDate: '2026-01-01' }),
    makeCard({ id: 7, threadId: 'old-inbox', column: 'inbox', lastEventAt: T0 }),
  ], t);

  it('列は右から左（done → inbox）', () => {
    expect(view.columns.map((c) => c.column)).toEqual(['done', 'review', 'doing', 'ready', 'inbox']);
  });

  it('staleDays 日間イベントのない進行中カードを stale として示す', () => {
    expect(view.stale.map((s) => s.threadId)).toEqual(['stale']);
  });

  it('ブロック経過日数を返す', () => {
    expect(view.blocked).toEqual([{ threadId: 'blk', column: 'review', reason: '回答待ち', days: 1.5 }]);
  });

  it('期限超過を返す（done は対象外、当日は超過ではない）', () => {
    expect(view.overdue).toEqual([{ threadId: 'late', column: 'ready', dueDate: '2026-01-14' }]);
  });

  it('WIP 違反（件数 > 上限）を返す', () => {
    expect(view.wipViolations).toEqual([{ column: 'doing', wipLimit: 1, count: 2 }]);
  });
});

describe('computeMetrics（差し戻しと期間境界）', () => {
  it('差し戻して再完了したカードは最後の done 到着で数え、最初の doing 入りからサイクルタイムを測る', () => {
    const card = makeCard({ id: 20, threadId: 'R', column: 'done' });
    const evs = path(20, [
      ['inbox', T0],
      ['ready', T0 + DAY],
      ['doing', T0 + 2 * DAY],
      ['review', T0 + 3 * DAY],
      ['done', T0 + 4 * DAY],
      ['doing', T0 + 5 * DAY],
      ['review', T0 + 6 * DAY],
      ['done', T0 + 7 * DAY],
    ]);
    const m = computeMetrics([card], evs, { from: T0, to: T0 + 10 * DAY }, T0 + 10 * DAY);
    expect(m.completed).toHaveLength(1);
    expect(m.completed[0]).toMatchObject({ leadTimeDays: 7, cycleTimeDays: 5 });
  });

  it('to より後のイベントを渡しても無視し、期間内の完了として数える', () => {
    const card = makeCard({ id: 21, threadId: 'S', column: 'done' });
    const evs = path(21, [
      ['inbox', T0],
      ['ready', T0 + DAY],
      ['doing', T0 + 2 * DAY],
      ['review', T0 + 3 * DAY],
      ['done', T0 + 4 * DAY],
      ['review', T0 + 8 * DAY],
      ['done', T0 + 9 * DAY],
    ]);
    const m = computeMetrics([card], evs, { from: T0, to: T0 + 6 * DAY }, T0 + 10 * DAY);
    expect(m.completed.map((c) => c.leadTimeDays)).toEqual([4]);
  });

  it('期間前に始まったブロックは件数に入れず、延べ日数は期間内の分だけ数える', () => {
    const card = makeCard({ id: 22, threadId: 'T', column: 'doing' });
    const evs = [ev(22, 'blocked', T0 - 3 * DAY), ev(22, 'unblocked', T0 + 2 * DAY)];
    const m = computeMetrics([card], evs, { from: T0, to: T0 + 6 * DAY }, T0 + 10 * DAY);
    expect(m.blocks).toEqual({ count: 0, totalBlockedDays: 2 });
  });
});
