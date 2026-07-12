import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildCursorCliBackend,
  CURSOR_CLI_BACKEND_ID,
  CURSOR_MCP_BACKEND_ID,
  warnIfLegacyMcpBridgeEnvSet,
} from "./backend.ts";
import {
  buildCursorCliCatalogEntries,
  type CursorModelEntry,
  createCursorModelsCache,
  parseCursorModelsOutput,
} from "./catalog.ts";
import {
  resolveCursorCommandForCatalog,
  toUnifiedCatalogEntries,
} from "./entry-helpers.ts";

const execFileAsync = promisify(execFile);
const CATALOG_TTL_MS = 60 * 60 * 1000;
const MODELS_TIMEOUT_MS = 20000;

const STATIC_FALLBACK_MODELS: CursorModelEntry[] = [
  { id: "auto", name: "Auto" },
  { id: "grok-4.5-fast-xhigh", name: "Cursor Grok 4.5 Fast" },
  { id: "grok-4.5-xhigh", name: "Cursor Grok 4.5" },
  {
    id: "claude-sonnet-5-thinking-high",
    name: "Claude Sonnet 5 Thinking High",
  },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
];

export default definePluginEntry({
  id: CURSOR_CLI_BACKEND_ID,
  name: "Cursor CLI",
  description:
    "Run Cursor's cursor-agent CLI through OpenClaw as cursor-cli/<model> " +
    "(text-only, safe default) and cursor-mcp/<model> (adds OpenClaw's MCP " +
    "tool bridge, opt-in via explicit model selection)",
  register(api) {
    // OPENCLAW_CURSOR_CLI_MCP_BRIDGE (the old global on/off toggle) has been
    // replaced by the always-on-when-selected `cursor-mcp/<model>` backend.
    // Warn once (not an error) if the deprecated var is still set, so
    // operators relying on it notice it's now a no-op.
    warnIfLegacyMcpBridgeEnvSet(process.env, api.logger);

    // `cursor-cli/*`: bundleMcp off, the safe text-response-only default.
    api.registerCliBackend(
      buildCursorCliBackend({ id: CURSOR_CLI_BACKEND_ID, bundleMcp: false }),
    );
    // `cursor-mcp/*`: bundleMcp always on for this backend id. Opt-in is
    // simply choosing this model prefix (e.g. `/model
    // cursor-mcp/grok-4.5-fast-xhigh`) instead of `cursor-cli/*`.
    api.registerCliBackend(
      buildCursorCliBackend({ id: CURSOR_MCP_BACKEND_ID, bundleMcp: true }),
    );

    const caches = new Map<
      string,
      ReturnType<typeof createCursorModelsCache>
    >();
    const cacheFor = (command: string) => {
      let cache = caches.get(command);
      if (!cache) {
        cache = createCursorModelsCache(async () => {
          const { stdout } = await execFileAsync(command, ["models"], {
            timeout: MODELS_TIMEOUT_MS,
          });
          const models = parseCursorModelsOutput(stdout);
          if (models.length === 0)
            throw new Error("cursor-agent models returned no entries");
          return models;
        }, CATALOG_TTL_MS);
        caches.set(command, cache);
      }
      return cache;
    };

    // NOTE: As of OpenClaw v2026.6.11, no code path consumes this provider
    // (verified: only registration/dedupe/snapshot handling touches it —
    // `models list` reads the declarative manifest `modelCatalog`, and
    // in-session model resolution passes the model id straight through to
    // `cursor-agent --model`, gated only by the `agents.defaults.models`
    // allowlist). Kept for forward compatibility with OpenClaw's unified
    // catalog in case a future version wires it up. Registered once per
    // backend id (`cursor-cli`, `cursor-mcp`) — model list is identical
    // across both, only the `provider` value on each entry differs.
    const registerModelCatalogFor = (backendId: string) => {
      api.registerModelCatalogProvider({
        provider: backendId,
        kinds: ["text"],
        staticCatalog: () =>
          toUnifiedCatalogEntries(
            buildCursorCliCatalogEntries(STATIC_FALLBACK_MODELS, backendId),
            "static",
          ),
        liveCatalog: async (ctx) => {
          try {
            const models = await cacheFor(
              resolveCursorCommandForCatalog(ctx.config, backendId),
            ).get();
            return toUnifiedCatalogEntries(
              buildCursorCliCatalogEntries(models, backendId),
              "live",
            );
          } catch {
            return toUnifiedCatalogEntries(
              buildCursorCliCatalogEntries(STATIC_FALLBACK_MODELS, backendId),
              "static",
            );
          }
        },
      });
    };
    registerModelCatalogFor(CURSOR_CLI_BACKEND_ID);
    registerModelCatalogFor(CURSOR_MCP_BACKEND_ID);

    // Separate PROVIDER plugin registration (distinct from the "cursor-cli"/
    // "cursor-mcp" CLI backend ids above) whose sole purpose is the
    // `augmentModelCatalog` hook: this is the mechanism OpenClaw's built-in
    // "anthropic" provider plugin uses to supply per-model `contextWindow`
    // for its "claude-cli" catalog rows (see `extensions/anthropic/cli-catalog.ts`'s
    // `buildClaudeCliCatalogEntries`, wired via `augmentModelCatalog: () =>
    // buildClaudeCliCatalogEntries()` in the anthropic provider's
    // `register.runtime` registration). One registration here covers both
    // backend ids: it returns catalog rows for `cursor-cli` and `cursor-mcp`
    // concatenated (same underlying model list, different `provider` tag per
    // row) — only the *registration* id is the distinct "cursor" so it
    // cannot collide with either CLI backend registration above.
    //
    // `auth: []` is intentional: this provider plugin has no separate
    // API-key/OAuth auth surface of its own (auth for actually running
    // cursor-agent is handled by the CLI backend registration and by
    // `cursor-agent login`'s own keychain-backed session, not by anything
    // OpenClaw's provider-auth system manages).
    api.registerProvider({
      id: "cursor",
      label: "Cursor CLI",
      auth: [],
      augmentModelCatalog: async (ctx) => {
        try {
          // Not tied to one backend run: fall back cursor-cli → cursor-mcp →
          // "cursor-agent" so a command override under either block keeps
          // the live catalog working.
          const models = await cacheFor(
            resolveCursorCommandForCatalog(ctx.config),
          ).get();
          return [
            ...buildCursorCliCatalogEntries(models, CURSOR_CLI_BACKEND_ID),
            ...buildCursorCliCatalogEntries(models, CURSOR_MCP_BACKEND_ID),
          ];
        } catch {
          return [
            ...buildCursorCliCatalogEntries(
              STATIC_FALLBACK_MODELS,
              CURSOR_CLI_BACKEND_ID,
            ),
            ...buildCursorCliCatalogEntries(
              STATIC_FALLBACK_MODELS,
              CURSOR_MCP_BACKEND_ID,
            ),
          ];
        }
      },
    });
  },
});
