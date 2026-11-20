import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardResponse, MoveOption, UiEvent } from '../../ui/api-types.js';
import type { StreamHandlers } from '../../ui/sse.js';
import { boardResp, card, event, option } from './fixtures.js';

const platform = vi.hoisted(() => ({
  showModal: vi.fn(),
  closeDialog: vi.fn(),
  showPopover: vi.fn(),
  hidePopover: vi.fn(),
  focus: vi.fn((el: HTMLElement | null | undefined) => el?.focus()),
  scrollIntoView: vi.fn(),
  rect: vi.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 })),
  elementFromPoint: vi.fn((): Element | null => null),
  setPointerCapture: vi.fn(),
  requestFrame: vi.fn(() => 1),
  cancelFrame: vi.fn(),
  prefersReducedMotion: vi.fn(() => true),
  watchMedia: vi.fn((_q: string, cb: (m: boolean) => void) => {
    cb(false);
    return () => undefined;
  }),
  startViewTransition: vi.fn((update: () => Promise<void>) => {
    void update();
  }),
  announce: vi.fn(),
  copyText: vi.fn(async () => true),
}));
vi.mock('../../ui/platform.js', () => platform);

const api = vi.hoisted(() => ({
  getBoards: vi.fn(),
  getBoard: vi.fn(),
  getCardEvents: vi.fn(),
  getMoveOptions: vi.fn(),
  postMove: vi.fn(),
  postBlock: vi.fn(),
  postUnblock: vi.fn(),
  getHealth: vi.fn(),
}));
vi.mock('../../ui/api.js', () => api);

const streams = vi.hoisted(() => [] as StreamHandlers[]);
vi.mock('../../ui/sse.js', () => ({
  openStream: vi.fn((_key: string, _last: number | null, handlers: StreamHandlers) => {
    streams.push(handlers);
    return { close: vi.fn(), retryNow: vi.fn() };
  }),
}));

const { App } = await import('../../ui/components/App.js');

let root: HTMLElement;

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
};

async function mount(initial: BoardResponse, options: MoveOption[] = []): Promise<StreamHandlers> {
  api.getBoards.mockResolvedValue({ ok: true, boards: [{ key: 'k1', boardId: 'default', label: 'repo', dbPath: '/x.db', exists: true }], defaultKey: 'k1' });
  api.getBoard.mockResolvedValue(initial);
  api.getMoveOptions.mockResolvedValue({ ok: true, options });
  api.getCardEvents.mockResolvedValue({ ok: true, events: [] });
  await act(() => {
    render(<App />, root);
  });
  await flush();
  const handlers = streams[streams.length - 1];
  if (handlers === undefined) throw new Error('stream not opened');
  return handlers;
}

const cardEl = (id: number): HTMLElement => {
  const el = document.getElementById(`card-${id}`);
  if (el === null) throw new Error(`card-${id} not found`);
  return el;
};
const listbox = (column: string): HTMLElement => document.getElementById(`col-list-${column}`) as HTMLElement;
const dialog = (): HTMLDialogElement => document.querySelector('dialog.move-dialog') as HTMLDialogElement;

async function key(el: HTMLElement, k: string): Promise<KeyboardEvent> {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  await act(() => {
    el.dispatchEvent(ev);
  });
  await flush();
  return ev;
}

async function closeDialogWith(value: string): Promise<void> {
  const d = dialog();
  d.returnValue = value;
  await act(() => {
    d.dispatchEvent(new Event('close'));
  });
  await flush();
}

async function snapshot(handlers: StreamHandlers, resp: BoardResponse): Promise<void> {
  await act(() => handlers.onSnapshot(resp));
  await flush();
}

const columnOf = (id: number): string | null => cardEl(id).closest('[data-column]')?.getAttribute('data-column') ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  streams.length = 0;
  history.replaceState(null, '', '/');
  document.body.innerHTML = '<div id="app"></div><div id="live-region" aria-live="polite"></div>';
  root = document.getElementById('app') as HTMLElement;
});

afterEach(async () => {
  await act(() => {
    render(null, root);
  });
});

const base = (): BoardResponse =>
  boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)], doing: [card(4)], review: [] } });

describe('キーボード操作', () => {
  it('各列のタブストップは 1 つ（空の列は listbox 自体）', async () => {
    await mount(base());
    for (const column of ['inbox', 'ready', 'doing', 'done']) {
      const lb = listbox(column);
      const stops = [lb, ...lb.querySelectorAll<HTMLElement>('[role="option"]')].filter((el) => el.tabIndex === 0);
      expect(stops, column).toHaveLength(1);
    }
    expect(listbox('review').tabIndex).toBe(0);
    expect(document.querySelectorAll('[role="listbox"]')).toHaveLength(5);
    expect(listbox('inbox').getAttribute('aria-labelledby')).toBe('col-head-inbox');
  });

  it('↑/↓/←/→ で選択とフォーカスが移り、移動先がなければ preventDefault しない', async () => {
    await mount(base());
    cardEl(1).focus();
    await flush();
    let ev = await key(cardEl(1), 'ArrowDown');
    expect(ev.defaultPrevented).toBe(true);
    expect(cardEl(2).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(cardEl(2));
    ev = await key(cardEl(2), 'ArrowRight');
    expect(document.activeElement).toBe(cardEl(3));
    expect(cardEl(3).tabIndex).toBe(0);
    ev = await key(cardEl(3), 'ArrowUp');
    expect(ev.defaultPrevented).toBe(false);
    ev = await key(cardEl(3), 'ArrowRight');
    expect(document.activeElement).toBe(cardEl(4));
    ev = await key(cardEl(4), 'ArrowRight');
    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(cardEl(4));
  });

  it('Space → → → Space で移動し、移動の後にフォーカスがカードに戻る', async () => {
    await mount(base(), [option('ready'), option('doing', { allowed: false, code: 'SKIP_NOT_ALLOWED', wip: null })]);
    api.postMove.mockResolvedValue({ ok: true, card: {}, from: 'inbox', to: 'ready', direction: 'forward', violation: null, expediteOverLimit: false, t3Action: null });
    cardEl(1).focus();
    await flush();
    await key(cardEl(1), ' ');
    expect(cardEl(1).getAttribute('aria-roledescription')).toBe('つかんでいるカード');
    expect(document.querySelector('.grab-hint')?.textContent).toContain('Esc');
    await key(cardEl(1), 'ArrowRight');
    expect(document.querySelector('[data-column="ready"]')?.hasAttribute('data-target')).toBe(true);
    expect(document.querySelector('[data-column="doing"]')?.getAttribute('data-verdict')).toBe('forbidden');
    await key(cardEl(1), ' ');
    expect(api.postMove).toHaveBeenCalledWith('k1', 't-1', { to: 'ready' });
    expect(columnOf(1)).toBe('ready');
    expect(document.activeElement).toBe(cardEl(1));
    expect(platform.focus).toHaveBeenLastCalledWith(cardEl(1), { preventScroll: true });
    expect(platform.announce).toHaveBeenCalledWith('#1 を ready へ移動しました', 500);
  });

  it('Esc でつかむのを取り消す（送信しない）', async () => {
    await mount(base(), [option('ready')]);
    cardEl(1).focus();
    await key(cardEl(1), ' ');
    await key(cardEl(1), 'ArrowRight');
    await key(cardEl(1), 'Escape');
    expect(cardEl(1).hasAttribute('aria-roledescription')).toBe(false);
    expect(document.querySelector('.grab-hint')).toBeNull();
    expect(api.postMove).not.toHaveBeenCalled();
    expect(columnOf(1)).toBe('inbox');
  });
});

describe('SSE の取り込み', () => {
  it('選択中のカードがエージェントの更新で別の列へ移っても、選択とフォーカスが追従する', async () => {
    const handlers = await mount(base());
    cardEl(4).focus();
    await flush();
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)], review: [card(4)] }, lastEventId: 11 }));
    expect(columnOf(4)).toBe('review');
    expect(cardEl(4).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(cardEl(4));
  });

  it('選択中のカードが消えたら、同じ列の隣のカードへ移る', async () => {
    const handlers = await mount(base());
    cardEl(1).focus();
    await flush();
    await snapshot(handlers, boardResp({ cards: { inbox: [card(2)], ready: [card(3)], doing: [card(4)] }, lastEventId: 11 }));
    expect(document.activeElement).toBe(cardEl(2));
    expect(cardEl(2).getAttribute('aria-selected')).toBe('true');
  });

  it('つかんでいる間は snapshot を取り込まず、終わってから最新の 1 件を取り込む', async () => {
    const handlers = await mount(base(), [option('ready')]);
    cardEl(1).focus();
    await key(cardEl(1), ' ');
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)], review: [card(4)] }, lastEventId: 11 }));
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)], done: [card(4)] }, lastEventId: 12 }));
    expect(columnOf(4)).toBe('doing');
    await key(cardEl(1), 'Escape');
    expect(columnOf(4)).toBe('done');
  });

  it('モーダルの表示中も snapshot を溜め、閉じてから取り込む', async () => {
    const handlers = await mount(base(), [option('ready', { needsCriteria: true, entryCriteria: ['仕様が決まっている'] })]);
    cardEl(1).focus();
    await key(cardEl(1), ' ');
    await key(cardEl(1), 'ArrowRight');
    await key(cardEl(1), ' ');
    expect(platform.showModal).toHaveBeenCalledTimes(1);
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)], review: [card(4)] }, lastEventId: 11 }));
    expect(columnOf(4)).toBe('doing');
    await closeDialogWith('cancel');
    expect(columnOf(4)).toBe('review');
    expect(columnOf(1)).toBe('inbox');
  });

  it('初回の接続と取得上限の超過（snapshot のみ）ではトーストを出さず、再接続の取りこぼしは 1 件にまとめる', async () => {
    const handlers = await mount(base());
    const toasts = (): string[] => [...document.querySelectorAll('.toast-text')].map((el) => el.textContent ?? '');
    await act(() => handlers.onEvents([event(11)], { initial: true, gap: false }));
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1)] }, lastEventId: 500 }));
    expect(toasts()).toEqual([]);
    await act(() => handlers.onEvents([event(501), event(502), event(503)], { initial: false, gap: true }));
    await flush();
    expect(toasts()).toEqual(['切断中に 3 件の更新']);
    await act(() => handlers.onEvents([event(504, { cardId: 12, title: null })], { initial: false, gap: false }));
    await flush();
    expect(toasts()).toEqual(['切断中に 3 件の更新', '#12 が review に移動（エージェント）']);
    expect(platform.showPopover).toHaveBeenCalled();
    expect(document.querySelector('[role="region"][aria-label="通知"]')).not.toBeNull();
  });
});

describe('移動のダイアログ', () => {
  const criteriaThenWip = option('ready', {
    needsCriteria: true,
    entryCriteria: ['仕様が決まっている', '見積もり済み'],
    wip: 'exceeded',
    occupants: [{ cardId: 3, threadId: 't-3', title: 'カード3', serviceClass: 'regular', blocked: false }],
  });

  async function dropOnReady(handlersOptions: MoveOption[]): Promise<StreamHandlers> {
    const handlers = await mount(base(), handlersOptions);
    cardEl(1).focus();
    await key(cardEl(1), ' ');
    await key(cardEl(1), 'ArrowRight');
    await key(cardEl(1), ' ');
    return handlers;
  }

  it('role / aria-modal / open 属性を付けず、showModal の直後にキャンセルへ platform.focus を呼ぶ', async () => {
    await mount(base());
    expect(dialog().hasAttribute('open')).toBe(false);
    await act(() => undefined);
    vi.clearAllMocks();
    cardEl(1).focus();
    api.getMoveOptions.mockResolvedValue({ ok: true, options: [criteriaThenWip] });
    await key(cardEl(1), ' ');
    await key(cardEl(1), 'ArrowRight');
    await key(cardEl(1), ' ');
    const d = dialog();
    expect(d.hasAttribute('role')).toBe(false);
    expect(d.hasAttribute('aria-modal')).toBe(false);
    expect(d.hasAttribute('open')).toBe(false);
    expect(d.getAttribute('aria-labelledby')).toBe('move-dialog-title');
    const cancel = d.querySelector('button[value="cancel"]');
    expect(platform.showModal).toHaveBeenCalledWith(d);
    const showOrder = platform.showModal.mock.invocationCallOrder[0]!;
    const focusCall = platform.focus.mock.calls.findIndex((c) => c[0] === cancel);
    expect(focusCall).toBeGreaterThanOrEqual(0);
    expect(platform.focus.mock.invocationCallOrder[focusCall]!).toBeGreaterThan(showOrder);
  });

  it('入場条件 → WIP の 2 段階で、最後に 1 回だけ送信する（criteriaConfirmed と force / reason）', async () => {
    api.postMove.mockResolvedValue({ ok: true, card: {}, from: 'inbox', to: 'ready', direction: 'forward', violation: {}, expediteOverLimit: false, t3Action: null });
    await dropOnReady([criteriaThenWip]);
    const d = dialog();
    expect(columnOf(1)).toBe('ready');
    expect(d.textContent).toContain('入場条件');
    const next = [...d.querySelectorAll('button')].find((b) => b.textContent === '次へ') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    for (const box of d.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      await act(() => {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    expect(next.disabled).toBe(false);
    await act(() => next.click());
    await flush();
    expect(d.textContent).toContain('WIP 上限を超えます');
    expect(d.textContent).toContain('#3 カード3');
    const textarea = d.querySelector('textarea') as HTMLTextAreaElement;
    await act(() => {
      textarea.value = '急ぎの修正';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(api.postMove).not.toHaveBeenCalled();
    await closeDialogWith('confirm');
    expect(api.postMove).toHaveBeenCalledTimes(1);
    expect(api.postMove).toHaveBeenCalledWith('k1', 't-1', { to: 'ready', criteriaConfirmed: true, force: true, reason: '急ぎの修正' });
  });

  it('入場条件のない列では criteriaConfirmed を送らない', async () => {
    api.postMove.mockResolvedValue({ ok: true, card: {}, from: 'inbox', to: 'ready', direction: 'forward', violation: null, expediteOverLimit: false, t3Action: null });
    await dropOnReady([option('ready', { wip: 'exceeded' })]);
    await act(() => {
      const textarea = dialog().querySelector('textarea') as HTMLTextAreaElement;
      textarea.value = 'r';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await closeDialogWith('confirm');
    expect(api.postMove).toHaveBeenCalledWith('k1', 't-1', { to: 'ready', force: true, reason: 'r' });
  });

  it('キャンセルで先に更新した表示を元に戻す', async () => {
    await dropOnReady([criteriaThenWip]);
    expect(columnOf(1)).toBe('ready');
    await closeDialogWith('cancel');
    expect(columnOf(1)).toBe('inbox');
    expect(api.postMove).not.toHaveBeenCalled();
    expect(dialog().returnValue).toBe('');
  });

  it('送信が失敗したら元に戻し、ダイアログで理由を示す', async () => {
    api.postMove.mockResolvedValue({ ok: false, status: 400, code: 'WIP_LIMIT_EXCEEDED', message: 'ready の WIP 上限 5 に達しています' });
    await dropOnReady([option('ready')]);
    expect(api.postMove).toHaveBeenCalledWith('k1', 't-1', { to: 'ready' });
    expect(columnOf(1)).toBe('inbox');
    expect(platform.showModal).toHaveBeenCalledTimes(1);
    expect(dialog().textContent).toContain('移動できませんでした');
    expect(dialog().textContent).toContain('ready の WIP 上限 5 に達しています');
    await closeDialogWith('close');
    expect(columnOf(1)).toBe('inbox');
  });

  it('ダイアログの表示中はトーストを溜め、閉じた後にまとめて出す', async () => {
    const handlers = await dropOnReady([criteriaThenWip]);
    await act(() => handlers.onEvents([event(11), event(12, { cardId: 2, threadId: 't-2' })], { initial: false, gap: false }));
    await flush();
    expect(document.querySelectorAll('.toast')).toHaveLength(0);
    await closeDialogWith('cancel');
    expect([...document.querySelectorAll('.toast-text')].map((e) => e.textContent)).toEqual(['ダイアログの表示中に 2 件の更新']);
  });
});

describe('トーストと settle の通知', () => {
  it('自分のタブの操作はトーストにせず、settle の通知はリンクとコピーボタン付きで出る', async () => {
    const r = boardResp({
      cards: {
        review: [card(5, { t3: { link: 'https://t3.example/t/5', projectId: null, parentThreadId: null, branch: null, worktreePath: null, pullRequests: [], syncedAt: '' } })],
      },
    });
    const handlers = await mount(r, [option('done')]);
    api.postMove.mockResolvedValue({
      ok: true,
      card: {},
      from: 'review',
      to: 'done',
      direction: 'forward',
      violation: null,
      expediteOverLimit: false,
      t3Action: { tool: 't3_thread_organize', args: { action: 'settle', threadId: 't-5' }, reason: 'r' },
    });
    cardEl(5).focus();
    await key(cardEl(5), ' ');
    await key(cardEl(5), 'ArrowRight');
    await key(cardEl(5), ' ');
    const own: UiEvent = event(11, { cardId: 5, threadId: 't-5', fromColumn: 'review', toColumn: 'done', actor: 'ui' });
    await act(() => handlers.onEvents([own], { initial: false, gap: false }));
    await flush();
    const toasts = [...document.querySelectorAll('.toast')];
    expect(toasts).toHaveLength(1);
    const t = toasts[0] as HTMLElement;
    expect(t.classList.contains('toast-persistent')).toBe(true);
    expect(t.textContent).toContain('T3 側は未反映');
    expect(t.querySelector('a')?.getAttribute('href')).toBe('https://t3.example/t/5');
    const copy = [...t.querySelectorAll('button')].find((b) => b.textContent?.includes('コピー')) as HTMLButtonElement;
    await act(() => copy.click());
    await flush();
    expect(platform.copyText).toHaveBeenCalledWith(expect.stringContaining('t3_thread_organize'));
  });
});

describe('ポインターでのドラッグ', () => {
  it('つかみ手から持ち上げ（position: fixed / pointer-events: none）、elementFromPoint の列へ落として移動する', async () => {
    await mount(base(), [option('ready', { wip: 'expediteOver' }), option('doing', { allowed: false, code: 'SKIP_NOT_ALLOWED', wip: null })]);
    api.postMove.mockResolvedValue({ ok: true, card: {}, from: 'inbox', to: 'ready', direction: 'forward', violation: null, expediteOverLimit: true, t3Action: null });
    const handle = cardEl(1).querySelector('.handle') as HTMLElement;
    await act(() => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, button: 0, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
    });
    await flush();
    expect(platform.setPointerCapture).toHaveBeenCalledWith(handle, 7);
    expect(cardEl(1).getAttribute('style')).toContain('position: fixed');
    expect(cardEl(1).getAttribute('style')).toContain('pointer-events: none');
    expect(document.querySelector('.placeholder')).not.toBeNull();
    expect(document.querySelector('[data-column="ready"]')?.getAttribute('data-verdict')).toBe('expedite');
    expect(document.querySelector('[data-column="doing"]')?.getAttribute('data-verdict')).toBe('forbidden');
    const ready = document.querySelector('[data-column="ready"] .column-head') as HTMLElement;
    platform.elementFromPoint.mockReturnValue(ready);
    await act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 8, clientX: 300, clientY: 20 }));
    });
    expect(document.querySelector('[data-column="ready"]')?.hasAttribute('data-target')).toBe(false);
    await act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 300, clientY: 20 }));
    });
    await flush();
    expect(document.querySelector('[data-column="ready"]')?.hasAttribute('data-target')).toBe(true);
    await act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, clientX: 300, clientY: 20 }));
    });
    await flush();
    expect(api.postMove).toHaveBeenCalledWith('k1', 't-1', { to: 'ready' });
    expect(columnOf(1)).toBe('ready');
    expect(cardEl(1).getAttribute('style')).not.toContain('position: fixed');
  });

  it('ドラッグ中の Esc は取り消して元の位置へ戻す', async () => {
    await mount(base(), [option('ready')]);
    const handle = cardEl(1).querySelector('.handle') as HTMLElement;
    await act(() => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
    });
    platform.elementFromPoint.mockReturnValue(document.querySelector('[data-column="ready"]'));
    await act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 300, clientY: 20 }));
    });
    await act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 300, clientY: 20 }));
    });
    await flush();
    expect(api.postMove).not.toHaveBeenCalled();
    expect(columnOf(1)).toBe('inbox');
    expect(document.querySelector('.placeholder')).toBeNull();
  });
});

describe('カード詳細のドロワー', () => {
  it('Enter で開いて閉じるボタンへフォーカスし、Esc で閉じて元のカードへ戻す', async () => {
    await mount(base());
    api.getCardEvents.mockResolvedValue({ ok: true, events: [event(3, { cardId: 1, actor: 'ui' }), event(4, { cardId: 1, actor: null })] });
    cardEl(1).focus();
    await key(cardEl(1), 'Enter');
    const drawer = document.querySelector('dialog.drawer') as HTMLDialogElement;
    expect(drawer.getAttribute('popover')).toBe('manual');
    expect(drawer.getAttribute('aria-labelledby')).toBe('drawer-title');
    expect(platform.showPopover).toHaveBeenCalledWith(drawer);
    const close = drawer.querySelector('.drawer-close') as HTMLButtonElement;
    expect(platform.focus).toHaveBeenCalledWith(close);
    expect(drawer.querySelector('#drawer-title')?.textContent).toBe('#1 カード1');
    const history = [...drawer.querySelectorAll('.history li')].map((li) => li.textContent ?? '');
    expect(history[0]).toContain('（UI）');
    expect(history[1]).toContain('（エージェント）');
    close.focus();
    await key(close, 'Escape');
    expect(platform.hidePopover).toHaveBeenCalledWith(drawer);
    expect(document.activeElement).toBe(cardEl(1));
  });

  it('ブロックと「移動先…」をドロワーのボタンから行う', async () => {
    await mount(base(), [option('ready'), option('doing', { allowed: false, code: 'SKIP_NOT_ALLOWED', wip: null })]);
    api.postBlock.mockResolvedValue({ ok: true, card: {} });
    api.postMove.mockResolvedValue({ ok: true, card: {}, from: 'inbox', to: 'ready', direction: 'forward', violation: null, expediteOverLimit: false, t3Action: null });
    cardEl(1).focus();
    await key(cardEl(1), 'Enter');
    const drawer = document.querySelector('dialog.drawer') as HTMLDialogElement;
    const input = drawer.querySelector('.block-form input') as HTMLInputElement;
    await act(() => {
      input.value = 'レビュー待ち';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => {
      (drawer.querySelector('.block-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(api.postBlock).toHaveBeenCalledWith('k1', 't-1', 'レビュー待ち');
    const moveBtn = [...drawer.querySelectorAll('button')].find((b) => b.textContent === '移動先…') as HTMLButtonElement;
    await act(() => moveBtn.click());
    await flush();
    const buttons = [...drawer.querySelectorAll<HTMLButtonElement>('.move-options button')];
    expect(buttons.map((b) => [b.textContent, b.disabled])).toEqual([
      ['ready', false],
      ['doing', true],
    ]);
    await act(() => buttons[0]!.click());
    await flush();
    expect(api.postMove).toHaveBeenCalledWith('k1', 't-1', { to: 'ready' });
    expect(columnOf(1)).toBe('ready');
  });
});

describe('切断と再認証', () => {
  it('起動時の /api/boards が 403 で health が cookie なしなら「新しい URL を開いてください」', async () => {
    api.getBoards.mockResolvedValue({ ok: false, status: 403, code: 'HTTP', message: 'forbidden' });
    api.getHealth.mockResolvedValue({ kind: 'http', status: 200, body: { ok: true, version: '1', authenticated: 'none' } });
    await act(() => {
      render(<App />, root);
    });
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('新しい URL を開いてください');
  });

  it('stream の案内（unavailable）は「ボードを読み込めません」と再試行ボタン', async () => {
    const handlers = await mount(base());
    await act(() => handlers.onBanner('unavailable'));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('ボードを読み込めません');
    expect(document.querySelector('[role="alert"] button')?.textContent).toBe('再試行');
  });

  it('起動時の GET /api/boards/:key が 503 BOARD_UNAVAILABLE なら「ボードを読み込めません」と再試行ボタン（空の状態は出さない）', async () => {
    api.getBoards.mockResolvedValue({ ok: true, boards: [{ key: 'k1', boardId: 'default', label: 'repo', dbPath: '/x.db', exists: true }], defaultKey: 'k1' });
    api.getBoard.mockResolvedValue({ ok: false, status: 503, code: 'BOARD_UNAVAILABLE', message: 'x' });
    await act(() => {
      render(<App />, root);
    });
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('ボードを読み込めません');
    expect(document.querySelector('[role="alert"] button')?.textContent).toBe('再試行');
    expect(document.querySelector('.empty-state')).toBeNull();
    // 再試行で取り直す
    api.getBoard.mockResolvedValue(base());
    await act(() => (document.querySelector('[role="alert"] button') as HTMLButtonElement).click());
    await flush();
    expect(cardEl(1)).not.toBeNull();
  });

  it('ボードがまだないときは空の状態を出す', async () => {
    await mount({ ...base(), board: null });
    expect(document.querySelector('.empty-state')?.textContent).toContain('kanban_card_add');
  });
});

describe('レビューで見つかった不具合の回帰', () => {
  const okMove = { ok: true, card: {}, from: 'inbox', to: 'ready', direction: 'forward', violation: null, expediteOverLimit: false, t3Action: null, lastEventId: 11 };
  const toastTexts = (): string[] => [...document.querySelectorAll('.toast-text')].map((el) => el.textContent ?? '');

  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve: (v: T) => void = () => undefined;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  async function grabAndDrop(id: number): Promise<void> {
    cardEl(id).focus();
    await key(cardEl(id), ' ');
    await key(cardEl(id), 'ArrowRight');
    await key(cardEl(id), ' ');
  }

  it('移動の送信中は、キーボードで別のカードをつかめない', async () => {
    await mount(base(), [option('ready')]);
    const pending = deferred<unknown>();
    api.postMove.mockReturnValue(pending.promise);
    await grabAndDrop(1);
    expect(api.postMove).toHaveBeenCalledTimes(1);
    cardEl(2).focus();
    await flush();
    await key(cardEl(2), ' ');
    expect(cardEl(2).hasAttribute('aria-roledescription')).toBe(false);
    expect(document.querySelector('.grab-hint')).toBeNull();
    pending.resolve(okMove);
    await flush();
  });

  it('つかんだカードからフォーカスが外れたら、つかむのを取り消して溜めた snapshot を取り込む', async () => {
    const handlers = await mount(base(), [option('ready')]);
    cardEl(1).focus();
    await key(cardEl(1), ' ');
    expect(cardEl(1).getAttribute('aria-roledescription')).toBe('つかんでいるカード');
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)], review: [card(4)] }, lastEventId: 11 }));
    expect(columnOf(4)).toBe('doing');
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    await act(() => {
      cardEl(1).dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    });
    await flush();
    expect(cardEl(1).hasAttribute('aria-roledescription')).toBe(false);
    expect(document.querySelector('.grab-hint')).toBeNull();
    expect(columnOf(4)).toBe('review');
  });

  it('ボードを切り替えたら、開いていたドロワーを閉じる', async () => {
    await mount(base());
    cardEl(1).focus();
    await key(cardEl(1), 'Enter');
    const drawer = document.querySelector('dialog.drawer') as HTMLDialogElement;
    expect(drawer.querySelector('#drawer-title')?.textContent).toBe('#1 カード1');
    api.getBoard.mockResolvedValue(boardResp({ key: 'k2', cards: { inbox: [card(9)] } }));
    await act(() => {
      history.replaceState(null, '', '#board=k2');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();
    expect(api.getBoard).toHaveBeenLastCalledWith('k2');
    expect(drawer.textContent).not.toContain('このカードはボードにありません');
    expect(platform.hidePopover).toHaveBeenLastCalledWith(drawer);
  });

  it('つかみ手でのドラッグを落とした直後の click ではドロワーを開かない', async () => {
    await mount(base(), [option('ready')]);
    const handle = cardEl(1).querySelector('.handle') as HTMLElement;
    await act(() => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 3, button: 0, clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
    });
    await flush();
    await act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, clientX: 0, clientY: 0 }));
      cardEl(1).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(api.getCardEvents).not.toHaveBeenCalled();
    // 少し後の通常の click では開く
    await act(() => {
      cardEl(1).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(api.getCardEvents).toHaveBeenCalledWith('k1', 't-1');
  });

  it('view transition の更新が遅れて走っても、古い snapshot で新しい snapshot を上書きしない', async () => {
    const handlers = await mount(base());
    const updates: (() => Promise<void>)[] = [];
    const capture = (update: () => Promise<void>): void => {
      updates.push(update);
    };
    platform.startViewTransition.mockImplementationOnce(capture).mockImplementationOnce(capture);
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)], review: [card(4)] }, lastEventId: 11 }));
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)], done: [card(4)] }, lastEventId: 12 }));
    expect(updates).toHaveLength(2);
    await act(async () => {
      void updates[1]!();
    });
    await flush();
    await act(async () => {
      void updates[0]!();
    });
    await flush();
    expect(columnOf(4)).toBe('done');
  });

  it('移動の成功後は、移動の前に溜めた snapshot を取り込まない（移動を反映した snapshot は取り込む）', async () => {
    const handlers = await mount(base(), [option('ready')]);
    const pending = deferred<unknown>();
    api.postMove.mockReturnValue(pending.promise);
    cardEl(1).focus();
    await key(cardEl(1), ' ');
    // つかんでいる間に届いた（移動の前の）snapshot
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)], doing: [card(4)] }, lastEventId: 11 }));
    await key(cardEl(1), 'ArrowRight');
    await key(cardEl(1), ' ');
    expect(columnOf(1)).toBe('ready');
    pending.resolve({ ...okMove, lastEventId: 12 });
    await flush();
    expect(columnOf(1)).toBe('ready');
    await snapshot(handlers, boardResp({ cards: { inbox: [card(2)], ready: [card(3), card(1)], doing: [card(4)] }, lastEventId: 12 }));
    expect(columnOf(1)).toBe('ready');
  });

  it('送信中に届いた、移動を反映した snapshot は成功後に取り込む', async () => {
    const handlers = await mount(base(), [option('ready')]);
    const pending = deferred<unknown>();
    api.postMove.mockReturnValue(pending.promise);
    await grabAndDrop(1);
    await snapshot(handlers, boardResp({ cards: { inbox: [card(2)], ready: [card(3), card(1)], review: [card(4)] }, lastEventId: 12 }));
    expect(columnOf(4)).toBe('doing');
    pending.resolve(okMove);
    await flush();
    expect(columnOf(4)).toBe('review');
    expect(columnOf(1)).toBe('ready');
  });

  it('truncated の snapshot ではトーストを 1 件だけ出し、開いているドロワーの履歴を読み直す', async () => {
    const handlers = await mount(base());
    cardEl(1).focus();
    await key(cardEl(1), 'Enter');
    expect(api.getCardEvents).toHaveBeenCalledTimes(1);
    await snapshot(handlers, { ...boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)] }, lastEventId: 900 }), truncated: true });
    expect(toastTexts()).toEqual(['多数の更新がありました']);
    expect(api.getCardEvents).toHaveBeenCalledTimes(2);
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)] }, lastEventId: 901 }));
    expect(toastTexts()).toEqual(['多数の更新がありました']);
  });

  it('送信が失敗したら、そのカードの UI のイベントをトーストで知らせる（自分の操作として隠さない）', async () => {
    const handlers = await mount(base(), [option('ready')]);
    api.postMove.mockResolvedValue({ ok: false, status: 400, code: 'WIP_LIMIT_EXCEEDED', message: 'x' });
    await grabAndDrop(1);
    await closeDialogWith('close');
    await act(() => handlers.onEvents([event(11, { cardId: 1, threadId: 't-1', fromColumn: 'inbox', toColumn: 'ready', actor: 'ui' })], { initial: false, gap: false }));
    await flush();
    expect(toastTexts()).toEqual(['#1「カード1」 が ready に移動（UI）']);
  });

  async function switchBoard(next: BoardResponse): Promise<void> {
    api.getBoard.mockResolvedValue(next);
    await act(() => {
      history.replaceState(null, '', `#board=${next.key}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();
  }

  it('つかんでいる間にボードを切り替えたら、つかむのを取り消す', async () => {
    await mount(base(), [option('ready')]);
    cardEl(1).focus();
    await key(cardEl(1), ' ');
    expect(document.querySelector('.grab-hint')).not.toBeNull();
    await switchBoard(boardResp({ key: 'k2', cards: { inbox: [card(1)] } }));
    expect(api.getBoard).toHaveBeenLastCalledWith('k2');
    expect(document.querySelector('.grab-hint')).toBeNull();
    expect(cardEl(1).hasAttribute('aria-roledescription')).toBe(false);
  });

  it('移動の送信中にボードを切り替えたら、失敗しても前のボードへ戻さずダイアログも出さない', async () => {
    await mount(base(), [option('ready')]);
    const pending = deferred<unknown>();
    api.postMove.mockReturnValue(pending.promise);
    await grabAndDrop(1);
    expect(api.postMove).toHaveBeenCalledWith('k1', 't-1', { to: 'ready' });
    await switchBoard(boardResp({ key: 'k2', cards: { inbox: [card(9)] } }));
    pending.resolve({ ok: false, status: 400, code: 'WIP_LIMIT_EXCEEDED', message: 'x' });
    await flush();
    expect(platform.showModal).not.toHaveBeenCalled();
    expect(document.getElementById('card-1')).toBeNull();
    expect(cardEl(9)).not.toBeNull();
  });

  it('移動のダイアログの表示中にボードを切り替えたら、ダイアログを閉じて送信しない', async () => {
    await mount(base(), [option('ready', { needsCriteria: true, entryCriteria: ['仕様が決まっている'] })]);
    await grabAndDrop(1);
    expect(dialog().textContent).toContain('入場条件');
    await switchBoard(boardResp({ key: 'k2', cards: { inbox: [card(9)] } }));
    expect(platform.closeDialog).toHaveBeenCalledWith(dialog());
    expect(dialog().textContent).not.toContain('入場条件');
    await closeDialogWith('confirm');
    expect(api.postMove).not.toHaveBeenCalled();
    expect(cardEl(9)).not.toBeNull();
    expect(document.getElementById('card-1')).toBeNull();
  });

  it('ブロックの送信中にボードを切り替えたら、失敗のトーストも履歴の読み直しもしない', async () => {
    await mount(base());
    const pending = deferred<unknown>();
    api.postBlock.mockReturnValue(pending.promise);
    cardEl(1).focus();
    await key(cardEl(1), 'Enter');
    const drawer = document.querySelector('dialog.drawer') as HTMLDialogElement;
    const input = drawer.querySelector('.block-form input') as HTMLInputElement;
    await act(() => {
      input.value = 'r';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => {
      (drawer.querySelector('.block-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(api.postBlock).toHaveBeenCalledWith('k1', 't-1', 'r');
    await switchBoard(boardResp({ key: 'k2', cards: { inbox: [card(9)] } }));
    pending.resolve({ ok: false, status: 409, code: 'CARD_NOT_FOUND', message: 'x' });
    await flush();
    expect(toastTexts()).toEqual([]);
    expect(api.getCardEvents).not.toHaveBeenCalledWith('k2', 't-1');
  });

  it('ブロックの送信中にボードを切り替えたら送信中の表示を解除し、前のボードの結果で新しいボードの送信中を解除しない', async () => {
    await mount(base());
    const pendingA = deferred<unknown>();
    api.postBlock.mockReturnValue(pendingA.promise);
    const submitBlock = async (threadCard: number): Promise<HTMLButtonElement> => {
      cardEl(threadCard).focus();
      await key(cardEl(threadCard), 'Enter');
      const drawer = document.querySelector('dialog.drawer') as HTMLDialogElement;
      const input = drawer.querySelector('.block-form input') as HTMLInputElement;
      await act(() => {
        input.value = 'r';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      return drawer.querySelector('.block-form button[type="submit"]') as HTMLButtonElement;
    };
    const submitA = await submitBlock(1);
    await act(() => {
      submitA.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(api.postBlock).toHaveBeenCalledWith('k1', 't-1', 'r');
    await switchBoard(boardResp({ key: 'k2', cards: { inbox: [card(9)] } }));
    const submitB = await submitBlock(9);
    expect(submitB.disabled).toBe(false);
    const pendingB = deferred<unknown>();
    api.postBlock.mockReturnValue(pendingB.promise);
    await act(() => {
      submitB.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(api.postBlock).toHaveBeenCalledWith('k2', 't-9', 'r');
    pendingA.resolve({ ok: true, card: {} });
    await flush();
    expect((document.querySelector('dialog.drawer .block-form button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    pendingB.resolve({ ok: false, status: 409, code: 'CARD_NOT_FOUND', message: 'x' });
    await flush();
    expect((document.querySelector('dialog.drawer .block-form button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('同じカードの別の操作が成功していれば、後の操作が失敗してもその操作の UI イベントは隠す', async () => {
    const handlers = await mount(base(), [option('ready')]);
    api.postBlock.mockResolvedValue({ ok: true, card: {} });
    api.postMove.mockResolvedValue({ ok: false, status: 400, code: 'WIP_LIMIT_EXCEEDED', message: 'x' });
    cardEl(1).focus();
    await key(cardEl(1), 'Enter');
    const drawer = document.querySelector('dialog.drawer') as HTMLDialogElement;
    const input = drawer.querySelector('.block-form input') as HTMLInputElement;
    await act(() => {
      input.value = 'r';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => {
      (drawer.querySelector('.block-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(api.postBlock).toHaveBeenCalledTimes(1);
    const moveBtn = [...drawer.querySelectorAll('button')].find((b) => b.textContent === '移動先…') as HTMLButtonElement;
    await act(() => moveBtn.click());
    await flush();
    await act(() => [...drawer.querySelectorAll<HTMLButtonElement>('.move-options button')][0]!.click());
    await flush();
    expect(api.postMove).toHaveBeenCalledTimes(1);
    await closeDialogWith('close');
    await act(() => handlers.onEvents([event(11, { cardId: 1, threadId: 't-1', type: 'blocked', fromColumn: null, toColumn: null, actor: 'ui' })], { initial: false, gap: false }));
    await flush();
    expect(toastTexts()).toEqual([]);
  });

  it('ボードを切り替えたら、新しいボードの取得を待たずに前のボードのカードを消す（前のカードから新しいキーへ送らない）', async () => {
    await mount(base(), [option('ready')]);
    api.postMove.mockResolvedValue(okMove);
    api.postBlock.mockResolvedValue({ ok: true, card: {} });
    // 切り替えの前に、前のボードのカードとドロワーのブロックのフォームをつかんでおく
    const stale = cardEl(1);
    stale.focus();
    await key(stale, 'Enter');
    const drawer = document.querySelector('dialog.drawer') as HTMLDialogElement;
    const staleForm = drawer.querySelector('.block-form') as HTMLFormElement;
    const staleInput = staleForm.querySelector('input') as HTMLInputElement;
    await act(() => {
      staleInput.value = 'r';
      staleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    api.getMoveOptions.mockClear();
    api.getCardEvents.mockClear();
    const load = deferred<unknown>();
    api.getBoard.mockReturnValue(load.promise);
    await act(() => {
      history.replaceState(null, '', '#board=k2');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();
    expect(api.getBoard).toHaveBeenLastCalledWith('k2');
    // 取得の途中: 前のボードのカードは出さない（クリック・キー操作の対象がない）
    expect(document.getElementById('card-1')).toBeNull();
    expect(document.querySelector('.loading')).not.toBeNull();
    // 外れた前のカードの要素とフォームに操作を送っても（ハンドラーは残っている）、どこにも送らない
    await key(stale, ' ');
    await key(stale, 'ArrowRight');
    await key(stale, ' ');
    await key(stale, 'Enter');
    await act(() => {
      staleForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(api.getMoveOptions).not.toHaveBeenCalled();
    expect(api.getCardEvents).not.toHaveBeenCalled();
    expect(api.postBlock).not.toHaveBeenCalled();
    expect(api.postMove).not.toHaveBeenCalled();
    load.resolve(boardResp({ key: 'k2', cards: { inbox: [card(9)] } }));
    await flush();
    expect(cardEl(9)).not.toBeNull();
  });

  it('新しいボードの取得が失敗しても前のボードのカードを出さず、「ボードを読み込めません」を出す', async () => {
    await mount(base());
    api.getBoard.mockResolvedValue({ ok: false, status: 503, code: 'BOARD_UNAVAILABLE', message: 'x' });
    await act(() => {
      history.replaceState(null, '', '#board=k2');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();
    expect(document.getElementById('card-1')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('ボードを読み込めません');
  });

  it('A → B → A と戻った後に、最初の A での移動の応答が届いても反映しない（世代で照合する）', async () => {
    await mount(base(), [option('ready')]);
    const pending = deferred<unknown>();
    api.postMove.mockReturnValue(pending.promise);
    await grabAndDrop(1);
    expect(api.postMove).toHaveBeenCalledWith('k1', 't-1', { to: 'ready' });
    await switchBoard(boardResp({ key: 'k2', cards: { inbox: [card(9)] } }));
    await switchBoard(base());
    expect(columnOf(1)).toBe('inbox');
    pending.resolve({ ok: false, status: 400, code: 'WIP_LIMIT_EXCEEDED', message: 'x' });
    await flush();
    expect(platform.showModal).not.toHaveBeenCalled();
    expect(columnOf(1)).toBe('inbox');
  });

  it('A → B → A と戻った後に、最初の A で開いたドロワーの履歴の応答が届いても反映しない', async () => {
    await mount(base());
    const first = deferred<unknown>();
    api.getCardEvents.mockReturnValueOnce(first.promise);
    cardEl(1).focus();
    await key(cardEl(1), 'Enter');
    await switchBoard(boardResp({ key: 'k2', cards: { inbox: [card(9)] } }));
    await switchBoard(base());
    api.getCardEvents.mockResolvedValue({ ok: true, events: [] });
    cardEl(1).focus();
    await key(cardEl(1), 'Enter');
    await flush();
    const drawer = document.querySelector('dialog.drawer') as HTMLDialogElement;
    const before = drawer.textContent;
    first.resolve({ ok: true, events: [event(3, { cardId: 1, threadId: 't-1', fromColumn: 'inbox', toColumn: 'ready' })] });
    await flush();
    expect(drawer.textContent).toBe(before);
  });

  it('移動の送信中に届いた、自分の移動より後の snapshot は列が違っても成功後に取り込む（lastEventId で判定）', async () => {
    const handlers = await mount(base(), [option('ready')]);
    const pending = deferred<unknown>();
    api.postMove.mockReturnValue(pending.promise);
    await grabAndDrop(1);
    expect(columnOf(1)).toBe('ready');
    // 自分の移動（id 11）の後にエージェントが doing へ移した（id 12）
    await snapshot(handlers, boardResp({ cards: { inbox: [card(2)], ready: [card(3)], doing: [card(4), card(1)] }, lastEventId: 12 }));
    pending.resolve({ ...okMove, lastEventId: 11 });
    await flush();
    expect(columnOf(1)).toBe('doing');
  });

  it('移動の前の snapshot を捨てたら GET /api/boards/:key で取り直す', async () => {
    const handlers = await mount(base(), [option('ready')]);
    const pending = deferred<unknown>();
    api.postMove.mockReturnValue(pending.promise);
    cardEl(1).focus();
    await key(cardEl(1), ' ');
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)], doing: [card(4)] }, lastEventId: 11 }));
    await key(cardEl(1), 'ArrowRight');
    await key(cardEl(1), ' ');
    api.getBoard.mockClear();
    api.getBoard.mockResolvedValue(boardResp({ cards: { inbox: [card(2)], ready: [card(3), card(1)], review: [card(4)] }, lastEventId: 12 }));
    pending.resolve({ ...okMove, lastEventId: 12 });
    await flush();
    expect(api.getBoard).toHaveBeenCalledWith('k1');
    expect(columnOf(1)).toBe('ready');
    expect(columnOf(4)).toBe('review');
  });

  it('移動の送信中に別のボードへ切り替えたら、新しいボードの snapshot をすぐに取り込みつかむこともでき、前のボードの完了で新しいボードの送信中を解除しない', async () => {
    await mount(base(), [option('ready')]);
    const pendingA = deferred<unknown>();
    api.postMove.mockReturnValue(pendingA.promise);
    await grabAndDrop(1);
    expect(api.postMove).toHaveBeenCalledWith('k1', 't-1', { to: 'ready' });
    await switchBoard(boardResp({ key: 'k2', cards: { inbox: [card(9)] } }));
    const handlersB = streams[streams.length - 1] as StreamHandlers;
    await snapshot(handlersB, boardResp({ key: 'k2', cards: { ready: [card(9)] }, lastEventId: 11 }));
    expect(columnOf(9)).toBe('ready');
    cardEl(9).focus();
    await key(cardEl(9), ' ');
    expect(document.querySelector('.grab-hint')).not.toBeNull();
    await key(cardEl(9), 'Escape');
    // B で移動を送信中に、A の送信が終わっても B の送信中は続く（B の snapshot は溜める）
    api.getMoveOptions.mockResolvedValue({ ok: true, options: [option('doing')] });
    const pendingB = deferred<unknown>();
    api.postMove.mockReturnValue(pendingB.promise);
    await grabAndDrop(9);
    expect(api.postMove).toHaveBeenLastCalledWith('k2', 't-9', { to: 'doing' });
    expect(columnOf(9)).toBe('doing');
    pendingA.resolve(okMove);
    await flush();
    await snapshot(handlersB, boardResp({ key: 'k2', cards: { ready: [card(9)] }, lastEventId: 11 }));
    expect(columnOf(9)).toBe('doing');
    pendingB.resolve({ ...okMove, to: 'doing', lastEventId: 12 });
    await flush();
    await snapshot(handlersB, boardResp({ key: 'k2', cards: { review: [card(9)] }, lastEventId: 13 }));
    expect(columnOf(9)).toBe('review');
  });

  it('前のボードの読み込みの失敗（403 で health を確かめている途中）は、切り替えた後のボードに案内を出さない', async () => {
    await mount(base());
    const health = deferred<unknown>();
    api.getHealth.mockReturnValue(health.promise);
    api.getBoard.mockResolvedValue({ ok: false, status: 403, code: 'FORBIDDEN', message: 'x' });
    await act(() => {
      history.replaceState(null, '', '#board=k2');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await flush();
    expect(api.getHealth).toHaveBeenCalledTimes(1);
    await switchBoard(boardResp({ key: 'k3', cards: { inbox: [card(9)] } }));
    health.resolve({ kind: 'http', status: 200, body: { ok: true, version: '1', authenticated: 'none' } });
    await flush();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(cardEl(9)).not.toBeNull();
  });

  it('移動の応答に lastEventId がなければ、溜めた snapshot を捨てて GET /api/boards/:key で取り直す', async () => {
    const handlers = await mount(base(), [option('ready')]);
    const pending = deferred<unknown>();
    api.postMove.mockReturnValue(pending.promise);
    cardEl(1).focus();
    await key(cardEl(1), ' ');
    // つかんでいる間に届いた、自分の移動を含まない（移動の前の位置 + 1 の）snapshot
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)], doing: [card(4)] }, lastEventId: 11 }));
    await key(cardEl(1), 'ArrowRight');
    await key(cardEl(1), ' ');
    api.getBoard.mockClear();
    api.getBoard.mockResolvedValue(boardResp({ cards: { inbox: [card(2)], ready: [card(3), card(1)], review: [card(4)] }, lastEventId: 12 }));
    const { lastEventId: _omit, ...withoutLastEventId } = okMove;
    pending.resolve(withoutLastEventId);
    await flush();
    expect(api.getBoard).toHaveBeenCalledWith('k1');
    expect(columnOf(1)).toBe('ready');
    expect(columnOf(4)).toBe('review');
  });

  it('取り直しの間に SSE で同じ lastEventId の snapshot が届いていれば、取り直した結果で上書きしない', async () => {
    const handlers = await mount(base(), [option('ready')]);
    const pending = deferred<unknown>();
    api.postMove.mockReturnValue(pending.promise);
    cardEl(1).focus();
    await key(cardEl(1), ' ');
    await snapshot(handlers, boardResp({ cards: { inbox: [card(1), card(2)], ready: [card(3)], doing: [card(4)] }, lastEventId: 11 }));
    await key(cardEl(1), 'ArrowRight');
    await key(cardEl(1), ' ');
    const refetch = deferred<unknown>();
    api.getBoard.mockClear();
    api.getBoard.mockReturnValue(refetch.promise);
    pending.resolve({ ...okMove, lastEventId: 12 });
    await flush();
    expect(api.getBoard).toHaveBeenCalledWith('k1');
    await snapshot(handlers, boardResp({ cards: { inbox: [card(2)], ready: [card(3), card(1)], review: [card(4)] }, lastEventId: 12 }));
    expect(columnOf(4)).toBe('review');
    refetch.resolve(boardResp({ cards: { inbox: [card(2)], ready: [card(3), card(1)], done: [card(4)] }, lastEventId: 12 }));
    await flush();
    expect(columnOf(4)).toBe('review');
  });

  it('前のボードで頼んだ移動先の応答が切り替えの後に届いても、ドロワーに空の「移動先」を出さない', async () => {
    await mount(base());
    const first = deferred<unknown>();
    api.getMoveOptions.mockReturnValueOnce(first.promise);
    const moveButton = (): HTMLButtonElement =>
      [...(document.querySelector('dialog.drawer') as HTMLDialogElement).querySelectorAll('button')].find((b) => b.textContent === '移動先…') as HTMLButtonElement;
    cardEl(1).focus();
    await key(cardEl(1), 'Enter');
    await act(() => moveButton().click());
    await flush();
    await switchBoard(boardResp({ key: 'k2', cards: { inbox: [card(1)] } }));
    const second = deferred<unknown>();
    api.getMoveOptions.mockReturnValueOnce(second.promise);
    cardEl(1).focus();
    await key(cardEl(1), 'Enter');
    await act(() => moveButton().click());
    await flush();
    const options = (): HTMLElement => document.getElementById('drawer-move-options') as HTMLElement;
    expect(options().textContent).toContain('移動先を確認しています');
    first.resolve({ ok: true, options: [option('ready')] });
    await flush();
    expect(options().textContent).toContain('移動先を確認しています');
    second.resolve({ ok: true, options: [option('ready')] });
    await flush();
    expect(options().querySelectorAll('button')).toHaveLength(1);
  });

  it('ドロワーの T3 のリンクは http: / https: のときだけ出す', async () => {
    const t3 = (link: string) => ({ link, projectId: null, parentThreadId: null, branch: null, worktreePath: null, pullRequests: [{ url: 'javascript:alert(2)', number: 3 }], syncedAt: '' });
    await mount(boardResp({ cards: { inbox: [card(1, { t3: t3('javascript:alert(1)') }), card(2, { t3: t3('https://t3.example/t/2') })] } }));
    cardEl(1).focus();
    await key(cardEl(1), 'Enter');
    const drawer = document.querySelector('dialog.drawer') as HTMLDialogElement;
    expect(drawer.querySelectorAll('a')).toHaveLength(0);
    cardEl(2).focus();
    await key(cardEl(2), 'Enter');
    expect([...drawer.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://t3.example/t/2']);
  });
});
