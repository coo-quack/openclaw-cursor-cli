# openclaw-cursor-cli

[![npm version](https://img.shields.io/npm/v/@coo-quack/openclaw-cursor-cli)](https://www.npmjs.com/package/@coo-quack/openclaw-cursor-cli)
[![CI](https://github.com/coo-quack/openclaw-cursor-cli/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/coo-quack/openclaw-cursor-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Use your Cursor subscription as an OpenClaw inference backend.** Grok, Claude,
and GPT models through the `cursor-agent` CLI you already have — no extra API
key, no separate bill.

If you pay for Cursor, you are already paying for model access. This plugin
points OpenClaw at that same `cursor-agent` binary, so agent turns run on your
existing subscription quota instead of a second provider account.

### Quick Start

```bash
# 1. cursor-agent must be installed and logged in
cursor-agent login

# 2. Install the plugin
openclaw plugins install npm:@coo-quack/openclaw-cursor-cli
openclaw gateway restart
```

Then allow the model you want — one entry under `agents.defaults.models`, see
[Allowing a model](#allowing-a-model) — and use it:

```bash
openclaw agent \
  --session-key agent:main:demo \
  --model cursor-cli/grok-4.5-high-fast \
  --message "hello"
```

In an existing chat session, `/model cursor-cli/grok-4.5-high-fast`
switches to it and nothing else changes.

---

## Two backends, one plugin

The plugin registers two backend ids. They run the identical `cursor-agent`
command; the only difference is whether OpenClaw's own tools are handed to the
model.

| | `cursor-cli/<model>` | `cursor-mcp/<model>` |
|---|---|---|
| Text inference | ✅ | ✅ |
| Session resume | ✅ | ✅ |
| Same model catalog | ✅ | ✅ |
| OpenClaw MCP tools | ❌ none | ✅ full surface |
| Use it for | everything, by default | sessions you trust with tool access |

There is no global switch. You opt in per session by choosing the model ref —
`/model cursor-mcp/grok-4.5-high-fast` — and every other session stays
text-only. See [OpenClaw MCP tool bridge](#openclaw-mcp-tool-bridge) for what
that surface includes and why it deserves a deliberate choice.

## Models

Five models ship in the plugin's catalog. Any other id `cursor-agent` accepts
works too — ids are passed straight through — it just will not appear in
`openclaw models list`.

| Model id | Context | Good for |
|---|---|---|
| `grok-4.5-high-fast` | 256k | **The recommended default.** Fast, cheap on quota, fine for most turns |
| `grok-4.5-high` | 256k | Same model, more reasoning effort |
| `claude-sonnet-5-thinking-high` | 200k | Careful work where Claude's style helps |
| `gpt-5.3-codex` | 272k | Code-heavy turns |
| `auto` | 200k | Let Cursor pick per request |

Prefix each with the backend id you want: `cursor-cli/gpt-5.3-codex`,
`cursor-mcp/gpt-5.3-codex`.

Grok is the one id that differs between OpenClaw and the CLI: `cursor-agent`
lists it as `cursor-grok-4.5-*`, and this plugin exposes it to OpenClaw
without the redundant `cursor-` prefix (`grok-4.5-*`), restoring the prefix
when it invokes the CLI. Use the short form in OpenClaw config.

<details>
<summary>Where these context windows come from</summary>

Every figure is the **"Default Context" column of Cursor's own model table**
([cursor.com/docs.md](https://cursor.com/docs.md)) — what Cursor actually
serves, not the vendor's headline number. The two differ often enough to
matter: Grok 4.5 is a 500k model upstream but Cursor serves 256k, and the "1M"
in a name like "Sonnet 5 1M" is the Max Mode ceiling rather than the default.
Max Mode is a per-request mode this plugin never selects, so quoting its
ceiling would over-declare the window for every ordinary turn.

Resolution is by id prefix, in `resolveCursorContextWindow` (`src/catalog.ts`):

| Prefix | Window |
|---|---|
| `cursor-grok-4.5*` (and OpenClaw's short `grok-4.5*`) | 256,000 |
| `claude-opus-5*`, `claude-opus-4-8*`, `claude-fable-5*` | 300,000 |
| `claude-sonnet-5*` | 200,000 |
| `gpt-5*` | 272,000 |
| `kimi-k2.7*` | 262,000 |
| everything else, including `auto` | 200,000 |

Context window cannot be set through `agents.defaults.models.<id>` — that key
is validated against a strict schema allowing only `alias`, `params`,
`agentRuntime` and `streaming`. If a window changes upstream, update the
mapping in `src/catalog.ts`.

</details>

> **Upgrading from an early version?** `grok-4.5-fast-xhigh` and
> `grok-4.5-fast-high` no longer exist. `cursor-agent` renamed them to
> `cursor-grok-4.5-high-fast` and `cursor-grok-4.5-high`, which this plugin
> exposes to OpenClaw as `grok-4.5-high-fast` and `grok-4.5-high`. The old
> ones simply fail to resolve — rename them in your config. No alias is
> provided, because the old names are not models `cursor-agent` knows about.

## Install

### From npm

```bash
openclaw plugins install npm:@coo-quack/openclaw-cursor-cli
openclaw gateway restart
```

### From a working copy

`--link` picks up edits to `src/` without reinstalling, which is what you want
while developing:

```bash
git clone https://github.com/coo-quack/openclaw-cursor-cli.git
cd openclaw-cursor-cli
openclaw plugins install --link .
openclaw gateway restart
```

Either way, `cursor-cli` is added to `plugins.allow` in
`~/.openclaw/openclaw.json` for you.

> **Editing `plugins.allow` by hand?** It is an *exclusive* allowlist: once
> set, only the listed plugin ids load. **Append** `cursor-cli` to the existing
> array rather than replacing it, or every other plugin silently stops loading
> on the next restart.

## Configuration

### Allowing a model

Being in the catalog is not the same as being usable. Add the model refs you
want under `agents.defaults.models`:

```jsonc
{
  "agents": {
    "defaults": {
      "models": {
        "cursor-cli/grok-4.5-high-fast": {}
      }
    }
  }
}
```

An empty `{}` is enough. Add the `cursor-mcp/` equivalent only if that session
needs OpenClaw's tools:

```jsonc
{
  "agents": {
    "defaults": {
      "models": {
        "cursor-cli/grok-4.5-high-fast": {},
        "cursor-mcp/grok-4.5-high-fast": {}
      }
    }
  }
}
```

Shorter names are available through `alias`:

```jsonc
"cursor-cli/grok-4.5-high-fast": { "alias": "grok" }
```

### `cursor-agent` is not on PATH

Common when the gateway runs as a LaunchAgent with a minimal `PATH`. Override
only the `command`; everything else comes from the plugin's defaults:

```jsonc
{
  "agents": {
    "defaults": {
      "cliBackends": {
        "cursor-cli": { "command": "/Users/you/.local/bin/cursor-agent" },
        "cursor-mcp": { "command": "/Users/you/.local/bin/cursor-agent" }
      }
    }
  }
}
```

The two backend ids have separate blocks. Override only the one you use.

## OpenClaw MCP tool bridge

Choosing `cursor-mcp/<model>` gives the model OpenClaw's own tool surface for
that session: session status, cron, memory search, sending messages, spawning
subagents, browser automation, and any other MCP servers OpenClaw bundles for
CLI backends.

`cursor-agent` has no flag for this — it reads MCP servers from
`.cursor/mcp.json` in the workspace. So the bridge merges OpenClaw's loopback
server into that file for the duration of the run, adds `--approve-mcps` so
nothing waits on an interactive prompt, and restores the file afterwards.
Servers you already had are preserved.

> [!WARNING]
> **This is a real grant of capability.** The model can send messages, spawn
> subagents and drive a browser on your behalf, with no per-server
> confirmation step. Use `cursor-mcp/<model>` only for sessions you trust with
> that, and keep `cursor-cli/<model>` as the default everywhere else.
>
> While a bridged run is in flight, the loopback server's URL and **bearer
> token** sit in the workspace's `.cursor/mcp.json`. Anyone who can read that
> file during the run — a concurrent process in the same workspace, or any
> local user who can traverse the workspace path — can reach the tool server
> with them, so the backend split is not isolation between concurrent runs in
> the same directory. The bridge writes the file mode `0600` when it creates
> it, but an existing `mcp.json` keeps whatever permissions it already has.

To enable, allow `cursor-mcp/<model>` as shown above and select it for the
session — `/model cursor-mcp/grok-4.5-high-fast`. No env var, no extra
restart.

📖 **[Full bridge documentation](docs/mcp-bridge.md)** — how the merge works,
the six situations where it declines, what happens to a leftover file if the
gateway dies mid-run, and why the `openclaw` server name is reserved.

<details>
<summary>Migrating from <code>OPENCLAW_CURSOR_CLI_MCP_BRIDGE</code></summary>

Earlier versions used one `cursor-cli` backend and a global
`OPENCLAW_CURSOR_CLI_MCP_BRIDGE=1` environment variable that turned the bridge
on for *every* session at once. That variable is **removed** and is no longer
read. If it is still set when the gateway starts, the plugin logs one warning
pointing at `cursor-mcp/<model>` and otherwise ignores it. Move the affected
sessions to `cursor-mcp/<model>` and delete the line from `~/.openclaw/.env`.

</details>

## Requirements

- **`cursor-agent` installed and logged in** (`cursor-agent login`).
- **An active Cursor subscription.** Turns consume the same quota as
  interactive use; there is no separate API billing path.
- **On macOS, an unlocked login keychain.** `cursor-agent` reads its
  credentials from there. On a headless Mac — nobody logged in at the console,
  or the gateway starting as a LaunchAgent before login — the keychain stays
  locked and every call fails with an auth error that says nothing about the
  keychain. If you run headless, arrange to unlock it at boot; without that,
  calls start failing after a reboot with no obvious plugin-side cause.
- **No runtime tool allowlists.** OpenClaw runs that carry a runtime
  `toolsAllow` list (for example cron jobs configured with a tool allow-list)
  are rejected by the gateway before launch for CLI backends:
  `CLI backend cursor-mcp cannot enforce runtime toolsAllow; use an embedded
  runtime for restricted tool policy`. Any job or session that may run on —
  or fall back to — `cursor-cli`/`cursor-mcp` must therefore be configured to
  run with all tools allowed (no `toolsAllow`). If tool restriction is wanted,
  it has to live on the Cursor side (`cursor-agent`'s own permission
  configuration), which OpenClaw neither verifies nor enforces.

## Known limitations

- **Text only.** No image input; multimodal turns are not supported.
- **No per-call system prompt.** `cursor-agent -p` does not accept one. Fresh
  turns get a short `[OpenClaw runtime]` banner prepended to stdin so the model
  knows where it is running; resumed turns do not repeat it. Longer persona
  text belongs in the workspace's `AGENTS.md`, which `cursor-agent` reads
  directly.
- **`openclaw models list` shows the five catalog models, not Cursor's live
  list.** Listing commands build the catalog read-only and skip the plugin's
  runtime hooks, so what they read is the static block in
  `openclaw.plugin.json`. A model Cursor adds later will not appear until the
  manifest is updated — but you can still *use* it by adding it to
  `agents.defaults.models`. Verified against OpenClaw v2026.7.1.

## Development

```bash
corepack enable pnpm   # provisions the version packageManager pins
pnpm install
pnpm run check         # typecheck + lint + format + tests
```

| Command | What it does |
|---|---|
| `pnpm test` | Unit tests (`node --test`) |
| `pnpm run typecheck` | `tsc --noEmit` |
| `pnpm run lint` | Biome |
| `pnpm run fix` | Auto-fix lint, format and import order |
| `pnpm run test:integration:docker` | Integration suite in the image CI uses |

There is no build step: TypeScript sources ship as-is and Node strips the types
at runtime. `openclaw` is an optional peer dependency the gateway provides, but
pnpm installs it locally anyway, which is what lets `tsc` and the tests resolve
`openclaw/plugin-sdk/*`. Nothing needs linking by hand.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the integration suite, the Node
version floor, and the branching model.

## License

MIT
