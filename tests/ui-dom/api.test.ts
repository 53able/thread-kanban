import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBoard } from '../../ui/api.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ui/api.ts', () => {
  it('503 BOARD_UNAVAILABLE は再試行せず、そのまま失敗として返す（BUSY だけを再試行する）', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { ok: false, code: 'BOARD_UNAVAILABLE', message: 'ボードを読み込めません' }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await getBoard('k1');
    expect(r).toMatchObject({ ok: false, status: 503, code: 'BOARD_UNAVAILABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('503 BUSY は再試行して、成功すればその応答を返す', async () => {
    const ok = { ok: true, key: 'k1', label: 'repo', board: null, next: null, now: '', lastEventId: 0 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { ok: false, code: 'BUSY', message: 'locked' }))
      .mockResolvedValueOnce(jsonResponse(200, ok));
    vi.stubGlobal('fetch', fetchMock);
    const r = await getBoard('k1');
    expect(r).toEqual(ok);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
