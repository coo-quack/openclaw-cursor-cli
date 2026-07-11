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
