import { describe, expect, it } from 'vitest';
import { pullCandidates, recommendNext } from '../../src/domain/next.js';
import { HOUR, makeBoard, makeCard, T0 } from '../helpers/fixtures.js';

describe('recommendNext の優先順', () => {
  it('1. review のカードがあれば完了支援を推奨する（ブロックや ready より優先）', () => {
    const cards = [
      makeCard({ threadId: 'rev', column: 'review' }),
      makeCard({ threadId: 'blk', column: 'doing', blocked: { reason: 'x', since: T0 } }),
      makeCard({ threadId: 'rdy', column: 'ready' }),
    ];
    const r = recommendNext(makeBoard(), cards);
    expect(r.action).toBe('complete_review');
    expect(r.card?.threadId).toBe('rev');
  });

  it('2. review がなければブロック中カードの解消を推奨する（ready より優先）', () => {
    const cards = [
      makeCard({ threadId: 'blk', column: 'doing', blocked: { reason: 'レビュアー不在', since: T0 } }),
      makeCard({ threadId: 'rdy', column: 'ready' }),
    ];
    const r = recommendNext(makeBoard(), cards);
    expect(r.action).toBe('resolve_blocker');
    expect(r.card?.threadId).toBe('blk');
  });

  it('review にあるのがブロック中カードだけなら、それはブロック解消として扱う', () => {
    const cards = [makeCard({ threadId: 'rev-blk', column: 'review', blocked: { reason: 'x', since: T0 } })];
    const r = recommendNext(makeBoard(), cards);
    expect(r.action).toBe('resolve_blocker');
    expect(r.card?.threadId).toBe('rev-blk');
  });

  it('ブロック中カードは done に近い列から推奨する', () => {
    const cards = [
      makeCard({ threadId: 'ready-blk', column: 'ready', blocked: { reason: 'x', since: T0 } }),
      makeCard({ threadId: 'doing-blk', column: 'doing', blocked: { reason: 'x', since: T0 + HOUR } }),
    ];
    expect(recommendNext(makeBoard(), cards).card?.threadId).toBe('doing-blk');
  });

  it('3. doing に空きがあれば ready からクラス順に pull を推奨する', () => {
    const cards = [makeCard({ threadId: 'reg', column: 'ready' }), makeCard({ threadId: 'exp', column: 'ready', serviceClass: 'expedite' })];
    const r = recommendNext(makeBoard(), cards);
    expect(r.action).toBe('pull');
    expect(r.to).toBe('doing');
    expect(r.card?.threadId).toBe('exp');
  });

  it('4. doing に空きがなければ新規着手しない', () => {
    const cards = [
      ...[1, 2, 3].map((i) => makeCard({ threadId: `d${i}`, column: 'doing' })),
      makeCard({ threadId: 'rdy', column: 'ready' }),
    ];
    const r = recommendNext(makeBoard(), cards);
    expect(r.action).toBe('no_new_work');
    expect(r.idleReason).toBe('NO_CAPACITY');
    expect(r.card).toBeNull();
  });

  it('doing に空きがなくても ready の expedite は pull を推奨する', () => {
    const cards = [
      ...[1, 2, 3].map((i) => makeCard({ threadId: `d${i}`, column: 'doing' })),
      makeCard({ threadId: 'exp', column: 'ready', serviceClass: 'expedite' }),
    ];
    const r = recommendNext(makeBoard(), cards);
    expect(r.action).toBe('pull');
    expect(r.card?.threadId).toBe('exp');
  });

  it('ready が空なら新規着手しない（READY_EMPTY）', () => {
    const r = recommendNext(makeBoard(), [makeCard({ column: 'inbox' })]);
    expect(r.action).toBe('no_new_work');
    expect(r.idleReason).toBe('READY_EMPTY');
  });
});

describe('pull 順: expedite > fixed_date（期限順）> regular（FIFO）> intangible', () => {
  it('クラス順と期限順・到着順で並ぶ', () => {
    const cards = [
      makeCard({ threadId: 'reg-late', column: 'ready', columnEnteredAt: T0 + 2 * HOUR }),
      makeCard({ threadId: 'fix-far', column: 'ready', serviceClass: 'fixed_date', dueDate: '2026-03-01' }),
      makeCard({ threadId: 'reg-early', column: 'ready', columnEnteredAt: T0 + HOUR }),
      makeCard({ threadId: 'exp', column: 'ready', serviceClass: 'expedite', columnEnteredAt: T0 + 5 * HOUR }),
      makeCard({ threadId: 'fix-near', column: 'ready', serviceClass: 'fixed_date', dueDate: '2026-01-20' }),
    ];
    expect(pullCandidates(cards).map((c) => c.threadId)).toEqual(['exp', 'fix-near', 'fix-far', 'reg-early', 'reg-late']);
  });

  it('intangible は他クラスが ready にあるときは候補にならない', () => {
    const cards = [
      makeCard({ threadId: 'int', column: 'ready', serviceClass: 'intangible', columnEnteredAt: T0 }),
      makeCard({ threadId: 'reg', column: 'ready', columnEnteredAt: T0 + HOUR }),
    ];
    expect(pullCandidates(cards).map((c) => c.threadId)).toEqual(['reg']);
  });

  it('intangible は他クラスが ready にないときだけ pull 候補になる', () => {
    const cards = [makeCard({ threadId: 'int', column: 'ready', serviceClass: 'intangible' })];
    const r = recommendNext(makeBoard(), cards);
    expect(r.action).toBe('pull');
    expect(r.card?.threadId).toBe('int');
  });

  it('ready のブロック中カードは pull 候補にならない', () => {
    const cards = [
      makeCard({ threadId: 'blk', column: 'ready', blocked: { reason: 'x', since: T0 } }),
      makeCard({ threadId: 'ok', column: 'ready', columnEnteredAt: T0 + HOUR }),
    ];
    expect(pullCandidates(cards).map((c) => c.threadId)).toEqual(['ok']);
  });
});
