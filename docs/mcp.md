# MCP リファレンス

[README に戻る](../README.md)

## ツール

| ツール | 内容 |
|---|---|
| `kanban_board_get` | ボード全体。列は右（done）から左（inbox）の順。WIP 上限と件数、カードごとのブロック経過日数・期限超過・stale、WIP 違反 |
| `kanban_board_configure` | 列ごとの WIP 上限（`null` で無制限）と入場条件、stale 判定日数（`staleDays`）を設定 |
| `kanban_card_add` | スレッドをカード化して `inbox` に置く。同じ `threadId` なら既存カードを返す（`created: false`）。T3 CLI が使えるときは `title` を省略でき、子スレッドは拒否する（`asWorkItem: true` で登録） |
| `kanban_card_update` | タイトル・説明・種別・サービスクラス・期限・サイズ・外部参照（PR / Issue）を更新 |
| `kanban_card_move` | 列移動。[移動ポリシー](#列)を強制 |
| `kanban_card_block` | 理由付きでブロック |
| `kanban_card_unblock` | ブロック解除（`resolution` に解消内容を残せる） |
| `kanban_next` | 次の行動を 1 件推奨（理由付き） |
| `kanban_metrics` | 期間（既定は直近 30 日）のフローメトリクス |
| `kanban_sync` | ボードと T3 Code のスレッドを突き合わせ、[ずれと提案を返す](t3-code.md#kanban_sync)。列・ブロックは変更しない |

全ツールは人間向けのテキスト（`content`）と機械可読な JSON（`structuredContent`）を返します。
ルール違反は例外ではなく `isError: true` で返り、`structuredContent` に `{ ok: false, code, message, details }` が入ります。
入力スキーマ違反（列名の誤り、実在しない日付、空の `threadId` など）だけは SDK が `isError: true` とテキストのみで返し、`structuredContent` は付きません。

| code | 意味 |
|---|---|
| `WIP_LIMIT_EXCEEDED` | 移動先の WIP 上限に達している。`details.occupants` / `details.occupantThreadIds` に占有中のカード |
| `BLOCKED` | ブロック中のカードは前進できない |
| `SKIP_NOT_ALLOWED` | 列の飛び越し前進。`details.nextColumn` が次の列 |
| `CRITERIA_NOT_CONFIRMED` | 入場条件の確認が必要。`details.entryCriteria` が条件一覧 |
| `EXPEDITE_LIMIT` | expedite はボード上に同時 1 枚まで |
| `DUE_DATE_REQUIRED` | fixed_date には `dueDate` が必要 |
| `FORCE_REASON_REQUIRED` | `force: true` には `reason` が必要 |
| `THREAD_ID_REQUIRED` | `threadId` も `KANBAN_THREAD_ID` も `T3CODE_THREAD_ID` もない |
| `CARD_NOT_FOUND` | その `threadId` のカードがない |
| `SAME_COLUMN` / `TERMINAL_COLUMN` | 同じ列への移動 / `discarded` からの移動 |
| `ALREADY_BLOCKED` / `NOT_BLOCKED` / `CARD_NOT_ACTIVE` | 二重ブロック / 未ブロックの解除 / done・discarded のブロック |
| `INVALID_ARGUMENT` | `kanban_metrics` の日時が解釈できない、`from` が `to` より後、期間が 366 日を超える。`kanban_card_add` で `title` がなく、T3 のスレッド名も得られない。`threadId` の形式が不正 |
| `CHILD_THREAD` | `kanban_card_add` の対象が委譲で作られた子スレッド。`details.parentThreadId` と `details.parentCard`（親のカード。なければ `null`） |
| `T3_UNAVAILABLE` | `kanban_sync` で T3 CLI も `threads` 引数もない、または呼び出し元スレッド・スレッド一覧を取得できない。`details.reason` に理由 |

## ポリシー

### 列

`inbox → ready → doing → review → done`、終端に `discarded`。列の追加・改名はできません。

- 前進は隣の列へのみ。`inbox → doing` のような飛び越しは拒否
- 後退（差し戻し）は任意の列へ可能（例: `review → doing`、`done → review`）
- `discarded` へはどの列からでも移動可能。`discarded` からは戻せない
- 列の出入りは全てイベントとして自動記録（メトリクスの元データ）

### WIP 制限

- 既定の上限: `ready` 5、`doing` 3、`review` 2（`inbox` と `done` は無制限）
- 上限を超える移動は拒否し、その列を占有しているカード一覧を返す。差し戻し先にも適用
- `force: true` と `reason` を指定すると突破できる。突破は WIP 違反イベントとして記録され、`kanban_metrics` の `wipViolations` に出る

### サービスクラス

| クラス | ルール |
|---|---|
| `expedite` | ボード上（done / discarded 以外）に同時 1 枚まで。列の WIP 上限を超えて移動できる（違反扱いにしない） |
| `fixed_date` | `dueDate`（YYYY-MM-DD）必須 |
| `regular` | `ready` への到着順（FIFO） |
| `intangible` | 他クラスのカードが `ready` にないときだけ pull 候補になる |

pull 順は `expedite` → `fixed_date`（期限の近い順）→ `regular`（FIFO）→ `intangible`。
作業種別 `type` は `feature` / `defect` / `maintenance` で、`defect` を failure demand として集計します。サイズは任意の T シャツサイズ（XS〜XL）です。

### ブロック

ブロックは列ではなくカードのフラグです。理由と開始時刻を持ち、カードは列に残って WIP に数えられます。
ブロック中は前進できません（差し戻しと `discarded` への移動は可能。`discarded` にすると自動で解除されます）。

### 入場条件

`kanban_board_configure` で列ごとにチェックリスト（文字列の配列）を設定できます。
条件を持つ列への移動には `criteriaConfirmed: true` が必要で、指定がなければ条件一覧を返して拒否します。

### 次の行動（`kanban_next`）

done に近い側から順に判断します。

1. `review` にあるカードの完了支援
2. ブロック中カードの解消（done に近い列から）
3. `doing` に空きがあれば `ready` から pull 順で 1 枚（`expedite` は空きがなくても pull 可）
4. 空きがなければ、または `ready` が空なら「新規着手しない」

### メトリクス（`kanban_metrics`）

- リードタイム（`inbox` 入り〜`done`）とサイクルタイム（最初の `doing` 入り〜`done`）の中央値と 85 パーセンタイル（nearest-rank 法、単位は日）
- 週次スループット（月曜始まり、UTC）
- ブロック件数（期間内に始まったブロックの数）と延べブロック日数（期間前に始まったブロックも期間内の分を含む）、期限遵守率、failure demand 比率、破棄件数、WIP 違反件数
- CFD（日別・列別の件数、各日の終わり時点、UTC）

日付の境界は全て UTC です。期間は最長 366 日です。期間内に `done` へ入り、現在も `done` にあるカードを完了として数えます。

### stale

`doing` / `review` にあり、最後のイベントから `staleDays` 日（既定 3）以上経ったカードを `kanban_board_get` が stale として示します。

## 環境変数

| 変数 | 内容 |
|---|---|
| `KANBAN_DB_PATH` | SQLite ファイルのパス。既定は `~/.t3-kanban/<boardId>.db`。相対パスはサーバーの起動ディレクトリ基準で解決されるため、worktree ごとに別のボードになる。共有するなら絶対パスで指定する。`ui` では、`~/.t3-kanban` の外を指す場合に表示対象として自動で登録される |
| `KANBAN_BOARD_ID` | ボード ID。既定は `git rev-parse --git-common-dir` の絶対パスのハッシュ（worktree 間で共通）。git リポジトリでなければカレントディレクトリのハッシュ |
| `KANBAN_THREAD_ID` | ツールの `threadId` 引数を省略したときに使うスレッド ID。`T3CODE_THREAD_ID` より優先 |
| `T3CODE_THREAD_ID` | T3 Code が設定する起動元スレッドの ID。`KANBAN_THREAD_ID` がなければ `threadId` の既定値になる。`kanban_sync` では呼び出し元スレッドとして扱う |
| `T3CODE_CLI_PATH` | T3 Code が設定する T3 CLI のパス。絶対パスが設定されているときだけ T3 CLI を使う |

複数のスレッドのサーバープロセスが同じ DB を同時に使います。書き込みは SQLite の WAL と `BEGIN IMMEDIATE` で直列化し、WIP の確認と移動を 1 トランザクションで行います。
MCP サーバーのログは stderr に出力します。MCP モードの stdout はプロトコル専用です。
