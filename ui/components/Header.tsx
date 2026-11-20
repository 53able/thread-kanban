// ヘッダー（ボードの切り替え、要対応の件数、WIP 超過の列の数、次の推奨、最近の更新）と、
// オフライン・再認証の案内、空の状態。

import type { JSX } from 'preact';
import type { BoardKey, BoardResponse, BoardSummary } from '../api-types.js';
import { attentionCount, wipOverCount, type Banner, type RecentItem } from '../state.js';

export interface HeaderProps {
  boards: BoardSummary[];
  currentKey: BoardKey | null;
  resp: BoardResponse | null;
  recent: RecentItem[];
  onSwitch: (key: BoardKey) => void;
}

export function Header({ boards, currentKey, resp, recent, onSwitch }: HeaderProps): JSX.Element {
  const board = resp?.board ?? null;
  const next = resp?.next ?? null;
  return (
    <header class="header">
      <div class="header-row">
        <h1 class="title">thread-kanban</h1>
        {boards.length > 0 && (
          <label class="board-switch">
            <span class="visually-hidden">ボード</span>
            <select value={currentKey ?? ''} onChange={(ev) => onSwitch(ev.currentTarget.value)}>
              {boards.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.label}
                  {b.exists ? '' : '（未作成）'}
                </option>
              ))}
            </select>
          </label>
        )}
        {board !== null && (
          <p class="stats">
            <span
              class="stat stat-attention"
              data-alert={attentionCount(board) > 0 ? '' : undefined}
              title="ブロック・期限超過・停滞のどれかに当たるカードの枚数。期限超過は UTC の日付で判定します"
            >
              要対応 {attentionCount(board)} 件
            </span>
            <span class="stat stat-wip" data-alert={wipOverCount(board) > 0 ? '' : undefined}>
              WIP 超過 {wipOverCount(board)} 列
            </span>
            {board.discardedCount > 0 && <span class="stat">破棄 {board.discardedCount} 件</span>}
          </p>
        )}
        <details class="recent">
          <summary>最近の更新（{recent.length}）</summary>
          {recent.length === 0 ? (
            <p>まだ更新はありません</p>
          ) : (
            <ol class="recent-list">
              {recent.map((r) => (
                <li key={r.id}>{r.text}</li>
              ))}
            </ol>
          )}
        </details>
      </div>
      {next !== null && (
        <p class="next">
          <span class="next-label">次の推奨:</span>{' '}
          {next.card !== null && (
            <strong>
              #{next.card.cardId} {next.card.title}
            </strong>
          )}{' '}
          {next.reason}
        </p>
      )}
    </header>
  );
}

export function BannerView({ banner, onRetry }: { banner: Banner; onRetry: () => void }): JSX.Element | null {
  if (banner === null) return null;
  if (banner === 'reauth') {
    return (
      <div class="banner banner-error" role="alert">
        認証が切れました。新しい URL を開いてください（<code>thread-kanban ui</code> を実行すると表示されます）。
      </div>
    );
  }
  if (banner === 'unavailable') {
    return (
      <div class="banner banner-error" role="alert">
        ボードを読み込めません。{' '}
        <button type="button" onClick={onRetry}>
          再試行
        </button>
      </div>
    );
  }
  return (
    <div class="banner banner-warn" role="status">
      サーバーに接続できません。再接続しています…
    </div>
  );
}

export function EmptyState(): JSX.Element {
  return (
    <div class="empty-state">
      <p>まだカードがありません。スレッドで kanban_card_add を呼ぶと表示されます。</p>
    </div>
  );
}
