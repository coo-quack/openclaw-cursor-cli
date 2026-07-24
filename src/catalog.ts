export type CursorModelEntry = { id: string; name: string };

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/i;

export function parseCursorModelsOutput(output: string): CursorModelEntry[] {
  const entries: CursorModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const sep = line.indexOf(" - ");
    if (sep <= 0) continue;
    const id = line.slice(0, sep).trim();
    const name = line.slice(sep + 3).trim();
    if (!MODEL_ID_PATTERN.test(id) || name.length === 0 || seen.has(id))
      continue;
    seen.add(id);
    entries.push({ id, name });
  }
  return entries;
}

export const DEFAULT_CONTEXT_WINDOW = 200000;

/**
 * Resolves the published context window for a Cursor CLI model id, by id prefix.
 *
 * Sources (see README "Per-model context windows" for links):
 * - "grok-4.5*" or "cursor-grok-4.5*": 500k (OpenRouter / llmreference Grok 4.5 listing)
 * - "claude-sonnet-5*": 200k (Cursor's standard/non-max serving cap)
 * - "gpt-5*": 400k (published OpenAI GPT-5-family vendor window)
 * - everything else (including "auto"): DEFAULT_CONTEXT_WINDOW (200k)
 */
export function resolveCursorContextWindow(id: string): number {
  if (id.startsWith("grok-4.5") || id.startsWith("cursor-grok-4.5"))
    return 500000;
  if (id.startsWith("claude-sonnet-5")) return 200000;
  if (id.startsWith("gpt-5")) return 400000;
  return DEFAULT_CONTEXT_WINDOW;
}

export function buildCursorCliCatalogEntries(
  models: CursorModelEntry[],
  provider = "cursor-cli",
) {
  return models.map((model) => {
    // Typed as a mutable `Array<"text">` (rather than the widened `string[]`
    // TS would otherwise infer) so this structurally matches OpenClaw's
    // `ModelCatalogEntry.input?: ModelInputType[]` field at the
    // `augmentModelCatalog` boundary in src/index.ts, without importing that
    // type here and coupling this domain module to the SDK.
    const input: Array<"text"> = ["text"];
    return {
      id: model.id,
      name: `${model.name} (Cursor CLI)`,
      provider,
      reasoning: true,
      input,
      contextWindow: resolveCursorContextWindow(model.id),
    };
  });
}

export function createCursorModelsCache(
  fetcher: () => Promise<CursorModelEntry[]>,
  ttlMs: number,
  now: () => number = Date.now,
) {
  let cached: CursorModelEntry[] | null = null;
  let fetchedAt = -Infinity;
  return {
    async get(): Promise<CursorModelEntry[]> {
      if (cached && now() - fetchedAt <= ttlMs) return cached;
      try {
        cached = await fetcher();
        fetchedAt = now();
      } catch (error) {
        if (!cached) throw error;
      }
      return cached;
    },
  };
}
