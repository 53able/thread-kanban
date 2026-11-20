import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../../src/server.js';
import { tempDir } from '../helpers/fixtures.js';
import { startServer, structured, text, type Harness } from '../helpers/mcp.js';

const tmp = tempDir('kanban-e2e-');
afterAll(() => tmp.cleanup());

let counter = 0;
function freshEnv(extra: Record<string, string> = {}): Record<string, string> {
  counter += 1;
  return {
    KANBAN_DB_PATH: join(tmp.path, `e2e-${counter}.db`),
    HOME: join(tmp.path, `home-${counter}`),
    ...extra,
  };
}

describe('MCP サーバー（ビルド済み dist/index.js を stdio で起動）', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startServer(freshEnv());
  });
  afterAll(async () => {
    await h.close();
  });

  it('tools/list が 10 個ちょうどのツールを返す', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'kanban_board_get',
        'kanban_board_configure',
        'kanban_card_add',
        'kanban_card_update',
        'kanban_card_move',
        'kanban_card_block',
        'kanban_card_unblock',
        'kanban_next',
        'kanban_metrics',
        'kanban_sync',
      ].sort(),
    );
    expect(tools).toHaveLength(10);
    expect([...TOOL_NAMES].sort()).toEqual(tools.map((t) => t.name).sort());
  });

  it('stdio 経由で add → move (inbox→ready→doing→review→done) → board_get → metrics の一連が成功する', async () => {
    const add = await h.call('kanban_card_add', { threadId: 'flow-1', title: '一連の流れ', type: 'defect' });
    expect(add.isError).toBeFalsy();
    expect(structured(add).card.column).toBe('inbox');

    for (const to of ['ready', 'doing', 'review', 'done']) {
      const move = await h.call('kanban_card_move', { threadId: 'flow-1', to });
      expect(move.isError, text(move)).toBeFalsy();
      expect(structured(move).card.column).toBe(to);
    }

    const board = await h.call('kanban_board_get');
    expect(board.isError).toBeFalsy();
    const done = structured(board).board.columns.find((c: { column: string }) => c.column === 'done');
    expect(done.cards.map((c: { threadId: string }) => c.threadId)).toContain('flow-1');

    const metrics = await h.call('kanban_metrics');
    expect(metrics.isError).toBeFalsy();
    const m = structured(metrics).metrics;
    expect(m.completed.map((c: { threadId: string }) => c.threadId)).toContain('flow-1');
    expect(m.leadTime.count).toBeGreaterThanOrEqual(1);
    expect(m.failureDemand.defects).toBeGreaterThanOrEqual(1);
  });

  it('全ツールが content のテキストと structuredContent の両方を返す（成功時・失敗時とも）', async () => {
    await h.call('kanban_card_add', { threadId: 'all-1', title: 'all tools' });
    const calls: [string, Record<string, unknown>][] = [
      ['kanban_board_get', {}],
      ['kanban_board_configure', { columns: [{ column: 'ready', wipLimit: 6 }], staleDays: 4 }],
      ['kanban_card_add', { threadId: 'all-1', title: 'all tools' }],
      ['kanban_card_update', { threadId: 'all-1', size: 'S', externalRefs: ['PR#12'] }],
      ['kanban_card_move', { threadId: 'all-1', to: 'ready' }],
      ['kanban_card_block', { threadId: 'all-1', reason: 'レビュー待ち' }],
      ['kanban_card_unblock', { threadId: 'all-1', resolution: '解消' }],
      ['kanban_next', {}],
      ['kanban_metrics', { from: '2020-01-01' }],
      ['kanban_sync', { threads: [] }],
      // 失敗系
      ['kanban_card_move', { threadId: 'all-1', to: 'review' }],
      ['kanban_card_unblock', { threadId: 'all-1' }],
    ];
    const seen = new Set<string>();
    for (const [name, args] of calls) {
      const r = await h.call(name, args);
      seen.add(name);
      expect(text(r).length, name).toBeGreaterThan(0);
      expect(r.content.some((c) => c.type === 'text'), name).toBe(true);
      expect(typeof r.structuredContent, name).toBe('object');
      expect(structured(r).ok, name).toBe(r.isError !== true);
    }
    expect([...seen].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('ルール違反は isError: true と structuredContent の理由コードで返る', async () => {
    const cases: [string, Record<string, unknown>, string][] = [];
    await h.call('kanban_card_add', { threadId: 'r-1', title: 'r1' });
    cases.push(['kanban_card_move', { threadId: 'r-1', to: 'doing' }, 'SKIP_NOT_ALLOWED']);
    cases.push(['kanban_card_move', { threadId: 'r-1', to: 'ready', force: true }, 'FORCE_REASON_REQUIRED']);
    cases.push(['kanban_card_move', { threadId: 'missing', to: 'ready' }, 'CARD_NOT_FOUND']);
    cases.push(['kanban_card_add', { threadId: 'r-2', title: 'x', serviceClass: 'fixed_date' }, 'DUE_DATE_REQUIRED']);
    for (const [name, args, code] of cases) {
      const r = await h.call(name, args);
      expect(r.isError, `${name} ${code}`).toBe(true);
      expect(structured(r)).toMatchObject({ ok: false, code });
      expect(text(r)).toContain(code);
    }

    await h.call('kanban_card_block', { threadId: 'r-1', reason: '待ち' });
    await h.call('kanban_card_move', { threadId: 'r-1', to: 'ready' }).then((r) => {
      expect(structured(r)).toMatchObject({ ok: false, code: 'BLOCKED' });
    });
  });

  it('WIP 超過・expedite・入場条件の拒否理由と付随情報を返す', async () => {
    const own = await startServer(freshEnv());
    try {
      for (const t of ['w1', 'w2', 'w3', 'w4']) {
        await own.call('kanban_card_add', { threadId: t, title: t });
        await own.call('kanban_card_move', { threadId: t, to: 'ready' });
      }
      for (const t of ['w1', 'w2', 'w3']) await own.call('kanban_card_move', { threadId: t, to: 'doing' });
      const over = await own.call('kanban_card_move', { threadId: 'w4', to: 'doing' });
      expect(over.isError).toBe(true);
      expect(structured(over).code).toBe('WIP_LIMIT_EXCEEDED');
      expect(structured(over).details.occupantThreadIds).toEqual(['w1', 'w2', 'w3']);

      const forced = await own.call('kanban_card_move', { threadId: 'w4', to: 'doing', force: true, reason: '緊急' });
      expect(forced.isError).toBeFalsy();
      expect(structured(forced).violation.limit).toBe(3);
      const board = structured(await own.call('kanban_board_get')).board;
      expect(board.wipViolations).toEqual([{ column: 'doing', wipLimit: 3, count: 4 }]);
      expect(structured(await own.call('kanban_metrics')).metrics.wipViolations).toBe(1);

      await own.call('kanban_card_add', { threadId: 'x1', title: 'x1', serviceClass: 'expedite' });
      const exp2 = await own.call('kanban_card_add', { threadId: 'x2', title: 'x2', serviceClass: 'expedite' });
      expect(structured(exp2)).toMatchObject({ ok: false, code: 'EXPEDITE_LIMIT' });
      await own.call('kanban_card_move', { threadId: 'x1', to: 'ready' });
      const expMove = await own.call('kanban_card_move', { threadId: 'x1', to: 'doing' });
      expect(expMove.isError).toBeFalsy();
      expect(structured(expMove).expediteOverLimit).toBe(true);

      await own.call('kanban_board_configure', { columns: [{ column: 'review', entryCriteria: ['テスト済み'] }] });
      const crit = await own.call('kanban_card_move', { threadId: 'x1', to: 'review' });
      expect(structured(crit)).toMatchObject({ ok: false, code: 'CRITERIA_NOT_CONFIRMED', details: { entryCriteria: ['テスト済み'] } });
      const ok = await own.call('kanban_card_move', { threadId: 'x1', to: 'review', criteriaConfirmed: true });
      expect(ok.isError).toBeFalsy();

      const next = structured(await own.call('kanban_next')).recommendation;
      expect(next).toMatchObject({ action: 'complete_review', card: { threadId: 'x1' } });
    } finally {
      await own.close();
    }
  });

  it('同じ threadId で 2 回 add してもカードは 1 枚', async () => {
    const own = await startServer(freshEnv());
    try {
      const a = await own.call('kanban_card_add', { threadId: 'dup', title: '1' });
      const b = await own.call('kanban_card_add', { threadId: 'dup', title: '2' });
      expect(structured(a).created).toBe(true);
      expect(structured(b).created).toBe(false);
      const cards = structured(await own.call('kanban_board_get')).board.columns.flatMap((c: { cards: unknown[] }) => c.cards);
      expect(cards).toHaveLength(1);
    } finally {
      await own.close();
    }
  });
});

describe('threadId の既定値', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('threadId 引数がなく KANBAN_THREAD_ID もない場合は isError (THREAD_ID_REQUIRED) で拒否する', async () => {
    h = await startServer(freshEnv());
    for (const [name, args] of [
      ['kanban_card_add', { title: 'x' }],
      ['kanban_card_update', { title: 'y' }],
      ['kanban_card_move', { to: 'ready' }],
      ['kanban_card_block', { reason: 'r' }],
      ['kanban_card_unblock', {}],
    ] as [string, Record<string, unknown>][]) {
      const r = await h.call(name, args);
      expect(r.isError, name).toBe(true);
      expect(structured(r), name).toMatchObject({ ok: false, code: 'THREAD_ID_REQUIRED' });
    }
  });

  it('KANBAN_THREAD_ID があればそれを使い、引数があれば引数を優先する', async () => {
    h = await startServer(freshEnv({ KANBAN_THREAD_ID: 'env-thread' }));
    const add = await h.call('kanban_card_add', { title: 'env' });
    expect(add.isError).toBeFalsy();
    expect(structured(add).card.threadId).toBe('env-thread');
    const move = await h.call('kanban_card_move', { to: 'ready' });
    expect(structured(move).card).toMatchObject({ threadId: 'env-thread', column: 'ready' });
    const other = await h.call('kanban_card_add', { threadId: 'explicit', title: 'explicit' });
    expect(structured(other).card.threadId).toBe('explicit');
  });
});

describe('入力の検証', () => {
  it('実在しない dueDate、空白だけの threadId、366 日を超える期間を拒否する', async () => {
    const h = await startServer(freshEnv());
    try {
      const badDate = await h.call('kanban_card_add', { threadId: 'v-1', title: 'x', dueDate: '2026-13-45' });
      expect(badDate.isError).toBe(true);
      const blank = await h.call('kanban_card_add', { threadId: '   ', title: 'x' });
      expect(blank.isError).toBe(true);
      const board = structured(await h.call('kanban_board_get')).board;
      expect(board.columns.flatMap((c: { cards: unknown[] }) => c.cards)).toEqual([]);

      const tooLong = await h.call('kanban_metrics', { from: '2020-01-01', to: '2026-01-01' });
      expect(tooLong.isError).toBe(true);
      expect(structured(tooLong)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
      const year = await h.call('kanban_metrics', { from: '2025-01-01', to: '2025-12-31' });
      expect(year.isError).toBeFalsy();
    } finally {
      await h.close();
    }
  });
});

describe('ボードの共有', () => {
  it('同じ DB を使う 2 つのサーバープロセスが同じボードを見る', async () => {
    const env = freshEnv();
    const a = await startServer(env);
    const b = await startServer(env);
    try {
      await a.call('kanban_card_add', { threadId: 'shared', title: 'from a' });
      const board = structured(await b.call('kanban_board_get')).board;
      const inbox = board.columns.find((c: { column: string }) => c.column === 'inbox');
      expect(inbox.cards.map((c: { threadId: string }) => c.threadId)).toEqual(['shared']);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
