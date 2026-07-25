import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CliBackendConfig,
  CliBackendPlugin,
  CliBackendPreparedExecution,
  CliBackendPrepareExecutionContext,
} from "openclaw/plugin-sdk/cli-backend";
import { OPENCLAW_CURSOR_AGENT_BIN_ENV } from "./cursor-agent-wrapper.ts";

export const CURSOR_CLI_BACKEND_ID = "cursor-cli";
export const CURSOR_MCP_BACKEND_ID = "cursor-mcp";
export const CURSOR_MCP_DEFAULT_MODEL_REF =
  "cursor-mcp/cursor-grok-4.5-high-fast";

export const CURSOR_BACKEND_VARIANTS = [
  { id: CURSOR_CLI_BACKEND_ID, bundleMcp: false },
  { id: CURSOR_MCP_BACKEND_ID, bundleMcp: true },
] as const;

const CURSOR_CLI_BASE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--trust",
  "--force",
] as const;

// Two backend ids share this module: `cursor-cli` (bundleMcp: false, the
// safe text-only default) and `cursor-mcp` (bundleMcp: true, always-on).
// Bridges OpenClaw's "bundle MCP" loopback tool server (normally wired for
// the claude-cli/codex-cli/gemini-cli backends) into cursor-agent by
// piggybacking on the "claude-config-file" bundle mode. OpenClaw writes a
// throwaway `--strict-mcp-config --mcp-config <path>` pair into the backend
// args for that mode; cursor-agent has no equivalent flag, so the backend's
// `resolveExecutionArgs` hands those args to `applyCursorMcpBridge` (only when
// the backend that built them opted into `bundleMcp`), which copies the generated
// `{ mcpServers: { openclaw: { url, headers } } }` config into the
// workspace's `.cursor/mcp.json` (merging with any pre-existing file, which
// `prepareCursorCliExecution`'s cleanup restores afterwards), strips the
// unsupported Claude-shaped flags, and adds `--approve-mcps` so cursor-agent
// doesn't block headlessly on the new server's first-use prompt.
//
// Using `cursor-mcp/<model>` (rather than a global env toggle) is opt-in per
// turn/session: only sessions explicitly pinned to `cursor-mcp/*` get
// OpenClaw's MCP tool surface (including subagent delegation via
// `sessions_spawn`/`subagents`); `cursor-cli/*` stays text-only.
//
// See docs/notes/2026-07-11-mcp-bridge-investigation.md for the underlying
// bridge investigation and live verification.
const LEGACY_MCP_BRIDGE_ENV = "OPENCLAW_CURSOR_CLI_MCP_BRIDGE";

let warnedAboutLegacyMcpBridgeEnv = false;

/** Test-only: clears the "already warned" latch so tests can re-trigger the warning. */
export function resetLegacyMcpBridgeEnvWarningForTest(): void {
  warnedAboutLegacyMcpBridgeEnv = false;
}

export type MinimalWarnLogger = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

/**
 * `OPENCLAW_CURSOR_CLI_MCP_BRIDGE` (the old global on/off toggle) is
 * deprecated in favor of the `cursor-mcp/<model>` opt-in backend. If the env
 * var is still set at startup, warn once (not an error — the var is simply
 * ignored now) so operators know to switch to `/model cursor-mcp/<model>`.
 */
export function warnIfLegacyMcpBridgeEnvSet(
  env: NodeJS.ProcessEnv,
  logger: MinimalWarnLogger,
): void {
  if (warnedAboutLegacyMcpBridgeEnv) return;
  if (env[LEGACY_MCP_BRIDGE_ENV] === undefined) return;
  warnedAboutLegacyMcpBridgeEnv = true;
  logger.warn(
    `${LEGACY_MCP_BRIDGE_ENV} is deprecated and is no longer read. ` +
      `Use "${CURSOR_MCP_BACKEND_ID}/<model>" (for example "/model ${CURSOR_MCP_DEFAULT_MODEL_REF}") ` +
      `to opt into OpenClaw's MCP tool bridge instead of a global toggle.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cursorMcpConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, ".cursor", "mcp.json");
}

function stripResumeArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--resume" || arg === "--continue") {
      const next = args[i + 1];
      // Only consume the following token as --resume's value if it doesn't look like a flag,
      // so a missing/omitted session id doesn't cause the next flag to be swallowed.
      if (
        arg === "--resume" &&
        typeof next === "string" &&
        !next.startsWith("-")
      )
        i += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

export type CursorMcpBridge = ReturnType<typeof createCursorMcpBridge>;

export type CursorMcpBridgeOptions = {
  /** Optional logger for warnings. */
  warn?: (message: string) => void;
};

/**
 * The workspace's `.cursor/mcp.json` as it stood when the first prepare for
 * that workspace ran, and therefore what cleanup must put back:
 * - `content`: the file existed and was read; restore `raw`
 * - `absent`: the file did not exist; delete whatever the bridge wrote
 * - `unreadable`: the file existed but could not be read; leave it alone
 */
type McpBackupState =
  | { kind: "content"; raw: string }
  | { kind: "absent" }
  | { kind: "unreadable" };

/** Outcome of re-reading `.cursor/mcp.json` when the prepare-time backup can't supply it. */
type FallbackRead =
  | ({ kind: "read"; raw: string } & McpDocument)
  | { kind: "missing" }
  | { kind: "failed" };

/** Finds the value of Claude-style `--mcp-config <path>` / `--mcp-config=<path>` in args. */
export function extractClaudeMcpConfigPath(
  args: readonly string[],
): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--mcp-config") return args[i + 1];
    if (typeof arg === "string" && arg.startsWith("--mcp-config="))
      return arg.slice("--mcp-config=".length);
  }
  return undefined;
}

/**
 * True when OpenClaw injected the Claude-shaped bundle-MCP flags at all,
 * regardless of whether `--mcp-config` carries a usable path. Distinguishes
 * "no bridge was requested" from "a bridge was requested but is malformed":
 * the first must pass args through untouched, the second must still strip the
 * flags, since cursor-agent rejects them.
 */
function hasClaudeMcpConfigArgs(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--strict-mcp-config" ||
      arg === "--mcp-config" ||
      (typeof arg === "string" && arg.startsWith("--mcp-config=")),
  );
}

/** Removes Claude-only `--strict-mcp-config` / `--mcp-config <path>` flags cursor-agent doesn't support. */
export function stripClaudeMcpConfigArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--strict-mcp-config") continue;
    if (arg === "--mcp-config") {
      i += 1;
      continue;
    }
    if (typeof arg === "string" && arg.startsWith("--mcp-config=")) continue;
    out.push(arg);
  }
  return out;
}

/**
 * A parsed mcp.json. `doc` is the whole top-level object, kept so a rewrite can
 * put back keys the bridge doesn't understand (`$schema`, editor settings, …)
 * instead of reducing the file to `mcpServers`.
 *
 * `unparseable` covers anything the bridge can't safely rewrite: not JSON at
 * all (a JSONC file with comments lands here), not an object, or an
 * `mcpServers` that isn't an object. Callers must skip the write in that case
 * rather than treat it as an empty config, because writing would replace
 * content the bridge failed to understand.
 */
type McpDocument = {
  doc: Record<string, unknown>;
  servers: Record<string, unknown>;
};

const EMPTY_MCP_DOCUMENT: McpDocument = { doc: {}, servers: {} };

type ParsedMcpFile =
  | ({ kind: "parsed" } & McpDocument)
  | { kind: "unparseable" };

function parseMcpFile(raw: string): ParsedMcpFile {
  // A leading byte-order mark isn't valid JSON but says nothing about the
  // content, which is otherwise fine. Strip it rather than declining over it.
  const text = raw.replace(/^\uFEFF/, "");
  // An empty or whitespace-only file holds nothing to preserve, so it is an
  // empty config rather than content the bridge failed to understand.
  if (text.trim() === "") return { kind: "parsed", ...EMPTY_MCP_DOCUMENT };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unparseable" };
  }
  if (!isRecord(parsed)) return { kind: "unparseable" };
  const servers = parsed.mcpServers;
  // `null` carries no server data, the same as the key being absent. Any other
  // non-object is data the bridge can't interpret, so it declines instead.
  if (servers === undefined || servers === null)
    return { kind: "parsed", doc: parsed, servers: {} };
  if (!isRecord(servers)) return { kind: "unparseable" };
  return { kind: "parsed", doc: parsed, servers };
}

const UNPARSEABLE_SHAPE =
  `as a JSON object whose "mcpServers" is an object ` +
  `(comments are not valid JSON)`;

/** For the workspace's own config, which the bridge would otherwise rewrite. */
function unparseableWorkspaceMessage(filePath: string): string {
  return (
    `openclaw-cursor-cli: could not parse ${filePath} ${UNPARSEABLE_SHAPE}; ` +
    `leaving it untouched and running without the MCP bridge`
  );
}

/** For OpenClaw's throwaway bundle-MCP config, which the bridge only reads. */
function unparseableGeneratedMessage(filePath: string): string {
  return (
    `openclaw-cursor-cli: could not parse the generated mcp-config ${filePath} ` +
    `${UNPARSEABLE_SHAPE}; running without the MCP bridge`
  );
}

/**
 * Creates an isolated MCP bridge with its own backup state.
 * Each instance maintains a separate map of workspace backup states,
 * allowing tests to create isolated instances without global state.
 */
export function createCursorMcpBridge(options: CursorMcpBridgeOptions = {}) {
  const warn = options.warn ?? (() => {});

  // Keyed by workspaceDir. Populated by prepareExecution (which runs first and
  // can see the pre-existing `.cursor/mcp.json`, if any) and read by
  // resolveExecutionArgs (which runs later and has the actual bundle MCP
  // config to merge in, via baseArgs).
  //
  // Multiple prepare/cleanup pairs for the same workspace can race (e.g., nested
  // agent runs sharing a workspace). Solution: use reference counting so the
  // first prepare captures the original state, and the last cleanup restores it.
  // Concurrent prepares increment the count; concurrent cleanups decrement and
  // delete only when count reaches 0.
  //
  // Three-state backup tracking:
  // - kind: "content" (file exists, successfully read): restore with raw content
  // - kind: "absent" (file didn't exist at prepare time): delete if exists at cleanup
  // - kind: "unreadable" (file exists but unreadable): do nothing at cleanup
  //
  // The wrote flag is set before attempting write, so cleanup can restore the
  // backup even if write fails (preventing data loss on partial failure).
  // Cleanup only restores/deletes if wrote === true.
  const cursorMcpBridgeBackups = new Map<
    string,
    {
      backup: McpBackupState;
      refCount: number;
      /** An apply *attempted* a write. Drives cleanup, so partial failures still restore. */
      wrote: boolean;
      /**
       * An apply *completed* a write, so the bridged server really is on disk.
       * Narrower than `wrote` on purpose: a failed write leaves nothing to
       * approve, while a successful one must stay approved even if a later
       * apply in the same run declines.
       */
      bridgedOnDisk: boolean;
    }
  >();

  /**
   * Reads the workspace's mcp.json when the prepare-time backup can't supply
   * its contents. `missing` means the file is gone (ENOENT); `failed` means it
   * exists but could not be read or parsed, and the caller must skip the write.
   */
  function fallbackReadMcpFile(filePath: string): FallbackRead {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "missing" };
      }
      warn(
        `openclaw-cursor-cli: failed to read current mcp.json ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { kind: "failed" };
    }
    const parsed = parseMcpFile(raw);
    if (parsed.kind === "unparseable") {
      warn(unparseableWorkspaceMessage(filePath));
      return { kind: "failed" };
    }
    return { kind: "read", raw, doc: parsed.doc, servers: parsed.servers };
  }

  /**
   * Rewrites OpenClaw's bundle-MCP-injected args into cursor-agent's shape:
   * reads the temp Claude-style mcp-config file OpenClaw generated, merges its
   * `openclaw` server entry into the workspace's `.cursor/mcp.json` (on top of
   * any servers backed up from a pre-existing file), strips the unsupported
   * `--strict-mcp-config`/`--mcp-config` flags, and adds `--approve-mcps`.
   * No-ops (aside from stripping) if no bundle MCP config was injected.
   */
  function applyCursorMcpBridge(
    args: readonly string[],
    workspaceDir: string,
  ): string[] {
    const targetPath = cursorMcpConfigPath(workspaceDir);
    const info = cursorMcpBridgeBackups.get(workspaceDir);

    /**
     * Give up on bridging this call: drop the Claude-only flags and let the
     * turn run as if no bundle MCP config had been injected.
     *
     * `--approve-mcps` survives when an earlier apply in this run already
     * wrote the bridged config, because that server is still on disk for
     * cursor-agent to find. Dropping the flag there would leave it waiting on
     * an interactive approval prompt, which is the headless hang the flag
     * exists to prevent.
     */
    const decline = (): string[] => {
      const stripped = stripClaudeMcpConfigArgs(args);
      if (!info?.bridgedOnDisk || stripped.includes("--approve-mcps"))
        return stripped;
      return [...stripped, "--approve-mcps"];
    };

    const mcpConfigPath = extractClaudeMcpConfigPath(args);
    if (!mcpConfigPath) {
      // Nothing was injected: this is an ordinary turn, pass it through.
      if (!hasClaudeMcpConfigArgs(args)) return [...args];
      // Injected, but `--mcp-config` carries no path. Passing the Claude-only
      // flags on would make cursor-agent fail on an unknown option.
      warn(
        `openclaw-cursor-cli: bundle MCP flags carry no --mcp-config path; ` +
          `stripping them and running without the MCP bridge`,
      );
      return decline();
    }

    let raw: string;
    try {
      raw = readFileSync(mcpConfigPath, "utf-8");
    } catch (error) {
      warn(
        `openclaw-cursor-cli: failed to read mcp-config ${mcpConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return decline();
    }
    const generated = parseMcpFile(raw);
    if (generated.kind === "unparseable") {
      warn(unparseableGeneratedMessage(mcpConfigPath));
      return decline();
    }
    const generatedServers = generated.servers;

    /**
     * Re-reads the workspace config when the prepare-time backup cannot supply
     * it, and promotes the backup to whatever it finds so cleanup restores
     * that rather than the state prepare recorded. Reached from the
     * `unreadable` and `absent` cases, which differ only in what prepare saw,
     * not in what apply has to do about it.
     */
    const readExistingFromDisk = (): McpDocument | "declined" => {
      const result = fallbackReadMcpFile(targetPath);
      if (result.kind === "failed") return "declined";
      if (result.kind === "missing") {
        // Nothing on disk: cleanup should unlink whatever the bridge writes
        // rather than leave it. (Already `absent` in the absent case.)
        if (info) info.backup = { kind: "absent" };
        return EMPTY_MCP_DOCUMENT;
      }
      if (info) info.backup = { kind: "content", raw: result.raw };
      return { doc: result.doc, servers: result.servers };
    };

    // The whole pre-existing document, so keys the bridge doesn't own
    // (`$schema`, editor settings, …) survive the rewrite.
    let existing: McpDocument;

    // Switch on backup kind for exhaustiveness checking by TypeScript.
    switch (info?.backup?.kind) {
      case "content": {
        const parsed = parseMcpFile(info.backup.raw);
        if (parsed.kind === "unparseable") {
          // Rewriting would drop content this code failed to understand, and
          // the raw backup only gets restored if cleanup runs. Leave it alone.
          warn(unparseableWorkspaceMessage(targetPath));
          return decline();
        }
        existing = { doc: parsed.doc, servers: parsed.servers };
        break;
      }
      case "unreadable":
      case "absent":
      case undefined: {
        // info === undefined: No backup entry (prepare wasn't called).
        // "unreadable": prepare couldn't read the file.
        // "absent": prepare ran and the file didn't exist.
        // In each case the backup can't supply the current contents, so read
        // them from disk to preserve user-defined servers.

        // Exception: a prior apply in this same run already wrote the bridged
        // config (wrote === true) while the backup still says the file was
        // absent, so anything on disk now is this bridge's own output. Reading
        // it back would merge a previous run's generated servers — including a
        // stale bearer token entry no longer in `generatedServers` — into the
        // new file. Treat it as empty: there is no user-owned content to keep.
        if (info?.backup.kind === "absent" && info.wrote) {
          existing = EMPTY_MCP_DOCUMENT;
          break;
        }

        const fromDisk = readExistingFromDisk();
        if (fromDisk === "declined") return decline();
        existing = fromDisk;
        break;
      }
    }

    const merged = {
      ...existing.doc,
      mcpServers: { ...existing.servers, ...generatedServers },
    };
    try {
      // Mark as attempted write before the write, so partial failures
      // (ENOSPC, etc.) still set wrote=true and allow cleanup to restore backup
      if (info) {
        info.wrote = true;
      }
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(
        targetPath,
        `${JSON.stringify(merged, null, 2)}\n`,
        "utf-8",
      );
    } catch (error) {
      // Same posture as a missing/unreadable Claude mcp-config: strip unsupported
      // flags and continue without the bridge rather than crashing the run.
      // Log a minimal warning so operators can diagnose mcp.json setup issues.
      const msg = `openclaw-cursor-cli: failed to write ${targetPath}: ${error instanceof Error ? error.message : String(error)}`;
      warn(msg);
      return decline();
    }
    // The bridged server is now really on disk, so a later apply in this run
    // must keep approving it even if that apply declines.
    if (info) {
      info.bridgedOnDisk = true;
    }
    const stripped = stripClaudeMcpConfigArgs(args);
    return stripped.includes("--approve-mcps")
      ? stripped
      : [...stripped, "--approve-mcps"];
  }

  /**
   * Backs up any pre-existing `.cursor/mcp.json` in the workspace before the
   * bridge overwrites it, and restores (or removes) it once the run completes.
   * Only registered when the MCP bridge is enabled.
   *
   * Three-state backup tracking (content/absent/unreadable)
   * Cleanup behavior by state (restore on wrote=true only)
   */
  function prepareCursorCliExecution(
    ctx: CliBackendPrepareExecutionContext,
  ): CliBackendPreparedExecution {
    const targetPath = cursorMcpConfigPath(ctx.workspaceDir);

    // Back up the original state on the first prepare for this workspace.
    // If a backup already exists (concurrent/nested prepare), increment its
    // reference count so the last cleanup will restore (not the first).
    let backupInfo = cursorMcpBridgeBackups.get(ctx.workspaceDir);
    if (!backupInfo) {
      let backup: McpBackupState;
      try {
        const content = readFileSync(targetPath, "utf-8");
        backup = { kind: "content", raw: content };
      } catch (error) {
        // ENOENT (file not found) is normal for a fresh workspace; don't warn.
        // Other errors (EACCES, etc.) are unreadable; mark them and warn.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          backup = { kind: "absent" };
        } else {
          const msg = `openclaw-cursor-cli: failed to read ${targetPath}: ${error instanceof Error ? error.message : String(error)}`;
          warn(msg);
          backup = { kind: "unreadable" };
        }
      }
      backupInfo = { backup, refCount: 0, wrote: false, bridgedOnDisk: false };
      cursorMcpBridgeBackups.set(ctx.workspaceDir, backupInfo);
    }
    // Increment the reference count for this prepare
    backupInfo.refCount += 1;

    // Each cleanup decrements the reference count. When it reaches 0,
    // restore the backup and delete the entry.
    let cleanupRan = false;
    return {
      cleanup: async () => {
        if (cleanupRan) return; // Safety: only run once per prepared execution
        cleanupRan = true;

        const info = cursorMcpBridgeBackups.get(ctx.workspaceDir);
        if (!info) return; // Already cleaned up by another cleanup

        info.refCount -= 1;
        const isLastCleanup = info.refCount === 0;

        // Only restore the file and delete the backup entry on the last cleanup.
        // Intermediate cleanups (from nested/concurrent runs) just decrement the
        // count and return, leaving the file as-is so outer runs complete normally.
        // Only restore/delete if wrote === true
        if (isLastCleanup && info.wrote) {
          try {
            if (info.backup.kind === "content") {
              writeFileSync(targetPath, info.backup.raw, "utf-8");
            } else if (
              info.backup.kind === "absent" &&
              existsSync(targetPath)
            ) {
              unlinkSync(targetPath);
            }
            // kind === "unreadable": do nothing; don't touch unreadable files
          } catch (error) {
            // best-effort restore; don't fail the run over cleanup.
            // Log a minimal warning so operators can diagnose cleanup issues.
            const msg = `openclaw-cursor-cli: failed to restore ${targetPath}: ${error instanceof Error ? error.message : String(error)}`;
            warn(msg);
          }
        }

        if (isLastCleanup) {
          cursorMcpBridgeBackups.delete(ctx.workspaceDir);
        }
      },
    };
  }

  return {
    applyCursorMcpBridge,
    prepareCursorCliExecution,
  };
}

export function resolveCursorAgentWrapperPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "cursor-agent-wrapper.ts",
  );
}

/** True when two filesystem paths resolve to the same absolute location. */
export function pathsEqual(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Basename-only classification: any path whose final segment is the wrapper
 * filename. Use for "do not treat this as the real cursor-agent binary".
 * Do not use for identity / idempotent skip — use `isThisPackageCursorAgentWrapper`.
 */
export function isCursorAgentWrapperCommand(command: string): boolean {
  return path.basename(command) === "cursor-agent-wrapper.ts";
}

/** True when `command` is exactly this package's wrapper (cwd-relative OK). */
export function isThisPackageCursorAgentWrapper(command: string): boolean {
  return pathsEqual(command, resolveCursorAgentWrapperPath());
}

/** Rewrite user/plugin command to the stdin wrapper; stash the real binary in env. */
export function normalizeCursorCliConfig(
  config: CliBackendConfig,
): CliBackendConfig {
  const wrapperPath = resolveCursorAgentWrapperPath();
  const configured =
    typeof config.command === "string" && config.command.trim().length > 0
      ? config.command.trim()
      : "cursor-agent";
  const existingBin = config.env?.[OPENCLAW_CURSOR_AGENT_BIN_ENV]?.trim();

  // Only skip when already pointing at *this* package's wrapper. A same-basename
  // path elsewhere must still be rewritten so banner injection cannot be bypassed.
  if (isThisPackageCursorAgentWrapper(configured) && existingBin) {
    return config;
  }

  const realBin =
    existingBin ||
    (isCursorAgentWrapperCommand(configured) ? "cursor-agent" : configured);

  return {
    ...config,
    command: wrapperPath,
    env: {
      ...config.env,
      [OPENCLAW_CURSOR_AGENT_BIN_ENV]: realBin,
    },
  };
}

export type CursorCliBackendOptions = {
  /** Backend id, used as the model-ref provider prefix (`<id>/<model>`). */
  id: string;
  /**
   * Whether this backend instance opts into OpenClaw's bundle-MCP bridge.
   * `cursor-cli` sets this `false` (safe, text-only default); `cursor-mcp`
   * sets this `true` (always-on opt-in, selected only via `/model
   * cursor-mcp/<model>`).
   */
  bundleMcp: boolean;
  /**
   * MCP bridge instance to use when `bundleMcp` is true. Omit it and the
   * backend creates its own; pass one to share (or observe) bridge state, as
   * `src/index.ts` does to inject a logger. Ignored when `bundleMcp` is false,
   * since that backend never touches `.cursor/mcp.json`.
   */
  mcpBridge?: CursorMcpBridge;
};

export function buildCursorCliBackend(
  options: CursorCliBackendOptions = {
    id: CURSOR_CLI_BACKEND_ID,
    bundleMcp: false,
  },
): CliBackendPlugin {
  const { id, bundleMcp, mcpBridge } = options;
  const bridge = bundleMcp ? (mcpBridge ?? createCursorMcpBridge()) : undefined;
  return {
    id,
    liveTest: {
      defaultModelRef: `${id}/cursor-grok-4.5-high-fast`,
      defaultImageProbe: false,
      defaultMcpProbe: false,
    },
    nativeToolMode: "always-on",
    sideQuestionToolMode: "disabled",
    config: {
      command: "cursor-agent",
      args: [...CURSOR_CLI_BASE_ARGS],
      resumeArgs: [...CURSOR_CLI_BASE_ARGS, "--resume", "{sessionId}"],
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      input: "stdin",
      modelArg: "--model",
      sessionMode: "existing",
      sessionIdFields: ["session_id"],
      systemPromptWhen: "never",
      serialize: true,
    },
    normalizeConfig: normalizeCursorCliConfig,
    resolveExecutionArgs: (context) => {
      let args =
        context.executionMode === "side-question"
          ? [...stripResumeArgs(context.baseArgs), "--mode", "ask"]
          : [...context.baseArgs];
      if (bundleMcp && context.workspaceDir && bridge) {
        args = bridge.applyCursorMcpBridge(args, context.workspaceDir);
      }
      return args;
    },
    ...(bundleMcp && bridge
      ? {
          bundleMcp: true,
          bundleMcpMode: "claude-config-file" as const,
          prepareExecution: bridge.prepareCursorCliExecution,
        }
      : {}),
  };
}
