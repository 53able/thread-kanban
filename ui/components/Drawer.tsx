// カード詳細のドロワー。ボードを見ながら開いておけるように非モーダルの <dialog popover="manual"> にする。
// popover="manual" は Esc で閉じないので、ドロワーの中にフォーカスがあるときの Esc で閉じる。

import type { JSX, TargetedKeyboardEvent } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { BoardCardView, Column, MoveOption, UiEvent } from '../api-types.js';
import { columnVerdicts, eventText, safeHttpUrl } from '../state.js';
import * as platform from '../platform.js';

export interface DrawerProps {
  /** null = 閉じている */
  threadId: string | null;
  card: BoardCardView | null;
  column: Column | null;
  events: UiEvent[] | null;
  options: MoveOption[] | null;
  pending: boolean;
  onClose: () => void;
  onBlock: (reason: string) => void;
  onUnblock: () => void;
  onRequestOptions: () => void;
  onChooseOption: (option: MoveOption) => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ja-JP');
}

export function Drawer(props: DrawerProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState('');
  const [showOptions, setShowOptions] = useState(false);
  const open = props.threadId !== null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (open) {
      platform.showPopover(el);
      platform.focus(closeRef.current);
    } else {
      platform.hidePopover(el);
    }
    setReason('');
    setShowOptions(false);
  }, [props.threadId]);

  // カードが別の列へ移ったら、移動先の一覧（古い判定）を閉じる
  useEffect(() => setShowOptions(false), [props.column]);

  const onKeyDown = (ev: TargetedKeyboardEvent<HTMLDialogElement>): void => {
    if (ev.key === 'Escape' && open) {
      ev.preventDefault();
      ev.stopPropagation();
      props.onClose();
    }
  };

  const card = props.card;
  const t3 = card?.t3 ?? null;
  const t3Link = safeHttpUrl(t3?.link);
  return (
    <dialog ref={ref} popover="manual" class="drawer" aria-labelledby="drawer-title" onKeyDown={onKeyDown}>
      <div class="drawer-head">
        <h2 id="drawer-title">{card === null ? 'カード' : `#${card.cardId} ${card.title}`}</h2>
        <button ref={closeRef} type="button" class="drawer-close" onClick={props.onClose}>
          閉じる
        </button>
      </div>
      {open && card === null && <p>このカードはボードにありません。</p>}
      {card !== null && (
        <>
          <dl class="props">
            <dt>列</dt>
            <dd>{props.column}</dd>
            <dt>threadId</dt>
            <dd>
              <code>{card.threadId}</code>
            </dd>
            <dt>サービスクラス</dt>
            <dd>{card.serviceClass}</dd>
            <dt>種別</dt>
            <dd>{card.type}</dd>
            {card.dueDate !== null && (
              <>
                <dt>期限（UTC）</dt>
                <dd>
                  {card.dueDate}
                  {card.overdue ? '（超過）' : ''}
                </dd>
              </>
            )}
            {t3Link !== null && (
              <>
                <dt>T3</dt>
                <dd>
                  <a href={t3Link} target="_blank" rel="noopener noreferrer">
                    スレッドを開く
                  </a>
                </dd>
              </>
            )}
            {t3?.branch != null && (
              <>
                <dt>ブランチ</dt>
                <dd>
                  <code>{t3.branch}</code>
                </dd>
              </>
            )}
            {t3 !== null && t3.pullRequests.length > 0 && (
              <>
                <dt>PR</dt>
                <dd>
                  <ul class="plain">
                    {t3.pullRequests.map((pr) => {
                      const label = pr.number !== undefined ? `#${pr.number}` : pr.url;
                      const href = safeHttpUrl(pr.url);
                      return (
                        <li key={pr.url}>
                          {href === null ? (
                            label
                          ) : (
                            <a href={href} target="_blank" rel="noopener noreferrer">
                              {label}
                            </a>
                          )}
                          {pr.state !== undefined ? `（${pr.state}）` : ''}
                        </li>
                      );
                    })}
                  </ul>
                </dd>
              </>
            )}
            {card.blocked !== null && (
              <>
                <dt>ブロックの理由</dt>
                <dd>
                  {card.blocked.reason}（{card.blocked.days} 日）
                </dd>
              </>
            )}
          </dl>

          <div class="drawer-actions">
            {card.blocked !== null ? (
              <button type="button" disabled={props.pending} onClick={props.onUnblock}>
                ブロックを解除
              </button>
            ) : (
              <form
                class="block-form"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  if (reason.trim() !== '') props.onBlock(reason);
                }}
              >
                <label class="field">
                  ブロックの理由
                  <input type="text" value={reason} onInput={(ev) => setReason(ev.currentTarget.value)} />
                </label>
                <button type="submit" disabled={props.pending || reason.trim() === ''}>
                  ブロックする
                </button>
              </form>
            )}
            <button
              type="button"
              aria-expanded={showOptions ? 'true' : 'false'}
              aria-controls="drawer-move-options"
              onClick={() => {
                if (!showOptions) props.onRequestOptions();
                setShowOptions(!showOptions);
              }}
            >
              移動先…
            </button>
          </div>
          {showOptions && (
            <div id="drawer-move-options" class="move-options">
              {props.options === null ? (
                <p>移動先を確認しています…</p>
              ) : (
                <ul class="plain">
                  {props.options
                    .filter((o) => o.column !== 'discarded')
                    .map((o) => (
                      <li key={o.column}>
                        <button type="button" disabled={!o.allowed || props.pending} onClick={() => props.onChooseOption(o)}>
                          {o.column}
                        </button>{' '}
                        <span class="option-verdict">{columnVerdicts(o).map((v) => v.label).join('・')}</span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}

          <h3>履歴</h3>
          {props.events === null ? (
            <p>読み込んでいます…</p>
          ) : (
            <ol class="history">
              {props.events.map((e) => (
                <li key={e.id}>
                  <time dateTime={e.at}>{formatTime(e.at)}</time> {eventText(e)}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </dialog>
  );
}
