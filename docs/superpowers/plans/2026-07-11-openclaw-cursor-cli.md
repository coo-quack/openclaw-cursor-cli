# openclaw-cursor-cli Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the local cursor-agent CLI as an OpenClaw text-inference backend `cursor-cli/<model>`, with a dynamic model catalog parsed from `cursor-agent models`.

**Architecture:** Two phases. Phase 1 wires cursor-agent through OpenClaw's generic CLI-backend config (`agents.defaults.cliBackends`) to verify stream-json compatibility live. Phase 2 packages the verified config as a CLI backend plugin (`api.registerCliBackend`) plus a dynamic catalog (`api.registerModelCatalogProvider`), mirroring OpenClaw's built-in claude-cli backend.

**Tech Stack:** TypeScript (type-stripped, run by OpenClaw's plugin loader), Node 26 `node:test` for unit tests, OpenClaw plugin SDK (`openclaw/plugin-sdk/*`).

## Global Constraints

- OpenClaw v2026.6.11, installed globally at `/opt/homebrew/lib/node_modules/openclaw`.
- cursor-agent v2026.07.09-a3815c0 at `/Users/ai/.local/bin/cursor-agent` (NOT in the gateway's PATH — always configure the absolute path).
- Plugin repo: `/Users/ai/projects/openclaw-cursor-cli` (local git, no remote).
- Default model ref: `cursor-cli/grok-4.5-fast-xhigh`.
- `~/.openclaw/openclaw.json` edits: back up first to `~/.openclaw/openclaw.json.bak-20260711-cursorcli`, edit with `jq`, then `chmod 600 ~/.openclaw/openclaw.json` (jq rewrites reset permissions to 644).
- `plugins.allow` in this config is an EXCLUSIVE allowlist (`["zai","imessage","browser","memory-core","google","elevenlabs"]`). When the plugin is installed, `"cursor-cli"` must be APPENDED, never replacing existing entries.
- `cliBackends` / `plugins` config changes need `openclaw gateway restart` (no hot reload).
- Commit messages in English, no Co-Authored-By trailer, no generated-with credits.
- cursor-agent requires the macOS login keychain unlocked. If any `cursor-agent` call fails with "keychain is locked", STOP and report — do not work around it.
- Known contract (verified 2026-07-11, see spec): headless argv is `-p --output-format stream-json --trust`; prompt via stdin; every event carries `session_id`; resume via `--resume <id>`; `agent models` prints plain `<id> - <display name>` lines; no system-prompt flag and no image flag exist.
- OpenClaw drops the system prompt silently for backends with no `systemPromptArg`/`systemPromptFileArg`/`systemPromptFileConfigKey` (verified in `dist/helpers-Bzlrrr7P.js:resolveSystemPromptUsage`). Initial version accepts this: cursor-agent natively reads `AGENTS.md` from its working directory, which OpenClaw's workspace provides. Do NOT invent flags cursor-agent does not have.

---

### Task 1: Phase-1 config smoke test (no plugin code)

**Files:**
- Modify: `~/.openclaw/openclaw.json` (via jq, with backup)
- Create: `docs/notes/2026-07-11-phase1-findings.md` (in the plugin repo)

**Interfaces:**
- Produces: verified `CliBackendConfig` JSON shape that Task 4 embeds as plugin defaults, plus answers to: (a) does OpenClaw's jsonl parser read cursor-agent events, (b) does resume work through OpenClaw session state, (c) observable impact of the dropped system prompt.

- [ ] **Step 1: Back up and patch openclaw.json**

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak-20260711-cursorcli
jq '.agents.defaults.cliBackends = {
  "cursor-cli": {
    "command": "/Users/ai/.local/bin/cursor-agent",
    "args": ["-p", "--output-format", "stream-json", "--trust"],
    "resumeArgs": ["-p", "--output-format", "stream-json", "--trust", "--resume", "{sessionId}"],
    "output": "jsonl",
    "input": "stdin",
    "modelArg": "--model",
    "sessionMode": "existing",
    "sessionIdFields": ["session_id"],
    "serialize": true
  }
}' ~/.openclaw/openclaw.json > ~/.openclaw/openclaw.json.tmp && mv ~/.openclaw/openclaw.json.tmp ~/.openclaw/openclaw.json
chmod 600 ~/.openclaw/openclaw.json
jq '.agents.defaults.cliBackends' ~/.openclaw/openclaw.json
```

Expected: the cursor-cli block echoed back. Note: current value is `[]` (empty array) — full replacement as above is intended.

- [ ] **Step 2: Restart gateway and confirm health**

```bash
openclaw gateway restart
sleep 5
openclaw gateway status
```

Expected: gateway running. If status shows errors mentioning `cliBackends`, restore the backup, restart, and report.

- [ ] **Step 3: One-shot inference through the backend**

```bash
openclaw agent --message "reply exactly: backend ok" --model cursor-cli/grok-4.5-fast-xhigh
```

Expected: reply text containing exactly `backend ok`. If the model ref is rejected as not allowlisted, inspect `openclaw agent --help` for a bypass flag; if none, add the ref via `jq '.agents.defaults.models["cursor-cli/grok-4.5-fast-xhigh"] = {}'` (same backup/chmod procedure), restart, retry.

- [ ] **Step 4: Resume verification**

Run a second turn against the same OpenClaw session (check `openclaw agent --help` for the session flag; use a dedicated test session, NOT the main agent session):

```bash
openclaw agent --message "What did I ask you to reply in my previous message? Answer with that exact word pair." --model cursor-cli/grok-4.5-fast-xhigh
```

Expected: answer references `backend ok`, proving context reuse. Confirm in logs (`openclaw logs --follow` or `~/.openclaw/logs/`) that the second run's argv contained `--resume <uuid>`.

- [ ] **Step 5: Record findings and commit**

Write `docs/notes/2026-07-11-phase1-findings.md` in the plugin repo answering: jsonl parse issues seen (thinking events, missing timestamp_ms disambiguation), resume argv observed, whether the missing system prompt caused malformed replies (e.g. wrong formatting for the channel), any watchdog timeouts. Then:

```bash
cd ~/projects/openclaw-cursor-cli
git add docs/notes/2026-07-11-phase1-findings.md
git commit -m "Record phase-1 cursor-cli backend verification findings"
```

### Task 2: Plugin scaffold

**Files:**
- Create: `package.json`, `openclaw.plugin.json`, `tsconfig.json`, `.gitignore`

**Interfaces:**
- Produces: package with `openclaw.extensions` → `./src/index.ts` (Task 5 creates it), plugin id `cursor-cli`, `npm link openclaw` for SDK type resolution.

- [ ] **Step 1: Write package metadata**

`package.json`:

```json
{
  "name": "openclaw-cursor-cli",
  "version": "0.1.0",
  "type": "module",
  "description": "Run Cursor's cursor-agent CLI as an OpenClaw text inference backend",
  "openclaw": {
    "extensions": ["./src/index.ts"],
    "compat": {
      "pluginApi": ">=2026.6.0",
      "minGatewayVersion": "2026.6.0"
    }
  },
  "scripts": {
    "test": "node --test test/",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.9.0"
  }
}
```

`openclaw.plugin.json`:

```json
{
  "id": "cursor-cli",
  "name": "Cursor CLI",
  "description": "Run Cursor's cursor-agent CLI through OpenClaw as cursor-cli/<model>",
  "cliBackends": ["cursor-cli"],
  "setup": {
    "cliBackends": ["cursor-cli"],
    "requiresRuntime": false
  },
  "activation": {
    "onStartup": false
  },
  "configSchema": {
    "type": "object",
    "additionalProperties": false
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src", "test"]
}
```

`.gitignore`:

```
node_modules/
```

- [ ] **Step 2: Link the SDK and install dev deps**

```bash
cd ~/projects/openclaw-cursor-cli
npm install
npm link openclaw
node -e "import('openclaw/plugin-sdk/plugin-entry').then(m => console.log(typeof m.definePluginEntry))"
```

Expected: `function`. If the subpath import fails, list `/opt/homebrew/lib/node_modules/openclaw/package.json` `exports` for the correct plugin-sdk subpaths and adjust (report the actual paths in the commit message body).

- [ ] **Step 3: Commit**

```bash
git add package.json openclaw.plugin.json tsconfig.json .gitignore package-lock.json
git commit -m "Scaffold openclaw-cursor-cli plugin package"
```

### Task 3: Model catalog parser (`src/catalog.ts`)

**Files:**
- Create: `src/catalog.ts`
- Test: `test/catalog.test.ts`

**Interfaces:**
- Produces: `parseCursorModelsOutput(output: string): CursorModelEntry[]` where `CursorModelEntry = { id: string; name: string }`; `buildCursorCliCatalogEntries(models: CursorModelEntry[]): UnifiedCatalogEntryLike[]` returning `{ id, name, provider: "cursor-cli", reasoning: true, input: ["text"], contextWindow: 200000 }` per model; `createCursorModelsCache(fetcher, ttlMs, now)` with `get(): Promise<CursorModelEntry[]>`. Task 5 consumes all three.

- [ ] **Step 1: Write failing tests**

`test/catalog.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCursorModelsOutput,
  buildCursorCliCatalogEntries,
  createCursorModelsCache,
} from "../src/catalog.ts";

const SAMPLE = [
  "Available models",
  "",
  "auto - Auto",
  "grok-4.5-fast-xhigh - Cursor Grok 4.5 Fast",
  "claude-sonnet-5-thinking-high - Claude Sonnet 5 Thinking High",
  "",
  "Tip: run cursor-agent --model <id> to pick a model",
].join("\n");

test("parses id - name lines, skipping header/blank/tip lines", () => {
  const models = parseCursorModelsOutput(SAMPLE);
  assert.deepEqual(models, [
    { id: "auto", name: "Auto" },
    { id: "grok-4.5-fast-xhigh", name: "Cursor Grok 4.5 Fast" },
    { id: "claude-sonnet-5-thinking-high", name: "Claude Sonnet 5 Thinking High" },
  ]);
});

test("keeps display names containing ' - ' intact", () => {
  const models = parseCursorModelsOutput("weird-id - Name - With Dash\n");
  assert.deepEqual(models, [{ id: "weird-id", name: "Name - With Dash" }]);
});

test("builds catalog entries with provider and defaults", () => {
  const entries = buildCursorCliCatalogEntries([{ id: "auto", name: "Auto" }]);
  assert.deepEqual(entries, [
    {
      id: "auto",
      name: "Auto (Cursor CLI)",
      provider: "cursor-cli",
      reasoning: true,
      input: ["text"],
      contextWindow: 200000,
    },
  ]);
});

test("cache returns fetched models and honors TTL", async () => {
  let calls = 0;
  let clock = 0;
  const cache = createCursorModelsCache(
    async () => {
      calls += 1;
      return [{ id: "auto", name: "Auto" }];
    },
    1000,
    () => clock,
  );
  await cache.get();
  await cache.get();
  assert.equal(calls, 1);
  clock = 1001;
  await cache.get();
  assert.equal(calls, 2);
});

test("cache serves stale data when refresh fails", async () => {
  let calls = 0;
  let clock = 0;
  const cache = createCursorModelsCache(
    async () => {
      calls += 1;
      if (calls > 1) throw new Error("cli failed");
      return [{ id: "auto", name: "Auto" }];
    },
    1000,
    () => clock,
  );
  await cache.get();
  clock = 1001;
  const models = await cache.get();
  assert.deepEqual(models, [{ id: "auto", name: "Auto" }]);
});
```

- [ ] **Step 2: Run tests, verify failure**

```bash
cd ~/projects/openclaw-cursor-cli && npm test
```

Expected: FAIL (module `../src/catalog.ts` not found).

- [ ] **Step 3: Implement `src/catalog.ts`**

```ts
export type CursorModelEntry = { id: string; name: string };

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/i;

export function parseCursorModelsOutput(output: string): CursorModelEntry[] {
  const entries: CursorModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const sep = line.indexOf(" - ");
    if (sep <= 0) continue;
    const id = line.slice(0, sep).trim();
    const name = line.slice(sep + 3).trim();
    if (!MODEL_ID_PATTERN.test(id) || name.length === 0 || seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, name });
  }
  return entries;
}

const DEFAULT_CONTEXT_WINDOW = 200000;

export function buildCursorCliCatalogEntries(models: CursorModelEntry[]) {
  return models.map((model) => ({
    id: model.id,
    name: `${model.name} (Cursor CLI)`,
    provider: "cursor-cli",
    reasoning: true,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }));
}

export function createCursorModelsCache(
  fetcher: () => Promise<CursorModelEntry[]>,
  ttlMs: number,
  now: () => number = Date.now,
) {
  let cached: CursorModelEntry[] | null = null;
  let fetchedAt = -Infinity;
  return {
    async get(): Promise<CursorModelEntry[]> {
      if (cached && now() - fetchedAt <= ttlMs) return cached;
      try {
        cached = await fetcher();
        fetchedAt = now();
      } catch (error) {
        if (!cached) throw error;
      }
      return cached;
    },
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npm test
```

Expected: all catalog tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog.ts test/catalog.test.ts
git commit -m "Add cursor-agent models output parser and TTL cache"
```

### Task 4: Backend definition (`src/backend.ts`)

**Files:**
- Create: `src/backend.ts`
- Test: `test/backend.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `CURSOR_CLI_BACKEND_ID = "cursor-cli"`, `CURSOR_CLI_DEFAULT_MODEL_REF = "cursor-cli/grok-4.5-fast-xhigh"`, `resolveCursorCliExecutionArgs(ctx: { executionMode?: string; baseArgs: readonly string[] }): string[]`, `buildCursorCliBackend(): CliBackendPlugin`. Task 5 consumes `buildCursorCliBackend` and the constants.

- [ ] **Step 1: Write failing tests**

`test/backend.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCursorCliBackend,
  resolveCursorCliExecutionArgs,
} from "../src/backend.ts";

const BASE = ["-p", "--output-format", "stream-json", "--trust"];

test("agent mode keeps base args unchanged", () => {
  const args = resolveCursorCliExecutionArgs({ executionMode: "agent", baseArgs: BASE });
  assert.deepEqual(args, BASE);
});

test("side-question mode appends ask mode and strips resume", () => {
  const args = resolveCursorCliExecutionArgs({
    executionMode: "side-question",
    baseArgs: [...BASE, "--resume", "abc-123"],
  });
  assert.deepEqual(args, [...BASE, "--mode", "ask"]);
});

test("backend defaults match the verified phase-1 contract", () => {
  const backend = buildCursorCliBackend();
  assert.equal(backend.id, "cursor-cli");
  assert.equal(backend.nativeToolMode, "always-on");
  assert.equal(backend.sideQuestionToolMode, "disabled");
  assert.equal(backend.config.command, "cursor-agent");
  assert.deepEqual(backend.config.args, BASE);
  assert.deepEqual(backend.config.resumeArgs, [...BASE, "--resume", "{sessionId}"]);
  assert.equal(backend.config.output, "jsonl");
  assert.equal(backend.config.input, "stdin");
  assert.equal(backend.config.modelArg, "--model");
  assert.equal(backend.config.sessionMode, "existing");
  assert.deepEqual(backend.config.sessionIdFields, ["session_id"]);
  assert.equal(backend.config.serialize, true);
  assert.equal(backend.config.jsonlDialect, "claude-stream-json");
  assert.equal(backend.config.systemPromptWhen, "never");
});
```

- [ ] **Step 2: Run tests, verify failure**

```bash
npm test
```

Expected: FAIL (module `../src/backend.ts` not found).

- [ ] **Step 3: Implement `src/backend.ts`**

Use a type-only SDK import so `node --test` never needs to resolve the openclaw runtime:

```ts
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";

export const CURSOR_CLI_BACKEND_ID = "cursor-cli";
export const CURSOR_CLI_DEFAULT_MODEL_REF = "cursor-cli/grok-4.5-fast-xhigh";

const CURSOR_CLI_BASE_ARGS = ["-p", "--output-format", "stream-json", "--trust"] as const;

function stripResumeArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--resume" || arg === "--continue") {
      const next = args[i + 1];
      if (arg === "--resume" && typeof next === "string" && !next.startsWith("-")) i += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

export function resolveCursorCliExecutionArgs(context: {
  executionMode?: string;
  baseArgs: readonly string[];
}): string[] {
  if (context.executionMode === "side-question") {
    return [...stripResumeArgs(context.baseArgs), "--mode", "ask"];
  }
  return [...context.baseArgs];
}

export function buildCursorCliBackend(): CliBackendPlugin {
  return {
    id: CURSOR_CLI_BACKEND_ID,
    liveTest: {
      defaultModelRef: CURSOR_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: false,
      defaultMcpProbe: false,
    },
    nativeToolMode: "always-on",
    sideQuestionToolMode: "disabled",
    config: {
      command: "cursor-agent",
      args: [...CURSOR_CLI_BASE_ARGS],
      resumeArgs: [...CURSOR_CLI_BASE_ARGS, "--resume", "{sessionId}"],
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      input: "stdin",
      modelArg: "--model",
      sessionMode: "existing",
      sessionIdFields: ["session_id"],
      systemPromptWhen: "never",
      serialize: true,
    },
    resolveExecutionArgs: resolveCursorCliExecutionArgs,
  };
}
```

If `tsc --noEmit` reports that `CliBackendPlugin` requires fields not listed here, or rejects `resolveExecutionArgs`'s signature, align with the actual type from `openclaw/plugin-sdk/cli-backend` (the built-in claude-cli backend in `/opt/homebrew/lib/node_modules/openclaw/dist/cli-backend-CkQ4PBJi.js` is the reference) and adjust the test expectations to match — do not weaken the argv behavior.

- [ ] **Step 4: Run tests and typecheck, verify pass**

```bash
npm test && npm run typecheck
```

Expected: PASS on both. Incorporate any phase-1 findings (Task 1 notes) that contradict these defaults — the notes file wins over this plan; update code and tests accordingly.

- [ ] **Step 5: Commit**

```bash
git add src/backend.ts test/backend.test.ts
git commit -m "Add cursor-cli backend definition with side-question args"
```

### Task 5: Plugin entry (`src/index.ts`)

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Consumes: `buildCursorCliBackend`, `CURSOR_CLI_BACKEND_ID` (Task 4); `parseCursorModelsOutput`, `buildCursorCliCatalogEntries`, `createCursorModelsCache` (Task 3).
- Produces: default plugin entry consumed by the OpenClaw plugin loader.

- [ ] **Step 1: Implement `src/index.ts`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildCursorCliBackend,
  CURSOR_CLI_BACKEND_ID,
} from "./backend.ts";
import {
  buildCursorCliCatalogEntries,
  createCursorModelsCache,
  parseCursorModelsOutput,
  type CursorModelEntry,
} from "./catalog.ts";

const execFileAsync = promisify(execFile);
const CATALOG_TTL_MS = 60 * 60 * 1000;
const MODELS_TIMEOUT_MS = 20000;

const STATIC_FALLBACK_MODELS: CursorModelEntry[] = [
  { id: "auto", name: "Auto" },
  { id: "grok-4.5-fast-xhigh", name: "Cursor Grok 4.5 Fast" },
  { id: "grok-4.5-xhigh", name: "Cursor Grok 4.5" },
  { id: "claude-sonnet-5-thinking-high", name: "Claude Sonnet 5 Thinking High" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
];

function resolveCursorCommand(config: unknown): string {
  const command = (config as {
    agents?: { defaults?: { cliBackends?: Record<string, { command?: string }> } };
  })?.agents?.defaults?.cliBackends?.[CURSOR_CLI_BACKEND_ID]?.command;
  return typeof command === "string" && command.trim().length > 0
    ? command
    : "cursor-agent";
}

export default definePluginEntry({
  id: CURSOR_CLI_BACKEND_ID,
  name: "Cursor CLI",
  description: "Run Cursor's cursor-agent CLI through OpenClaw as cursor-cli/<model>",
  register(api) {
    api.registerCliBackend(buildCursorCliBackend());

    const caches = new Map<string, ReturnType<typeof createCursorModelsCache>>();
    const cacheFor = (command: string) => {
      let cache = caches.get(command);
      if (!cache) {
        cache = createCursorModelsCache(async () => {
          const { stdout } = await execFileAsync(command, ["models"], {
            timeout: MODELS_TIMEOUT_MS,
          });
          const models = parseCursorModelsOutput(stdout);
          if (models.length === 0) throw new Error("cursor-agent models returned no entries");
          return models;
        }, CATALOG_TTL_MS);
        caches.set(command, cache);
      }
      return cache;
    };

    api.registerModelCatalogProvider({
      provider: CURSOR_CLI_BACKEND_ID,
      kinds: ["text"],
      staticCatalog: () => buildCursorCliCatalogEntries(STATIC_FALLBACK_MODELS),
      liveCatalog: async (ctx) => {
        try {
          const models = await cacheFor(resolveCursorCommand(ctx.config)).get();
          return buildCursorCliCatalogEntries(models);
        } catch {
          return buildCursorCliCatalogEntries(STATIC_FALLBACK_MODELS);
        }
      },
    });
  },
});
```

- [ ] **Step 2: Typecheck and unit-test**

```bash
npm run typecheck && npm test
```

Expected: PASS. If `registerModelCatalogProvider`'s entry type rejects the `buildCursorCliCatalogEntries` shape (e.g. `input` needs a stricter literal type), fix `src/catalog.ts` types to satisfy it without changing runtime values, and keep tests green.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "Register cursor-cli backend and dynamic model catalog"
```

### Task 6: Install, wire config, live verification

**Files:**
- Modify: `~/.openclaw/openclaw.json` (via jq, with a fresh backup `~/.openclaw/openclaw.json.bak-20260711-cursorcli2`)
- Create: `README.md`

**Interfaces:**
- Consumes: everything prior; the plugin replaces the Task 1 manual `cliBackends` defaults but the `command` override stays (cursor-agent is outside the gateway PATH).

- [ ] **Step 1: Install the plugin (linked) and allow it**

```bash
cd ~/projects/openclaw-cursor-cli
openclaw plugins install --link .
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak-20260711-cursorcli2
jq '.plugins.allow += ["cursor-cli"] | .agents.defaults.cliBackends = { "cursor-cli": { "command": "/Users/ai/.local/bin/cursor-agent" } }' ~/.openclaw/openclaw.json > ~/.openclaw/openclaw.json.tmp && mv ~/.openclaw/openclaw.json.tmp ~/.openclaw/openclaw.json
chmod 600 ~/.openclaw/openclaw.json
openclaw gateway restart
sleep 5
```

Note: this intentionally shrinks the Task 1 manual config down to the `command` override only — the plugin now owns the defaults.

- [ ] **Step 2: Verify discovery and registration**

```bash
openclaw plugins inspect cursor-cli --runtime --json
```

Expected: JSON showing the plugin loaded with cliBackends `["cursor-cli"]` and no errors. If the plugin fails allowlist checks, confirm `plugins.allow` contains all seven entries (six originals + cursor-cli).

- [ ] **Step 3: Live smoke through the plugin**

```bash
openclaw agent --message "reply exactly: plugin ok" --model cursor-cli/grok-4.5-fast-xhigh
```

Expected: `plugin ok`. Then verify the dynamic catalog surfaces cursor models (check `openclaw models list 2>/dev/null || openclaw models 2>/dev/null` or the command found in `openclaw --help`); expected: multiple `cursor-cli/...` entries beyond the static fallback five.

- [ ] **Step 4: Write README and commit**

`README.md` must cover: what the plugin does, install (`openclaw plugins install --link .`), the `plugins.allow` caveat, the `command` override for non-PATH installs, default model `cursor-cli/grok-4.5-fast-xhigh`, keychain requirement + the `ai.keychain.unlock` LaunchAgent, known limitations (no per-turn system prompt — relies on workspace AGENTS.md; no image input; subscription quota). English.

```bash
git add README.md
git commit -m "Add README with install and configuration guide"
```

- [ ] **Step 5: Full verification sweep**

Re-run the spec's verification list: one-shot reply, resume across two turns in one test session, `/model` switch listing, side-question path if reachable via `openclaw agent` flags. Record results in `docs/notes/2026-07-11-phase2-verification.md`, commit with `git commit -m "Record phase-2 live verification results"`. Any failed item: fix before commit or report why it must wait.
