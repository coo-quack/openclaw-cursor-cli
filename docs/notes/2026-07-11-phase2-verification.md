# Phase 2 live verification (2026-07-11)

Verification performed against the live gateway (OpenClaw 2026.6.11) on
Chataclaws-Mac-mini after installing the plugin via `openclaw plugins install
--link .` and rewriting `~/.openclaw/openclaw.json` per Task 6.

## Config changes applied

- Backup: `~/.openclaw/openclaw.json.bak-20260711-cursorcli2`
- `plugins.allow`: appended `"cursor-cli"` (deduped after `plugins install
  --link` had already added it) — final: `["browser", "cursor-cli",
  "elevenlabs", "google", "imessage", "memory-core", "zai"]` (all 7 original +
  new entries present, none dropped).
- `agents.defaults.cliBackends` replaced with just:
  ```json
  { "cursor-cli": { "command": "/Users/ai/.local/bin/cursor-agent" } }
  ```
  (plugin defaults now own args/resumeArgs/session handling/jsonlDialect;
  only the non-PATH `command` override remains, as intended.)
- `agents.defaults.models["cursor-cli/grok-4.5-fast-xhigh"]` left untouched
  (still `{}`, i.e. allowlisted with no overrides).
- File permissions: `chmod 600` re-applied after every rewrite.
- One `openclaw gateway restart` performed after all config edits; gateway
  came back healthy (`openclaw gateway status`: Runtime running, Connectivity
  probe: ok, Capability: admin-capable).

## 1. Plugin discovery/registration

`openclaw plugins inspect cursor-cli --runtime --json`:

- `status: "loaded"`, `activated: true`, `enabled: true`
- `cliBackendIds: ["cursor-cli"]`
- `diagnostics: []` (no errors)
- `install.source: "path"`, `install.sourcePath:
  "/Users/ai/projects/openclaw-cursor-cli"` (linked install confirmed)

Result: **PASS**

## 2. One-shot reply (smoke test)

```
openclaw agent --message "reply exactly: plugin ok" \
  --model cursor-cli/grok-4.5-fast-xhigh \
  --session-key "agent:main:cursor-cli-plugin-test"
```

Output: `plugin ok`

Result: **PASS**

## 3. Resume across two turns (same isolated session)

Second turn on the same session key:

```
openclaw agent --message "reply exactly: turn two ok" \
  --model cursor-cli/grok-4.5-fast-xhigh \
  --session-key "agent:main:cursor-cli-plugin-test"
```

Output: `turn two ok`

`grep "cli exec:" /tmp/openclaw/openclaw-2026-07-11.log` shows the two calls
for this session:

- Turn 1: `useResume=false session=none resumeSession=none reuse=none`
- Turn 2: `useResume=true session=present resumeSession=530bdeaecffd
  reuse=reusable`

Turn 2 correctly reused the prior `cursor-agent` session via `--resume`.

Result: **PASS**

## 4. Model catalog / `/model` listing

- `openclaw models list --all` and `openclaw models list --all --provider
  cursor-cli`: only the explicitly allowlisted
  `cursor-cli/grok-4.5-fast-xhigh` entry shows (tagged `configured`); no
  additional dynamic `cursor-cli/...` entries beyond it.
- Chat-level `/model list` (sent as a message to the isolated test session):
  shows only `.models.providers.*` (API-key-based provider) entries — zai and
  google — no `cursor-cli` entries at all.

**Root cause (not a plugin bug):** both `openclaw models list` and the
chat `/model list` command are driven by each plugin's **declarative**
manifest metadata (`openclaw.plugin.json` → `modelCatalog` field, resolved via
`planManifestModelCatalogRows` in OpenClaw core), not by the **runtime**
`api.registerModelCatalogProvider()` call this plugin makes in `register()`
(`src/index.ts`). This plugin's manifest does not declare a static
`modelCatalog` block, so nothing surfaces there. The runtime catalog
provider (with live `cursor-agent models` fetch + static 5-model fallback,
covered by the existing unit tests) is instead consumed during in-session
model resolution — which is exactly what step 2/3 exercised successfully via
`--model cursor-cli/grok-4.5-fast-xhigh`.

Result: **KNOWN LIMITATION, not blocking** — documented in `README.md` under
"Known limitations". The backend itself (the actual gate per the task brief)
works correctly.

**Correction (final review, 2026-07-11):** the claim above that the runtime
catalog provider "is instead consumed during in-session model resolution"
is unsupported and incorrect. Re-checking OpenClaw v2026.6.11: no code path
consumes `registerModelCatalogProvider` beyond registration/dedupe/snapshot
handling; `models list` reads the declarative manifest, and in-session
model resolution passes the model id straight through to `cursor-agent
--model <id>`, gated only by the `agents.defaults.models` allowlist. Steps
2/3 above worked via that allowlist + pass-through mechanism, not via the
dynamic catalog. The manifest-vs-runtime mechanism findings in this section
otherwise stand.

## 5. Side-question path

No `openclaw agent` CLI flag exists to force `executionMode: "side-question"`
directly (it's an internal execution-mode set by OpenClaw core, not
CLI-selectable). This path is instead covered by the existing unit tests for
`resolveCursorCliExecutionArgs` (`test/backend.test.ts`), including the
edge-case tests for `--resume`/`--continue` arg stripping added in an earlier
commit. Re-ran the full suite to confirm no regressions from the live config
changes:

```
npm test
# 19 pass, 0 fail
```

Result: **PASS (via unit tests; not reachable live through `openclaw agent`
CLI flags)**

## Gateway health

`openclaw gateway status` after all changes: Runtime running, Connectivity
probe ok, Capability admin-capable. iMessage channel unaffected (not touched
by any config change; `plugins.allow` retained `imessage`).

## Summary

| Check | Result |
|---|---|
| Plugin discovery/registration | PASS |
| One-shot reply | PASS |
| Two-turn resume | PASS |
| Model catalog / `/model` listing | Known limitation (documented), not blocking |
| Side-question path | PASS (unit tests; not live-reachable via CLI) |
| Gateway health post-restart | PASS |
