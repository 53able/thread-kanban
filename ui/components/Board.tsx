// ボード: 列ごとの role="listbox" と、カードの role="option"（列ごとに roving tabindex でタブストップ 1 つ）。
// カードの中には操作できる要素を置かない（ドラッグのつかみ手は aria-hidden の装飾）。

import type { JSX, TargetedKeyboardEvent, TargetedPointerEvent } from 'preact';
import type { BoardCardView, BoardColumnView, BoardView, Column, MoveOption } from '../api-types.js';
import { columnVerdicts, displayColumns } from '../state.js';
import * as platform from '../platform.js';

export interface GrabState {
  threadId: string;
  /** つかんだ列の表示上の番号 */
  from: number;
  /** 移動先として選んでいる列の表示上の番号 */
  target: number;
  options: MoveOption[] | null;
}

export interface DragState {
  threadId: string;
  pointerId: number;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  over: Column | null;
  options: MoveOption[] | null;
}

export interface BoardProps {
  board: BoardView;
  selected: string | null;
  grab: GrabState | null;
  drag: DragState | null;
  highlighted: ReadonlySet<number>;
  narrow: boolean;
  activeColumn: Column | null;
  onCardKeyDown: (ev: TargetedKeyboardEvent<HTMLElement>, threadId: string) => void;
  onCardFocus: (threadId: string) => void;
  onCardClick: (threadId: string) => void;
  onColumnFocus: (column: Column) => void;
  onHandlePointerDown: (ev: TargetedPointerEvent<HTMLElement>, threadId: string) => void;
  onSelectTab: (column: Column) => void;
}

export function columnHeadingId(column: Column): string {
  return `col-head-${column}`;
}

export function columnListId(column: Column): string {
  return `col-list-${column}`;
}

export function cardElementId(cardId: number): string {
  return `card-${cardId}`;
}

function tabId(column: Column): string {
  return `col-tab-${column}`;
}

function wipText(col: BoardColumnView): string {
  return col.wipLimit === null ? `${col.count}` : `${col.count}/${col.wipLimit}`;
}

export function Board(props: BoardProps): JSX.Element {
  const cols = displayColumns(props.board);
  const active = props.activeColumn ?? cols[0]?.column ?? null;
  const moving = props.drag ?? props.grab;
  const options = moving?.options ?? null;
  const movingFrom = moving === null ? null : findColumnOf(props.board, moving.threadId);
  return (
    <div class="board-wrap">
      {props.narrow && (
        <ColumnTabs columns={cols} active={active} onSelect={props.onSelectTab} />
      )}
      {props.grab !== null && (
        <p class="grab-hint" role="note">
          つかんでいます: ←/→ で移動先の列を選び、Space で確定、Esc で取り消し
        </p>
      )}
      <div class="board" data-narrow={props.narrow ? '' : undefined}>
        {cols.map((col, index) => {
          const verdicts =
            options === null || moving === null ? null : col.column === movingFrom ? columnVerdicts(undefined) : columnVerdicts(options.find((o) => o.column === col.column));
          const isTarget =
            (props.grab !== null && props.grab.target === index) || (props.drag !== null && props.drag.over === col.column);
          return (
            <ColumnView
              key={col.column}
              col={col}
              props={props}
              hidden={props.narrow && col.column !== active}
              verdicts={verdicts}
              isTarget={isTarget}
            />
          );
        })}
      </div>
    </div>
  );
}

function findColumnOf(board: BoardView, threadId: string): Column | null {
  return board.columns.find((c) => c.cards.some((card) => card.threadId === threadId))?.column ?? null;
}

function ColumnView({
  col,
  props,
  hidden,
  verdicts,
  isTarget,
}: {
  col: BoardColumnView;
  props: BoardProps;
  hidden: boolean;
  verdicts: ReturnType<typeof columnVerdicts> | null;
  isTarget: boolean;
}): JSX.Element {
  const selectedHere = col.cards.some((c) => c.threadId === props.selected);
  const empty = col.cards.length === 0;
  return (
    <section
      class="column"
      id={`col-panel-${col.column}`}
      data-column={col.column}
      data-over={col.overLimit ? '' : undefined}
      data-target={isTarget ? '' : undefined}
      data-verdict={verdicts?.map((v) => v.kind).join(' ')}
      hidden={hidden}
      role={props.narrow ? 'tabpanel' : undefined}
      aria-labelledby={props.narrow ? tabId(col.column) : undefined}
    >
      <h2 class="column-head" id={columnHeadingId(col.column)}>
        <span class="column-name">{col.column}</span> <span class="column-count">{wipText(col)}</span>
        {col.overLimit && (
          <span class="badge badge-wip">
            <span aria-hidden="true">▲</span> WIP 超過
          </span>
        )}
        {col.entryCriteria.length > 0 && (
          <span class="badge badge-criteria" title={col.entryCriteria.join('\n')}>
            入場条件 {col.entryCriteria.length}
          </span>
        )}
      </h2>
      {verdicts !== null && (
        <ul class="verdicts" aria-hidden="true">
          {verdicts.map((v) => (
            <li key={v.kind} class={`verdict verdict-${v.kind}`}>
              {v.label}
            </li>
          ))}
        </ul>
      )}
      <ul
        class="cards"
        role="listbox"
        id={columnListId(col.column)}
        aria-labelledby={columnHeadingId(col.column)}
        tabIndex={empty ? 0 : -1}
        onFocus={(ev) => {
          if (ev.target === ev.currentTarget) props.onColumnFocus(col.column);
        }}
      >
        {col.cards.map((card, i) => (
          <CardView
            key={card.cardId}
            card={card}
            props={props}
            tabStop={selectedHere ? card.threadId === props.selected : i === 0}
          />
        ))}
        {empty && <li class="empty-column" aria-hidden="true">カードなし</li>}
      </ul>
    </section>
  );
}

function CardView({ card, props, tabStop }: { card: BoardCardView; props: BoardProps; tabStop: boolean }): JSX.Element {
  const selected = card.threadId === props.selected;
  const grabbed = props.grab?.threadId === card.threadId;
  const drag = props.drag?.threadId === card.threadId ? props.drag : null;
  const flags: string[] = [];
  if (card.blocked !== null) flags.push('blocked');
  if (card.overdue) flags.push('overdue');
  if (card.stale) flags.push('stale');
  const style =
    `view-transition-name: card-${card.cardId};` +
    (drag === null
      ? ''
      : ` position: fixed; left: ${drag.x - drag.offsetX}px; top: ${drag.y - drag.offsetY}px; width: ${drag.width}px; pointer-events: none; z-index: 10;`);
  const describe = [
    card.blocked !== null ? `ブロック中: ${card.blocked.reason}` : null,
    card.overdue ? `期限超過（${card.dueDate ?? ''}、UTC）` : null,
    card.stale ? `${card.daysSinceLastEvent} 日更新なし` : null,
  ].filter((x): x is string => x !== null);
  return (
    <>
      {drag !== null && <li class="placeholder" aria-hidden="true" style={`height: ${drag.height}px`} />}
      <li
        role="option"
        id={cardElementId(card.cardId)}
        class={[
          'card',
          `class-${card.serviceClass}`,
          ...flags,
          props.highlighted.has(card.cardId) ? 'changed' : '',
          grabbed ? 'grabbed' : '',
          drag !== null ? 'dragging' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-thread-id={card.threadId}
        aria-selected={selected ? 'true' : 'false'}
        aria-roledescription={grabbed ? 'つかんでいるカード' : undefined}
        tabIndex={tabStop ? 0 : -1}
        style={style}
        onKeyDown={(ev) => props.onCardKeyDown(ev, card.threadId)}
        onFocus={() => props.onCardFocus(card.threadId)}
        onClick={() => props.onCardClick(card.threadId)}
      >
        <span
          class="handle"
          aria-hidden="true"
          title="ドラッグして移動"
          onPointerDown={(ev) => props.onHandlePointerDown(ev, card.threadId)}
        >
          ⠿
        </span>
        <span class="card-body">
          <span class="card-title">{card.title}</span>
          <span class="card-meta">
            #{card.cardId} · {card.serviceClass}
            {card.size !== null ? ` · ${card.size}` : ''}
            {card.dueDate !== null ? ` · 期限 ${card.dueDate}` : ''}
          </span>
          {describe.length > 0 && (
            <span class="card-flags">
              {card.blocked !== null && (
                <span class="badge badge-blocked">
                  <span aria-hidden="true">■</span> ブロック
                </span>
              )}
              {card.overdue && (
                <span class="badge badge-overdue" title="期限は UTC の日付で判定します">
                  <span aria-hidden="true">●</span> 期限超過
                </span>
              )}
              {card.stale && (
                <span class="badge badge-stale">
                  <span aria-hidden="true">◆</span> 停滞
                </span>
              )}
              <span class="visually-hidden">{describe.join('。')}</span>
            </span>
          )}
        </span>
      </li>
    </>
  );
}

/** 幅 480px 未満で列を切り替えるタブ（roving tabindex、選択はフォーカスに追従）。 */
function ColumnTabs({
  columns,
  active,
  onSelect,
}: {
  columns: BoardColumnView[];
  active: Column | null;
  onSelect: (column: Column) => void;
}): JSX.Element {
  const onKeyDown = (ev: TargetedKeyboardEvent<HTMLElement>, index: number): void => {
    let next: number | null = null;
    if (ev.key === 'ArrowRight') next = (index + 1) % columns.length;
    else if (ev.key === 'ArrowLeft') next = (index - 1 + columns.length) % columns.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = columns.length - 1;
    if (next === null) return;
    ev.preventDefault();
    const col = columns[next] as BoardColumnView;
    onSelect(col.column);
    platform.focus(document.getElementById(tabId(col.column)));
  };
  return (
    <div class="tabs" role="tablist" aria-label="列">
      {columns.map((col, i) => (
        <button
          key={col.column}
          type="button"
          role="tab"
          id={tabId(col.column)}
          aria-selected={col.column === active ? 'true' : 'false'}
          aria-controls={`col-panel-${col.column}`}
          tabIndex={col.column === active ? 0 : -1}
          onClick={() => onSelect(col.column)}
          onKeyDown={(ev) => onKeyDown(ev, i)}
        >
          {col.column} {wipText(col)}
        </button>
      ))}
    </div>
  );
}
