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
export const CURSOR_MCP_DEFAULT_MODEL_REF = "cursor-mcp/grok-4.5-fast-xhigh";

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

// Keyed by workspaceDir. Populated by prepareExecution (which runs first and
// can see the pre-existing `.cursor/mcp.json`, if any) and read by
// resolveExecutionArgs (which runs later and has the actual bundle MCP
// config to merge in, via baseArgs).
const cursorMcpBridgeBackups = new Map<string, string | null>();

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
 * Rewrites OpenClaw's bundle-MCP-injected args into cursor-agent's shape:
 * reads the temp Claude-style mcp-config file OpenClaw generated, merges its
 * `openclaw` server entry into the workspace's `.cursor/mcp.json` (on top of
 * any servers backed up from a pre-existing file), strips the unsupported
 * `--strict-mcp-config`/`--mcp-config` flags, and adds `--approve-mcps`.
 * No-ops (aside from stripping) if no bundle MCP config was injected.
 */
export function applyCursorMcpBridge(
  args: readonly string[],
  workspaceDir: string,
): string[] {
  const mcpConfigPath = extractClaudeMcpConfigPath(args);
  if (!mcpConfigPath) return [...args];
  let raw: string;
  try {
    raw = readFileSync(mcpConfigPath, "utf-8");
  } catch {
    return stripClaudeMcpConfigArgs(args);
  }
  const generatedServers = extractMcpServers(raw);
  const backup = cursorMcpBridgeBackups.get(workspaceDir);
  const existingServers =
    typeof backup === "string" ? extractMcpServers(backup) : {};
  const merged = { mcpServers: { ...existingServers, ...generatedServers } };
  const targetPath = cursorMcpConfigPath(workspaceDir);
  try {
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  } catch {
    // Same posture as a missing/unreadable Claude mcp-config: strip unsupported
    // flags and continue without the bridge rather than crashing the run.
    return stripClaudeMcpConfigArgs(args);
  }
  const stripped = stripClaudeMcpConfigArgs(args);
  return stripped.includes("--approve-mcps")
    ? stripped
    : [...stripped, "--approve-mcps"];
}

export function resolveCursorCliExecutionArgs(context: {
  executionMode?: string;
  baseArgs: readonly string[];
  workspaceDir?: string;
  /** Whether the backend that produced this call opted into the MCP bridge (`bundleMcp: true`). */
  bundleMcp?: boolean;
}): string[] {
  let args =
    context.executionMode === "side-question"
      ? [...stripResumeArgs(context.baseArgs), "--mode", "ask"]
      : [...context.baseArgs];
  if (context.bundleMcp && context.workspaceDir) {
    args = applyCursorMcpBridge(args, context.workspaceDir);
  }
  return args;
}

/**
 * Backs up any pre-existing `.cursor/mcp.json` in the workspace before the
 * bridge overwrites it, and restores (or removes) it once the run completes.
 * Only registered when the MCP bridge is enabled.
 */
export function prepareCursorCliExecution(
  ctx: CliBackendPrepareExecutionContext,
): CliBackendPreparedExecution {
  const targetPath = cursorMcpConfigPath(ctx.workspaceDir);
  let original: string | null = null;
  try {
    original = readFileSync(targetPath, "utf-8");
  } catch {
    original = null;
  }
  cursorMcpBridgeBackups.set(ctx.workspaceDir, original);
  return {
    cleanup: async () => {
      const backup = cursorMcpBridgeBackups.get(ctx.workspaceDir);
      cursorMcpBridgeBackups.delete(ctx.workspaceDir);
      try {
        if (typeof backup === "string") {
          writeFileSync(targetPath, backup, "utf-8");
        } else if (existsSync(targetPath)) {
          unlinkSync(targetPath);
        }
      } catch {
        // best-effort restore; don't fail the run over cleanup
      }
    },
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
};

export function buildCursorCliBackend(
  options: CursorCliBackendOptions = {
    id: CURSOR_CLI_BACKEND_ID,
    bundleMcp: false,
  },
): CliBackendPlugin {
  const { id, bundleMcp } = options;
  return {
    id,
    liveTest: {
      defaultModelRef: `${id}/grok-4.5-fast-xhigh`,
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
    resolveExecutionArgs: (context) =>
      resolveCursorCliExecutionArgs({ ...context, bundleMcp }),
    ...(bundleMcp
      ? {
          bundleMcp: true,
          bundleMcpMode: "claude-config-file" as const,
          prepareExecution: prepareCursorCliExecution,
        }
      : {}),
  };
}
