# Copilot instructions for openclaw-cursor-cli

## What this project is

An OpenClaw plugin that registers Cursor's `cursor-agent` CLI as an OpenClaw text-inference backend, under two backend ids:

- `cursor-cli/<model>` — text-only; no OpenClaw tools are exposed (the safe default).
- `cursor-mcp/<model>` — the same CLI invocation plus OpenClaw's MCP tool bridge, opted into by selecting the model ref.

TypeScript sources in `src/` ship as-is on npm and are executed by the gateway with Node's `--experimental-strip-types`. There is no build step and no bundler; `engines.node` is `>=22.6.0`.

## Review priorities

Weight findings in this order.

1. **Filesystem safety in the MCP bridge** (`src/backend.ts`). The bridge rewrites the workspace's `.cursor/mcp.json` and must restore it afterwards. Invariants: never overwrite or delete a file that could not be read; only restore what this plugin wrote; nested or concurrent runs in one workspace share a reference-counted backup where only the last cleanup restores. Flag any path that can leave the bridged config — which contains a loopback URL and a bearer token — in place after a run.
2. **Error observability.** Failures degrade gracefully instead of crashing the turn, so every swallowed error must still reach the injected `warn` logger. Direct `console.*` calls in plugin code are a defect; logging is routed through the logger injected from `api.logger`.
3. **Public API surface.** Exports of `src/backend.ts` are consumed by `src/index.ts` and the tests. Flag test-only exports, module-global mutable state, and exports that lock in internals.
4. **Model id correctness.** Cursor model ids follow `cursor-grok-4.5-<effort>[-fast]`, `claude-sonnet-5-thinking-<effort>`, and `gpt-5.3-codex[-<effort>]`. Ids come from the `cursor-agent models` output, never invented. Flag stale ids in code, tests, README, and prefix matching in `src/catalog.ts`.
5. **Error-path test coverage**, not only happy paths: child process termination by signal, spawn errors, unreadable or unwritable config files, and live catalog failure falling back to the static list.

## Conventions

- Lint and format with Biome only (`npm run lint`, `npm run format:check`, `npm run fix`). Do not suggest ESLint, oxlint, or Prettier.
- Tests use `node --test` over `.ts` files in `test/`. There is no test-framework dependency.
- Typecheck is `tsc --noEmit`. The `openclaw` SDK is a runtime-provided optional peer dependency, linked with `npm link openclaw` locally and in CI. Do not suggest moving it to `dependencies`.
- The full gate is `npm run check` (typecheck, lint, format, tests).

## Do not flag

- Publishing `.ts` sources to npm: intentional, since the gateway strips types at runtime.
- `openclaw` as an optional peer dependency: intentional, since the host provides it.
- `docs/notes/` being gitignored: local investigation notes are deliberately untracked.
- The MCP bridge writing a bearer token into `.cursor/mcp.json` for the duration of a run: a documented, accepted residual risk (see the README security section). Flag only changes that widen or extend that window.
