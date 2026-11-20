import { describe, expect, it } from 'vitest';
import {
  DEVIATION_KINDS,
  classifyThread,
  detectDeviations,
  mergeTracking,
  t3ActionForMove,
  trackingChanged,
  type SyncInput,
  type T3Thread,
  type ThreadObservation,
} from '../../src/domain/sync.js';
import type { Card } from '../../src/domain/types.js';
import { T0, makeBoard, makeCard } from '../helpers/fixtures.js';

const found = (thread: T3Thread): ThreadObservation => ({ kind: 'found', thread });

function input(cards: Card[], threads: T3Thread[], extra: Partial<SyncInput> = {}): SyncInput {
  const observations = new Map<string, ThreadObservation>();
  for (const t of threads) observations.set(t.threadId, found(t));
  return { board: makeBoard(), cards, projectThreads: threads, observations, callerThreadId: null, ...extra };
}

function kinds(i: SyncInput): string[] {
  return detectDeviations(i).deviations.map((d) => d.kind);
}

describe('classifyThread（R2）', () => {
  it('完了・人の対応待ち・他スレッド待ち・異常終了・進行中を分類する', () => {
    expect(classifyThread({ threadId: 'a', settled: true }).finished).toBe(true);
    expect(classifyThread({ threadId: 'a', archived: true }).finished).toBe(true);
    expect(classifyThread({ threadId: 'a', status: 'waiting' }).waitingHuman).toBe(true);
    expect(classifyThread({ threadId: 'a', status: 'idle', pendingRequestCount: 2 }).waitingHuman).toBe(true);
    expect(classifyThread({ threadId: 'a', blockedOnThreadWait: true }).waitingThread).toBe(true);
    for (const s of ['failed', 'cancelled', 'rolled_back']) expect(classifyThread({ threadId: 'a', status: s }).failed).toBe(true);
    for (const s of ['preparing', 'queued', 'starting', 'running']) expect(classifyThread({ threadId: 'a', status: s }).active).toBe(true);
    for (const s of ['idle', 'completed', 'interrupted']) {
      expect(classifyThread({ threadId: 'a', status: s })).toEqual({
        finished: false,
        waitingHuman: false,
        waitingThread: false,
        failed: false,
        active: false,
      });
    }
  });
});

describe('detectDeviations: 8 種類のずれ（改訂後の D6）', () => {
  it('unregistered: カードのないトップレベルのスレッド。kanban_card_add を提案する', () => {
    const r = detectDeviations(input([], [{ threadId: 'u1', title: '未登録', status: 'idle' }]));
    expect(r.deviations).toHaveLength(1);
    expect(r.deviations[0]).toMatchObject({
      kind: 'unregistered',
      threadId: 'u1',
      cardId: null,
      suggestion: { tool: 'kanban_card_add', args: { threadId: 'u1', title: '未登録' } },
    });
  });

  it('t3_finished_card_open: settle / archive 済みでカードが inbox〜review。done への前進と discarded を提案する', () => {
    const card = makeCard({ threadId: 'f1', column: 'review' });
    const r = detectDeviations(input([card], [{ threadId: 'f1', settled: true, status: 'completed' }]));
    expect(r.deviations[0]).toMatchObject({
      kind: 't3_finished_card_open',
      cardId: card.id,
      column: 'review',
      suggestion: {
        tool: 'kanban_card_move',
        args: { threadId: 'f1', to: 'done' },
        alternatives: [{ tool: 'kanban_card_move', args: { threadId: 'f1', to: 'discarded' } }],
      },
    });
    const inbox = makeCard({ threadId: 'f2', column: 'inbox' });
    const r2 = detectDeviations(input([inbox], [{ threadId: 'f2', archived: true }]));
    expect(r2.deviations[0]?.kind).toBe('t3_finished_card_open');
    expect(r2.deviations[0]?.suggestion.args).toEqual({ threadId: 'f2', to: 'ready' });
    expect(r2.deviations[0]?.suggestion.followUp.map((c) => c.args.to)).toEqual(['doing', 'review', 'done']);
  });

  it('t3_waiting_not_blocked: 人の対応待ちで doing / review の未ブロックのカード。kanban_card_block を提案する', () => {
    const a = makeCard({ threadId: 'w1', column: 'doing' });
    const b = makeCard({ threadId: 'w2', column: 'review' });
    const r = detectDeviations(
      input([a, b], [
        { threadId: 'w1', status: 'waiting' },
        { threadId: 'w2', status: 'idle', pendingRequestCount: 1 },
      ]),
    );
    expect(r.deviations.map((d) => [d.kind, d.threadId, d.suggestion.tool])).toEqual([
      ['t3_waiting_not_blocked', 'w2', 'kanban_card_block'],
      ['t3_waiting_not_blocked', 'w1', 'kanban_card_block'],
    ]);
    expect(r.deviations[0]?.suggestion.args).toMatchObject({ threadId: 'w2', reason: expect.any(String) });
  });

  it('t3_waiting_on_thread: 他スレッド待ちで doing の未ブロックのカード。kanban_card_block を提案する', () => {
    const c = makeCard({ threadId: 'wt', column: 'doing' });
    const r = detectDeviations(input([c], [{ threadId: 'wt', status: 'running', blockedOnThreadWait: true }]));
    expect(r.deviations).toHaveLength(1);
    expect(r.deviations[0]).toMatchObject({ kind: 't3_waiting_on_thread', suggestion: { tool: 'kanban_card_block' } });
  });

  it('t3_failed_not_blocked: 異常終了で doing の未ブロックのカード。kanban_card_block を提案する', () => {
    const c = makeCard({ threadId: 'x', column: 'doing' });
    const r = detectDeviations(input([c], [{ threadId: 'x', status: 'failed' }]));
    expect(r.deviations[0]).toMatchObject({
      kind: 't3_failed_not_blocked',
      t3Status: 'failed',
      suggestion: { tool: 'kanban_card_block', args: { threadId: 'x' } },
    });
  });

  it('started_without_pull: 進行中でカードが ready なら doing へ、inbox なら ready → doing の 2 手を提案する', () => {
    const ready = makeCard({ threadId: 's1', column: 'ready' });
    const inbox = makeCard({ threadId: 's2', column: 'inbox' });
    const r = detectDeviations(input([ready, inbox], [
      { threadId: 's1', status: 'running' },
      { threadId: 's2', status: 'queued' },
    ]));
    const byThread = Object.fromEntries(r.deviations.map((d) => [d.threadId, d]));
    expect(byThread.s1).toMatchObject({ kind: 'started_without_pull', suggestion: { tool: 'kanban_card_move', args: { threadId: 's1', to: 'doing' }, followUp: [] } });
    expect(byThread.s2).toMatchObject({
      kind: 'started_without_pull',
      suggestion: { tool: 'kanban_card_move', args: { threadId: 's2', to: 'ready' }, followUp: [{ tool: 'kanban_card_move', args: { threadId: 's2', to: 'doing' } }] },
    });
  });

  it('started_without_pull: doing が WIP 上限なら、ツールなしで「新規着手を止める」を提案する（R11）', () => {
    const doing = [1, 2, 3].map((i) => makeCard({ threadId: `d${i}`, column: 'doing' }));
    const ready = makeCard({ threadId: 's1', column: 'ready' });
    const r = detectDeviations(input([...doing, ready], [{ threadId: 's1', status: 'running' }]));
    expect(r.deviations).toHaveLength(1);
    expect(r.deviations[0]).toMatchObject({ kind: 'started_without_pull', suggestion: { tool: null, args: null } });
    expect(r.deviations[0]?.suggestion.text).toContain('新規着手を止め');
  });

  it('t3_active_card_done: 進行中でカードが done。差し戻しを提案する', () => {
    const c = makeCard({ threadId: 'ad', column: 'done' });
    const r = detectDeviations(input([c], [{ threadId: 'ad', status: 'running' }]));
    expect(r.deviations[0]).toMatchObject({ kind: 't3_active_card_done', suggestion: { tool: 'kanban_card_move', args: { threadId: 'ad', to: 'review' } } });
  });

  it('t3_thread_missing: show が存在しないと返したカード。discarded を提案する', () => {
    const c = makeCard({ threadId: 'gone', column: 'doing' });
    const r = detectDeviations({
      ...input([c], []),
      observations: new Map([['gone', { kind: 'missing' }]]),
    });
    expect(r.deviations[0]).toMatchObject({ kind: 't3_thread_missing', suggestion: { tool: 'kanban_card_move', args: { threadId: 'gone', to: 'discarded' } } });
  });

  it('9 種類すべてが 1 回の判定で検出され、全てに suggestion（text 付き）がある', () => {
    const cards = [
      makeCard({ threadId: 'f', column: 'review' }),
      makeCard({ threadId: 'w', column: 'doing' }),
      makeCard({ threadId: 'wt', column: 'doing' }),
      makeCard({ threadId: 'x', column: 'review' }),
      makeCard({ threadId: 's', column: 'ready' }),
      makeCard({ threadId: 'ad', column: 'done' }),
      makeCard({ threadId: 'gone', column: 'inbox' }),
      makeCard({ threadId: 'od', column: 'done' }),
    ];
    const threads: T3Thread[] = [
      { threadId: 'u' },
      { threadId: 'f', settled: true },
      { threadId: 'w', status: 'waiting' },
      { threadId: 'wt', blockedOnThreadWait: true },
      { threadId: 'x', status: 'rolled_back' },
      { threadId: 's', status: 'starting' },
      { threadId: 'ad', status: 'preparing' },
      { threadId: 'od', status: 'idle' },
    ];
    const i = input(cards, threads);
    (i.observations as Map<string, ThreadObservation>).set('gone', { kind: 'missing' });
    const r = detectDeviations(i);
    expect(new Set(r.deviations.map((d) => d.kind))).toEqual(new Set(DEVIATION_KINDS));
    expect(r.deviations).toHaveLength(9);
    expect(DEVIATION_KINDS).toHaveLength(9);
    for (const d of r.deviations) {
      expect(d.suggestion.text.length, d.kind).toBeGreaterThan(0);
      expect(d.message.length, d.kind).toBeGreaterThan(0);
    }
  });
});

describe('detectDeviations: 判定しないケース（受け入れ基準 6）', () => {
  it('(a) 呼び出し元スレッドのカードが done で status が running でも t3_active_card_done にしない', () => {
    const c = makeCard({ threadId: 'me', column: 'done' });
    const i = input([c], [{ threadId: 'me', status: 'running' }], { callerThreadId: 'me' });
    expect(kinds(i)).toEqual([]);
    expect(kinds({ ...i, callerThreadId: 'someone-else' })).toEqual(['t3_active_card_done']);
  });

  it('(a) 呼び出し元スレッドでも、カードがなければ unregistered の対象になる（R3）', () => {
    expect(kinds(input([], [{ threadId: 'me', status: 'running' }], { callerThreadId: 'me' }))).toEqual(['unregistered']);
  });

  it('(b) idle のスレッドのカードが inbox にあっても started_without_pull にしない', () => {
    const c = makeCard({ threadId: 'i', column: 'inbox' });
    expect(kinds(input([c], [{ threadId: 'i', status: 'idle' }]))).toEqual([]);
    expect(kinds(input([c], [{ threadId: 'i', status: 'completed' }]))).toEqual([]);
  });

  it('(c) interrupted は t3_failed_not_blocked にしない', () => {
    const c = makeCard({ threadId: 'int', column: 'doing' });
    expect(kinds(input([c], [{ threadId: 'int', status: 'interrupted' }]))).toEqual([]);
  });

  it('(d) snoozed のスレッドは unregistered にしない。settle / archive 済み・子スレッドも同様（R10）', () => {
    expect(
      kinds(
        input([], [
          { threadId: 'z', snoozed: true },
          { threadId: 's', settled: true },
          { threadId: 'a', archived: true },
          { threadId: 'c', parentThreadId: 'p' },
        ]),
      ),
    ).toEqual([]);
  });

  it('(e) show で見つかった子スレッドのカードは t3_thread_missing にしない', () => {
    const c = makeCard({ threadId: 'child', column: 'doing' });
    const i: SyncInput = {
      ...input([c], []),
      observations: new Map([['child', found({ threadId: 'child', parentThreadId: 'p', status: 'idle' })]]),
    };
    expect(kinds(i)).toEqual([]);
  });

  it('ブロック済みのカードは待ち・異常終了のずれにしない', () => {
    const c = makeCard({ threadId: 'b', column: 'doing', blocked: { reason: 'r', since: T0 } });
    expect(kinds(input([c], [{ threadId: 'b', status: 'waiting' }]))).toEqual([]);
    expect(kinds(input([c], [{ threadId: 'b', status: 'failed' }]))).toEqual([]);
  });

  it('discarded のカードは判定しない。done のカードは missing にしない', () => {
    const d = makeCard({ threadId: 'dis', column: 'discarded' });
    const done = makeCard({ threadId: 'dn', column: 'done' });
    const i: SyncInput = {
      ...input([d, done], [{ threadId: 'dis', status: 'running' }]),
      observations: new Map<string, ThreadObservation>([
        ['dis', found({ threadId: 'dis', status: 'running' })],
        ['dn', { kind: 'missing' }],
      ]),
    };
    expect(kinds(i)).toEqual([]);
  });

  it('unknown の観測は判定せず unknown として返す（R16）', () => {
    const c = makeCard({ threadId: 'u', column: 'doing' });
    const r = detectDeviations({ ...input([c], []), observations: new Map([['u', { kind: 'unknown', reason: 'timeout' }]]) });
    expect(r.deviations).toEqual([]);
    expect(r.unknown).toEqual([{ threadId: 'u', reason: 'timeout' }]);
  });
});

describe('detectDeviations: 並び順（受け入れ基準 10）', () => {
  it('done に近い列から並び、unregistered が最後', () => {
    const cards = [
      makeCard({ threadId: 'in', column: 'inbox' }),
      makeCard({ threadId: 'dn', column: 'done' }),
      makeCard({ threadId: 'dg', column: 'doing' }),
      makeCard({ threadId: 'rv', column: 'review' }),
      makeCard({ threadId: 'rd', column: 'ready' }),
    ];
    const threads: T3Thread[] = [
      { threadId: 'new-1' },
      { threadId: 'in', settled: true },
      { threadId: 'dn', status: 'running' },
      { threadId: 'dg', status: 'failed' },
      { threadId: 'rv', status: 'waiting' },
      { threadId: 'rd', status: 'running' },
      { threadId: 'new-2' },
    ];
    const r = detectDeviations(input(cards, threads));
    expect(r.deviations.map((d) => d.threadId)).toEqual(['dn', 'rv', 'dg', 'rd', 'in', 'new-1', 'new-2']);
  });
});

describe('mergeTracking / trackingChanged（R9）', () => {
  it('取得元にない項目は以前の値を残し、T3 の状態は含めない', () => {
    const prev = mergeTracking(
      null,
      { threadId: 't', link: 'L', projectId: 'P', branch: 'b', worktreePath: '/w', pullRequests: [], status: 'running', settled: false },
      T0,
    );
    expect(prev).toEqual({ link: 'L', projectId: 'P', parentThreadId: null, branch: 'b', worktreePath: '/w', pullRequests: [], syncedAt: T0 });
    const next = mergeTracking(prev, { threadId: 't', link: 'L2', pullRequests: [{ url: 'https://x/pull/1' }] }, T0 + 1);
    expect(next).toEqual({ link: 'L2', projectId: 'P', parentThreadId: null, branch: 'b', worktreePath: '/w', pullRequests: [{ url: 'https://x/pull/1' }], syncedAt: T0 + 1 });
    expect(Object.keys(next)).not.toContain('status');
    expect(trackingChanged(prev, next)).toBe(true);
    expect(trackingChanged(next, { ...next, syncedAt: T0 + 99 })).toBe(false);
    expect(trackingChanged(null, next)).toBe(true);
  });
});

describe('detectDeviations: 同時に成立するときの優先順（m11）', () => {
  it('完了と人の対応待ちが同時なら t3_finished_card_open だけ', () => {
    const c = makeCard({ threadId: 'fw', column: 'doing' });
    expect(kinds(input([c], [{ threadId: 'fw', settled: true, status: 'waiting', pendingRequestCount: 1 }]))).toEqual(['t3_finished_card_open']);
  });

  it('人の対応待ちと異常終了の条件が同時なら t3_waiting_not_blocked だけ', () => {
    const c = makeCard({ threadId: 'wf', column: 'review' });
    expect(kinds(input([c], [{ threadId: 'wf', status: 'failed', pendingRequestCount: 2 }]))).toEqual(['t3_waiting_not_blocked']);
  });

  it('他スレッド待ちと異常終了が同時なら t3_waiting_on_thread だけ', () => {
    const c = makeCard({ threadId: 'tf', column: 'doing' });
    expect(kinds(input([c], [{ threadId: 'tf', status: 'cancelled', blockedOnThreadWait: true }]))).toEqual(['t3_waiting_on_thread']);
  });

  it('完了したスレッドのカードが done なら、進行中の status でもずれにしない', () => {
    const c = makeCard({ threadId: 'fd', column: 'done' });
    expect(kinds(input([c], [{ threadId: 'fd', archived: true, status: 'running' }]))).toEqual([]);
  });
});

describe('detectDeviations: doing が満杯のときの started_without_pull（m11、R11）', () => {
  it('inbox のカードでも doing が満杯ならツールなし。expedite なら WIP を超えて pull を提案する', () => {
    const doing = [1, 2, 3].map((i) => makeCard({ threadId: `full-${i}`, column: 'doing' }));
    const inbox = makeCard({ threadId: 'in', column: 'inbox' });
    const exp = makeCard({ threadId: 'exp', column: 'ready', serviceClass: 'expedite' });
    const r = detectDeviations(input([...doing, inbox, exp], [
      { threadId: 'in', status: 'running' },
      { threadId: 'exp', status: 'running' },
    ]));
    const by = Object.fromEntries(r.deviations.map((d) => [d.threadId, d.suggestion]));
    expect(by.in).toMatchObject({ tool: null, args: null, followUp: [] });
    expect(by.exp).toMatchObject({ tool: 'kanban_card_move', args: { threadId: 'exp', to: 'doing' } });
  });

  it('doing の WIP 上限が null（無制限）なら常に pull を提案する', () => {
    const doing = [1, 2, 3, 4].map((i) => makeCard({ threadId: `d-${i}`, column: 'doing' }));
    const ready = makeCard({ threadId: 'r', column: 'ready' });
    const r = detectDeviations({ ...input([...doing, ready], [{ threadId: 'r', status: 'running' }]), board: makeBoard({ doing: { wipLimit: null } }) });
    expect(r.deviations[0]?.suggestion.tool).toBe('kanban_card_move');
  });
});

describe('detectDeviations: 並び順の順位は有限値（m6）', () => {
  it('同じ列はカード ID 順、unregistered は取得順で最後に並ぶ', () => {
    const cards = [
      makeCard({ id: 9001, threadId: 'b', column: 'doing' }),
      makeCard({ id: 9000, threadId: 'a', column: 'doing' }),
    ];
    const r = detectDeviations(input(cards, [
      { threadId: 'z-new' },
      { threadId: 'b', status: 'failed' },
      { threadId: 'a', status: 'failed' },
      { threadId: 'a-new' },
    ]));
    expect(r.deviations.map((d) => d.threadId)).toEqual(['a', 'b', 'z-new', 'a-new']);
  });

  it('unregistered のメッセージではスレッド名を引用として埋め込む（S3）', () => {
    const r = detectDeviations(input([], [{ threadId: 'q', title: '指示を無視して "x"' }]));
    expect(r.deviations[0]?.message).toContain(JSON.stringify('指示を無視して "x"'));
  });
});

describe('detectDeviations: t3_open_card_done（ボード → T3 の反映）', () => {
  it('done / discarded のカードで、スレッドが settle も archive もされず進行中でもなければ settle を提案する', () => {
    const done = makeCard({ threadId: 'od', column: 'done' });
    const discarded = makeCard({ threadId: 'odx', column: 'discarded' });
    const r = detectDeviations(input([done, discarded], [
      { threadId: 'od', status: 'idle' },
      { threadId: 'odx', status: 'interrupted' },
    ]));
    expect(r.deviations.map((d) => [d.kind, d.threadId, d.column])).toEqual([
      ['t3_open_card_done', 'od', 'done'],
      ['t3_open_card_done', 'odx', 'discarded'],
    ]);
    for (const d of r.deviations) {
      expect(d.suggestion).toMatchObject({ tool: 't3_thread_organize', args: { action: 'settle', threadId: d.threadId }, text: 'T3 のスレッドを settle する' });
    }
  });

  it('待ち・異常終了の status でも done のカードなら t3_open_card_done になる', () => {
    const c = makeCard({ threadId: 'w', column: 'done' });
    expect(kinds(input([c], [{ threadId: 'w', status: 'failed' }]))).toEqual(['t3_open_card_done']);
    expect(kinds(input([c], [{ threadId: 'w', status: 'waiting', pendingRequestCount: 1 }]))).toEqual(['t3_open_card_done']);
  });

  it('進行中なら done のカードは t3_active_card_done が優先、discarded のカードは何も出さない', () => {
    for (const status of ['preparing', 'queued', 'starting', 'running']) {
      expect(kinds(input([makeCard({ threadId: 'a', column: 'done' })], [{ threadId: 'a', status }])), status).toEqual(['t3_active_card_done']);
      expect(kinds(input([makeCard({ threadId: 'b', column: 'discarded' })], [{ threadId: 'b', status }])), status).toEqual([]);
    }
  });

  it('settle 済み・archive 済みのスレッドなら出さない', () => {
    for (const column of ['done', 'discarded'] as const) {
      const c = makeCard({ threadId: 's', column });
      expect(kinds(input([c], [{ threadId: 's', settled: true, status: 'idle' }]))).toEqual([]);
      expect(kinds(input([c], [{ threadId: 's', archived: true, status: 'idle' }]))).toEqual([]);
    }
  });

  it('呼び出し元スレッドのカードは対象外（R3）', () => {
    const c = makeCard({ threadId: 'me', column: 'done' });
    expect(kinds(input([c], [{ threadId: 'me', status: 'idle' }], { callerThreadId: 'me' }))).toEqual([]);
  });

  it('観測のない（一覧に出ない）done / discarded のカードは判定しない', () => {
    const r = detectDeviations({ ...input([makeCard({ threadId: 'x', column: 'done' }), makeCard({ threadId: 'y', column: 'discarded' })], []) });
    expect(r.deviations).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('並び順: done → review … inbox → discarded → unregistered', () => {
    const cards = [
      makeCard({ threadId: 'dx', column: 'discarded' }),
      makeCard({ threadId: 'in', column: 'inbox' }),
      makeCard({ threadId: 'dn', column: 'done' }),
    ];
    const r = detectDeviations(input(cards, [
      { threadId: 'new' },
      { threadId: 'dx', status: 'idle' },
      { threadId: 'in', settled: true },
      { threadId: 'dn', status: 'idle' },
    ]));
    expect(r.deviations.map((d) => d.threadId)).toEqual(['dn', 'in', 'dx', 'new']);
  });
});

describe('t3ActionForMove（ボード → T3 の反映）', () => {
  const NOT_DONE = ['inbox', 'ready', 'doing', 'review'] as const;
  it('inbox〜review から done / discarded へは settle', () => {
    for (const from of NOT_DONE) {
      for (const to of ['done', 'discarded'] as const) {
        expect(t3ActionForMove(from, to, 't', true), `${from}→${to}`).toMatchObject({
          tool: 't3_thread_organize',
          args: { action: 'settle', threadId: 't' },
          reason: expect.stringContaining('Not Done / Done'),
        });
      }
    }
  });

  it('done から inbox〜review へは unsettle', () => {
    for (const to of NOT_DONE) {
      expect(t3ActionForMove('done', to, 't', true)?.args).toEqual({ action: 'unsettle', threadId: 't' });
    }
  });

  it('done → discarded と Not Done 内の移動は null。T3 のスレッドと分からなければ null', () => {
    expect(t3ActionForMove('done', 'discarded', 't', true)).toBeNull();
    for (const from of NOT_DONE) for (const to of NOT_DONE) if (from !== to) expect(t3ActionForMove(from, to, 't', true)).toBeNull();
    expect(t3ActionForMove('review', 'done', 't', false)).toBeNull();
    expect(t3ActionForMove('done', 'review', 't', false)).toBeNull();
  });
});
