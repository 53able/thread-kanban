// 移動のダイアログ（入場条件のチェックリスト → WIP 超過の確認、失敗時の理由）。
// ネイティブの <dialog> を showModal() で開く。role / aria-modal / フォーカストラップ / Esc の処理は書かない。
// JSX に open 属性を書かず、要素は常に描画して useLayoutEffect で ref から開く（作り直すと top layer から外れる）。

import type { JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { MoveOption } from '../api-types.js';
import type { MoveStep } from '../state.js';
import * as platform from '../platform.js';

export interface MoveFlow {
  /** 同じカード・列でも開き直しを区別するための通し番号 */
  seq: number;
  threadId: string;
  cardId: number;
  title: string;
  option: MoveOption;
  steps: MoveStep[];
  step: MoveStep | 'error';
  error?: string;
}

export interface MoveDialogProps {
  flow: MoveFlow | null;
  onAdvance: () => void;
  onConfirm: (forceReason: string | undefined) => void;
  /** キャンセル・Esc・失敗表示の「閉じる」 */
  onCancel: () => void;
}

interface Occupant {
  cardId?: number;
  threadId?: string;
  title?: string;
}

export function MoveDialog({ flow, onAdvance, onConfirm, onCancel }: MoveDialogProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const seq = flow?.seq ?? null;
  // 入力は開き直し（seq）ごとに持つ。seq が変わった最初の描画から空の状態にする
  const [form, setForm] = useState<{ seq: number | null; checked: boolean[]; reason: string }>({ seq, checked: [], reason: '' });
  const current = form.seq === seq ? form : { seq, checked: [], reason: '' };
  const { checked, reason } = current;
  const setChecked = (next: boolean[]): void => setForm({ ...current, checked: next });
  const setReason = (next: string): void => setForm({ ...current, reason: next });
  const latest = useRef({ flow, reason, onConfirm, onCancel });
  latest.current = { flow, reason, onConfirm, onCancel };

  const step = flow?.step ?? null;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (step !== null) {
      platform.showModal(el);
      platform.focus(cancelRef.current);
    } else {
      platform.closeDialog(el);
    }
  }, [seq, step]);

  const onClose = (): void => {
    const el = ref.current;
    if (el === null) return;
    const value = el.returnValue;
    el.returnValue = '';
    const { flow: current, reason: r, onConfirm: confirm, onCancel: cancel } = latest.current;
    if (current === null) return;
    if (value === 'confirm' && current.step !== 'error') confirm(current.step === 'wip' ? r : undefined);
    else cancel();
  };

  const option = flow?.option;
  const criteria = option?.entryCriteria ?? [];
  const allChecked = criteria.every((_, i) => checked[i] === true);
  const isLast = flow !== null && flow.steps[flow.steps.length - 1] === flow.step;
  const occupants = (option?.occupants ?? []) as Occupant[];
  const card = flow === null ? '' : `#${flow.cardId}「${flow.title}」`;

  return (
    <dialog ref={ref} class="move-dialog" aria-labelledby="move-dialog-title" onClose={onClose}>
      <form method="dialog">
        {flow?.step === 'criteria' && (
          <>
            <h2 id="move-dialog-title">{option?.column} の入場条件</h2>
            <p>
              {card} を {option?.column} に移します。次の条件を満たしていることを確認してください。
            </p>
            <ul class="criteria">
              {criteria.map((c, i) => (
                <li key={i}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked[i] === true}
                      onChange={(ev) => {
                        const next = [...checked];
                        next[i] = ev.currentTarget.checked;
                        setChecked(next);
                      }}
                    />{' '}
                    {c}
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        {flow?.step === 'wip' && (
          <>
            <h2 id="move-dialog-title">{option?.column} の WIP 上限を超えます</h2>
            <p>
              {card} を移すと WIP 上限を超えます。強行する場合は理由を入力してください。この操作は記録に残ります。
            </p>
            {occupants.length > 0 && (
              <>
                <h3>{option?.column} にあるカード</h3>
                <ul class="occupants">
                  {occupants.map((o, i) => (
                    <li key={o.threadId ?? i}>
                      #{o.cardId} {o.title}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <label class="field">
              強行する理由
              <textarea
                name="reason"
                rows={3}
                value={reason}
                onInput={(ev) => setReason(ev.currentTarget.value)}
              />
            </label>
          </>
        )}
        {flow?.step === 'error' && (
          <>
            <h2 id="move-dialog-title">移動できませんでした</h2>
            <p>
              {card} を {option?.column} に移せませんでした。表示を元に戻しました。
            </p>
            <p class="error-text">{flow.error}</p>
          </>
        )}
        <div class="dialog-actions">
          <button ref={cancelRef} value="cancel" autofocus>
            {flow?.step === 'error' ? '閉じる' : 'キャンセル'}
          </button>
          {flow?.step === 'criteria' && !isLast && (
            <button type="button" disabled={!allChecked} onClick={onAdvance}>
              次へ
            </button>
          )}
          {flow?.step === 'criteria' && isLast && (
            <button value="confirm" disabled={!allChecked}>
              移動する
            </button>
          )}
          {flow?.step === 'wip' && (
            <button value="confirm" class="danger" disabled={reason.trim() === ''}>
              強行して移動する
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
