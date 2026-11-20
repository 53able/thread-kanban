import { describe, expect, it, vi } from 'vitest';
import type { HealthResult } from '../../ui/api.js';
import { openStream, streamUrl, type StreamDeps, type StreamHandlers } from '../../ui/sse.js';
import { boardResp, event } from './fixtures.js';

class FakeSource {
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  listeners = new Map<string, (ev: MessageEvent) => void>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function setup(healthResults: HealthResult[]) {
  const sources: FakeSource[] = [];
  const timers: { cb: () => void; ms: number }[] = [];
  const handlers: StreamHandlers & { calls: string[] } = {
    calls: [],
    onEvents: vi.fn((events, info) => handlers.calls.push(`events:${events.length}:${info.initial}:${info.gap}`)),
    onSnapshot: vi.fn((r) => handlers.calls.push(`snapshot:${r.lastEventId}`)),
    onBanner: vi.fn((b) => handlers.calls.push(`banner:${b}`)),
  };
  const deps: StreamDeps = {
    createEventSource: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    health: vi.fn(async () => healthResults.shift() ?? { kind: 'network' as const }),
    setTimer: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length;
    },
    clearTimer: vi.fn(),
  };
  return { sources, timers, handlers, deps };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const valid: HealthResult = { kind: 'http', status: 200, body: { ok: true, version: '1', authenticated: 'valid' } };

describe('openStream', () => {
  it('URL に ?lastEventId= を付け、onerror ですぐ close() して最後の id で作り直す（待ち時間は指数的）', async () => {
    const { sources, timers, handlers, deps } = setup([{ kind: 'network' }, { kind: 'network' }]);
    openStream('k 1', 10, handlers, deps);
    expect(sources[0]!.url).toBe(streamUrl('k 1', 10));
    expect(sources[0]!.url).toBe('/api/boards/k%201/stream?lastEventId=10');
    sources[0]!.emit('events', { events: [event(11), event(12)] });
    sources[0]!.emit('snapshot', boardResp({ lastEventId: 12 }));
    sources[0]!.onerror?.(new Event('error'));
    expect(sources[0]!.closed).toBe(true);
    await flush();
    expect(handlers.onBanner).toHaveBeenLastCalledWith('offline');
    expect(timers[0]!.ms).toBe(500);
    timers[0]!.cb();
    expect(sources[1]!.url).toBe('/api/boards/k%201/stream?lastEventId=12');
    sources[1]!.onerror?.(new Event('error'));
    await flush();
    expect(timers[1]!.ms).toBe(1000);
  });

  it('初回の接続の events は initial、再接続して最初の snapshot より前の events は gap として渡す', async () => {
    const { sources, timers, handlers, deps } = setup([{ kind: 'network' }]);
    openStream('k', 10, handlers, deps);
    sources[0]!.emit('events', { events: [event(11)] });
    sources[0]!.emit('snapshot', boardResp({ lastEventId: 11 }));
    sources[0]!.emit('events', { events: [event(12)] });
    sources[0]!.onerror?.(new Event('error'));
    await flush();
    timers[0]!.cb();
    sources[1]!.emit('events', { events: [event(13), event(14)] });
    sources[1]!.emit('snapshot', boardResp({ lastEventId: 14 }));
    sources[1]!.emit('events', { events: [event(15)] });
    expect(handlers.calls.filter((c) => c.startsWith('events') || c.startsWith('snapshot'))).toEqual([
      'events:1:true:false',
      'snapshot:11',
      'events:1:false:false',
      'events:2:false:true',
      'snapshot:14',
      'events:1:false:false',
    ]);
  });

  it('403 と cookie なしでは再試行をやめて再認証の案内を出す', async () => {
    for (const result of [
      { kind: 'http', status: 403, body: null },
      { kind: 'http', status: 200, body: { ok: true, version: '1', authenticated: 'none' } },
    ] as HealthResult[]) {
      const { sources, timers, handlers, deps } = setup([result]);
      openStream('k', null, handlers, deps);
      expect(sources[0]!.url).toBe('/api/boards/k/stream');
      sources[0]!.onerror?.(new Event('error'));
      await flush();
      expect(handlers.onBanner).toHaveBeenLastCalledWith('reauth');
      expect(timers).toHaveLength(0);
    }
  });

  it('valid が 5 回続いたら「ボードを読み込めません」を出して止まり、手動の再試行で接続し直す', async () => {
    const { sources, timers, handlers, deps } = setup([valid, valid, valid, valid, valid]);
    const handle = openStream('k', 1, handlers, deps);
    for (let i = 0; i < 5; i += 1) {
      sources[i]!.onerror?.(new Event('error'));
      await flush();
      if (i < 4) timers[i]!.cb();
    }
    expect(timers).toHaveLength(4);
    expect(handlers.onBanner).toHaveBeenLastCalledWith('unavailable');
    handle.retryNow();
    expect(sources).toHaveLength(6);
    expect(handlers.onBanner).toHaveBeenLastCalledWith(null);
  });

  it('接続は開くがメッセージを受け取る前に閉じる、が 5 回続いたら「ボードを読み込めません」を出して止まる', async () => {
    const { sources, timers, handlers, deps } = setup([valid, valid, valid, valid, valid]);
    openStream('k', 1, handlers, deps);
    for (let i = 0; i < 5; i += 1) {
      sources[i]!.onopen?.(new Event('open'));
      sources[i]!.onerror?.(new Event('error'));
      await flush();
      if (i < 4) timers[i]!.cb();
    }
    expect(timers.map((t) => t.ms)).toEqual([500, 1000, 2000, 4000]);
    expect(handlers.onBanner).toHaveBeenLastCalledWith('unavailable');
    expect(sources).toHaveLength(5);
  });

  it('メッセージを受け取った接続のあとは、失敗の回数と待ち時間を戻す', async () => {
    const { sources, timers, handlers, deps } = setup([valid, valid, valid]);
    openStream('k', 1, handlers, deps);
    sources[0]!.onopen?.(new Event('open'));
    sources[0]!.onerror?.(new Event('error'));
    await flush();
    timers[0]!.cb();
    sources[1]!.onopen?.(new Event('open'));
    sources[1]!.emit('snapshot', boardResp({ lastEventId: 3 }));
    sources[1]!.onerror?.(new Event('error'));
    await flush();
    expect(timers.map((t) => t.ms)).toEqual([500, 500]);
  });

  it('close() の後は作り直さない', async () => {
    const { sources, timers, handlers, deps } = setup([{ kind: 'network' }]);
    const handle = openStream('k', 1, handlers, deps);
    handle.close();
    expect(sources[0]!.closed).toBe(true);
    sources[0]!.onerror?.(new Event('error'));
    await flush();
    expect(timers).toHaveLength(0);
  });

  it('health の確認中に retryNow したら、古い確認の結果を捨てて EventSource を 1 つだけにする', async () => {
    const { sources, timers, handlers, deps } = setup([]);
    let resolveHealth: (r: HealthResult) => void = () => undefined;
    deps.health = vi.fn(() => new Promise<HealthResult>((r) => (resolveHealth = r)));
    const handle = openStream('k', 1, handlers, deps);
    sources[0]!.onerror?.(new Event('error'));
    handle.retryNow();
    expect(sources).toHaveLength(2);
    expect(sources[0]!.closed).toBe(true);
    resolveHealth({ kind: 'network' });
    await flush();
    expect(timers).toHaveLength(0);
    expect(handlers.onBanner).not.toHaveBeenCalledWith('offline');
    expect(sources.filter((s) => !s.closed)).toHaveLength(1);
  });

  it('retryNow は開いている EventSource を閉じてから作り直す', () => {
    const { sources, handlers, deps } = setup([]);
    const handle = openStream('k', 1, handlers, deps);
    handle.retryNow();
    expect(sources).toHaveLength(2);
    expect(sources[0]!.closed).toBe(true);
    expect(sources[1]!.closed).toBe(false);
  });
});
