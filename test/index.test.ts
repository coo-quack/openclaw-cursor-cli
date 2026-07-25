import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resetLegacyMcpBridgeEnvWarningForTest } from "../src/backend.ts";
import plugin from "../src/index.ts";

type RegisteredCliBackend = { id: string; bundleMcp?: boolean };
type RegisteredCatalogProvider = {
  provider: string;
  staticCatalog: () => Array<{ provider: string; model: string }>;
};
type RegisteredProvider = {
  id: string;
  augmentModelCatalog: (ctx: {
    config: unknown;
  }) => Promise<Array<{ provider: string; id: string }>>;
};

/**
 * What `register` is handed at runtime.
 *
 * The fake below implements the four members this plugin touches, not the
 * whole surface, so it reaches `register` through `unknown`. That keeps the
 * fake's own contents type-checked — an `any` here would silently accept a
 * misspelt `registerCliBackend` and quietly assert nothing.
 */
type PluginApi = Parameters<typeof plugin.register>[0];

function createFakeApi() {
  const cliBackends: RegisteredCliBackend[] = [];
  const catalogProviders: RegisteredCatalogProvider[] = [];
  const providers: RegisteredProvider[] = [];
  const warnings: string[] = [];

  return {
    api: {
      logger: {
        warn: (message: string) => warnings.push(message),
        info: () => {},
        error: () => {},
      },
      registerCliBackend: (backend: RegisteredCliBackend) => {
        cliBackends.push(backend);
      },
      registerModelCatalogProvider: (provider: RegisteredCatalogProvider) => {
        catalogProviders.push(provider);
      },
      registerProvider: (provider: RegisteredProvider) => {
        providers.push(provider);
      },
    },
    cliBackends,
    catalogProviders,
    providers,
    warnings,
  };
}

test("register() registers exactly two CLI backends: cursor-cli (no bridge) and cursor-mcp (bridge)", () => {
  const { api, cliBackends } = createFakeApi();
  plugin.register(api as unknown as PluginApi);

  assert.equal(cliBackends.length, 2);
  const cli = cliBackends.find((b) => b.id === "cursor-cli");
  const mcp = cliBackends.find((b) => b.id === "cursor-mcp");
  assert.ok(cli, "cursor-cli backend should be registered");
  assert.ok(mcp, "cursor-mcp backend should be registered");
  assert.equal(cli?.bundleMcp, undefined);
  assert.equal(mcp?.bundleMcp, true);
});

test("register() registers a model catalog provider per backend id with matching provider tags", () => {
  const { api, catalogProviders } = createFakeApi();
  plugin.register(api as unknown as PluginApi);

  assert.equal(catalogProviders.length, 2);
  const providerIds = catalogProviders.map((p) => p.provider).sort();
  assert.deepEqual(providerIds, ["cursor-cli", "cursor-mcp"]);

  for (const entry of catalogProviders) {
    const staticEntries = entry.staticCatalog();
    assert.ok(staticEntries.length > 0);
    assert.ok(staticEntries.every((e) => e.provider === entry.provider));
  }
});

test("register() registers a single 'cursor' provider whose augmentModelCatalog covers both backend ids", async () => {
  const { api, providers } = createFakeApi();
  plugin.register(api as unknown as PluginApi);

  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.id, "cursor");

  // Force the live `cursor-agent models` call to fail deterministically so
  // augmentModelCatalog falls back to the static list for both providers,
  // regardless of whether a real `cursor-agent` binary happens to be on PATH
  // in the test environment.
  const config = {
    agents: {
      defaults: {
        cliBackends: {
          "cursor-cli": { command: "definitely-not-a-real-binary-xyz123" },
        },
      },
    },
  };
  const entries = await providers[0]?.augmentModelCatalog({ config });
  assert.ok(entries && entries.length > 0);
  const entryProviders = new Set(entries?.map((e) => e.provider));
  assert.deepEqual([...entryProviders].sort(), ["cursor-cli", "cursor-mcp"]);
});

test("augmentModelCatalog resolves the live command from a cursor-mcp-only override", async () => {
  const { api, providers } = createFakeApi();
  plugin.register(api as unknown as PluginApi);

  // Fake cursor-agent whose `models` output contains a marker model only this
  // script produces, so we can tell the live path (via the cursor-mcp block)
  // apart from the static fallback list.
  const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-mcp-cmd-"));
  const fakeBin = path.join(dir, "fake-cursor-agent");
  writeFileSync(
    fakeBin,
    '#!/bin/sh\necho "mcp-only-marker-model - MCP Only Marker"\n',
  );
  chmodSync(fakeBin, 0o755);
  try {
    const config = {
      agents: {
        defaults: {
          cliBackends: {
            // Only cursor-mcp overrides the command; cursor-cli block absent.
            "cursor-mcp": { command: fakeBin },
          },
        },
      },
    };
    const entries = await providers[0]?.augmentModelCatalog({ config });
    assert.ok(entries?.some((e) => e.id === "mcp-only-marker-model"));
    const entryProviders = new Set(entries?.map((e) => e.provider));
    assert.deepEqual([...entryProviders].sort(), ["cursor-cli", "cursor-mcp"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("register() warns once when the deprecated MCP bridge env var is set", () => {
  resetLegacyMcpBridgeEnvWarningForTest();
  const originalEnv = process.env.OPENCLAW_CURSOR_CLI_MCP_BRIDGE;
  process.env.OPENCLAW_CURSOR_CLI_MCP_BRIDGE = "1";
  try {
    const { api, warnings } = createFakeApi();
    plugin.register(api as unknown as PluginApi);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /deprecated/);
  } finally {
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_CURSOR_CLI_MCP_BRIDGE;
    } else {
      process.env.OPENCLAW_CURSOR_CLI_MCP_BRIDGE = originalEnv;
    }
    resetLegacyMcpBridgeEnvWarningForTest();
  }
});
