# MCP ブリッジのセキュリティ検討 引き継ぎメモ

2026-07-12 作成。openclaw-cursor-cli の MCP ツールブリッジについて、「機能を保ったまま危険なツールだけ塞ぐ」ことを試み、**現行の cursor-agent では不可能**と結論した調査の記録。

## 現在の状態（意図的にこの構成）

- MCP ブリッジ **有効**（`~/.openclaw/.env` に `OPENCLAW_CURSOR_CLI_MCP_BRIDGE=1`）
- cursor-agent の argv: `-p --output-format stream-json --trust --force`（プラグイン既定）
- `~/.cursor/cli-config.json`: `approvalMode: "unrestricted"`、`permissions.allow = ["Shell(**)","Read(**)","Write(**)","Mcp(**)"]`、`deny` は空
- 結果として cursor-cli 経由のターンは、シェル・ファイル操作・OpenClaw の全 MCP ツール（25 個）を承認なしで実行できる

安全対策は**未実装**。ユーザーが別途検討する方針（2026-07-12 時点の判断）。

## 公開されている OpenClaw MCP ツール（25）

読み取り系（11）：`agents_list` / `get_goal` / `memory_get` / `memory_search` / `session_status` / `sessions_history` / `sessions_list` / `web_fetch` / `web_search` / `gateway` / `nodes`

副作用あり（14）：`message`（メッセージ送信）/ `cron`（ジョブ作成・削除）/ `browser`（ログイン済みブラウザ操作）/ `skill_workshop`（スキル改変）/ `sessions_send`（他セッションへ指示）/ `sessions_spawn`・`subagents`（別モデルへ委譲）/ `sessions_yield` / `create_goal` / `update_goal` / `image_generate` / `music_generate` / `video_generate` / `tts`

`sessions_spawn` と `subagents` があるため、**cursor から glm など他モデルへサブエージェント委譲が可能**（ユーザーが望んだ機能）。

## 試して駄目だった対策

### 1. cursor-agent の deny リスト（`~/.cursor/cli-config.json` の `permissions.deny`）

書式自体は実在する：`Mcp(<server>:<tool>)`、glob 対応・大小無視。判定は `matchesMcpEntry` → `matchesMcpPattern` で行われ、`shouldBlockMcp` の**最初**に評価される（approvalMode より先）。サーバー名はブリッジが書く `.cursor/mcp.json` のキー `openclaw` で正しい。

**しかし効かない。** 呼び出し側がこうなっているため：

```js
const r = !t.skipApproval && await n.permissionsService.shouldBlockMcp(e, t);
```

`skipApproval` が立つと deny 判定に到達しない。そして MCP ツールを使うには `--approve-mcps` が必要で、これが `skipApproval` を立てる。

実測（すべてライブ検証済み）：

| argv | MCP ツール | deny の効果 |
|---|---|---|
| `--force --approve-mcps`（既定） | 使える | 効かない（`cron` 実行成功） |
| `--approve-mcps` のみ（force 無し） | 使える | 効かない（同上） |
| どちらも無し | **読み込まれない**（cursor が「openclaw のツールが見当たらない」と報告） | 判定以前の問題 |

つまり「MCP ツールが使える状態」と「deny が効く状態」は排他。cursor-agent 側では両立できない。

### 2. OpenClaw の `tools.byProvider` deny

`~/.openclaw/openclaw.json` に以下を入れて gateway 再起動：

```json5
tools: { byProvider: { "cursor-cli": { deny: ["message","cron","browser","skill_workshop","sessions_send"] } } }
```

**効かない。** cursor からは 25 ツール全部が見えたままで、`cron` の実行も成功した。この機構は OpenClaw 自身のネイティブツールループには効くが、CLI バックエンドへブリッジされるループバック MCP のツール面には適用されない模様（要 OpenClaw 側の裏取り）。

## 残る選択肢（未実装）

### A. バックエンド 2 本立て（推奨、実装容易）

プラグインに 2 つ登録する：

- `cursor-cli/*` … `bundleMcp` 無し。テキスト応答専用（安全な既定）
- `cursor-mcp/*` … `bundleMcp: true` + ブリッジ有効。OpenClaw ツール込み

`bundleMcp` は `CliBackendPlugin` の静的プロパティなので、backend id ごとに値を変えた 2 回の `registerCliBackend` で実現できる。使う側は `/model cursor-mcp/grok-4.5-fast-xhigh` と明示したときだけツールが付く。**常時オンのリスクを消しつつ、必要時に全機能（サブエージェント委譲含む）を取り出せる。**

環境変数によるグローバルなオン/オフ（現行方式）を、モデル参照によるオプトインに置き換える形。

### B. OpenClaw 側でループバック MCP のツール面を絞る

本来はここが正しい防御層（cursor 側のフラグでは迂回できないため）。ただし現行 v2026.6.11 では `tools.byProvider` が効かないことが分かっているので、OpenClaw の実装調査か upstream への機能要望が必要。

### C. シェル面の縮小

ブリッジとは独立の話だが、`--force` により cursor はホスト上で任意のシェルコマンドを実行できる。`--mode ask`（編集なし）や sandbox 有効化と組み合わせれば「OpenClaw ツールは使えるが破壊的なローカル操作はできない」構成を狙えるが、ヘッドレスで承認待ちハングを起こさないかの検証が必要。

## 参考: 調査に使ったコマンド

```bash
# cursor-agent バンドル内の権限判定ロジック
V=$(ls -t ~/.local/share/cursor-agent/versions/ | head -1)
grep -o "isMcpExplicitlyDenied[^;]\{0,200\}" ~/.local/share/cursor-agent/versions/$V/index.js
# → shouldBlockMcp / matchesMcpPattern / skipApproval の呼び出し関係を確認

# ブリッジが生成する MCP 設定（サーバー名の確認）
jq 'keys' ~/.openclaw/workspace/.cursor/mcp.json

# ライブ検証（隔離セッション）
openclaw agent --session-key "agent:main:mcp-probe" \
  --message "list every MCP tool you can see; then try openclaw:cron (list) and report EXECUTED or BLOCKED" \
  --model cursor-cli/grok-4.5-fast-xhigh --json
```

## バックアップ（この調査中に作成）

- `~/.cursor/cli-config.json.bak-20260712-predeny`（deny 追加前）
- `~/.cursor/cli-config.json.bak-20260712-unrestricted`（無制限化前 = セッション前の allowlist 状態）
- `~/.openclaw/openclaw.json.bak-20260712-noforce`、`~/.openclaw/.env.bak-20260712-bridge-off`

なお `~/.cursor/cli-config.json` は本セッション中の作業で `allowlist` + `Shell(ls)` から `unrestricted` + 全許可に変更されている（cursor がツールを使えるようにするため）。安全対策を入れる際はここも見直し対象。
