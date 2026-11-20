import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DocWithNotify = Document & { ariaNotify?: (message: string) => void };

let announce: (text: string, delayMs?: number) => void;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  ({ announce } = await import('../../ui/platform.js'));
  document.body.innerHTML = '<div id="live-region" aria-live="polite"></div>';
});

afterEach(() => {
  delete (document as DocWithNotify).ariaNotify;
  vi.useRealTimers();
});

const region = (): HTMLElement => document.getElementById('live-region') as HTMLElement;

describe('announce', () => {
  it('待ち時間付きの読み上げの途中で次の読み上げが来ても取り消さず、順に読み上げる', () => {
    const notify = vi.fn();
    (document as DocWithNotify).ariaNotify = notify;
    announce('#1 を ready へ移動しました', 500);
    announce('#2 が review に移動（エージェント）');
    vi.advanceTimersByTime(5000);
    expect(notify.mock.calls.map((c) => c[0])).toEqual(['#1 を ready へ移動しました', '#2 が review に移動（エージェント）']);
  });

  it('live region はいったん空にしてから、待ち時間の後に文字を入れる', () => {
    region().textContent = '前の文';
    announce('#1 を ready へ移動しました', 500);
    expect(region().textContent).toBe('');
    vi.advanceTimersByTime(499);
    expect(region().textContent).toBe('');
    vi.advanceTimersByTime(1);
    expect(region().textContent).toBe('#1 を ready へ移動しました');
  });

  it('live region でも、待ち時間付きの読み上げの後に次の読み上げを入れる', () => {
    announce('A', 500);
    announce('B');
    expect(region().textContent).toBe('');
    vi.advanceTimersByTime(500);
    expect(region().textContent).toBe('A');
    vi.advanceTimersByTime(2000);
    expect(region().textContent).toBe('B');
  });
});
