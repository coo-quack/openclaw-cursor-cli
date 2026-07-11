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
import { resolveCursorCommand, toUnifiedCatalogEntries } from "./entry-helpers.ts";

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
      staticCatalog: () =>
        toUnifiedCatalogEntries(buildCursorCliCatalogEntries(STATIC_FALLBACK_MODELS), "static"),
      liveCatalog: async (ctx) => {
        try {
          const models = await cacheFor(resolveCursorCommand(ctx.config)).get();
          return toUnifiedCatalogEntries(buildCursorCliCatalogEntries(models), "live");
        } catch {
          return toUnifiedCatalogEntries(
            buildCursorCliCatalogEntries(STATIC_FALLBACK_MODELS),
            "static",
          );
        }
      },
    });
  },
});
