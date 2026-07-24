import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCursorCliCatalogEntries,
  createCursorModelsCache,
  parseCursorModelsOutput,
  resolveCursorContextWindow,
} from "../src/catalog.ts";

const SAMPLE = [
  "Available models",
  "",
  "auto - Auto",
  "cursor-grok-4.5-high-fast - Cursor Grok 4.5 Fast",
  "claude-sonnet-5-thinking-high - Claude Sonnet 5 Thinking High",
  "",
  "Tip: run cursor-agent --model <id> to pick a model",
].join("\n");

test("parses id - name lines, skipping header/blank/tip lines", () => {
  const models = parseCursorModelsOutput(SAMPLE);
  assert.deepEqual(models, [
    { id: "auto", name: "Auto" },
    { id: "cursor-grok-4.5-high-fast", name: "Cursor Grok 4.5 Fast" },
    {
      id: "claude-sonnet-5-thinking-high",
      name: "Claude Sonnet 5 Thinking High",
    },
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

test("buildCursorCliCatalogEntries tags entries with the given provider id", () => {
  const entries = buildCursorCliCatalogEntries(
    [{ id: "auto", name: "Auto" }],
    "cursor-mcp",
  );
  assert.deepEqual(entries, [
    {
      id: "auto",
      name: "Auto (Cursor CLI)",
      provider: "cursor-mcp",
      reasoning: true,
      input: ["text"],
      contextWindow: 200000,
    },
  ]);
});

test("resolveCursorContextWindow: grok-4.5 models get 500k", () => {
  assert.equal(resolveCursorContextWindow("grok-4.5-fast-high"), 500000);
  assert.equal(resolveCursorContextWindow("grok-4.5-high"), 500000);
  assert.equal(resolveCursorContextWindow("cursor-grok-4.5-high-fast"), 500000);
  assert.equal(resolveCursorContextWindow("cursor-grok-4.5-high"), 500000);
});

test("resolveCursorContextWindow: claude-sonnet-5 models get 200k", () => {
  assert.equal(
    resolveCursorContextWindow("claude-sonnet-5-thinking-high"),
    200000,
  );
});

test("resolveCursorContextWindow: gpt-5 models get 400k", () => {
  assert.equal(resolveCursorContextWindow("gpt-5.3-codex"), 400000);
});

test("resolveCursorContextWindow: auto and unknown ids get the 200k default", () => {
  assert.equal(resolveCursorContextWindow("auto"), 200000);
  assert.equal(resolveCursorContextWindow("some-other-model"), 200000);
});

test("buildCursorCliCatalogEntries reflects per-model context windows", () => {
  const entries = buildCursorCliCatalogEntries([
    { id: "cursor-grok-4.5-high-fast", name: "Cursor Grok 4.5 Fast" },
    {
      id: "claude-sonnet-5-thinking-high",
      name: "Claude Sonnet 5 Thinking High",
    },
    { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "auto", name: "Auto" },
  ]);
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.contextWindow]),
    [
      ["cursor-grok-4.5-high-fast", 500000],
      ["claude-sonnet-5-thinking-high", 200000],
      ["gpt-5.3-codex", 400000],
      ["auto", 200000],
    ],
  );
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

test("cache TTL boundary: serves cached value at exactly ttlMs, refetches after", async () => {
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
  assert.equal(calls, 1);
  clock = 1000;
  await cache.get();
  assert.equal(calls, 1, "should still serve cached value at clock == ttlMs");
  clock = 1001;
  await cache.get();
  assert.equal(calls, 2, "should refetch once clock exceeds ttlMs");
});

test("parseCursorModelsOutput dedupes duplicate ids, first name wins", () => {
  const models = parseCursorModelsOutput(
    ["dup-id - First Name", "dup-id - Second Name", "auto - Auto"].join("\n"),
  );
  assert.deepEqual(models, [
    { id: "dup-id", name: "First Name" },
    { id: "auto", name: "Auto" },
  ]);
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

test("cache throws when fetcher fails on first call (no stale data)", async () => {
  const cache = createCursorModelsCache(async () => {
    throw new Error("cursor-agent not found");
  }, 1000);
  await assert.rejects(
    () => cache.get(),
    /cursor-agent not found/,
    "cache should propagate fetcher errors when no cached data exists",
  );
});

test("liveCatalog in registerModelCatalogProvider catches fetcher error and returns static fallback", async () => {
  const { catalogProviders } = await (async () => {
    // cliBackends is intentionally unused; only catalogProviders is returned
    const _cliBackends: { id: string }[] = [];
    const catalogProviders: Array<{
      provider: string;
      liveCatalog: (ctx: { config: unknown }) => Promise<unknown>;
    }> = [];
    // biome-ignore lint/suspicious/noExplicitAny: test fixture API mock
    const api: any = {
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      registerCliBackend: () => {},
      registerModelCatalogProvider: (provider: {
        provider: string;
        liveCatalog: (ctx: { config: unknown }) => Promise<unknown>;
      }) => {
        catalogProviders.push(provider);
      },
      registerProvider: () => {},
    };
    const plugin = await import("../src/index.ts").then((m) => m.default);
    plugin.register(api);
    return { catalogProviders };
  })();

  // Force live catalog to fail by using a command that doesn't exist
  const failingConfig = {
    agents: {
      defaults: {
        cliBackends: {
          "cursor-cli": { command: "nonexistent-cursor-agent-xyz" },
          "cursor-mcp": { command: "nonexistent-cursor-agent-xyz" },
        },
      },
    },
  };

  // Both catalog providers should return static fallback entries (no exception)
  for (const provider of catalogProviders) {
    const entries = await provider.liveCatalog({ config: failingConfig });
    assert.ok(
      Array.isArray(entries) && entries.length > 0,
      `${provider.provider} should return fallback entries on live catalog failure`,
    );
    // All fallback entries must be from the static source
    assert.ok(
      entries.every(
        // biome-ignore lint/suspicious/noExplicitAny: entries are untyped from live catalog
        (e: any) => e.source === "static",
      ),
      `${provider.provider} should serve static fallback models on live failure`,
    );
    // Verify fallback entry models match the expected static models
    // (unified catalog entries use 'model' field, not 'id')
    const expectedFallbackModels = [
      "auto",
      "cursor-grok-4.5-high-fast",
      "cursor-grok-4.5-high",
      "claude-sonnet-5-thinking-high",
      "gpt-5.3-codex",
    ];
    const actualModels = entries.map((e: any) => e.model);
    assert.deepEqual(
      actualModels,
      expectedFallbackModels,
      `${provider.provider} fallback models should match STATIC_FALLBACK_MODELS`,
    );
  }
});
