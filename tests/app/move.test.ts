import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockCard, toBlockResponse, toUnblockResponse, unblockCard } from '../../src/app/block.js';
import { moveCard, toMoveResponse } from '../../src/app/move.js';
import { resolveThreadId } from '../../src/app/thread-id.js';
import { KanbanStore } from '../../src/store/sqlite.js';
import { DAY, manualClock, tempDir } from '../helpers/fixtures.js';

let dir: ReturnType<typeof tempDir>;
let clock: ReturnType<typeof manualClock>;
let store: KanbanStore;

beforeEach(() => {
  dir = tempDir('kanban-app-');
  clock = manualClock();
  store = KanbanStore.open({ path: join(dir.path, 'k.db'), boardId: 'b1', clock });
});

afterEach(() => {
  store.close();
  dir.cleanup();
});

function add(threadId: string, extra: Record<string, unknown> = {}): void {
  const r = store.addCard({ threadId, title: threadId, ...extra });
  if (!r.ok) throw new Error(r.error.code);
}

function move(threadId: string, to: Parameters<typeof store.moveCard>[1]['to']): void {
  const r = store.moveCard(threadId, { to });
  if (!r.ok) throw new Error(`${threadId} → ${to}: ${r.error.code}`);
}

function lastEvents(n: number) {
  return store.listEvents().slice(-n);
}

describe('resolveThreadId', () => {
  it('指定がなければ既定値を使い、どちらもなければ THREAD_ID_REQUIRED', () => {
    expect(resolveThreadId('a', 'b')).toEqual({ ok: true, value: 'a' });
    expect(resolveThreadId(undefined, 'b')).toEqual({ ok: true, value: 'b' });
    const missing = resolveThreadId(undefined, undefined);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('THREAD_ID_REQUIRED');
    const empty = resolveThreadId('', undefined);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('THREAD_ID_REQUIRED');
  });

  it('形式が不正なら INVALID_ARGUMENT と details.threadId（200 文字で切る）', () => {
    const bad = resolveThreadId('../etc', undefined);
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', details: { threadId: '../etc' } } });
    const long = resolveThreadId(`a${'/'.repeat(300)}`, undefined);
    expect(long.ok).toBe(false);
    if (!long.ok) expect(String(long.error.details?.threadId)).toHaveLength(200);
  });
});

describe('app: moveCard', () => {
  it('成功すると card / decision / notes / t3Action を返し、toMoveResponse は structuredContent の形に展開する', () => {
    add('a');
    const r = moveCard({ store, threadId: 'a', input: { to: 'ready' }, t3Available: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.notes).toEqual([]);
    expect(r.value.t3Action).toBeNull();
    const response = toMoveResponse(r.value);
    expect(Object.keys(response)).toEqual(['card', 'from', 'to', 'direction', 'violation', 'expediteOverLimit', 't3Action']);
    expect(response).toMatchObject({ from: 'inbox', to: 'ready', direction: 'forward', violation: null, expediteOverLimit: false });
    expect(response.card.column).toBe('ready');
  });

  it('WIP を強行すると違反の note が付き、actor が moved と wip_violation の両方に記録される', () => {
    store.configure({ columns: [{ column: 'ready', wipLimit: 1 }] });
    add('a');
    add('b');
    move('a', 'ready');
    const denied = moveCard({ store, threadId: 'b', input: { to: 'ready' }, t3Available: false, actor: 'ui' });
    expect(denied).toMatchObject({ ok: false, error: { code: 'WIP_LIMIT_EXCEEDED' } });

    const r = moveCard({ store, threadId: 'b', input: { to: 'ready', force: true, reason: '急ぎ' }, t3Available: false, actor: 'ui' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.notes).toEqual(['WIP 違反を記録しました（ready 上限 1、理由: 急ぎ）']);
    const [moved, violation] = lastEvents(2);
    expect(moved).toMatchObject({ type: 'moved', data: { force: true, reason: '急ぎ', actor: 'ui' } });
    expect(violation).toMatchObject({ type: 'wip_violation', data: { column: 'ready', limit: 1, reason: '急ぎ', actor: 'ui' } });
  });

  it('actor を省略したとき（MCP）はイベントに actor を付けない', () => {
    add('a');
    const r = moveCard({ store, threadId: 'a', input: { to: 'ready', criteriaConfirmed: true }, t3Available: false });
    expect(r.ok).toBe(true);
    const [moved] = lastEvents(1);
    expect(moved?.data).toEqual({ direction: 'forward', force: false, criteriaConfirmed: true });
  });

  it('expedite が WIP 上限を超えると note が付く', () => {
    store.configure({ columns: [{ column: 'ready', wipLimit: 1 }] });
    add('a');
    add('x', { serviceClass: 'expedite' });
    move('a', 'ready');
    const r = moveCard({ store, threadId: 'x', input: { to: 'ready' }, t3Available: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.notes).toEqual(['expedite のため WIP 上限を超えて移動しました']);
    expect(toMoveResponse(r.value).expediteOverLimit).toBe(true);
  });

  it('done へ移すと t3Available のときだけ settle を提案し、done から戻すと unsettle を提案する', () => {
    add('a');
    for (const to of ['ready', 'doing', 'review'] as const) move('a', to);
    const settle = moveCard({ store, threadId: 'a', input: { to: 'done' }, t3Available: true });
    expect(settle.ok).toBe(true);
    if (!settle.ok) return;
    expect(settle.value.t3Action).toMatchObject({ args: { action: 'settle', threadId: 'a' } });
    expect(settle.value.notes).toEqual([`T3 側: ${settle.value.t3Action?.tool} で settle する（T3 は Not Done / Done だけを持つ）`]);

    const back = moveCard({ store, threadId: 'a', input: { to: 'review' }, t3Available: false });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.t3Action).toBeNull();
    expect(back.value.notes).toEqual([]);
  });

  it('T3 の追跡参照があるカードは t3Available: false でも t3Action を返す', () => {
    add('a', { t3: { link: 'https://l/a', projectId: 'P', parentThreadId: null, branch: null, worktreePath: null, pullRequests: [], syncedAt: 1 } });
    for (const to of ['ready', 'doing', 'review'] as const) move('a', to);
    const r = moveCard({ store, threadId: 'a', input: { to: 'done' }, t3Available: false });
    expect(r.ok && r.value.t3Action?.args.action).toBe('settle');
  });

  it('ブロック中のカードを discard すると、自動の unblocked にも actor が付く', () => {
    add('a');
    store.blockCard('a', '待ち');
    const r = moveCard({ store, threadId: 'a', input: { to: 'discarded' }, t3Available: false, actor: 'ui' });
    expect(r.ok).toBe(true);
    const [moved, unblocked] = lastEvents(2);
    expect(moved).toMatchObject({ type: 'moved', data: { direction: 'discard', actor: 'ui' } });
    expect(unblocked).toMatchObject({ type: 'unblocked', data: { resolution: 'discarded', actor: 'ui' } });
  });

  it('カードがなければ CARD_NOT_FOUND をそのまま返す', () => {
    expect(moveCard({ store, threadId: 'none', input: { to: 'ready' }, t3Available: false })).toMatchObject({
      ok: false,
      error: { code: 'CARD_NOT_FOUND' },
    });
  });
});

describe('app: blockCard / unblockCard', () => {
  it('block / unblock の actor をイベントに記録し、応答は MCP と同じ形（blockedDays は小数第 2 位で丸める）', () => {
    add('a');
    const blocked = blockCard({ store, threadId: 'a', input: { reason: '待ち' }, t3Available: false, actor: 'ui' });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(Object.keys(toBlockResponse(blocked.value))).toEqual(['card']);
    expect(blocked.value.card.blocked?.reason).toBe('待ち');
    expect(lastEvents(1)[0]).toMatchObject({ type: 'blocked', data: { reason: '待ち', actor: 'ui' } });

    clock.advance(DAY / 3);
    const unblocked = unblockCard({ store, threadId: 'a', input: { resolution: '解消' }, t3Available: false, actor: 'ui' });
    expect(unblocked.ok).toBe(true);
    if (!unblocked.ok) return;
    const response = toUnblockResponse(unblocked.value);
    expect(Object.keys(response)).toEqual(['card', 'blockedDays']);
    expect(response.blockedDays).toBe(0.33);
    expect(lastEvents(1)[0]).toMatchObject({ type: 'unblocked', data: { reason: '待ち', resolution: '解消', actor: 'ui' } });
  });

  it('actor を省略したときはイベントに actor を付けず、失敗はそのまま返す', () => {
    add('a');
    expect(blockCard({ store, threadId: 'a', input: { reason: 'r' }, t3Available: false }).ok).toBe(true);
    expect(lastEvents(1)[0]?.data).toEqual({ reason: 'r' });
    expect(blockCard({ store, threadId: 'a', input: { reason: 'r' }, t3Available: false })).toMatchObject({
      ok: false,
      error: { code: 'ALREADY_BLOCKED' },
    });
    expect(unblockCard({ store, threadId: 'a', input: {}, t3Available: false }).ok).toBe(true);
    expect(Object.keys(lastEvents(1)[0]?.data ?? {})).toEqual(['reason', 'blockedDays']);
    expect(unblockCard({ store, threadId: 'a', input: {}, t3Available: false })).toMatchObject({
      ok: false,
      error: { code: 'NOT_BLOCKED' },
    });
  });
});
