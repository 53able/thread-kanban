import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({
  showPopover: vi.fn(),
  hidePopover: vi.fn(),
  announce: vi.fn(),
  copyText: vi.fn(async () => true),
  rect: vi.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 })),
}));
vi.mock('../../ui/platform.js', () => platform);

const { Toasts, TOAST_TIMEOUT_MS } = await import('../../ui/components/Toasts.js');

let root: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app') as HTMLElement;
});
afterEach(() => {
  render(null, root);
  vi.useRealTimers();
});

describe('Toasts', () => {
  it('popover="manual" で出して読み上げ、6 秒で自動的に消す。settle の通知は消さない', () => {
    const onDismiss = vi.fn();
    act(() => {
      render(
        <Toasts
          toasts={[
            { id: 1, text: '#1 が review に移動（エージェント）', persistent: false },
            { id: 2, text: 'T3 側は未反映', persistent: true, settle: { action: 'settle', threadId: 't', link: null, instruction: 'x' } },
          ]}
          onDismiss={onDismiss}
        />,
        root,
      );
    });
    const region = root.querySelector('[role="region"]');
    expect(region?.getAttribute('aria-label')).toBe('通知');
    const items = root.querySelectorAll('[popover="manual"]');
    expect(items).toHaveLength(2);
    expect(platform.showPopover).toHaveBeenCalledTimes(2);
    expect(platform.announce).toHaveBeenCalledWith('#1 が review に移動（エージェント）');
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS + 1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 10);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('トーストの中にフォーカスがある間は消さない', () => {
    const onDismiss = vi.fn();
    act(() => {
      render(<Toasts toasts={[{ id: 1, text: 'a', persistent: false }]} onDismiss={onDismiss} />, root);
    });
    (root.querySelector('.toast-close') as HTMLButtonElement).focus();
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 3);
    expect(onDismiss).not.toHaveBeenCalled();
    (document.activeElement as HTMLElement).blur();
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS + 1);
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it('settle の通知のリンクは http: / https: のときだけ出す', () => {
    act(() => {
      render(
        <Toasts
          toasts={[
            { id: 1, text: 'a', persistent: true, settle: { action: 'settle', threadId: 't', link: 'javascript:alert(1)', instruction: 'x' } },
            { id: 2, text: 'b', persistent: true, settle: { action: 'settle', threadId: 't', link: 'https://t3.example/t/2', instruction: 'x' } },
          ]}
          onDismiss={vi.fn()}
        />,
        root,
      );
    });
    expect(root.querySelector('[data-toast-id="1"] a')).toBeNull();
    expect(root.querySelector('[data-toast-id="2"] a')?.getAttribute('href')).toBe('https://t3.example/t/2');
  });
});
