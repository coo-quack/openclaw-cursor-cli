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
export const CURSOR_CLI_DEFAULT_MODEL_REF = "cursor-cli/grok-4.5-fast-xhigh";

const CURSOR_CLI_BASE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--trust",
  "--force",
] as const;

// Experimental, default-off: bridges OpenClaw's "bundle MCP" loopback tool
// server (normally wired for the claude-cli/codex-cli/gemini-cli backends)
// into cursor-agent by piggybacking on the "claude-config-file" bundle mode.
// OpenClaw writes a throwaway `--strict-mcp-config --mcp-config <path>`
// pair into the backend args for that mode; cursor-agent has no equivalent
// flag, so `resolveCursorCliExecutionArgs` intercepts those args, copies the
// generated `{ mcpServers: { openclaw: { url, headers } } }` config into the
// workspace's `.cursor/mcp.json` (merging with any pre-existing file, which
// `prepareCursorCliExecution`'s cleanup restores afterwards), strips the
// unsupported Claude-shaped flags, and adds `--approve-mcps` so cursor-agent
// doesn't block headlessly on the new server's first-use prompt.
//
// See docs/notes/2026-07-11-mcp-bridge-investigation.md for the full
// investigation and live verification result before relying on this.
const MCP_BRIDGE_ENV = "OPENCLAW_CURSOR_CLI_MCP_BRIDGE";

function isMcpBridgeEnabled(): boolean {
  return process.env[MCP_BRIDGE_ENV] === "1";
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
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  const stripped = stripClaudeMcpConfigArgs(args);
  return stripped.includes("--approve-mcps")
    ? stripped
    : [...stripped, "--approve-mcps"];
}

export function resolveCursorCliExecutionArgs(context: {
  executionMode?: string;
  baseArgs: readonly string[];
  workspaceDir?: string;
}): string[] {
  let args =
    context.executionMode === "side-question"
      ? [...stripResumeArgs(context.baseArgs), "--mode", "ask"]
      : [...context.baseArgs];
  if (isMcpBridgeEnabled() && context.workspaceDir) {
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

export function isCursorAgentWrapperCommand(command: string): boolean {
  return path.basename(command) === "cursor-agent-wrapper.ts";
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

  if (isCursorAgentWrapperCommand(configured) && existingBin) {
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

export function buildCursorCliBackend(): CliBackendPlugin {
  const mcpBridge = isMcpBridgeEnabled();
  return {
    id: CURSOR_CLI_BACKEND_ID,
    liveTest: {
      defaultModelRef: CURSOR_CLI_DEFAULT_MODEL_REF,
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
    resolveExecutionArgs: resolveCursorCliExecutionArgs,
    ...(mcpBridge
      ? {
          bundleMcp: true,
          bundleMcpMode: "claude-config-file" as const,
          prepareExecution: prepareCursorCliExecution,
        }
      : {}),
  };
}
