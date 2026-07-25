import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCursorCliCatalogEntries } from "../src/catalog.ts";
import {
  resolveCursorCommand,
  resolveCursorCommandForCatalog,
  toUnifiedCatalogEntries,
} from "../src/entry-helpers.ts";

test("toUnifiedCatalogEntries maps a single entry with full fidelity", () => {
  const entries = buildCursorCliCatalogEntries([{ id: "auto", name: "Auto" }]);
  const unified = toUnifiedCatalogEntries(entries, "static");
  assert.deepEqual(unified, [
    {
      kind: "text",
      provider: "cursor-cli",
      model: "auto",
      label: "Auto (Cursor CLI)",
      source: "static",
      capabilities: {
        reasoning: true,
        input: ["text"],
        contextWindow: 200000,
      },
    },
  ]);
});

test("toUnifiedCatalogEntries preserves multiple entries in order", () => {
  const entries = buildCursorCliCatalogEntries([
    { id: "auto", name: "Auto" },
    { id: "grok-4.5-high-fast", name: "Grok 4.5 Fast" },
  ]);
  const unified = toUnifiedCatalogEntries(entries, "live");
  assert.deepEqual(
    unified.map((e) => e.model),
    ["auto", "grok-4.5-high-fast"],
  );
  assert.ok(unified.every((e) => e.source === "live" && e.kind === "text"));
});

test("resolveCursorCommand returns configured command when present", () => {
  const config = {
    agents: {
      defaults: {
        cliBackends: {
          "cursor-cli": { command: "/usr/local/bin/cursor-agent" },
        },
      },
    },
  };
  assert.equal(resolveCursorCommand(config), "/usr/local/bin/cursor-agent");
});

test("resolveCursorCommand falls back to cursor-agent when config is undefined", () => {
  assert.equal(resolveCursorCommand(undefined), "cursor-agent");
});

test("resolveCursorCommand falls back to cursor-agent when config is empty object", () => {
  assert.equal(resolveCursorCommand({}), "cursor-agent");
});

test("resolveCursorCommand falls back to cursor-agent when command is missing", () => {
  assert.equal(
    resolveCursorCommand({ agents: { defaults: { cliBackends: {} } } }),
    "cursor-agent",
  );
});

test("resolveCursorCommand falls back to cursor-agent when command is empty or whitespace", () => {
  assert.equal(
    resolveCursorCommand({
      agents: { defaults: { cliBackends: { "cursor-cli": { command: "" } } } },
    }),
    "cursor-agent",
  );
  assert.equal(
    resolveCursorCommand({
      agents: {
        defaults: { cliBackends: { "cursor-cli": { command: "   " } } },
      },
    }),
    "cursor-agent",
  );
});

test("resolveCursorCommand falls back to cursor-agent when command is a non-string", () => {
  assert.equal(
    resolveCursorCommand({
      agents: { defaults: { cliBackends: { "cursor-cli": { command: 42 } } } },
    }),
    "cursor-agent",
  );
});

test("resolveCursorCommand reads the given backendId's cliBackends block, not just cursor-cli", () => {
  const config = {
    agents: {
      defaults: {
        cliBackends: {
          "cursor-cli": { command: "/usr/local/bin/cursor-agent-cli" },
          "cursor-mcp": { command: "/usr/local/bin/cursor-agent-mcp" },
        },
      },
    },
  };
  assert.equal(
    resolveCursorCommand(config, "cursor-cli"),
    "/usr/local/bin/cursor-agent-cli",
  );
  assert.equal(
    resolveCursorCommand(config, "cursor-mcp"),
    "/usr/local/bin/cursor-agent-mcp",
  );
});

test("resolveCursorCommandForCatalog prefers the given backend id's block", () => {
  const config = {
    agents: {
      defaults: {
        cliBackends: {
          "cursor-cli": { command: "/usr/local/bin/cursor-agent-cli" },
          "cursor-mcp": { command: "/usr/local/bin/cursor-agent-mcp" },
        },
      },
    },
  };
  assert.equal(
    resolveCursorCommandForCatalog(config, "cursor-cli"),
    "/usr/local/bin/cursor-agent-cli",
  );
  assert.equal(
    resolveCursorCommandForCatalog(config, "cursor-mcp"),
    "/usr/local/bin/cursor-agent-mcp",
  );
});

test("resolveCursorCommandForCatalog falls back to the other backend's block when only one is configured", () => {
  const onlyMcp = {
    agents: {
      defaults: {
        cliBackends: {
          "cursor-mcp": { command: "/usr/local/bin/cursor-agent-mcp" },
        },
      },
    },
  };
  // Default preference (cursor-cli) still finds the cursor-mcp override.
  assert.equal(
    resolveCursorCommandForCatalog(onlyMcp),
    "/usr/local/bin/cursor-agent-mcp",
  );
  assert.equal(
    resolveCursorCommandForCatalog(onlyMcp, "cursor-cli"),
    "/usr/local/bin/cursor-agent-mcp",
  );

  const onlyCli = {
    agents: {
      defaults: {
        cliBackends: {
          "cursor-cli": { command: "/usr/local/bin/cursor-agent-cli" },
        },
      },
    },
  };
  assert.equal(
    resolveCursorCommandForCatalog(onlyCli, "cursor-mcp"),
    "/usr/local/bin/cursor-agent-cli",
  );
});

test("resolveCursorCommandForCatalog falls back to cursor-agent when nothing is configured", () => {
  assert.equal(resolveCursorCommandForCatalog(undefined), "cursor-agent");
  assert.equal(
    resolveCursorCommandForCatalog({}, "cursor-mcp"),
    "cursor-agent",
  );
});

test("resolveCursorCommand ignores wrapper basename but keeps substring lookalikes", () => {
  assert.equal(
    resolveCursorCommand({
      agents: {
        defaults: {
          cliBackends: {
            "cursor-cli": {
              command: "/opt/cursor-agent-wrapper.ts",
            },
          },
        },
      },
    }),
    "cursor-agent",
  );
  assert.equal(
    resolveCursorCommand({
      agents: {
        defaults: {
          cliBackends: {
            "cursor-cli": {
              command: "/tmp/cursor-agent-wrapper-extra/bin/cursor-agent",
            },
          },
        },
      },
    }),
    "/tmp/cursor-agent-wrapper-extra/bin/cursor-agent",
  );
});
