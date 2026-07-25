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

/**
 * The models offered when `cursor-agent models` can't be reached. Also the
 * source for the static `modelCatalog` block in `openclaw.plugin.json`, which
 * is what `openclaw models list --all` reads — the runtime catalog hooks are
 * skipped when that command builds its catalog read-only. A test asserts the
 * two stay in step.
 */
export const STATIC_FALLBACK_MODELS: CursorModelEntry[] = [
  { id: "auto", name: "Auto" },
  { id: "cursor-grok-4.5-high-fast", name: "Cursor Grok 4.5 Fast" },
  { id: "cursor-grok-4.5-high", name: "Cursor Grok 4.5" },
  {
    id: "claude-sonnet-5-thinking-high",
    name: "Claude Sonnet 5 Thinking High",
  },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
];

export const DEFAULT_CONTEXT_WINDOW = 200000;

/**
 * Context window by model id prefix, taken from Cursor's own model table
 * (https://cursor.com/docs.md), "Default Context" column. These are what
 * Cursor serves, which is not the same as the vendor's headline number: Grok
 * 4.5 is a 500k model upstream but Cursor serves 256k, and the "1M" in names
 * like "Sonnet 5 1M" is the Max Mode ceiling, not the default.
 *
 * Max Mode is deliberately not modeled: it is a per-request mode this plugin
 * never selects, so quoting its ceiling would over-declare the window for
 * every ordinary turn.
 *
 * First matching prefix wins; ids that match nothing fall back to
 * DEFAULT_CONTEXT_WINDOW.
 */
const CONTEXT_WINDOW_BY_ID_PREFIX: ReadonlyArray<readonly [string, number]> = [
  // Cursor serves 256k even though Grok 4.5 is a 500k model upstream.
  ["cursor-grok-4.5", 256000],
  // Pre-rename ids; cursor-agent no longer lists them, kept for stale configs.
  ["grok-4.5", 256000],
  ["claude-opus-5", 300000],
  ["claude-opus-4-8", 300000],
  ["claude-fable-5", 300000],
  // Same as the default, but stated so the Max Mode 1M ceiling isn't read in.
  ["claude-sonnet-5", 200000],
  ["gpt-5", 272000],
  ["kimi-k2.7", 262000],
];

/**
 * Resolves the context window Cursor serves for a model id, by id prefix.
 * See CONTEXT_WINDOW_BY_ID_PREFIX and README "Per-model context windows".
 */
export function resolveCursorContextWindow(id: string): number {
  for (const [prefix, contextWindow] of CONTEXT_WINDOW_BY_ID_PREFIX)
    if (id.startsWith(prefix)) return contextWindow;
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
