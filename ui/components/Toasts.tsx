// トースト: role="region" aria-label="通知" の固定コンテナ 1 つに、popover="manual" の要素として出す。
// 6 秒で自動的に消す（中にフォーカスがある間は消さない）。settle / unsettle の通知は閉じるまで残す。

import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { safeHttpUrl, type Toast } from '../state.js';
import * as platform from '../platform.js';

export const TOAST_TIMEOUT_MS = 6000;
const TOAST_GAP_PX = 8;

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }): JSX.Element {
  // popover は top layer に出るのでコンテナの配置が効かない。高さを測って下から積む（新しいものが下）
  const [heights, setHeights] = useState<Record<number, number>>({});
  const onMeasure = (id: number, h: number): void => setHeights((prev) => (prev[id] === h ? prev : { ...prev, [id]: h }));
  // 消えたトーストの高さを捨てる
  const ids = toasts.map((t) => t.id).join(',');
  useEffect(() => {
    const keep = new Set(toasts.map((t) => t.id));
    setHeights((prev) => {
      const stale = Object.keys(prev).filter((id) => !keep.has(Number(id)));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const id of stale) delete next[Number(id)];
      return next;
    });
  }, [ids]);
  let offset = 0;
  const offsets = new Map<number, number>();
  for (let i = toasts.length - 1; i >= 0; i -= 1) {
    const t = toasts[i] as Toast;
    offsets.set(t.id, offset);
    offset += (heights[t.id] ?? 0) + TOAST_GAP_PX;
  }
  return (
    <section class="toasts" role="region" aria-label="通知">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} offset={offsets.get(t.id) ?? 0} onMeasure={onMeasure} onDismiss={onDismiss} />
      ))}
    </section>
  );
}

function ToastItem({
  toast,
  offset,
  onMeasure,
  onDismiss,
}: {
  toast: Toast;
  offset: number;
  onMeasure: (id: number, height: number) => void;
  onDismiss: (id: number) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<boolean | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    platform.showPopover(el);
    platform.announce(toast.text);
    return () => platform.hidePopover(el);
  }, []);

  useLayoutEffect(() => {
    onMeasure(toast.id, platform.rect(ref.current).height);
  });

  useEffect(() => {
    if (toast.persistent) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      timer = setTimeout(() => {
        const el = ref.current;
        if (el !== null && el.contains(document.activeElement)) arm();
        else onDismiss(toast.id);
      }, TOAST_TIMEOUT_MS);
    };
    arm();
    return () => clearTimeout(timer);
  }, []);

  const settle = toast.settle;
  const link = safeHttpUrl(settle?.link);
  return (
    <div
      ref={ref}
      popover="manual"
      class={`toast${toast.persistent ? ' toast-persistent' : ''}`}
      data-toast-id={toast.id}
      style={`--toast-offset: ${offset}px`}
    >
      <p class="toast-text">{toast.text}</p>
      {settle !== undefined && (
        <div class="toast-actions">
          {link !== null && (
            <a href={link} target="_blank" rel="noopener noreferrer">
              T3 のスレッドを開く
            </a>
          )}
          <button
            type="button"
            onClick={() => {
              void platform.copyText(settle.instruction).then(setCopied);
            }}
          >
            エージェントへの指示文をコピー
          </button>
          {copied !== null && <span class="toast-note">{copied ? 'コピーしました' : 'コピーできませんでした'}</span>}
        </div>
      )}
      <button type="button" class="toast-close" aria-label="通知を閉じる" onClick={() => onDismiss(toast.id)}>
        ×
      </button>
    </div>
  );
}
