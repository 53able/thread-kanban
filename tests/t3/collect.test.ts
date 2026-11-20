import { describe, expect, it } from 'vitest';
import type { T3Thread } from '../../src/domain/sync.js';
import { collectFromArgument, collectFromCli, SYNC_TOTAL_TIMEOUT_MS } from '../../src/t3/collect.js';
import type { CallOptions, ListResult, ShowResult, T3Gateway } from '../../src/t3/gateway.js';
import { makeCard } from '../helpers/fixtures.js';

interface FakeGatewayOptions {
  current?: string | null;
  available?: boolean;
  /** show が返すスレッド（list に出るかどうかは listIds で決める） */
  threads: T3Thread[];
  listIds: string[];
  /** show で応答しない（timeoutMs まで待って timeout を返す）threadId */
  hang?: string[];
  listFails?: boolean;
}

function fakeGateway(o: FakeGatewayOptions) {
  const shows: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const gateway: T3Gateway = {
    available: () => o.available ?? true,
    currentThreadId: () => (o.current === undefined ? 'caller' : o.current),
    async showThread(id: string, call?: CallOptions): Promise<ShowResult> {
      shows.push(id);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (o.hang?.includes(id)) {
          await new Promise((r) => setTimeout(r, call?.timeoutMs ?? 0));
          return { kind: 'error', reason: 'timeout', message: 'timeout' };
        }
        await new Promise((r) => setTimeout(r, 5));
        const t = o.threads.find((x) => x.threadId === id);
        return t === undefined ? { kind: 'missing' } : { kind: 'found', thread: t };
      } finally {
        inFlight -= 1;
      }
    },
    async listThreads(projectId: string): Promise<ListResult> {
      if (o.listFails) return { ok: false, reason: 'exit', message: 'boom' };
      return { ok: true, threads: o.threads.filter((t) => o.listIds.includes(t.threadId) && t.projectId === projectId), skipped: 0 };
    },
    shutdown: () => {},
  };
  return { gateway, shows, maxInFlight: () => maxInFlight };
}

const caller: T3Thread = { threadId: 'caller', projectId: 'p1', status: 'running' };

describe('collectFromCli（R4）', () => {
  it('呼び出し元を show して projectId を得て list し、list に出ない inbox〜review のカードだけ show する', async () => {
    const f = fakeGateway({
      threads: [caller, { threadId: 'listed', projectId: 'p1' }, { threadId: 'child', projectId: 'p1', parentThreadId: 'listed' }],
      listIds: ['caller', 'listed'],
    });
    const cards = [
      makeCard({ threadId: 'listed', column: 'doing' }),
      makeCard({ threadId: 'child', column: 'doing' }),
      makeCard({ threadId: 'gone', column: 'ready' }),
      makeCard({ threadId: 'old-done', column: 'done' }),
      makeCard({ threadId: 'old-discarded', column: 'discarded' }),
    ];
    const r = await collectFromCli(f.gateway, cards);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.projectId).toBe('p1');
    expect(f.shows.sort()).toEqual(['caller', 'child', 'gone']);
    expect(r.value.observations.get('child')).toEqual({ kind: 'found', thread: { threadId: 'child', projectId: 'p1', parentThreadId: 'listed' } });
    expect(r.value.observations.get('gone')).toEqual({ kind: 'missing' });
    expect(r.value.observations.has('old-done')).toBe(false);
  });

  it('個別取得は同時 4 本まで', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const f = fakeGateway({ threads: [caller, ...ids.map((threadId) => ({ threadId, projectId: 'p1' }))], listIds: ['caller'] });
    const r = await collectFromCli(f.gateway, ids.map((threadId) => makeCard({ threadId, column: 'doing' })));
    expect(r.ok).toBe(true);
    expect(f.maxInFlight()).toBe(4);
  });

  it('1 本の上限を超えたものは unknown（timeout）、全体の上限を超えたものは unknown（deadline）になる', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `h${i}`);
    const f = fakeGateway({ threads: [caller], listIds: ['caller'], hang: ids });
    const started = Date.now();
    const r = await collectFromCli(
      f.gateway,
      ids.map((threadId) => makeCard({ threadId, column: 'doing' })),
      { perCallTimeoutMs: 100, totalTimeoutMs: 150, concurrency: 4 },
    );
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const reasons = ids.map((id) => {
      const o = r.value.observations.get(id);
      return o?.kind === 'unknown' ? o.reason : o?.kind;
    });
    expect(reasons.slice(0, 4)).toEqual(['timeout', 'timeout', 'timeout', 'timeout']);
    // 2 巡目は残り 50ms 程度で timeout、またはその時点で期限切れなら deadline
    for (const reason of reasons.slice(4)) expect(['timeout', 'deadline']).toContain(reason);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('CLI がない、呼び出し元スレッドがない、一覧が取れないときは T3_UNAVAILABLE', async () => {
    const none = await collectFromCli(fakeGateway({ available: false, threads: [], listIds: [] }).gateway, []);
    expect(!none.ok && none.error.code).toBe('T3_UNAVAILABLE');
    const noCaller = await collectFromCli(fakeGateway({ current: null, threads: [], listIds: [] }).gateway, []);
    expect(!noCaller.ok && noCaller.error.details?.reason).toBe('no_current_thread');
    const listFails = await collectFromCli(fakeGateway({ threads: [caller], listIds: [], listFails: true }).gateway, []);
    expect(!listFails.ok && listFails.error.code).toBe('T3_UNAVAILABLE');
    const callerMissing = await collectFromCli(fakeGateway({ threads: [], listIds: [] }).gateway, []);
    expect(!callerMissing.ok && callerMissing.error.details?.reason).toBe('current_thread_missing');
  });
});

describe('collectFromArgument（R14）', () => {
  it('引数のスレッドで判定し、引数にない inbox〜review のカードは unknown にする。未知のキーは無視し、不正な要素は捨てて数える', () => {
    const cards = [makeCard({ threadId: 'a', column: 'doing' }), makeCard({ threadId: 'b', column: 'ready' }), makeCard({ threadId: 'c', column: 'done' })];
    const r = collectFromArgument([{ threadId: 'a', status: 'running', somethingNew: 1 }, { threadId: '-x' }, { threadId: 'y', settled: 'no' }], cards);
    expect(r.source).toBe('argument');
    expect(r.skippedThreads).toBe(2);
    expect(r.observations.get('a')).toEqual({ kind: 'found', thread: { threadId: 'a', status: 'running' } });
    expect(r.observations.get('b')).toEqual({ kind: 'unknown', reason: 'not_in_threads_argument' });
    expect(r.observations.has('c')).toBe(false);
  });
});

describe('全体の打ち切り時間', () => {
  it('受け入れ基準 13 の 20 秒に応答の組み立ての余裕を残すため 19 秒にしている', () => {
    expect(SYNC_TOTAL_TIMEOUT_MS).toBe(19_000);
  });
});
