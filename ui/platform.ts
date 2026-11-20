// ブラウザの機能を呼ぶ唯一の場所。コンポーネントはここを経由し、DOM テストでは vi.mock で差し替える
// （happy-dom には showPopover がなく、rect は 0、elementFromPoint は null を返すため）。

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export function showModal(dialog: HTMLDialogElement): void {
  if (!dialog.open) dialog.showModal();
}

export function closeDialog(dialog: HTMLDialogElement, returnValue?: string): void {
  if (dialog.open) dialog.close(returnValue);
}

function supportsPopover(el: HTMLElement): boolean {
  return 'showPopover' in el && typeof el.showPopover === 'function';
}

/**
 * popover を表示する。popover API がない環境では hidden の切り替えで代わりに表示する
 * （<dialog> は open 属性がないと表示されないので、非モーダルの show() も呼ぶ）。
 */
export function showPopover(el: HTMLElement): void {
  if (supportsPopover(el)) {
    if (!el.matches(':popover-open')) el.showPopover();
    return;
  }
  el.hidden = false;
  if (el instanceof HTMLDialogElement && !el.open) el.show();
}

export function hidePopover(el: HTMLElement): void {
  if (supportsPopover(el)) {
    if (el.matches(':popover-open')) el.hidePopover();
    return;
  }
  el.hidden = true;
  if (el instanceof HTMLDialogElement && el.open) el.close();
}

export function focus(el: HTMLElement | null | undefined, options: FocusOptions = { preventScroll: true }): void {
  el?.focus(options);
}

export function scrollIntoView(el: HTMLElement | null | undefined): void {
  if (el !== null && el !== undefined && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

export function rect(el: Element | null | undefined): Rect {
  if (el === null || el === undefined) return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
}

export function elementFromPoint(x: number, y: number): Element | null {
  return document.elementFromPoint(x, y);
}

export function setPointerCapture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // ポインターがすでに離れている場合は捕捉しない
  }
}

export function requestFrame(cb: () => void): number {
  return requestAnimationFrame(cb);
}

export function cancelFrame(id: number): void {
  cancelAnimationFrame(id);
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** メディアクエリを購読する。戻り値で購読を解除する。 */
export function watchMedia(query: string, cb: (matches: boolean) => void): () => void {
  if (typeof matchMedia !== 'function') {
    cb(false);
    return () => undefined;
  }
  const mq = matchMedia(query);
  const listener = (): void => cb(mq.matches);
  cb(mq.matches);
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}

/**
 * 描画の更新を view transition で包む。update は「state を更新し、commit の後に resolve する Promise」を返す。
 * startViewTransition がない環境と prefers-reduced-motion のときは、アニメーションなしでそのまま更新する。
 */
export function startViewTransition(update: () => Promise<void>): void {
  const doc = document as Document & { startViewTransition?: (cb: () => Promise<void>) => unknown };
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    void update();
    return;
  }
  doc.startViewTransition(update);
}

/** 続けて読み上げるときの間隔（live region の書き換えを読み上げが拾えるようにする） */
const ANNOUNCE_GAP_MS = 150;
const announceQueue: { text: string; delayMs: number }[] = [];
let announceTimer: ReturnType<typeof setTimeout> | undefined;

function speak(text: string): void {
  const doc = document as Document & { ariaNotify?: (message: string) => void };
  const region = document.getElementById('live-region');
  if (typeof doc.ariaNotify === 'function') doc.ariaNotify(text);
  else if (region !== null) region.textContent = text;
}

function pumpAnnouncements(): void {
  const next = announceQueue.shift();
  if (next === undefined) {
    announceTimer = undefined;
    return;
  }
  const region = document.getElementById('live-region');
  if (region !== null) region.textContent = '';
  const run = (): void => {
    speak(next.text);
    announceTimer = setTimeout(pumpAnnouncements, ANNOUNCE_GAP_MS);
  };
  if (next.delayMs > 0) announceTimer = setTimeout(run, next.delayMs);
  else run();
}

/**
 * スクリーンリーダーに読み上げる。ariaNotify があれば使い、なければページ読み込み時からある
 * aria-live="polite" の領域（#live-region）に、いったん空にしてから文字を入れる。
 * 読み上げ中（待ち時間を含む）に呼ばれたものは取り消さず、順に読み上げる。
 */
export function announce(text: string, delayMs = 0): void {
  announceQueue.push({ text, delayMs });
  if (announceTimer === undefined) pumpAnnouncements();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
