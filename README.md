# openclaw-cursor-cli

An OpenClaw plugin that runs Cursor's `cursor-agent` CLI as an OpenClaw text
inference backend, exposed as `cursor-cli/<model>` (for example
`cursor-cli/grok-4.5-fast-xhigh`).

It registers:

- A **CLI backend** (`cursor-cli`) that shells out to `cursor-agent -p
  --output-format stream-json --trust --force`, supports session resume via
  `--resume {sessionId}`, and strips/handles side-question style invocations.
  `--force` auto-approves `cursor-agent`'s command execution so it never emits
  an interactive approval prompt (which would hang a headless/chat-driven
  run); confirmation of risky/destructive actions is instead delegated to
  prompt-level guidance in the workspace `AGENTS.md` (the agent is expected to
  describe the action in a reply and wait for explicit approval before
  executing it, rather than relying on a CLI-level confirmation prompt).
- A **model catalog provider** that lists Cursor's available models. It
  prefers a live catalog (`cursor-agent models`, cached for 1 hour) and falls
  back to a small static list of five well-known models if the live call
  fails.

## Install

Once published, install the plugin from npm:

```bash
openclaw plugins install npm:@coo-quack/openclaw-cursor-cli
openclaw gateway restart
```

Until then (or for local development), install from the plugin's working
copy using OpenClaw's `--link` mode (recommended during development so edits
to `src/` are picked up without reinstalling):

```bash
cd ~/projects/openclaw-cursor-cli
openclaw plugins install --link .
openclaw gateway restart
```

Either method records the plugin as installed and also adds `cursor-cli` to
`plugins.allow` in `~/.openclaw/openclaw.json` automatically.

### `plugins.allow` caveat

`plugins.allow` is an **exclusive allowlist** — if it's set, only the plugin
IDs listed in it are loaded. If you're editing config by hand (rather than
letting `plugins install --link` do it), make sure you **append** `cursor-cli`
to the existing array instead of replacing it, or every other plugin
(channels, providers, etc.) will silently stop loading on the next restart.

```jsonc
{
  "plugins": {
    "allow": ["zai", "imessage", "browser", "memory-core", "google", "elevenlabs", "cursor-cli"]
  }
}
```

## Configuration

### Command override (non-PATH installs)

The plugin's built-in backend definition assumes `cursor-agent` is reachable
on the gateway process's `PATH`. If it isn't (e.g. installed under
`~/.local/bin`, which is common when the gateway runs as a LaunchAgent with a
minimal `PATH`), override just the `command` field — the rest of the backend
definition (args, resume args, session handling, JSON dialect) comes from the
plugin's defaults and does not need to be repeated:

```jsonc
{
  "agents": {
    "defaults": {
      "cliBackends": {
        "cursor-cli": {
          "command": "/Users/ai/.local/bin/cursor-agent"
        }
      }
    }
  }
}
```

### Default / allowed model

To make a Cursor model selectable (e.g. via `--model` or `/model`), add it to
`agents.defaults.models`:

```jsonc
{
  "agents": {
    "defaults": {
      "models": {
        "cursor-cli/grok-4.5-fast-xhigh": {}
      }
    }
  }
}
```

`cursor-cli/grok-4.5-fast-xhigh` is the recommended default: fast, cheap on
Cursor's subscription quota, and good enough for most day-to-day agent turns.

To add other Cursor models (e.g. `cursor-cli/grok-4.5-xhigh`,
`cursor-cli/claude-sonnet-5-thinking-high`, `cursor-cli/gpt-5.3-codex`,
`cursor-cli/auto`), add each id as its own key the same way — an empty `{}`
is sufficient; **`contextWindow` is not a valid field on these entries**
(`agents.defaults.models.<id>` is validated against a strict schema that
only allows `alias`, `params`, `agentRuntime`, and `streaming` — adding
`contextWindow` there is rejected by `openclaw models list` with an `Invalid
input` schema error). Per-model context windows are supplied automatically
instead — see below.

#### Per-model context windows

Context window is **not** a flat default anymore. `src/catalog.ts` exports
`resolveCursorContextWindow(id)`, which maps a Cursor model id prefix to its
published context window, and `buildCursorCliCatalogEntries` uses it for
every catalog entry:

| Model id prefix | Context window | Source |
|---|---|---|
| `grok-4.5*` | 500,000 | [OpenRouter Grok 4.5](https://openrouter.ai/x-ai/grok-4.5), [llmreference Grok 4.5](https://www.llmreference.com/model/grok-4.5) |
| `claude-sonnet-5*` | 200,000 | [cursor.com/docs/models/claude-sonnet-5](https://cursor.com/docs/models/claude-sonnet-5) — Cursor's standard/non-max serving cap (expandable to 1M in Cursor's Max Mode, not modeled here) |
| `gpt-5*` | 400,000 | [OpenAI GPT-5 family model docs](https://developers.openai.com/api/docs/models/gpt-5.3-codex) |
| everything else (including `auto`) | 200,000 (`DEFAULT_CONTEXT_WINDOW`) | conservative default; `auto` delegates to a model chosen per-request by Cursor, so no single published window applies |

This mapping is consulted in two places:

- The existing `registerModelCatalogProvider` runtime catalog (unchanged
  behavior, still not consumed by `openclaw models list`/`/model` as of
  v2026.6.11 — see "Known limitations" below).
- A second, separate **provider plugin** registration (`api.registerProvider`
  with id `"cursor"`, distinct from the `"cursor-cli"` CLI backend id) whose
  `augmentModelCatalog` hook returns these same per-model entries. This is
  the same mechanism OpenClaw's built-in `"anthropic"` provider plugin uses
  to give its `claude-cli/*` catalog rows per-model `contextWindow` values,
  and it *is* wired into `models list --all`'s full-discovery path (unlike
  the legacy `registerModelCatalogProvider` hook).

Since context window still cannot be set via `agents.defaults.models.<id>`,
if a model's real window changes upstream, update the mapping in
`resolveCursorContextWindow` (`src/catalog.ts`) rather than in config.

## Requirements

- `cursor-agent` installed and **logged in** (`cursor-agent login`).
- The macOS login keychain must be **unlocked** for `cursor-agent` to read its
  stored credentials. On a headless Mac (no one logged in at the console, or
  running under a LaunchAgent before login), the keychain stays locked and
  `cursor-agent` calls will fail with auth errors.
  - This host uses an `ai.keychain.unlock` LaunchAgent
    (`~/Library/LaunchAgents/ai.keychain.unlock.plist`, `RunAtLoad`) that runs
    `~/.local/bin/unlock-login-keychain.sh` to unlock the keychain
    automatically after boot/login. If you're setting this plugin up on a new
    headless macOS host, you need an equivalent mechanism, or `cursor-agent`
    calls will start failing after a reboot with no obvious plugin-side error.

## Known limitations

- **No native system-prompt flag.** `cursor-agent`'s `-p` mode does not accept
  an injected system prompt per call (`systemPromptWhen: "never"` in the
  backend definition). OpenClaw-mediated **fresh** turns prepend a short
  `[OpenClaw runtime]` banner to stdin via a wrapper (`src/cursor-agent-wrapper.ts`)
  so the model knows it is running through OpenClaw and should follow workspace
  norms (`AGENTS.md`, `SOUL.md`, …) plus OpenClaw MCP tools. Resume turns do
  not re-inject the banner. Bare `cursor-agent` outside OpenClaw is unaffected.
  Longer persona text still belongs in the workspace's `AGENTS.md`, which
  `cursor-agent` reads directly.
- **No image input.** The backend is text-only; multimodal turns are not
  supported through this plugin.
- **Subscription quota applies.** Usage goes through the same Cursor
  subscription quota as interactive use of `cursor-agent`/Cursor; there is no
  separate API billing path.
- **`openclaw models list` does not surface the dynamic catalog, and neither
  does anything else in OpenClaw v2026.6.11.** The CLI's `models
  list`/`models list --all` commands read from each plugin's declarative
  manifest metadata (`openclaw.plugin.json`), not from the runtime
  `registerModelCatalogProvider` call in `src/index.ts`. Since this plugin
  doesn't declare a static `modelCatalog` block in its manifest, only models
  explicitly added to `agents.defaults.models` show up in that listing. The
  runtime catalog provider is registered for forward compatibility with
  OpenClaw's unified catalog, but as of v2026.6.11 no code path — including
  in-session model resolution or `/model` switching — actually consumes it.
  In-session model refs (`--model cursor-cli/<id>`, `/model cursor-cli/<id>`)
  work simply because the model id string is passed straight through to
  `cursor-agent --model <id>`, gated only by the `agents.defaults.models`
  allowlist. To make a new Cursor model usable, add an entry for it under
  `agents.defaults.models` — the dynamic catalog does not do this for you.

## OpenClaw MCP tool bridge (experimental)

`cursor-agent` can be given access to OpenClaw's own loopback MCP tool
surface (`mcp__openclaw__*` — session status, cron, memory search, message
sending, subagent spawning, plus any other MCP servers OpenClaw bundles for
CLI backends, such as Playwright/Serena if configured). This is **off by
default** and verified working as of 2026-07-11 against gateway v2026.6.11.

### How it works

OpenClaw's CLI runner has a "bundle MCP" mechanism used by its claude-cli,
codex-cli, and gemini-cli backends: when a backend opts in, OpenClaw spins up
a loopback MCP server and writes its URL + bearer token into a
backend-specific shape before each run. `cursor-agent` has no equivalent CLI
flag — it only reads MCP servers from `.cursor/mcp.json` in the workspace (or
`~/.cursor/mcp.json`) and needs `--approve-mcps` to auto-approve them
headlessly. This plugin opts into the `claude-config-file` bundle mode (which
produces a throwaway `--strict-mcp-config --mcp-config <path>` pair pointing
at a generated `{ mcpServers: { openclaw: { url, headers } } }` file) purely
as a vehicle to obtain that config, then in `resolveExecutionArgs`:

1. reads the generated temp config,
2. merges its `openclaw` server entry into the workspace's
   `.cursor/mcp.json` (preserving any servers already configured there,
   which are backed up beforehand and restored via `prepareExecution`'s
   cleanup once the run finishes),
3. strips the unsupported `--strict-mcp-config`/`--mcp-config` flags, and
4. adds `--approve-mcps` so the new server isn't blocked on an interactive
   approval prompt.

### Enabling it

```bash
echo "OPENCLAW_CURSOR_CLI_MCP_BRIDGE=1" >> ~/.openclaw/.env
openclaw gateway restart
```

The flag is read once at plugin registration (gateway process start), so it
requires a full restart — `openclaw secrets reload` is not enough.

### Security caveat

Enabling this gives `cursor-agent` — and therefore whatever model is running
behind it — full access to OpenClaw's tool surface for the current session:
sending messages, spawning subagents, searching memory, browser automation,
etc. Only enable it for cursor-cli models you trust with that surface, and be
aware `--approve-mcps` means there is no per-server confirmation step.

See `docs/notes/2026-07-11-mcp-bridge-investigation.md` for the full
investigation and the live verification transcript.

## Development

`openclaw` is not a `package.json` dependency of this repo (it's expected to
be installed globally / linked at runtime). For local typecheck to resolve
`openclaw/plugin-sdk/*` imports, link it into `node_modules`:

```bash
npm link openclaw
npm run typecheck
npm test
```

Linting, formatting, and import ordering use [Biome](https://biomejs.dev/):

```bash
npm run lint          # lint only
npm run format:check  # format/import-order check only (no writes)
npm run fix           # auto-fix lint, format, and import order in place
```

To run typecheck, lint, format check, and the test suite together in one go:

```bash
npm run check
```

Note: `npm install` may prune the `openclaw` symlink from `node_modules`
(since it's not a declared dependency). If `npm run typecheck` or `npm run
check` fails to resolve `openclaw/plugin-sdk/*` imports after an install,
re-run `npm link openclaw`.
