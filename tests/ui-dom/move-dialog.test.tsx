import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoveFlow } from '../../ui/components/MoveDialog.js';
import { option } from './fixtures.js';

const platform = vi.hoisted(() => ({
  showModal: vi.fn(),
  closeDialog: vi.fn(),
  focus: vi.fn(),
}));
vi.mock('../../ui/platform.js', () => platform);

const { MoveDialog } = await import('../../ui/components/MoveDialog.js');

let root: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app') as HTMLElement;
});
afterEach(() => {
  render(null, root);
});

const flow = (seq: number): MoveFlow => ({
  seq,
  threadId: 't-1',
  cardId: 1,
  title: 'カード1',
  option: option('ready', { needsCriteria: true, entryCriteria: ['仕様が決まっている'] }),
  steps: ['criteria'],
  step: 'criteria',
});

const noop = (): void => undefined;

describe('MoveDialog', () => {
  it('開き直し（seq が変わる）では、最初の描画からチェックを外した状態で出す', () => {
    act(() => {
      render(<MoveDialog flow={flow(1)} onAdvance={noop} onConfirm={noop} onCancel={noop} />, root);
    });
    const box = root.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const confirm = (): HTMLButtonElement => root.querySelector('button[value="confirm"]') as HTMLButtonElement;
    expect(confirm().disabled).toBe(false);
    // showModal（layout effect）の時点の描画を記録する
    const seen: boolean[] = [];
    platform.showModal.mockImplementation(() => {
      seen.push(confirm().disabled);
    });
    act(() => {
      render(<MoveDialog flow={flow(2)} onAdvance={noop} onConfirm={noop} onCancel={noop} />, root);
    });
    expect(seen).toEqual([true]);
    expect(confirm().disabled).toBe(true);
    expect((root.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  });
});
