# openclaw-cursor-cli 設計

2026-07-11 作成。
対象環境は Chataclaws-Mac-mini-4.local（macOS、ユーザー `ai`、OpenClaw v2026.6.11 を npm グローバルインストール）。

## 目的

ローカルの cursor-agent CLI を OpenClaw のテキスト推論バックエンドとして使えるようにする。
モデル参照は `cursor-cli/<モデルID>` の形式とし、モデル一覧は `cursor-agent models` の出力から動的に取得する。
認証は cursor-agent のログインセッション（Cursor サブスクリプションの quota）を使う。

## 前提

- cursor-agent v2026.07.09-a3815c0 が `~/.local/bin/cursor-agent`（および同じ実体を指す `~/.local/bin/agent`）にインストール済みで、keitakato@gmail.com としてログイン済み。
- cursor-agent は認証情報を macOS ログインキーチェーンに保存するため、キーチェーンがロックされていると全コマンドが失敗する。
  対策として、ログイン時に `security unlock-keychain` を実行する LaunchAgent `ai.keychain.unlock` を導入済み。
  パスワードファイル `~/.config/keychain-unlock/password` の作成だけが未完了である。
- OpenClaw には **CLI backend plugin** の公式機構がある（`docs/plugins/cli-backend-plugins.md`）。
  プラグインは `api.registerCliBackend()` でバックエンドを、`api.registerModelCatalogProvider()` でモデルカタログを登録する。
  組み込みの claude-cli バックエンド（`extensions/anthropic/`）が実装の手本になる。

## cursor-agent のヘッドレス契約（実機検証済み）

以下は 2026-07-11 に実機で確認した挙動である。

- 基本形は `cursor-agent -p --output-format stream-json --trust` で、プロンプトは stdin から渡せる。
- `--trust` を付けないと、新しい作業ディレクトリで対話式の信頼確認を待ってハングする。
  非対話ラッパーでは必須である。
- stream-json は改行区切り JSON で、イベント型は `system`（subtype `init`）、`user`、`thinking`、`assistant`、`result`。
  すべてのイベントに `session_id` フィールドが付く。
- セッション再開は `--resume <session_id>` で行う。
  再開時に入力トークンが 33,303 から 103 に減り、キャッシュ再利用を確認した。
  `agent ls` と `agent resume`（サブコマンド形式）は TTY 前提でヘッドレスでは使えない。
- セッションの実体は `~/.cursor/chats/<workspace-hash>/<session_id>/` に保存され、workspace-hash は作業ディレクトリから決まる。
  再開は同じ作業ディレクトリ（または `--workspace` 指定）から行う必要がある。
- `agent models` の出力はプレーンテキストのみで、`<ID> - <表示名>` の行が 150 以上並ぶ。
  JSON 出力の手段はない。
- システムプロンプト用のフラグと画像添付フラグは存在しない。
- `-p` モードでは write と shell を含むネイティブツールがデフォルトで有効になる。
  編集を伴わないモードとして `--mode ask` と `--mode plan` がある。
  ツール実行の承認は `approvalMode`（既定 allowlist）に従い、承認プロンプトが出る操作はヘッドレスではハングするため、エージェント用途では `--force` の検討が要る。
- キーチェーンを使わない代替認証として `CURSOR_API_KEY` 環境変数（または `--api-key`）がある。

## 全体方針

二段階で進める。

第一段階では、プラグインを書かずに `openclaw.json` の `agents.defaults.cliBackends` だけで cursor-cli バックエンドを仮組みし、OpenClaw の汎用 jsonl パーサーとの互換性を実機で確認する。
第二段階では、確認結果を反映したプラグイン openclaw-cursor-cli を実装し、設定のみでは実現できない動的カタログとフック処理を足す。

この順にするのは、設定のみで確かめられる互換性の疑問（後述）が三つあり、その答えがプラグインのフック実装の要否を決めるからである。

## 第一段階の設定

`openclaw.json` に以下を追加する。

```json5
agents: {
  defaults: {
    cliBackends: {
      "cursor-cli": {
        command: "/Users/ai/.local/bin/cursor-agent",
        args: ["-p", "--output-format", "stream-json", "--trust"],
        resumeArgs: ["-p", "--output-format", "stream-json", "--trust", "--resume", "{sessionId}"],
        output: "jsonl",
        input: "stdin",
        modelArg: "--model",
        sessionMode: "existing",
        sessionIdFields: ["session_id"],
        serialize: true
      }
    }
  }
}
```

あわせて `cursor-cli/grok-4.5-fast-xhigh` をモデル許可リストに追加し、`openclaw agent --message "reply exactly: backend ok" --model cursor-cli/grok-4.5-fast-xhigh` で疎通を確認する。

この段階で確認する疑問は次の三つである。

1. OpenClaw の jsonl パーサーが cursor-agent のイベント列を正しく読めるか。
   特に `thinking` イベントの無視と、最終 `assistant` メッセージの抽出を確認する。
2. `systemPromptArg` を指定しない場合に、OpenClaw がシステムプロンプトをプロンプト本文へ前置するか。
   前置しないなら、プラグインの `transformSystemPrompt` フックで実装する。
3. セッション再開が OpenClaw のセッション管理（`sessionMode: "existing"` と `sessionIdFields`）で成立するか。
   作業ディレクトリ固定の制約が問題になる場合は、`--workspace` を args に固定で足す。

## 第二段階のプラグイン設計

### パッケージ構成

```
openclaw-cursor-cli/
├── package.json            # openclaw.extensions がエントリを指す
├── openclaw.plugin.json    # id: "cursor-cli", cliBackends: ["cursor-cli"]
├── src/
│   ├── index.ts            # definePluginEntry。registerCliBackend と registerModelCatalogProvider を呼ぶ
│   ├── backend.ts          # CliBackendPlugin の定義（第一段階の設定をデフォルトとして内蔵）
│   └── catalog.ts          # cursor-agent models のパースとカタログ生成
└── test/
```

マニフェストの `cliBackends: ["cursor-cli"]` により、モデル参照 `cursor-cli/...` が現れたときに OpenClaw がプラグインを自動ロードする。

### backend.ts

`buildCursorCliBackend()` が返す `CliBackendPlugin` は次を持つ。

- `config`：第一段階で検証した設定をデフォルト値として内蔵する。
  ユーザー設定 `agents.defaults.cliBackends.cursor-cli` が上書きできる。
- `nativeToolMode: "always-on"`：`-p` モードのネイティブツールが無効化できないことを OpenClaw に伝える。
- `sideQuestionToolMode: "disabled"` と `resolveExecutionArgs` フック：`executionMode === "side-question"` のとき argv を `--mode ask` 付きに差し替え、編集なしの一問一答として実行する。
- システムプロンプト前置（第一段階の確認で必要と判明した場合のみ）：`transformSystemPrompt` フックでプロンプト本文の先頭に埋め込む。
- `liveTest`：`defaultModelRef: "cursor-cli/grok-4.5-fast-xhigh"`、画像プローブと MCP プローブは無効。

`ownsNativeCompaction` は宣言しない。
cursor-agent が自前の transcript 圧縮を持つことを確認できていないためで、OpenClaw 側の safeguard 圧縮に任せる。

### catalog.ts

`registerModelCatalogProvider` の `liveCatalog` で `cursor-agent models` を実行し、`<ID> - <表示名>` 形式の行をパースしてカタログエントリを生成する。

- ヘッダー行、空行、末尾の Tip 行は読み飛ばす。
- 実行失敗（未ログイン、キーチェーンロック、バイナリ不在）に備え、主要モデルの静的リストを `staticCatalog` としてフォールバックに持つ。
- 呼び出しコストを抑えるため、結果を TTL 付き（例: 1 時間）でメモリキャッシュする。
- コンテキストウィンドウなどの詳細メタデータは `agent models` からは得られないため、保守的な既定値を与え、既知の主要モデルだけ個別に上書きする。

### デフォルトモデル

デフォルトモデル参照は `cursor-cli/grok-4.5-fast-xhigh`（表示名 Cursor Grok 4.5 Fast、reasoning effort 最上位の fast 系列）とする。

## 導入手順と環境固有の注意

- この環境の `plugins.allow` は排他的 allowlist であり、`"cursor-cli"` を追記しないとプラグインがロードされない。
  変更後は gateway restart が必要である（hot reload 不可）。
- キーチェーン解錠は LaunchAgent `ai.keychain.unlock` が担う。
  パスワードファイルが未作成のあいだは、再起動後に手動で `security unlock-keychain` を実行する必要がある。
- cursor-agent の実行はサブスクリプション quota を消費する。
  `serialize: true` により同一バックエンドの並列実行を防ぎ、glm-5.2 で起きた同時実行起因の 429 と同種の問題を避ける。
- OpenClaw の MCP ツールブリッジ（`bundleMcp`）は初版では有効にしない。
  cursor-agent が MCP 設定ファイルをどう受け取るかの検証を終えてから判断する。

## 検証計画

1. `openclaw plugins inspect cursor-cli --runtime --json` でプラグインの発見と登録を確認する。
2. `openclaw agent --message "reply exactly: backend ok" --model cursor-cli/grok-4.5-fast-xhigh` で一往復を確認する。
3. 同一セッションで二往復目を送り、`--resume` による再開とコンテキスト維持を確認する。
4. `/model` でのモデル切り替えと、動的カタログの一覧表示を確認する。
5. `/btw`（side question）が `--mode ask` で実行されることを確認する。
6. キーチェーンをロックした状態で呼び出し、エラーがユーザーに分かる形で表面化することを確認する。

## 未決事項

- リポジトリはまずローカル `~/projects/openclaw-cursor-cli` で開発する。
  coo-quack org への公開と npm publish は、動作確認が済んでから判断する。
- 画像入力は cursor-agent 側にフラグがないため対応しない。
- `--force`（コマンド承認の自動許可）を既定 argv に含めるかは、第一段階でツール呼び出しを伴うプロンプトの挙動を見てから決める。
  承認待ちでハングするなら含める必要があるが、shell 実行の自動許可という副作用を伴うため、既定では含めず設定例として文書化する案を第一候補とする。
