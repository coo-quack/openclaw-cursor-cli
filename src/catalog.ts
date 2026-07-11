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
    if (!MODEL_ID_PATTERN.test(id) || name.length === 0 || seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, name });
  }
  return entries;
}

const DEFAULT_CONTEXT_WINDOW = 200000;

export function buildCursorCliCatalogEntries(models: CursorModelEntry[]) {
  return models.map((model) => ({
    id: model.id,
    name: `${model.name} (Cursor CLI)`,
    provider: "cursor-cli",
    reasoning: true,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }));
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
