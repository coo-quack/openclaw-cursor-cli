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
import { toCursorAgentModelId } from "./catalog.ts";

export const CURSOR_CLI_BACKEND_ID = "cursor-cli";
export const CURSOR_MCP_BACKEND_ID = "cursor-mcp";
export const CURSOR_MCP_DEFAULT_MODEL_REF = "cursor-mcp/grok-4.5-high-fast";

const CURSOR_MODEL_ARG = "--model";

/** Static OpenClaw short id → cursor-agent CLI id mappings (belt-and-suspenders). */
export const CURSOR_GROK_MODEL_ALIASES: Record<string, string> = {
  "grok-4.5-high-fast": "cursor-grok-4.5-high-fast",
  "grok-4.5-high": "cursor-grok-4.5-high",
};

/**
 * Rewrites or appends the CLI `--model` flag so cursor-agent receives its native id
 * (e.g. `cursor-grok-4.5-high-fast`, not OpenClaw's short `grok-4.5-high-fast`).
 */
export function applyCursorAgentModelToArgs(
  args: readonly string[],
  modelArg: string,
  openClawModelId: string,
): string[] {
  const cliModelId = toCursorAgentModelId(openClawModelId);
  const out = [...args];
  for (let i = 0; i < out.length; i += 1) {
    const arg = out[i];
    if (arg === modelArg) {
      if (i + 1 < out.length) {
        out[i + 1] = cliModelId;
        return out;
      }
      return [...out, modelArg, cliModelId];
    }
    if (typeof arg === "string" && arg.startsWith(`${modelArg}=`)) {
      out[i] = `${modelArg}=${cliModelId}`;
      return out;
    }
  }
  return [...out, modelArg, cliModelId];
}

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
// args for that mode; cursor-agent has no equivalent flag, so
// `resolveCursorCliExecutionArgs` intercepts those args (only when the
// backend that built them opted into `bundleMcp`), copies the generated
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

function extractMcpServers(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && isRecord(parsed.mcpServers))
      return parsed.mcpServers;
  } catch {
    // ignore malformed JSON; treat as empty
  }
  return {};
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
      backup:
        | { kind: "content"; raw: string }
        | { kind: "absent" }
        | { kind: "unreadable" };
      refCount: number;
      wrote: boolean;
    }
  >();

  /**
   * Helper to read mcp.json with error handling.
   * Returns { raw, servers } on success, null on ENOENT, or "SKIP" on non-ENOENT error (with warning).
   */
  function fallbackReadServers(
    filePath: string,
    onNonEnoent: (msg: string) => void,
  ): { raw: string; servers: Record<string, unknown> } | null | "SKIP" {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const servers = extractMcpServers(raw);
      return { raw, servers };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null; // signal ENOENT, caller handles escalation
      }
      const msg = `openclaw-cursor-cli: failed to read current mcp.json ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
      onNonEnoent(msg);
      return "SKIP"; // signal: skip write
    }
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
    const mcpConfigPath = extractClaudeMcpConfigPath(args);
    if (!mcpConfigPath) return [...args];
    let raw: string;
    try {
      raw = readFileSync(mcpConfigPath, "utf-8");
    } catch (error) {
      warn(
        `openclaw-cursor-cli: failed to read mcp-config ${mcpConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return stripClaudeMcpConfigArgs(args);
    }
    const generatedServers = extractMcpServers(raw);
    const targetPath = cursorMcpConfigPath(workspaceDir);
    const info = cursorMcpBridgeBackups.get(workspaceDir);
    let existingServers: Record<string, unknown>;

    // Switch on backup kind for exhaustiveness checking by TypeScript.
    switch (info?.backup?.kind) {
      case "content": {
        existingServers = extractMcpServers(info.backup.raw);
        break;
      }
      case "unreadable": {
        // Prepare detected unreadable; attempt fallback read
        const result = fallbackReadServers(targetPath, warn);
        if (result === "SKIP") {
          return stripClaudeMcpConfigArgs(args);
        }
        if (result === null) {
          // File was deleted between prepare and apply; upgrade backup to absent
          // so cleanup can unlink the bridged mcp.json instead of leaving it
          if (info) {
            info.backup = { kind: "absent" };
          }
          existingServers = {};
        } else {
          // Successful read: upgrade backup to content so cleanup can restore original
          if (info) {
            info.backup = { kind: "content", raw: result.raw };
          }
          existingServers = result.servers;
        }
        break;
      }
      case "absent":
      case undefined: {
        // info === undefined: No backup entry (prepare wasn't called).
        // info.backup.kind === "absent": Prepare ran and file didn't exist.
        // Either way, attempt fallback read to preserve user-defined servers.
        const result = fallbackReadServers(targetPath, warn);
        if (result === "SKIP") {
          return stripClaudeMcpConfigArgs(args);
        }
        existingServers = result?.servers ?? {};

        // Promote absent backup to content if fallback read succeeded.
        // Only promote if wrote === false (no prior write in this run),
        // since wrote === true means the file contains bridged config (with bearer token)
        // from a prior apply in the same run, which must be deleted on cleanup.
        if (
          info &&
          info.backup.kind === "absent" &&
          !info.wrote &&
          result !== null
        ) {
          info.backup = { kind: "content", raw: result.raw };
        }
        break;
      }
    }

    const merged = { mcpServers: { ...existingServers, ...generatedServers } };
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
      return stripClaudeMcpConfigArgs(args);
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
      let backup:
        | { kind: "content"; raw: string }
        | { kind: "absent" }
        | { kind: "unreadable" };
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
      backupInfo = { backup, refCount: 0, wrote: false };
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
    return {
      ...config,
      modelAliases: {
        ...CURSOR_GROK_MODEL_ALIASES,
        ...config.modelAliases,
      },
      modelArg: undefined,
    };
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
    modelAliases: {
      ...CURSOR_GROK_MODEL_ALIASES,
      ...config.modelAliases,
    },
    // Model is injected in resolveExecutionArgs so live-catalog grok-* variants
    // always map to cursor-agent's `cursor-grok-*` ids (normalizeCliModel aliases
    // alone cannot cover every live-catalog entry).
    modelArg: undefined,
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
   * Optional MCP bridge instance. If provided, its methods will be used
   * for the MCP bridge. If omitted, the default instance is used.
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
  const bridge = bundleMcp ? (mcpBridge ?? createCursorMcpBridge()) : mcpBridge;
  return {
    id,
    liveTest: {
      defaultModelRef: `${id}/grok-4.5-high-fast`,
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
      modelAliases: { ...CURSOR_GROK_MODEL_ALIASES },
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
      return applyCursorAgentModelToArgs(
        args,
        CURSOR_MODEL_ARG,
        context.modelId,
      );
    },
    ...(bundleMcp && bridge
      ? {
          bundleMcp: true,
          bundleMcpMode: "claude-config-file" as const,
          prepareExecution: (ctx) => bridge.prepareCursorCliExecution(ctx),
        }
      : {}),
  };
}
