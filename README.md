# openclaw-cursor-cli

An OpenClaw plugin that runs Cursor's `cursor-agent` CLI as an OpenClaw text
inference backend, exposed as two backend ids:

- `cursor-cli/<model>` (for example `cursor-cli/cursor-grok-4.5-high-fast`) — the
  safe, **text-only** default. No OpenClaw tools are exposed to the model.
- `cursor-mcp/<model>` (for example `cursor-mcp/cursor-grok-4.5-high-fast`) — same
  underlying `cursor-agent` invocation, plus OpenClaw's MCP tool bridge
  (session status, cron, memory search, message sending, subagent spawning,
  etc. — see "OpenClaw MCP tool bridge" below). Selecting this backend id is
  the *only* way to opt in; there is no global toggle.

Both backend ids share the same `cursor-agent` argv, session handling, and
model catalog — only whether OpenClaw's MCP tools are bridged in differs.
Pick `cursor-mcp/<model>` explicitly (via `--model`/`/model`) only for
sessions where you want the model to have that tool access; use
`cursor-cli/<model>` everywhere else.

It registers:

- Two **CLI backends**, `cursor-cli` and `cursor-mcp`, that both shell out to
  `cursor-agent -p --output-format stream-json --trust --force`, support
  session resume via `--resume {sessionId}`, and strip/handle side-question
  style invocations. `--force` auto-approves `cursor-agent`'s command
  execution so it never emits an interactive approval prompt (which would
  hang a headless/chat-driven run); confirmation of risky/destructive actions
  is instead delegated to prompt-level guidance in the workspace `AGENTS.md`
  (the agent is expected to describe the action in a reply and wait for
  explicit approval before executing it, rather than relying on a CLI-level
  confirmation prompt). Only `cursor-mcp` additionally bundles OpenClaw's MCP
  tool bridge (`bundleMcp: true`); `cursor-cli` never does.
- A **model catalog provider**, registered once per backend id, that lists
  Cursor's available models. It prefers a live catalog (`cursor-agent
  models`, cached for 1 hour) and falls back to a small static list of five
  well-known models if the live call fails. The model list is identical for
  both backend ids — only the `provider` tag on each catalog entry differs.

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

The plugin's built-in backend definitions assume `cursor-agent` is reachable
on the gateway process's `PATH`. If it isn't (e.g. installed under
`~/.local/bin`, which is common when the gateway runs as a LaunchAgent with a
minimal `PATH`), override just the `command` field — the rest of the backend
definition (args, resume args, session handling, JSON dialect) comes from the
plugin's defaults and does not need to be repeated. Since `cursor-cli` and
`cursor-mcp` are separate backend ids, each has its own `cliBackends` block;
if you only use one of the two, you only need to override that one (both
default to the same `"cursor-agent"` command otherwise):

```jsonc
{
  "agents": {
    "defaults": {
      "cliBackends": {
        "cursor-cli": {
          "command": "/Users/ai/.local/bin/cursor-agent"
        },
        "cursor-mcp": {
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
        "cursor-cli/cursor-grok-4.5-high-fast": {}
      }
    }
  }
}
```

`cursor-cli/cursor-grok-4.5-high-fast` is the recommended default: fast, cheap on
Cursor's subscription quota, and good enough for most day-to-day agent turns.
It is text-only — no OpenClaw tools are exposed.

> **Renamed model ids.** Earlier versions of this plugin documented
> `grok-4.5-fast-xhigh` and `grok-4.5-fast-high`. `cursor-agent` now names
> those models `cursor-grok-4.5-high-fast` and `cursor-grok-4.5-high`. The
> plugin passes model ids straight through to `cursor-agent --model`, so the
> old ids no longer resolve: rename them in `agents.defaults.models` (and in
> any `--model`/`/model` invocation) when upgrading. No alias is provided,
> because the old names are not models `cursor-agent` knows about.

If (and only if) a session needs OpenClaw's MCP tool bridge, also allow the
`cursor-mcp/*` equivalent and select it explicitly for that session (see
"OpenClaw MCP tool bridge" below for what this exposes):

```jsonc
{
  "agents": {
    "defaults": {
      "models": {
        "cursor-cli/cursor-grok-4.5-high-fast": {},
        "cursor-mcp/cursor-grok-4.5-high-fast": {}
      }
    }
  }
}
```

To add other Cursor models (e.g. `cursor-cli/cursor-grok-4.5-high`,
`cursor-cli/claude-sonnet-5-thinking-high`, `cursor-cli/gpt-5.3-codex`,
`cursor-cli/auto`, or their `cursor-mcp/*` equivalents), add each id as its
own key the same way — an empty `{}`
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

Every number below is the **"Default Context" column of Cursor's own model
table** ([cursor.com/docs.md](https://cursor.com/docs.md)), i.e. what Cursor
actually serves, not the vendor's headline figure. The two differ often enough
to matter: Grok 4.5 is a 500k model upstream but Cursor serves 256k, and the
"1M" in a name like "Sonnet 5 1M" is the Max Mode ceiling rather than the
default. Max Mode is a per-request mode this plugin never selects, so quoting
its ceiling would over-declare the window for every ordinary turn.

| Model id prefix | Context window | Note |
|---|---|---|
| `cursor-grok-4.5*` (and legacy `grok-4.5*`) | 256,000 | Cursor's serving cap; the model is 500k upstream. The legacy prefix is kept only for stale configs — `cursor-agent` no longer lists those ids |
| `claude-opus-5*`, `claude-opus-4-8*`, `claude-fable-5*` | 300,000 | 1M available in Max Mode, not modeled here |
| `claude-sonnet-5*` | 200,000 | same as the default, stated explicitly so the Max Mode 1M isn't read in |
| `gpt-5*` | 272,000 | uniform across the GPT-5 family Cursor serves |
| `kimi-k2.7*` | 262,000 | |
| everything else (including `auto`) | 200,000 (`DEFAULT_CONTEXT_WINDOW`) | conservative default; `auto` delegates to a model chosen per-request by Cursor, so no single published window applies |

This mapping is consulted in two places:

- The existing `registerModelCatalogProvider` runtime catalog, registered
  once per backend id (`cursor-cli`, `cursor-mcp`) with matching `provider`
  tags on its entries (unchanged behavior otherwise, still not consumed by
  `openclaw models list`/`/model` as of v2026.6.11 — see "Known limitations"
  below).
- A second, separate **provider plugin** registration (`api.registerProvider`
  with id `"cursor"`, distinct from both the `"cursor-cli"` and
  `"cursor-mcp"` CLI backend ids) whose `augmentModelCatalog` hook returns
  the same per-model entries twice — once tagged `provider: "cursor-cli"`,
  once tagged `provider: "cursor-mcp"` — from a single shared model-list
  fetch/cache. This is the same mechanism OpenClaw's built-in `"anthropic"`
  provider plugin uses to give its `claude-cli/*` catalog rows per-model
  `contextWindow` values, and it *is* wired into `models list --all`'s
  full-discovery path (unlike the legacy `registerModelCatalogProvider`
  hook).

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
  In-session model refs (`--model cursor-cli/<id>` or `--model
  cursor-mcp/<id>`, `/model cursor-cli/<id>` or `/model cursor-mcp/<id>`)
  work simply because the model id string is passed straight through to
  `cursor-agent --model <id>`, gated only by the `agents.defaults.models`
  allowlist. To make a new Cursor model usable, add an entry for it under
  `agents.defaults.models` (for whichever backend id(s) you need) — the
  dynamic catalog does not do this for you.

## OpenClaw MCP tool bridge

`cursor-agent` can be given access to OpenClaw's own loopback MCP tool
surface (`mcp__openclaw__*` — session status, cron, memory search, message
sending, subagent spawning, plus any other MCP servers OpenClaw bundles for
CLI backends, such as Playwright/Serena if configured).

This is exposed as a **separate backend id, `cursor-mcp`**, rather than a
global toggle: `cursor-cli/<model>` never bridges MCP; `cursor-mcp/<model>`
always does. Opting in means selecting `cursor-mcp/<model>` for a given
session (via `--model` or `/model`) instead of `cursor-cli/<model>` — nothing
else needs to change, and every other session stays on the safe text-only
default. Verified working as of 2026-07-11 against gateway v2026.6.11.

### How it works

OpenClaw's CLI runner has a "bundle MCP" mechanism used by its claude-cli,
codex-cli, and gemini-cli backends: when a backend opts in (`bundleMcp:
true`), OpenClaw spins up a loopback MCP server and writes its URL + bearer
token into a backend-specific shape before each run. `cursor-agent` has no
equivalent CLI flag — it only reads MCP servers from `.cursor/mcp.json` in
the workspace (or `~/.cursor/mcp.json`) and needs `--approve-mcps` to
auto-approve them headlessly. The `cursor-mcp` backend id opts into the
`claude-config-file` bundle mode (which produces a throwaway
`--strict-mcp-config --mcp-config <path>` pair pointing at a generated
`{ mcpServers: { openclaw: { url, headers } } }` file) purely as a vehicle to
obtain that config, then in `resolveExecutionArgs`:

1. reads the generated temp config,
2. merges its `openclaw` server entry into the workspace's
   `.cursor/mcp.json` (preserving any servers already configured there, plus
   any top-level keys the bridge doesn't own such as `$schema`; the original
   file is backed up beforehand and restored via `prepareExecution`'s cleanup
   once the run finishes),
3. strips the unsupported `--strict-mcp-config`/`--mcp-config` flags, and
4. adds `--approve-mcps` so the new server isn't blocked on an interactive
   approval prompt.

The `cursor-cli` backend id never runs any of this: `resolveExecutionArgs`
only applies the bridge when the backend that built it was constructed with
`bundleMcp: true`, i.e. only for `cursor-mcp`.

### When the bridge declines to run

Step 2 rewrites `.cursor/mcp.json`, so it only proceeds when the config it is
merging into can be parsed and re-serialized without losing anything. It
declines in six situations:

- **The workspace's `.cursor/mcp.json` can't be parsed** — not JSON, not an
  object, or an `mcpServers` that is neither an object nor `null`. The file is
  left byte-for-byte as it was.
- **That file exists but can't be read** (permissions).
- **The generated temp config from step 1 can't be read or parsed.** Nothing is
  written to the workspace at all.
- **The write itself fails** (permissions, no space).
- **`.cursor/mcp.json` is a symlink and the bridge would have to remove what
  it writes.** That is the case when prepare found nothing to restore — no
  file, or a file holding nothing but a stale `openclaw` entry — because
  cleanup then deletes rather than rewrites, and deleting through a symlink
  removes the link while the bearer token stays in the file it pointed at. A
  symlink to a real config is *not* refused: cleanup rewrites the original
  bytes through the link, which is safe.
- **OpenClaw resolved execution args without having run the prepare phase for
  that workspace.** Prepare is what registers the backup and the cleanup, so
  without it nothing would ever remove what the write puts on disk. OpenClaw
  always runs prepare first, so this points at a host contract change rather
  than at your configuration.

Each logs a warning, and the turn runs without the bridge.

Empty files, whitespace-only files, a leading byte-order mark, a missing
`mcpServers` key and an `mcpServers` of `null` are all fine — none of them
holds server data the bridge could destroy, so it merges into them normally.

The case worth knowing about is **comments**: `.cursor/mcp.json` is parsed as
strict JSON, so a JSONC-style file with `//` comments is treated as
unparseable. Strip the comments if you want the bridge to engage. Failing
closed is deliberate — the alternative is writing a file whose original content
the bridge could not read, and that content is only recoverable while the
gateway process lives (see the security caveat below).

Two details of when this check applies:

- The config the bridge merges into is the one **captured at prepare time**,
  not re-read at step 2, whenever prepare could read it. Editing
  `.cursor/mcp.json` while a `cursor-mcp` turn is in flight therefore has no
  effect on that turn: the edit is overwritten by the merge and then replaced
  by the prepare-time snapshot at cleanup. Only when prepare found the file
  missing or unreadable does step 2 read from disk.
- **Declining is not always the same as running text-only.** Usually it is:
  nothing is written, no `--approve-mcps` is added, and `cursor-mcp/<model>`
  behaves like `cursor-cli/<model>` for that turn. The exception is a decline
  that follows a *successful* write earlier in the same turn — OpenClaw can
  resolve execution args more than once per turn. The bridged server is
  already on disk then, so `--approve-mcps` is kept and the model still has
  OpenClaw's tools, with the bearer-token caveat below applying in full.
  Dropping the flag instead would leave `cursor-agent` waiting on an approval
  prompt it can never receive headlessly.

### Enabling it

Allow `cursor-mcp/<model>` under `agents.defaults.models` (see "Default /
allowed model" above) and select it for the session that needs the tool
bridge, e.g. `/model cursor-mcp/cursor-grok-4.5-high-fast`. No env var, no gateway
restart beyond having the plugin loaded — the split is a static property of
each registered backend, resolved per session by which model ref is chosen.

#### Deprecated: `OPENCLAW_CURSOR_CLI_MCP_BRIDGE`

Earlier versions of this plugin used a single `cursor-cli` backend id and a
global `OPENCLAW_CURSOR_CLI_MCP_BRIDGE=1` environment variable to turn the
bridge on for *every* `cursor-cli/*` session at once. That variable is
**removed** — it is no longer read for anything. If it is still set in
`~/.openclaw/.env` when the gateway starts, the plugin logs one warning (via
`api.logger.warn`) pointing at `cursor-mcp/<model>` and otherwise ignores it;
it does not error and does not re-enable the old behavior. Remove the line
from `.env` once you've migrated affected sessions to `cursor-mcp/<model>`.

### Security caveat

Selecting `cursor-mcp/<model>` gives `cursor-agent` — and therefore whatever
model is running behind it — full access to OpenClaw's tool surface for that
session: sending messages, spawning subagents, searching memory, browser
automation, etc. Only use `cursor-mcp/<model>` for sessions you trust with
that surface, and be aware `--approve-mcps` means there is no per-server
confirmation step. Keep `cursor-cli/<model>` as the default for everything
else.

Known residual risk: while a `cursor-mcp` run is in flight, the bridge writes
the loopback MCP server's URL and bearer token into the workspace's
`.cursor/mcp.json`. Any process sharing that workspace during that window —
including a concurrently running `cursor-cli` turn — can read that file and
reach the tool server, so don't rely on the backend split as isolation between
concurrent runs in the same workspace.

How long that window lasts depends on how many runs share the workspace.
Backups are reference-counted per workspace: the first prepare captures the
original `.cursor/mcp.json`, each further prepare increments the count, and
**only the cleanup that drops the count to zero restores or removes the file**.
Intermediate cleanups from nested or concurrent runs deliberately leave the
bridged file in place so the still-running outer turn keeps working. Two
consequences worth knowing:

- With overlapping runs, the token stays on disk until the *last* one
  finishes, not the first.
- If a cleanup never runs — the gateway is killed, the process crashes — the
  count never reaches zero and the bridged `.cursor/mcp.json` is left behind.

A leftover usually clears itself, but only on a later `cursor-mcp` turn in the
same workspace that actually bridges. Prepare drops any `openclaw` entry it
finds from the backup it captures, so that turn's cleanup restores the file
**without** the stale entry, and removes the file outright if the entry was all
it held. A turn that declines (see "When the bridge declines to run") writes
nothing and therefore cleans nothing. The one shape that never heals is a
symlinked `.cursor/mcp.json` whose target holds only a leftover entry: that
combination is refused every time, so replace the symlink with a real file if
you hit it.

Until then the file sits there shadowing your own MCP config, so delete it by
hand if that workspace won't see another bridging turn soon. The token itself
stops working when the gateway that issued it exits, since its loopback server
goes with it.

### The `openclaw` server name is reserved

The bridge owns exactly one entry in `mcpServers`, named `openclaw`, and takes
responsibility for removing it. If a run's cleanup never fires and a later run
finds that entry still in the file, it treats it as a leftover and drops it
rather than preserving it. A server of your own named `openclaw` would be
dropped the same way — pick a different name.

Everything else in the file is left to you, with two limits worth knowing.

When prepare found no readable file, a config that appears or changes mid-turn
is merged into and restored rather than overwritten, and cleanup will not
delete it: the bridge recognises its own output by comparing against the exact
bytes it last wrote, and leaves anything else alone with a warning. When
prepare *did* read a file, the merge uses that snapshot instead, and a mid-turn
edit is lost — as described under "When the bridge declines to run".

Dropping an `openclaw` entry is always logged, even when that means saying it
twice in one turn. A rewrite that quietly removes something you configured is
the worse outcome.

See `docs/notes/2026-07-11-mcp-bridge-investigation.md` for the underlying
bridge investigation and the live verification transcript.

## Development

`openclaw` is declared as an optional peer dependency, since the runtime host
(gateway) always provides it at execution time. For local development, install
the gateway's `openclaw` package and link it into this repo's `node_modules`
so that typecheck can resolve `openclaw/plugin-sdk/*` imports:

```bash
npm link openclaw
npm run check
```

The `npm link` command links the global `openclaw` into `node_modules`; it must
be re-run after each `npm install` (which will clear the link).

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
