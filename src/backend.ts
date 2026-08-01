import {
  existsSync,
  lstatSync,
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
import { toCursorAgentModelId } from "./catalog.ts";
import { OPENCLAW_CURSOR_AGENT_BIN_ENV } from "./cursor-agent-wrapper.ts";

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
      if (i + 1 < out.length && !out[i + 1]?.startsWith("-")) {
        out[i + 1] = cliModelId;
        return out;
      }
      out.splice(i + 1, 0, cliModelId);
      return out;
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

/**
 * True when a symlink sits at `filePath`, whether or not its target exists.
 *
 * Failures answer `false`, which is deliberate rather than a swallowed error.
 * A missing path is the ordinary "no". Any other failure — a `.cursor`
 * directory that turned unreadable, say — means the write that follows this
 * check will fail the same way and report it through `warn` as a write
 * failure, so nothing is lost by not raising it twice.
 */
function isSymbolicLink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
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

/**
 * The key inside `mcpServers` that OpenClaw's bundle-MCP config uses, and
 * therefore the only entry this bridge ever adds or takes responsibility for
 * removing.
 */
const BRIDGED_SERVER_KEY = "openclaw";

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
  // - kind: "absent" (file didn't exist at prepare time, or held nothing but a
  //   leftover bridge entry): delete if exists at cleanup
  // - kind: "unreadable" (file exists but unreadable): do nothing at cleanup
  //
  // Alongside it, three facts about what this run has done:
  // - wrote: an apply *attempted* a write. Set before writing so cleanup can
  //   restore the backup even on partial failure, and cleanup only acts on it.
  // - bridgedOnDisk: an apply *completed* a write, so a server really is there
  //   to approve.
  // - lastWrittenRaw: exactly what that write put on disk, so a later apply can
  //   tell the bridge's own output from a file someone else changed.
  const cursorMcpBridgeBackups = new Map<
    string,
    {
      backup: McpBackupState;
      refCount: number;
      /** An apply *attempted* a write. Drives cleanup, so partial failures still restore. */
      wrote: boolean;
      /**
       * Exactly what the last successful write put on disk, so a later apply
       * can tell the bridge's own output apart from a file someone else
       * created or edited during the turn.
       */
      lastWrittenRaw?: string;
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
   * Builds the backup to restore at cleanup, dropping any `openclaw` entry the
   * file already carries.
   *
   * Such an entry is a leftover from a run whose cleanup never fired (a killed
   * gateway, a reference count that never reached zero), because a completed
   * run always removes its own. Backing it up would restore it, so the orphan
   * — and its dead bearer token — would survive every future run in this
   * workspace. Dropping it here makes the next `cursor-mcp` turn clean up
   * after the crashed one.
   *
   * The cost is that this backup is re-serialized rather than kept as the
   * original bytes, so formatting is normalized. That only applies to files
   * carrying an `openclaw` entry, which are the bridge's own output.
   */
  function backupWithoutBridgedServer(
    raw: string,
    filePath: string,
  ): McpBackupState {
    const parsed = parseMcpFile(raw);
    if (parsed.kind === "unparseable") return { kind: "content", raw };
    if (!Object.hasOwn(parsed.servers, BRIDGED_SERVER_KEY))
      return { kind: "content", raw };

    const { [BRIDGED_SERVER_KEY]: _leftover, ...remainingServers } =
      parsed.servers;
    const otherKeys = Object.keys(parsed.doc).filter(
      (key) => key !== "mcpServers",
    );
    // Always announced, even at the cost of saying it twice in one turn when
    // prepare and apply both read the file: silently deleting an entry someone
    // put there is the worse failure. The wording avoids blaming an earlier
    // run, since a concurrent one can leave the same trace.
    warn(
      `openclaw-cursor-cli: dropping the "${BRIDGED_SERVER_KEY}" server already present in ${filePath}; ` +
        `the bridge owns that name and will not restore it`,
    );
    // Nothing of the user's left: restoring an empty shell would be worse than
    // removing the file the earlier run created.
    if (Object.keys(remainingServers).length === 0 && otherKeys.length === 0)
      return { kind: "absent" };
    return {
      kind: "content",
      raw: `${JSON.stringify({ ...parsed.doc, mcpServers: remainingServers }, null, 2)}\n`,
    };
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

    if (!info) {
      // No backup entry means prepareCursorCliExecution never ran for this
      // workspace, so no cleanup is registered and nothing would ever remove
      // what we write — the bearer token would sit in the workspace
      // indefinitely. OpenClaw always runs the prepare phase before resolving
      // execution args, so reaching this is a host contract violation rather
      // than a normal path; decline instead of writing.
      warn(
        `openclaw-cursor-cli: no prepared execution for ${workspaceDir}; skipping the MCP bridge because nothing would clean up ${targetPath}`,
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
        info.backup = { kind: "absent" };
        return EMPTY_MCP_DOCUMENT;
      }
      // Byte-identical to this run's own last write, so it is the bridge's
      // output rather than the user's. Merging it back would carry that
      // write's generated servers — a stale bearer token among them — into
      // the new file, and promoting it would make cleanup restore the
      // bridge's own config as if it were the original.
      if (info.lastWrittenRaw === result.raw) return EMPTY_MCP_DOCUMENT;
      // Anything else appeared or changed during the turn and belongs to
      // whoever put it there, so back it up and merge into it.
      info.backup = backupWithoutBridgedServer(result.raw, targetPath);
      return { doc: result.doc, servers: result.servers };
    };

    // The whole pre-existing document, so keys the bridge doesn't own
    // (`$schema`, editor settings, …) survive the rewrite.
    let existing: McpDocument;

    // Switch on backup kind for exhaustiveness checking by TypeScript.
    switch (info.backup.kind) {
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
      case "absent": {
        // The backup can't supply the current contents — prepare either
        // couldn't read the file or found none — so read them from disk to
        // preserve whatever servers are defined there now.
        const fromDisk = readExistingFromDisk();
        if (fromDisk === "declined") return decline();
        existing = fromDisk;
        break;
      }
    }

    // An `absent` backup means cleanup would `unlink` this path. Through a
    // symlink that removes the link, not the file the write went into, so the
    // bearer token would be left behind under a name the bridge never tracked.
    // Following the link and deleting its target instead is worse: that file
    // can live anywhere, and this plugin only removes what it created.
    // Declining is the honest option, and it is sticky — a workspace in this
    // shape stays un-bridged until someone resolves the symlink by hand.
    // Scoped to `absent` because that is the only backup kind whose cleanup
    // unlinks. A `content` backup writes its bytes back instead, which goes
    // through the link and overwrites the token, so the same shape is safe
    // there — at the cost of creating the link's target if it was dangling.
    if (info.backup.kind === "absent" && isSymbolicLink(targetPath)) {
      warn(
        `openclaw-cursor-cli: ${targetPath} is a symlink, and cleanup would ` +
          `have to remove the file this run creates — through a symlink that ` +
          `deletes the link instead, leaving the bearer token behind; ` +
          `skipping the MCP bridge. Replace the symlink with a real file to ` +
          `use cursor-mcp in this workspace`,
      );
      return decline();
    }

    const merged = {
      ...existing.doc,
      mcpServers: { ...existing.servers, ...generatedServers },
    };
    const serialized = `${JSON.stringify(merged, null, 2)}\n`;
    try {
      // Mark as attempted write before the write, so partial failures
      // (ENOSPC, etc.) still set wrote=true and allow cleanup to restore backup
      info.wrote = true;
      mkdirSync(path.dirname(targetPath), { recursive: true });
      // mode 0o600 limits the bearer token this file carries to the gateway
      // user. It only applies when the file is created here; an existing
      // file keeps whatever permissions it already has.
      writeFileSync(targetPath, serialized, { encoding: "utf-8", mode: 0o600 });
    } catch (error) {
      // Same posture as a missing/unreadable Claude mcp-config: strip unsupported
      // flags and continue without the bridge rather than crashing the run.
      // Log a minimal warning so operators can diagnose mcp.json setup issues.
      const msg = `openclaw-cursor-cli: failed to write ${targetPath}: ${error instanceof Error ? error.message : String(error)}`;
      warn(msg);
      return decline();
    }
    // The bridged server is now really on disk, so a later apply in this run
    // must keep approving it even if that apply declines, and must recognise
    // these exact bytes as the bridge's own output rather than the user's.
    info.bridgedOnDisk = true;
    info.lastWrittenRaw = serialized;
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
        backup = backupWithoutBridgedServer(content, targetPath);
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
              // mode only takes effect if the restore recreates a file that
              // was deleted mid-run; an existing file keeps its permissions.
              writeFileSync(targetPath, info.backup.raw, {
                encoding: "utf-8",
                mode: 0o600,
              });
            } else if (
              info.backup.kind === "absent" &&
              existsSync(targetPath)
            ) {
              // Remove only what this bridge put there. If the bytes changed
              // since our last write, someone else owns the file now, and
              // deleting content we never read is exactly what the bridge
              // must not do.
              const current = readFileSync(targetPath, "utf-8");
              if (current === info.lastWrittenRaw) {
                unlinkSync(targetPath);
              } else {
                warn(
                  `openclaw-cursor-cli: leaving ${targetPath} in place; it changed ` +
                    `since this run wrote it, so removing it would discard someone ` +
                    `else's content. Check it for a stale "${BRIDGED_SERVER_KEY}" entry`,
                );
              }
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
      // No modelArg here: OpenClaw's runner would append `--model <id>` with
      // the raw OpenClaw id after resolveExecutionArgs, duplicating the flag
      // this backend already maps and appends there. normalizeCursorCliConfig
      // always crushes modelArg to undefined at runtime for the same reason.
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
          prepareExecution: bridge.prepareCursorCliExecution,
        }
      : {}),
  };
}
