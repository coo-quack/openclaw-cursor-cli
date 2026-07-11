import { CURSOR_CLI_BACKEND_ID } from "./backend.ts";
import type { buildCursorCliCatalogEntries } from "./catalog.ts";
import { OPENCLAW_CURSOR_AGENT_BIN_ENV } from "./cursor-agent-wrapper.ts";

// `buildCursorCliCatalogEntries` (src/catalog.ts) returns a small, independently
// tested domain shape (`id`/`name`/`reasoning`/`input`/`contextWindow`). The SDK's
// `UnifiedModelCatalogEntry` uses a different, larger shape (`kind`/`model`/`source`/...).
// Adapt at this boundary instead of reshaping catalog.ts, so the catalog module's
// runtime output (and its unit tests) stay unchanged.
export function toUnifiedCatalogEntries(
  entries: ReturnType<typeof buildCursorCliCatalogEntries>,
  source: "static" | "live",
) {
  return entries.map((entry) => ({
    kind: "text" as const,
    provider: entry.provider,
    model: entry.id,
    label: entry.name,
    source,
    capabilities: {
      reasoning: entry.reasoning,
      input: entry.input,
      contextWindow: entry.contextWindow,
    },
  }));
}

export function resolveCursorCommand(config: unknown): string {
  const block = (
    config as {
      agents?: {
        defaults?: {
          cliBackends?: Record<
            string,
            { command?: string; env?: Record<string, string> }
          >;
        };
      };
    }
  )?.agents?.defaults?.cliBackends?.[CURSOR_CLI_BACKEND_ID];

  const fromEnv = block?.env?.[OPENCLAW_CURSOR_AGENT_BIN_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  const command = block?.command;
  if (
    typeof command === "string" &&
    command.trim().length > 0 &&
    !command.includes("cursor-agent-wrapper")
  ) {
    return command.trim();
  }

  return "cursor-agent";
}
