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
import { STATIC_FALLBACK_MODELS } from "../../src/catalog.ts";
import {
  createSandbox,
  integrationSkipReason,
  parseJson,
  runOpenclaw,
} from "./harness.ts";

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
    assert.ok(
      plugin.source?.startsWith(process.cwd()) ||
        plugin.source?.includes("src/index.ts"),
      `unexpected plugin source: ${plugin.source}`,
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
      for (const model of STATIC_FALLBACK_MODELS) {
        const key = `${backendId}/${model.id}`;
        const row = byKey.get(key);
        assert.ok(
          row,
          `${key} is missing from models list --all. The manifest's static ` +
            `modelCatalog is what this command reads — the runtime hooks are ` +
            `skipped when it builds the catalog read-only.`,
        );
      }
    }

    // Spot-check a window that is not the default, so a mapping regression
    // shows up here and not only in the unit tests.
    assert.equal(
      byKey.get("cursor-cli/cursor-grok-4.5-high-fast")?.contextWindow,
      256_000,
      "Cursor serves 256k for Grok 4.5, not the 500k upstream figure",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("a model allowed in config resolves even though the listing is static", {
  skip,
}, () => {
  // Being in the catalog and being usable are different things: the
  // allowlist is what gates a turn. This pins that an entry added by hand
  // shows up as configured.
  const sandbox = createSandbox({
    agents: {
      defaults: {
        models: { "cursor-cli/cursor-grok-4.5-high": {} },
      },
    },
  });
  try {
    const result = runOpenclaw(sandbox, ["models", "list", "--plain"]);
    assert.equal(result.status, 0, `models list failed:\n${result.stderr}`);
    assert.match(result.stdout, /^cursor-cli\/cursor-grok-4\.5-high$/m);
  } finally {
    sandbox.cleanup();
  }
});
