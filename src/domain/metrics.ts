import { ALL_COLUMNS, DAY_MS, IN_PROGRESS_COLUMNS, type Card, type Column, type KanbanEvent } from './types.js';

export interface DistributionStats {
  count: number;
  /** 日数。データがなければ null */
  median: number | null;
  /** 日数（nearest-rank 法）。データがなければ null */
  p85: number | null;
}

export interface CompletedItem {
  cardId: number;
  threadId: string;
  doneAt: string;
  leadTimeDays: number;
  cycleTimeDays: number | null;
}

export interface Metrics {
  range: { from: string; to: string };
  leadTime: DistributionStats;
  cycleTime: DistributionStats;
  completed: CompletedItem[];
  throughputWeekly: { weekStart: string; count: number }[];
  blocks: { count: number; totalBlockedDays: number };
  dueDate: { total: number; met: number; rate: number | null };
  failureDemand: { defects: number; total: number; ratio: number | null };
  discarded: number;
  wipViolations: number;
  cfd: ({ date: string } & Record<Column, number>)[];
}

export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** nearest-rank 法のパーセンタイル: 昇順で ceil(p * n) 番目の値。 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * s.length));
  return s[rank - 1] as number;
}

function stats(values: readonly number[]): DistributionStats {
  const m = median(values);
  const p = percentile(values, 0.85);
  return { count: values.length, median: m === null ? null : round(m), p85: p === null ? null : round(p) };
}

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** 月曜始まり（UTC）の週の開始時刻。 */
export function startOfUtcWeek(ms: number): number {
  const day = startOfUtcDay(ms);
  const dow = (new Date(day).getUTCDay() + 6) % 7; // 月曜 = 0
  return day - dow * DAY_MS;
}

function movesOf(events: readonly KanbanEvent[], cardId: number): KanbanEvent[] {
  return events.filter((e) => e.type === 'moved' && e.cardId === cardId).sort((a, b) => a.at - b.at || a.id - b.id);
}

/**
 * イベントログからフローメトリクスを計算する。
 * - 期間は [from, to]（ミリ秒）。日・週の境界は UTC。週は月曜始まり。
 * - to より後のイベントは無視する（呼び出し側の絞り込みには依存しない）。
 * - 完了 = to 以前で最後に done へ入った移動が期間内にあるカード（差し戻して再完了した場合は最後の到着で数える）。
 *   ただし現在 done にないカードは完了に数えない。
 * - リードタイム = inbox 入り（最初の移動）〜 done 入り。サイクルタイム = 最初の doing 入り 〜 done 入り。
 * - 期限遵守 = 期間内に完了し dueDate を持つカードのうち、done 入りの UTC 日付が dueDate 以前のもの。
 * - failure demand 比率 = 期間内完了のうち type=defect の割合。
 * - ブロック件数 = 期間内に始まったブロックの数（期間前に始まったものは延べ日数にのみ入る）。
 * - ブロック延べ日数 = 各ブロック区間を期間（未解除なら min(to, now)）で切り取った合計。
 */
export function computeMetrics(
  cards: readonly Card[],
  allEvents: readonly KanbanEvent[],
  range: { from: number; to: number },
  now: number,
): Metrics {
  const { from, to } = range;
  const events = allEvents.filter((e) => e.at <= to);
  const inRange = (at: number): boolean => at >= from && at <= to;

  const completed: CompletedItem[] = [];
  const leadTimes: number[] = [];
  const cycleTimes: number[] = [];
  let dueTotal = 0;
  let dueMet = 0;
  let defects = 0;

  for (const card of cards) {
    if (card.column !== 'done') continue;
    const moves = movesOf(events, card.id);
    const doneMoves = moves.filter((m) => m.toColumn === 'done');
    const lastDone = doneMoves[doneMoves.length - 1];
    if (lastDone === undefined || !inRange(lastDone.at)) continue;
    const start = moves[0]?.at ?? card.createdAt;
    const firstDoing = moves.find((m) => m.toColumn === 'doing' && m.at <= lastDone.at);
    const lead = (lastDone.at - start) / DAY_MS;
    const cycle = firstDoing === undefined ? null : (lastDone.at - firstDoing.at) / DAY_MS;
    leadTimes.push(lead);
    if (cycle !== null) cycleTimes.push(cycle);
    completed.push({
      cardId: card.id,
      threadId: card.threadId,
      doneAt: new Date(lastDone.at).toISOString(),
      leadTimeDays: round(lead),
      cycleTimeDays: cycle === null ? null : round(cycle),
    });
    if (card.dueDate !== null) {
      dueTotal += 1;
      if (utcDate(lastDone.at) <= card.dueDate) dueMet += 1;
    }
    if (card.type === 'defect') defects += 1;
  }
  completed.sort((a, b) => a.doneAt.localeCompare(b.doneAt) || a.cardId - b.cardId);

  // 週次スループット（期間に重なる全ての週を 0 件も含めて返す）
  const weeks = new Map<number, number>();
  for (let w = startOfUtcWeek(from); w <= to; w += 7 * DAY_MS) weeks.set(w, 0);
  for (const item of completed) {
    const w = startOfUtcWeek(Date.parse(item.doneAt));
    weeks.set(w, (weeks.get(w) ?? 0) + 1);
  }
  const throughputWeekly = [...weeks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([w, count]) => ({ weekStart: utcDate(w), count }));

  // ブロック
  let blockCount = 0;
  let blockedMs = 0;
  const sorted = [...events].sort((a, b) => a.at - b.at || a.id - b.id);
  const openBlocks = new Map<number, number>();
  const end = Math.min(to, now);
  for (const e of sorted) {
    if (e.cardId === null) continue;
    if (e.type === 'blocked') {
      if (inRange(e.at)) blockCount += 1;
      openBlocks.set(e.cardId, e.at);
    } else if (e.type === 'unblocked') {
      const since = openBlocks.get(e.cardId);
      if (since !== undefined) {
        blockedMs += Math.max(0, Math.min(e.at, to) - Math.max(since, from));
        openBlocks.delete(e.cardId);
      }
    }
  }
  for (const since of openBlocks.values()) {
    blockedMs += Math.max(0, end - Math.max(since, from));
  }

  const discarded = events.filter((e) => e.type === 'moved' && e.toColumn === 'discarded' && inRange(e.at)).length;
  const wipViolations = events.filter((e) => e.type === 'wip_violation' && inRange(e.at)).length;

  return {
    range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    leadTime: stats(leadTimes),
    cycleTime: stats(cycleTimes),
    completed,
    throughputWeekly,
    blocks: { count: blockCount, totalBlockedDays: round(blockedMs / DAY_MS) },
    dueDate: { total: dueTotal, met: dueMet, rate: dueTotal === 0 ? null : round(dueMet / dueTotal) },
    failureDemand: {
      defects,
      total: completed.length,
      ratio: completed.length === 0 ? null : round(defects / completed.length),
    },
    discarded,
    wipViolations,
    cfd: computeCfd(events, from, to),
  };
}

/** 累積フロー図: 期間内の各日（UTC）終了時点で各列にあるカード数。 */
export function computeCfd(
  events: readonly KanbanEvent[],
  from: number,
  to: number,
): ({ date: string } & Record<Column, number>)[] {
  const moves = events.filter((e) => e.type === 'moved' && e.cardId !== null).sort((a, b) => a.at - b.at || a.id - b.id);
  const position = new Map<number, Column>();
  const rows: ({ date: string } & Record<Column, number>)[] = [];
  let i = 0;
  for (let day = startOfUtcDay(from); day <= to; day += DAY_MS) {
    const endOfDay = day + DAY_MS;
    while (i < moves.length && (moves[i] as KanbanEvent).at < endOfDay) {
      const m = moves[i] as KanbanEvent;
      if (m.toColumn !== null) position.set(m.cardId as number, m.toColumn);
      i += 1;
    }
    const row = { date: utcDate(day) } as { date: string } & Record<Column, number>;
    for (const c of ALL_COLUMNS) row[c] = 0;
    for (const col of position.values()) row[col] += 1;
    rows.push(row);
  }
  return rows;
}

export interface BoardCardView {
  cardId: number;
  threadId: string;
  title: string;
  type: Card['type'];
  serviceClass: Card['serviceClass'];
  dueDate: string | null;
  size: Card['size'];
  externalRefs: string[];
  /** T3 スレッドの追跡参照（kanban_sync / kanban_card_add で更新）。syncedAt は ISO 8601 */
  t3: (Omit<NonNullable<Card['t3']>, 'syncedAt'> & { syncedAt: string }) | null;
  daysInColumn: number;
  blocked: { reason: string; since: string; days: number } | null;
  overdue: boolean;
  stale: boolean;
  daysSinceLastEvent: number;
}

export interface BoardColumnView {
  column: Column;
  wipLimit: number | null;
  count: number;
  overLimit: boolean;
  entryCriteria: string[];
  cards: BoardCardView[];
}

export interface BoardView {
  boardId: string;
  staleDays: number;
  /** 右（done）から左（inbox）の順 */
  columns: BoardColumnView[];
  wipViolations: { column: Column; wipLimit: number; count: number }[];
  blocked: { threadId: string; column: Column; reason: string; days: number }[];
  overdue: { threadId: string; column: Column; dueDate: string }[];
  stale: { threadId: string; column: Column; daysSinceLastEvent: number }[];
  discardedCount: number;
}

/**
 * ボード表示用のビューを作る。列は右から左に並べ、WIP 件数にはブロック中カードを含める。
 * - overdue: done / discarded 以外で dueDate（UTC 日付）が now の UTC 日付より前
 * - stale: doing / review にあり、最後のイベントから staleDays 日以上経過
 */
export function buildBoardView(
  board: { id: string; staleDays: number; columns: { name: Column; wipLimit: number | null; entryCriteria: string[] }[] },
  cards: readonly Card[],
  now: number,
): BoardView {
  const today = utcDate(now);
  const view = (c: Card): BoardCardView => {
    const sinceEvent = (now - c.lastEventAt) / DAY_MS;
    return {
      cardId: c.id,
      threadId: c.threadId,
      title: c.title,
      type: c.type,
      serviceClass: c.serviceClass,
      dueDate: c.dueDate,
      size: c.size,
      externalRefs: c.externalRefs,
      t3: c.t3 === null ? null : { ...c.t3, syncedAt: new Date(c.t3.syncedAt).toISOString() },
      daysInColumn: round((now - c.columnEnteredAt) / DAY_MS, 2),
      blocked:
        c.blocked === null
          ? null
          : { reason: c.blocked.reason, since: new Date(c.blocked.since).toISOString(), days: round((now - c.blocked.since) / DAY_MS, 2) },
      overdue: c.dueDate !== null && c.column !== 'done' && c.column !== 'discarded' && c.dueDate < today,
      stale: IN_PROGRESS_COLUMNS.includes(c.column) && sinceEvent >= board.staleDays,
      daysSinceLastEvent: round(sinceEvent, 2),
    };
  };

  const columns: BoardColumnView[] = [...board.columns].reverse().map((col) => {
    const inCol = cards.filter((c) => c.column === col.name).sort((a, b) => a.columnEnteredAt - b.columnEnteredAt || a.id - b.id);
    return {
      column: col.name,
      wipLimit: col.wipLimit,
      count: inCol.length,
      overLimit: col.wipLimit !== null && inCol.length > col.wipLimit,
      entryCriteria: [...col.entryCriteria],
      cards: inCol.map(view),
    };
  });
  const all = columns.flatMap((col) => col.cards.map((card) => ({ card, column: col.column })));
  return {
    boardId: board.id,
    staleDays: board.staleDays,
    columns,
    wipViolations: columns
      .filter((c) => c.overLimit)
      .map((c) => ({ column: c.column, wipLimit: c.wipLimit as number, count: c.count })),
    blocked: all
      .filter((x) => x.card.blocked !== null)
      .map((x) => ({ threadId: x.card.threadId, column: x.column, reason: x.card.blocked?.reason ?? '', days: x.card.blocked?.days ?? 0 })),
    overdue: all
      .filter((x) => x.card.overdue)
      .map((x) => ({ threadId: x.card.threadId, column: x.column, dueDate: x.card.dueDate as string })),
    stale: all
      .filter((x) => x.card.stale)
      .map((x) => ({ threadId: x.card.threadId, column: x.column, daysSinceLastEvent: x.card.daysSinceLastEvent })),
    discardedCount: cards.filter((c) => c.column === 'discarded').length,
  };
}
