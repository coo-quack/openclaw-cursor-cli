/**
 * What a real `openclaw` sees when it loads this checkout.
 *
 * No gateway is needed for any of this: the CLI resolves plugins and builds its
 * model catalog in-process. That makes these the cheap half of the suite, and
 * the half that would have caught the manifest gap — the runtime catalog hooks
 * never run on the listing path, so for a long time no Cursor model appeared in
 * `models list --all` at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCursorCliCatalogEntries,
  STATIC_FALLBACK_MODELS,
} from "../../src/catalog.ts";
import {
  createSandbox,
  integrationSkipReason,
  parseJson,
  REPO_ROOT,
  requireIntegrationEnvironment,
  runOpenclaw,
} from "./harness.ts";

requireIntegrationEnvironment();
const skip = integrationSkipReason();

type PluginRow = {
  id: string;
  status?: string;
  enabled?: boolean;
  source?: string;
  cliBackendIds?: string[];
};

type ModelRow = { key: string; name?: string; contextWindow?: number };

test("openclaw discovers the plugin from a path and reports it loaded", {
  skip,
}, () => {
  const sandbox = createSandbox();
  try {
    const result = runOpenclaw(sandbox, ["plugins", "list", "--json"]);
    assert.equal(result.status, 0, `plugins list failed:\n${result.stderr}`);

    const payload = parseJson<PluginRow[] | { plugins: PluginRow[] }>(
      result,
      "plugins list --json",
    );
    const rows = Array.isArray(payload) ? payload : payload.plugins;
    const plugin = rows.find((row) => row.id === "cursor-cli");

    assert.ok(plugin, "cursor-cli is not in the plugin listing");
    assert.equal(plugin.status, "loaded", `plugin status: ${plugin.status}`);
    assert.notEqual(plugin.enabled, false, "plugin is disabled");
    // Pin that it came from *this* checkout. The previous form also accepted
    // any path ending in src/index.ts, which every candidate satisfies.
    assert.equal(
      plugin.source,
      `${REPO_ROOT}/src/index.ts`,
      "the loaded plugin is not the checkout under test",
    );

    // Both backend ids have to be declared, or `/model cursor-mcp/...` has
    // nothing to resolve against. The manifest lists each twice (once under
    // `cliBackends`, once under `setup.cliBackends`), so compare as a set.
    assert.deepEqual([...new Set(plugin.cliBackendIds ?? [])].sort(), [
      "cursor-cli",
      "cursor-mcp",
    ]);
  } finally {
    sandbox.cleanup();
  }
});

test("the static catalog reaches `models list --all` for both backend ids", {
  skip,
}, () => {
  const sandbox = createSandbox();
  try {
    const result = runOpenclaw(sandbox, ["models", "list", "--all", "--json"]);
    assert.equal(result.status, 0, `models list failed:\n${result.stderr}`);

    const payload = parseJson<{ models: ModelRow[] }>(
      result,
      "models list --all --json",
    );
    const byKey = new Map(payload.models.map((row) => [row.key, row]));

    for (const backendId of ["cursor-cli", "cursor-mcp"]) {
      // Rebuild the rows the same way the manifest was populated, so every
      // window is checked rather than one of the ten. A single spot-check
      // passed while the other nine — all five `cursor-mcp/` rows among them —
      // could carry any number at all.
      const expected = buildCursorCliCatalogEntries(
        STATIC_FALLBACK_MODELS,
        backendId,
      );
      for (const entry of expected) {
        const key = `${backendId}/${entry.id}`;
        const row = byKey.get(key);
        assert.ok(
          row,
          `${key} is missing from models list --all. The manifest's static ` +
            `modelCatalog is what this command reads — the runtime hooks are ` +
            `skipped when it builds the catalog read-only.`,
        );
        assert.equal(
          row.contextWindow,
          entry.contextWindow,
          `${key} reached the listing with a context window of ` +
            `${row.contextWindow}, not the ${entry.contextWindow} the code builds`,
        );
      }
    }

    // One window written out, so a table-wide regression that moved every
    // number in step would still be caught. Cursor serves 256k for Grok 4.5,
    // not the 500k the model carries upstream.
    assert.equal(
      byKey.get("cursor-cli/cursor-grok-4.5-high-fast")?.contextWindow,
      256_000,
    );
  } finally {
    sandbox.cleanup();
  }
});

test("the allowlist, not the catalog, decides which models are configured", {
  skip,
}, () => {
  // The claim is deliberately the narrow one: an allowed model is *configured*.
  // Whether a turn then resolves it is a different question, and one this test
  // cannot answer now that #15 made the listing static — the two gateway-backed
  // tests are what drive a real resolution.
  //
  // Asserting only that the allowed model appears would still pass if the
  // allowlist stopped gating anything at all, so the other four static models
  // have to be absent from the same listing for this to mean something.
  const allowed = "cursor-cli/cursor-grok-4.5-high";
  const sandbox = createSandbox({
    agents: { defaults: { models: { [allowed]: {} } } },
  });
  try {
    const result = runOpenclaw(sandbox, ["models", "list", "--plain"]);
    assert.equal(result.status, 0, `models list failed:\n${result.stderr}`);
    const listed = new Set(
      result.stdout.split("\n").map((line) => line.trim()),
    );

    assert.ok(listed.has(allowed), `${allowed} is configured but not listed`);
    for (const model of STATIC_FALLBACK_MODELS) {
      const key = `cursor-cli/${model.id}`;
      if (key === allowed) continue;
      assert.ok(
        !listed.has(key),
        `${key} is in the catalog but was never allowed, so it must not be listed as configured`,
      );
    }
  } finally {
    sandbox.cleanup();
  }
});
