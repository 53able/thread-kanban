import { describe, expect, it } from 'vitest';
import { checkClassPolicy, checkMove } from '../../src/domain/rules.js';
import type { Card } from '../../src/domain/types.js';
import { makeBoard, makeCard } from '../helpers/fixtures.js';

function errorOf<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; details?: Record<string, unknown> } }) {
  if (r.ok) throw new Error('エラーを期待したが成功した');
  return r.error;
}

function doingFull(): Card[] {
  return [1, 2, 3].map((i) => makeCard({ id: 100 + i, threadId: `busy-${i}`, column: 'doing' }));
}

describe('checkMove: WIP', () => {
  it('doing 上限 3 のとき 4 枚目の移動は WIP_LIMIT_EXCEEDED で、占有中 3 枚の threadId を返す', () => {
    const card = makeCard({ column: 'ready' });
    const err = errorOf(checkMove({ card, to: 'doing', cards: [...doingFull(), card], board: makeBoard() }));
    expect(err.code).toBe('WIP_LIMIT_EXCEEDED');
    expect(err.details?.occupantThreadIds).toEqual(['busy-1', 'busy-2', 'busy-3']);
    expect(err.details?.limit).toBe(3);
  });

  it('上限未満なら移動できる', () => {
    const card = makeCard({ column: 'ready' });
    const r = checkMove({ card, to: 'doing', cards: [...doingFull().slice(0, 2), card], board: makeBoard() });
    expect(r.ok).toBe(true);
  });

  it('force: true で reason なしは FORCE_REASON_REQUIRED', () => {
    const card = makeCard({ column: 'ready' });
    expect(errorOf(checkMove({ card, to: 'doing', cards: [...doingFull(), card], board: makeBoard(), force: true })).code).toBe(
      'FORCE_REASON_REQUIRED',
    );
    expect(
      errorOf(checkMove({ card, to: 'doing', cards: [...doingFull(), card], board: makeBoard(), force: true, reason: '  ' })).code,
    ).toBe('FORCE_REASON_REQUIRED');
  });

  it('force: true と reason で WIP を突破し、違反内容を返す', () => {
    const card = makeCard({ column: 'ready' });
    const r = checkMove({ card, to: 'doing', cards: [...doingFull(), card], board: makeBoard(), force: true, reason: '障害対応' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.violation).toMatchObject({ column: 'doing', limit: 3, countBefore: 3, reason: '障害対応' });
  });

  it('expedite は WIP 上限を超えて移動できる（違反扱いにしない）', () => {
    const card = makeCard({ column: 'ready', serviceClass: 'expedite' });
    const r = checkMove({ card, to: 'doing', cards: [...doingFull(), card], board: makeBoard() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expediteOverLimit).toBe(true);
    expect(r.value.violation).toBeNull();
  });

  it('上限 null の列は無制限', () => {
    const card = makeCard({ column: 'review' });
    const done = Array.from({ length: 50 }, (_, i) => makeCard({ id: 500 + i, column: 'done' }));
    expect(checkMove({ card, to: 'done', cards: [...done, card], board: makeBoard() }).ok).toBe(true);
  });

  it('差し戻し先の列も WIP 上限を適用する', () => {
    const card = makeCard({ column: 'review' });
    expect(errorOf(checkMove({ card, to: 'doing', cards: [...doingFull(), card], board: makeBoard() })).code).toBe(
      'WIP_LIMIT_EXCEEDED',
    );
  });
});

describe('checkMove: 方向', () => {
  it('inbox から doing への飛び越しは SKIP_NOT_ALLOWED', () => {
    const card = makeCard({ column: 'inbox' });
    const err = errorOf(checkMove({ card, to: 'doing', cards: [card], board: makeBoard() }));
    expect(err.code).toBe('SKIP_NOT_ALLOWED');
    expect(err.details?.nextColumn).toBe('ready');
  });

  it('review から doing への差し戻しは成功（backward）', () => {
    const card = makeCard({ column: 'review' });
    const r = checkMove({ card, to: 'doing', cards: [card], board: makeBoard() });
    expect(r.ok && r.value.direction).toBe('backward');
  });

  it('done から inbox への後退も可能', () => {
    const card = makeCard({ column: 'done' });
    expect(checkMove({ card, to: 'inbox', cards: [card], board: makeBoard() }).ok).toBe(true);
  });

  it.each(['inbox', 'ready', 'doing', 'review', 'done'] as const)('%s から discarded へ移動できる', (from) => {
    const card = makeCard({ column: from });
    const r = checkMove({ card, to: 'discarded', cards: [card], board: makeBoard() });
    expect(r.ok && r.value.direction).toBe('discard');
  });

  it('ブロック中でも discarded へは移動できる', () => {
    const card = makeCard({ column: 'doing', blocked: { reason: 'x', since: 0 } });
    expect(checkMove({ card, to: 'discarded', cards: [card], board: makeBoard() }).ok).toBe(true);
  });

  it('discarded からは移動できない（TERMINAL_COLUMN）', () => {
    const card = makeCard({ column: 'discarded' });
    expect(errorOf(checkMove({ card, to: 'inbox', cards: [card], board: makeBoard() })).code).toBe('TERMINAL_COLUMN');
  });

  it('同じ列への移動は SAME_COLUMN', () => {
    const card = makeCard({ column: 'ready' });
    expect(errorOf(checkMove({ card, to: 'ready', cards: [card], board: makeBoard() })).code).toBe('SAME_COLUMN');
  });
});

describe('checkMove: ブロック', () => {
  it('ブロック中カードの前進は BLOCKED', () => {
    const card = makeCard({ column: 'doing', blocked: { reason: 'API キー待ち', since: 0 } });
    const err = errorOf(checkMove({ card, to: 'review', cards: [card], board: makeBoard() }));
    expect(err.code).toBe('BLOCKED');
    expect(err.details?.blockedReason).toBe('API キー待ち');
  });

  it('ブロック中カードは force でも前進できない', () => {
    const card = makeCard({ column: 'doing', blocked: { reason: 'x', since: 0 } });
    expect(errorOf(checkMove({ card, to: 'review', cards: [card], board: makeBoard(), force: true, reason: 'r' })).code).toBe(
      'BLOCKED',
    );
  });

  it('ブロック中カードの差し戻しは可能', () => {
    const card = makeCard({ column: 'doing', blocked: { reason: 'x', since: 0 } });
    expect(checkMove({ card, to: 'ready', cards: [card], board: makeBoard() }).ok).toBe(true);
  });

  it('ブロック中カードは WIP 上限の判定で数えられる', () => {
    const blocked = makeCard({ id: 900, threadId: 'blocked', column: 'doing', blocked: { reason: 'x', since: 0 } });
    const others = [makeCard({ id: 901, column: 'doing' }), makeCard({ id: 902, column: 'doing' })];
    const card = makeCard({ column: 'ready' });
    const all = [blocked, ...others, card];
    const err = errorOf(checkMove({ card, to: 'doing', cards: all, board: makeBoard() }));
    expect(err.code).toBe('WIP_LIMIT_EXCEEDED');
    expect(err.details?.occupantThreadIds).toContain('blocked');
  });
});

describe('checkMove: 入場条件', () => {
  const board = makeBoard({ review: { entryCriteria: ['テストが通る', 'PR を作成済み'] } });

  it('入場条件を持つ列への移動は criteriaConfirmed なしで拒否され、条件一覧が返る', () => {
    const card = makeCard({ column: 'doing' });
    const err = errorOf(checkMove({ card, to: 'review', cards: [card], board }));
    expect(err.code).toBe('CRITERIA_NOT_CONFIRMED');
    expect(err.details?.entryCriteria).toEqual(['テストが通る', 'PR を作成済み']);
  });

  it('criteriaConfirmed: true なら移動できる', () => {
    const card = makeCard({ column: 'doing' });
    expect(checkMove({ card, to: 'review', cards: [card], board, criteriaConfirmed: true }).ok).toBe(true);
  });

  it('入場条件のない列は criteriaConfirmed 不要', () => {
    const card = makeCard({ column: 'inbox' });
    expect(checkMove({ card, to: 'ready', cards: [card], board }).ok).toBe(true);
  });
});

describe('サービスクラスのポリシー', () => {
  it('fixed_date で dueDate なしは DUE_DATE_REQUIRED', () => {
    expect(errorOf(checkClassPolicy({ serviceClass: 'fixed_date', dueDate: null }, [], null)).code).toBe('DUE_DATE_REQUIRED');
    expect(checkClassPolicy({ serviceClass: 'fixed_date', dueDate: '2026-02-01' }, [], null).ok).toBe(true);
  });

  it('ボード上 2 枚目の expedite は EXPEDITE_LIMIT', () => {
    const existing = makeCard({ serviceClass: 'expedite', column: 'doing' });
    const err = errorOf(checkClassPolicy({ serviceClass: 'expedite', dueDate: null }, [existing], null));
    expect(err.code).toBe('EXPEDITE_LIMIT');
  });

  it('done / discarded の expedite は同時枚数に数えない', () => {
    const done = makeCard({ serviceClass: 'expedite', column: 'done' });
    const discarded = makeCard({ serviceClass: 'expedite', column: 'discarded' });
    expect(checkClassPolicy({ serviceClass: 'expedite', dueDate: null }, [done, discarded], null).ok).toBe(true);
  });

  it('自分自身の更新は同時枚数に数えない', () => {
    const self = makeCard({ serviceClass: 'expedite', column: 'doing' });
    expect(checkClassPolicy({ serviceClass: 'expedite', dueDate: null }, [self], self).ok).toBe(true);
  });

  it('done の expedite を差し戻して 2 枚目にすることはできない', () => {
    const active = makeCard({ serviceClass: 'expedite', column: 'doing' });
    const done = makeCard({ serviceClass: 'expedite', column: 'done' });
    expect(errorOf(checkMove({ card: done, to: 'review', cards: [active, done], board: makeBoard() })).code).toBe(
      'EXPEDITE_LIMIT',
    );
  });
});
