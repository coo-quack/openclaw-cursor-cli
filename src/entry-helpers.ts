import {
  CURSOR_CLI_BACKEND_ID,
  CURSOR_MCP_BACKEND_ID,
  isCursorAgentWrapperCommand,
} from "./backend.ts";
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

/** Returns the explicitly configured cursor-agent command for one backend id, or undefined if none. */
function resolveConfiguredCursorCommand(
  config: unknown,
  backendId: string,
): string | undefined {
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
  )?.agents?.defaults?.cliBackends?.[backendId];

  const fromEnv = block?.env?.[OPENCLAW_CURSOR_AGENT_BIN_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  const command = block?.command;
  if (
    typeof command === "string" &&
    command.trim().length > 0 &&
    !isCursorAgentWrapperCommand(command.trim())
  ) {
    return command.trim();
  }

  return undefined;
}

export function resolveCursorCommand(
  config: unknown,
  backendId: string = CURSOR_CLI_BACKEND_ID,
): string {
  return resolveConfiguredCursorCommand(config, backendId) ?? "cursor-agent";
}

/**
 * Command resolution for catalog fetches (`cursor-agent models`), which are
 * not tied to a single backend run: prefer the given backend id's
 * `cliBackends` block, then fall back to the other backend id's block, then
 * to plain `cursor-agent`. This keeps the live catalog working when an
 * operator overrides `command` under only one of `cursor-cli`/`cursor-mcp`
 * (both backend ids front the same binary, so any configured path is valid
 * for listing models).
 */
export function resolveCursorCommandForCatalog(
  config: unknown,
  preferredBackendId: string = CURSOR_CLI_BACKEND_ID,
): string {
  const order = [
    preferredBackendId,
    ...[CURSOR_CLI_BACKEND_ID, CURSOR_MCP_BACKEND_ID].filter(
      (id) => id !== preferredBackendId,
    ),
  ];
  for (const backendId of order) {
    const command = resolveConfiguredCursorCommand(config, backendId);
    if (command !== undefined) return command;
  }
  return "cursor-agent";
}
