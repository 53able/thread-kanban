<img src="assets/icon.svg" width="64" height="64" alt="">

# thread-kanban

T3 Code で複数のスレッドを並行して進めるとき、どの作業がレビュー待ちで、どれが止まっているかをブラウザで確認できます。スレッドを 1 枚のカードとして登録し、同じ Git リポジトリの worktree を 1 枚のボードで管理します。

T3 Code のスレッドでエージェントにカードの登録を頼み、ブラウザでカードを移動すると、その結果をエージェントも読み取れます。両方とも同じ SQLite データベースを使い、列ごとの仕掛かり件数（WIP）の上限に従います。

## 導入

Node.js 22.13 以上、npm、Git が必要です。初回は `npx` が GitHub からパッケージを取得してビルドします。npm 12 以降で Git からの取得を許可するため、以下の例では `--allow-git=root` を指定しています。

### 最初のカードをボードで確認する

GitHub から取得する版は MCP と UI でそろえてください。PR #1 の Web UI を試す場合は、以下の起動コマンドと MCP 設定例の両方で `github:53able/thread-kanban` を `github:53able/thread-kanban#dd09ff973a62c2f477e6c2470903935de3732868` に置き換えます。

1. 利用するエージェントに合わせて MCP サーバーを登録します。[Claude Code の設定](#claude-code)・[Codex の設定](#codex)
2. T3 Code で作業中のスレッドを開き、「`kanban_card_add` でこのスレッドを『リリース準備』というタイトルで登録して」と頼みます。初めて登録したカードは `inbox` に入ります。
3. 同じプロジェクトのディレクトリで、次のコマンドを実行します。

   ```sh
   npx -y --allow-git=root github:53able/thread-kanban ui --open
   ```

4. ブラウザで「リリース準備」を選び、「移動先…」から `ready` に移します。スレッドで「`kanban_board_get` でリリース準備がどの列にあるか確認して」と頼み、`ready` と返れば動作確認は完了です。

### Claude Code

すべてのプロジェクトで使う場合:

```sh
claude mcp add --scope user thread-kanban -- npx -y --allow-git=root github:53able/thread-kanban
```

プロジェクト単位で使う場合は、そのプロジェクトの `.mcp.json` に追加します。

```json
{
  "mcpServers": {
    "thread-kanban": { "command": "npx", "args": ["-y", "--allow-git=root", "github:53able/thread-kanban"] }
  }
}
```

T3 Code の Claude スレッドはプロジェクトの `.mcp.json` を読み込みます（ツールが `mcp__thread-kanban__*` という名前で見える）。Codex スレッドでは確認していないため、下記の設定で登録してください。

### Codex

`~/.codex/config.toml` に追加します。

```toml
[mcp_servers.thread-kanban]
command = "npx"
args = ["-y", "--allow-git=root", "github:53able/thread-kanban"]
```

ボードの保存先は起動したプロジェクト（git の common dir）で決まるので、worktree をまたいでも同じボードを読み書きします。

## ドキュメント

- [Web UI](docs/web-ui.md) — 起動、カードの操作、キーボード操作、認証
- [MCP リファレンス](docs/mcp.md) — ツール、エラーコード、列のポリシー、環境変数
- [T3 Code 連携](docs/t3-code.md) — スレッドとの同期、完了状態の反映、エージェント向け運用指示

## 開発

```sh
git clone https://github.com/53able/thread-kanban.git
cd thread-kanban
npm install        # prepare でビルドも実行される
npm test           # vitest（ビルドも実行される）
npm run typecheck  # tsc --noEmit
```

このリポジトリの `.mcp.json` は開発用で、ビルド済みの `dist/index.js` を起動します。

## ライセンス

MIT。[LICENSE](LICENSE) を参照してください。

Created in [T3 Code](https://t3.codes).
