# MCP tool bridge investigation (2026-07-11)

Goal: let `cursor-agent` (this plugin's backend) call OpenClaw's loopback MCP
tools (`mcp__openclaw__*`), the same way OpenClaw's built-in claude-cli,
codex-cli, and gemini-cli backends already do.

## How OpenClaw's bundle-MCP mechanism works (dist v2026.6.11)

Source: `dist/helpers-Bzlrrr7P.js` (`prepareCliBundleMcpConfig`,
`prepareCliBundleMcpCaptureAttempt`), `dist/execute.runtime-Cojx2y5g.js`,
`dist/prepare.runtime-BCvXv4o3.js`.

A `CliBackendPlugin` opts in via two static fields:

- `bundleMcp: boolean`
- `bundleMcpMode: "claude-config-file" | "codex-config-overrides" |
  "gemini-system-settings"`

When `bundleMcp` is true and tools aren't disabled for the run, OpenClaw:

1. Ensures a loopback MCP server is running (`ensureMcpLoopbackServer`) and
   resolves its port + a per-session bearer token
   (`resolveMcpLoopbackBearerToken`).
2. Builds an `openclaw` MCP server config entry (url + `Authorization`
   header) and merges it with any bundle-MCP config contributed by other
   loaded plugins (`loadMergedBundleMcpConfig`).
3. Materializes that merged config according to `bundleMcpMode`:
   - `claude-config-file`: writes a real JSON file to a fresh
     `mkdtemp` temp dir (`mcp.json`, shape
     `{ mcpServers: { openclaw: { url, headers } } }`, with
     `${OPENCLAW_MCP_*}` env placeholders already resolved to literal
     values) and injects `--strict-mcp-config --mcp-config <path>` into
     `backend.args`/`backend.resumeArgs`.
   - `codex-config-overrides`: injects `-c mcp_servers=...` TOML overrides
     directly into argv.
   - `gemini-system-settings`: writes a system-level `settings.json` and
     points `GEMINI_CLI_SYSTEM_SETTINGS_PATH` at it via env.
4. This happens *before* `prepareExecution` and *before*
   `resolveExecutionArgs` are called. `resolveExecutionArgs` receives the
   already-mutated `args`/`resumeArgs` as its `baseArgs`.
5. Separately, `prepareCliBundleMcpCaptureAttempt` (called after
   `resolveExecutionArgs`, right before spawn) overlays a per-attempt
   `x-openclaw-cli-capture-key` header into the *same* temp file (for
   claude-config-file mode) or into env (other modes) — used for
   message-tool source-reply capture, not required for basic tool calls.

Crucially: `CliBackendPrepareExecutionContext` (the `prepareExecution` hook's
argument) does **not** carry the MCP server URL/token/config path at all —
only `resolveExecutionArgs`'s `baseArgs` does, and only because the
claude-config-file mode happens to encode it as CLI args. `CliBundleMcpMode`
is a closed 3-value union; a plugin cannot register a 4th mode without
patching OpenClaw core.

## cursor-agent's MCP consumption

`cursor-agent --help` / `cursor-agent mcp --help` (binary at
`~/.local/bin/cursor-agent`, this session's live version):

- No `--mcp-config` or equivalent flag exists.
- MCP servers are read from `.cursor/mcp.json` (workspace) and/or
  `~/.cursor/mcp.json` (global) — same shape as Claude's
  (`{ mcpServers: { <name>: { url, headers, ... } } }`).
- `--approve-mcps` auto-approves all configured MCP servers for a headless
  run (avoids an interactive per-server approval prompt).
- `cursor-agent mcp list` / `mcp enable <id>` / `mcp disable <id>` manage the
  local approved-server list.

## Feasibility verdict: yes, via a shape-translation hack

Since `claude-config-file` mode's injected args are visible to
`resolveExecutionArgs` (just not to `prepareExecution`), the plugin can:

1. Declare `bundleMcp: true`, `bundleMcpMode: "claude-config-file"` purely to
   get OpenClaw to generate the config file and inject
   `--mcp-config <path>` into `baseArgs`.
2. In `resolveExecutionArgs`, read that path, extract `mcpServers.openclaw`,
   write it into `<workspaceDir>/.cursor/mcp.json` (merged with any
   pre-existing file, backed up via `prepareExecution` and restored in its
   `cleanup`), strip the unsupported `--strict-mcp-config`/`--mcp-config`
   flags (cursor-agent would otherwise fail with an unknown-option error),
   and append `--approve-mcps`.

This was implemented in `src/backend.ts` (`applyCursorMcpBridge`,
`prepareCursorCliExecution`), gated behind `OPENCLAW_CURSOR_CLI_MCP_BRIDGE=1`
(default off, read once at plugin registration / gateway start).

Known gap: the per-attempt capture-key overlay
(`prepareCliBundleMcpCaptureAttempt`) runs after `resolveExecutionArgs` and
mutates the *original* temp file (found via the untouched `backend.args`),
not the copy already written to `.cursor/mcp.json`. So the bridge does not
carry the `x-openclaw-cli-capture-key` header through to cursor-agent. This
only affects message-tool source-reply delivery capture, not general MCP
tool availability/execution, and was not exercised by the live test below.

## Live verification (2026-07-11, gateway v2026.6.11)

Setup: `OPENCLAW_CURSOR_CLI_MCP_BRIDGE=1` appended to `~/.openclaw/.env`
(backup: `~/.openclaw/.env.bak-20260711-mcp-bridge`), `openclaw gateway
restart`, confirmed `Runtime: running` / `Connectivity probe: ok`.

Isolated session (`agent:main:cursor-cli-mcp-test2`), model
`cursor-cli/grok-4.5-fast-xhigh`:

> List the names of the MCP tools you have available, then call the one
> that looks like a harmless read-only OpenClaw tool (e.g. a status/
> echo-like tool) and report its raw result.

Result (`status: "ok"`): the model listed the full OpenClaw MCP tool set
(`agents_list`, `browser`, `create_goal`, `cron`, `gateway`, `get_goal`,
`image_generate`, `memory_get`, `memory_search`, `message`, `music_generate`,
`nodes`, `session_status`, `sessions_history`, `sessions_list`,
`sessions_send`, `sessions_spawn`, `sessions_yield`, `skill_workshop`,
`subagents`, `tts`, `update_goal`, `video_generate`, `web_fetch`,
`web_search`) plus the other MCP servers bundled in this environment
(`playwright_browser_*`, `serena_*`), then called `session_status` and
returned its **real** raw output:

```
🦞 OpenClaw 2026.6.11 (e085fa1)
⏱️ Uptime: gateway 1m 8s · system 16d
🧠 Model: cursor-cli/grok-4.5-fast-xhigh
...
🔌 Plugins: OK
```

The turn's `agentMeta.cliSessionBinding.mcpConfigHash` was populated (bundle
MCP config was generated and hashed), confirming the bridge activated.
`.cursor/mcp.json` did not exist after the run (as expected — no
pre-existing file to restore, so `prepareExecution`'s cleanup deleted the
generated one).

Sanity check (bridge enabled, but a plain non-tool turn): a separate session
asked to `reply exactly: mcp-off ok` returned exactly `mcp-off ok` — normal
operation is unaffected by the bridge being enabled.

**Conclusion: working, not partial.** Tools were both listed and
successfully called with a real result.

## Post-verification state

- Gateway: healthy (`Runtime: running`, `Connectivity probe: ok`) after all
  test runs.
- Feature flag left enabled (`OPENCLAW_CURSOR_CLI_MCP_BRIDGE=1`) in
  `~/.openclaw/.env` since it is proven working and default-off for anyone
  who hasn't opted in — no config edits beyond the `.env` line were made
  (`agents.defaults.model`/`zai` entries untouched).
