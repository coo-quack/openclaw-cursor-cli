# openclaw-cursor-cli

An OpenClaw plugin that runs Cursor's `cursor-agent` CLI as an OpenClaw text
inference backend, exposed as `cursor-cli/<model>` (for example
`cursor-cli/grok-4.5-fast-xhigh`).

It registers:

- A **CLI backend** (`cursor-cli`) that shells out to `cursor-agent -p
  --output-format stream-json --trust`, supports session resume via
  `--resume {sessionId}`, and strips/handles side-question style invocations.
- A **model catalog provider** that lists Cursor's available models. It
  prefers a live catalog (`cursor-agent models`, cached for 1 hour) and falls
  back to a small static list of five well-known models if the live call
  fails.

## Install

From the plugin's working copy, using OpenClaw's `--link` mode (recommended
during development so edits to `src/` are picked up without reinstalling):

```bash
cd ~/projects/openclaw-cursor-cli
openclaw plugins install --link .
openclaw gateway restart
```

`--link` records the plugin as installed from this path and also adds
`cursor-cli` to `plugins.allow` in `~/.openclaw/openclaw.json` automatically.

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

- **No per-turn system prompt.** `cursor-agent`'s `-p` mode does not accept an
  injected system prompt per call (`systemPromptWhen: "never"` in the backend
  definition). Persona/instruction customization has to live in the
  workspace's `AGENTS.md` file instead, which `cursor-agent` reads directly.
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

## Development

`openclaw` is not a `package.json` dependency of this repo (it's expected to
be installed globally / linked at runtime). For local typecheck to resolve
`openclaw/plugin-sdk/*` imports, link it into `node_modules`:

```bash
npm link openclaw
npm run typecheck
npm test
```

Linting uses [oxlint](https://oxc.rs/docs/guide/usage/linter.html) (a fast
Rust-based linter with built-in TypeScript support, no build step required):

```bash
npm run lint
```

To run typecheck, lint, and the test suite together in one go:

```bash
npm run check
```

Note: `npm install` may prune the `openclaw` symlink from `node_modules`
(since it's not a declared dependency). If `npm run typecheck` or `npm run
check` fails to resolve `openclaw/plugin-sdk/*` imports after an install,
re-run `npm link openclaw`.
