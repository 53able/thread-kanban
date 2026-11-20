import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT } from '../helpers/fixtures.js';

// 実際のスタイルシート（ui/app.css）を happy-dom に読み込み、hidden で切り替える要素が
// 作者の display 指定で表示されたままにならないことを computed style で確かめる
const css = readFileSync(join(ROOT, 'ui', 'app.css'), 'utf8');

let window: Window | null = null;

afterEach(async () => {
  await window?.happyDOM.close();
  window = null;
});

describe('ui/app.css', () => {
  it('狭幅で選択していない列（.column[hidden]）は display: none になり、選択中の列は flex のまま', () => {
    window = new Window();
    const { document } = window;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    document.body.innerHTML = `
      <div class="board" data-narrow="">
        <section class="column" id="shown" data-column="inbox"></section>
        <section class="column" id="hidden" data-column="ready" hidden></section>
      </div>`;
    const hidden = document.getElementById('hidden');
    const shown = document.getElementById('shown');
    if (hidden === null || shown === null) throw new Error('column not found');
    expect(hidden.hasAttribute('hidden')).toBe(true);
    expect(window.getComputedStyle(hidden).display).toBe('none');
    expect(window.getComputedStyle(shown).display).toBe('flex');
  });
});
