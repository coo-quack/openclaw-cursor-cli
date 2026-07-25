/**
 * Shared plumbing for the integration suite.
 *
 * These tests drive a real `openclaw` against a real plugin checkout. They are
 * deliberately kept out of `npm run check`: they need binaries that a plain
 * clone does not have, and they talk to the network when they install nothing
 * is cached. `npm run test:integration` runs them; `docker/integration.Dockerfile`
 * is what CI uses so the environment matches.
 *
 * Everything here is scoped to a temp directory. Nothing reads or writes the
 * developer's own `~/.openclaw`.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The plugin checkout under test — the repo this file lives in. */
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Where the fake cursor-agent lives, for tests that substitute it. */
export const FAKE_CURSOR_AGENT = path.join(
  import.meta.dirname,
  "fake-cursor-agent.mjs",
);

export function which(command: string): string | undefined {
  // Not a login shell: `sh -lc` re-reads the profile and replaces the PATH it
  // inherited, which loses a container's npm global bin and made the whole
  // suite skip itself inside Docker.
  const result = spawnSync("sh", ["-c", `command -v ${command}`], {
    encoding: "utf-8",
  });
  const found = result.stdout?.trim();
  return found ? found : undefined;
}

/**
 * True when the real cursor-agent is installed and has usable credentials.
 *
 * Read from the output, not the exit code: `cursor-agent status` exits 0 either
 * way, printing "Logged in as …" or "Not logged in". Testing the status code
 * reports every environment as authenticated, which silently skips the test
 * that depends on this in exactly the place it is meant to run.
 */
export function cursorAgentIsAuthenticated(): boolean {
  const binary = which("cursor-agent");
  if (!binary) return false;
  const status = spawnSync(binary, ["status"], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  const output = `${status.stdout ?? ""}${status.stderr ?? ""}`;
  // Fail closed. Only an explicit "not logged in" is treated as safe to run
  // against; different wording, a timeout, or empty output all mean we could
  // not establish that this machine lacks credentials, and guessing wrong
  // spends the user's Cursor subscription on a throwaway turn. Matching the
  // positive case instead would make every one of those a false "safe".
  return !/not logged in/i.test(output);
}

/**
 * Why the suite cannot run here, or undefined when it can.
 *
 * A missing `openclaw` is the normal case on a fresh clone, so these tests skip
 * rather than fail — but only off CI. On CI a skip is indistinguishable from a
 * pass in the job summary, and a suite that quietly runs nothing is worse than
 * no suite: `requireIntegrationEnvironment` turns it into a failure there.
 */
export function integrationSkipReason(): string | undefined {
  if (!which("openclaw"))
    return "openclaw is not on PATH (npm install -g openclaw, or run via npm run test:integration:docker)";
  return undefined;
}

/**
 * Fails the file at import time when CI cannot actually run the suite.
 *
 * Call this at the top of every integration test file. Without it, a container
 * that failed to install `openclaw` reports nothing but skips and a green job.
 */
export function requireIntegrationEnvironment(
  options: { cursorAgent?: boolean } = {},
): void {
  if (!process.env.CI) return;
  const reason = integrationSkipReason();
  if (reason)
    throw new Error(
      `integration suite cannot run under CI, and skipping there would report as success: ${reason}`,
    );
  // A file that needs the real binary has to say so. The container installs it
  // at start-up, and if that install ever fails the test would otherwise skip
  // itself quietly and the job would stay green — permanently, from the first
  // day the installer breaks.
  if (options.cursorAgent && !which("cursor-agent"))
    throw new Error(
      "cursor-agent is missing under CI; this test would skip itself and report as success",
    );
}

export type Sandbox = {
  /** Temp root; everything below lives here and is removed by `cleanup`. */
  root: string;
  /** Path of the generated openclaw config. */
  configPath: string;
  /** Env every `openclaw` invocation must carry to stay isolated. */
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
};

/**
 * Every root handed out, swept again when the test process exits.
 *
 * `cleanup` is not always the last word: a gateway that has been signalled and
 * confirmed gone can still have a descendant that outlived its process group,
 * and that descendant recreates `OPENCLAW_STATE_DIR` under a root already
 * deleted. Observed on a failing run — a lone `state/` directory holding one
 * session file. Sweeping at exit costs nothing and keeps a red run from
 * littering /tmp.
 */
const sandboxRoots: string[] = [];

/** Gateway process groups still believed to be running. */
const liveGatewayGroups = new Set<number>();

function sweep(): void {
  // Gateways first: killing the group after the config is gone leaves them
  // logging into a directory that no longer exists.
  for (const pid of liveGatewayGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  liveGatewayGroups.clear();
  for (const root of sandboxRoots)
    rmSync(root, { recursive: true, force: true });
}

process.once("exit", sweep);
// `exit` does not fire for a signalled process, and Ctrl-C in the middle of a
// gateway-backed test is the likeliest way to orphan one. Sweep, then let the
// signal take its default course — the listener is `once`, so re-raising it
// terminates rather than recursing.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    sweep();
    process.kill(process.pid, signal);
  });
}

/**
 * Creates an isolated openclaw home plus a config that loads this checkout.
 *
 * `extraConfig` is merged shallowly over the defaults, so a test can add
 * `agents` or `gateway` blocks without restating the plugin wiring. Pass a
 * function when the config has to name a path inside the sandbox — the temp
 * root only exists once this has been called.
 */
export function createSandbox(
  extraConfig:
    | Record<string, unknown>
    | ((root: string) => Record<string, unknown>) = {},
): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-integration-"));
  sandboxRoots.push(root);
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");

  const config = {
    plugins: { load: { paths: [REPO_ROOT] } },
    ...(typeof extraConfig === "function" ? extraConfig(root) : extraConfig),
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    // Keep the CLI's own noise out of the assertions.
    NO_COLOR: "1",
  };
  // The one credential that reaches cursor-agent through the environment, and
  // the one the skip guard cannot see: `cursor-agent status` prints "Not logged
  // in" whether or not `CURSOR_API_KEY` is set (measured), so a developer who
  // exports it would pass the guard, run the real binary, and authenticate — no
  // auth error, real inference, real quota. Dropping it here is better than
  // skipping on it, because the tests still run and still reach the error they
  // assert on. Credentials stored on disk are a different channel, and the
  // `status` guard is what covers those.
  delete env.CURSOR_API_KEY;

  return {
    root,
    configPath,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * The bearer token for one gateway, distinct per sandbox.
 *
 * A shared constant made the readiness check ambiguous: an orphan gateway left
 * on the same port by an earlier crash would answer `gateway health` with the
 * same credentials, and the suite would test against it. A token nothing else
 * knows turns that into a plain failure to become ready.
 */
function gatewayToken(port: number): string {
  return `integration-${port}-${process.pid}`;
}

/**
 * The listening port for a gateway-backed test file.
 *
 * One formula, one place. `slot` separates the files from each other — they can
 * run concurrently — and the pid keeps two runs on the same machine apart. Four
 * hundred ports per slot is wide enough that a wrapped pid rarely collides, and
 * `startGateway` fails fast rather than silently reusing a listener when it
 * does.
 */
export function gatewayPort(slot: number): number {
  return 19_000 + slot * 400 + (process.pid % 400);
}

/** A sandbox that also knows the workspace and model ref it was built for. */
export type GatewaySandbox = Sandbox & {
  /** `<backendId>/<model>`, ready to pass to `--model`. */
  modelRef: string;
  /** The agent's working directory — where the MCP bridge writes. */
  workspace: string;
};

/**
 * A sandbox wired for a turn that has to reach one of this plugin's backends.
 *
 * Both gateway-backed tests need the same shape, and the parts that look like
 * boilerplate are the parts that break quietly when they drift: the plugin has
 * to be *enabled*, not merely loaded, the model has to be allowed as well as
 * present in the catalog, and the workspace has to be set. Leaving the
 * workspace to OpenClaw's default means a `cursor-mcp` turn writes its bridged
 * `.cursor/mcp.json` — bearer token included — outside the temp root that
 * `cleanup` deletes.
 */
export function createGatewaySandbox(options: {
  /** `cursor-cli` or `cursor-mcp` — which backend the turn should route to. */
  backendId: string;
  /** Bare model id; `modelRef` on the result is what `--model` wants. */
  model: string;
  /** What the backend should spawn: the real binary, or the stub. */
  command: string;
  port: number;
  /** Extra environment for the spawned backend, e.g. the stub's hold time. */
  env?: Record<string, string>;
}): GatewaySandbox {
  const modelRef = `${options.backendId}/${options.model}`;
  let workspace = "";
  const sandbox = createSandbox((root) => {
    workspace = path.join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    return {
      plugins: {
        load: { paths: [REPO_ROOT] },
        // Loading the plugin from a path is not enough to make its backend run
        // a turn — it also has to be enabled. Measured: without this entry the
        // plugin still reports `status: loaded`, but the turn bypasses the
        // backend entirely and the command is handed the bare prompt with no
        // `--approve-mcps` and no bridged config. `plugins install --link` adds
        // the equivalent to `plugins.allow` for real installs.
        entries: { "cursor-cli": { enabled: true } },
      },
      gateway: {
        mode: "local",
        port: options.port,
        bind: "loopback",
        auth: { mode: "token", token: gatewayToken(options.port) },
      },
      agents: {
        defaults: {
          skipBootstrap: true,
          workspace,
          model: modelRef,
          models: { [modelRef]: {} },
          cliBackends: {
            [options.backendId]: {
              command: options.command,
              ...(options.env ? { env: options.env } : {}),
            },
          },
        },
      },
    };
  });
  return { ...sandbox, modelRef, workspace };
}

export type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

/** Runs one `openclaw` command to completion inside a sandbox. */
export function runOpenclaw(
  sandbox: Sandbox,
  args: string[],
  timeoutMs = 180_000,
): RunResult {
  const result = spawnSync("openclaw", args, {
    env: sandbox.env,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Runs one `openclaw` command without blocking the event loop.
 *
 * Needed wherever the caller has to keep working while the command is in
 * flight — a `cursor-mcp` turn parks on a stub that only the test can release,
 * so driving it with the synchronous runner deadlocks.
 */
export type AsyncRun = {
  /** Resolves when the command exits, however it exits. */
  done: Promise<RunResult>;
  /** Kills it. Safe to call after it has already finished. */
  kill: () => void;
};

export function runOpenclawAsync(
  sandbox: Sandbox,
  args: string[],
  timeoutMs = 240_000,
): AsyncRun {
  const child = spawn("openclaw", args, {
    env: sandbox.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out: string[] = [];
  const err: string[] = [];
  child.stdout?.on("data", (c) => out.push(String(c)));
  child.stderr?.on("data", (c) => err.push(String(c)));

  const kill = () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  };
  const timer = setTimeout(kill, timeoutMs);
  timer.unref?.();

  const done = new Promise<RunResult>((resolve) => {
    const finish = (status: number | null) => {
      clearTimeout(timer);
      resolve({ status, stdout: out.join(""), stderr: err.join("") });
    };
    child.once("close", finish);
    // A spawn failure emits `error` and never `close`; without this the caller
    // would wait for a process that does not exist.
    child.once("error", () => finish(null));
  });

  return { done, kill };
}

/**
 * Starts the one command every gateway-backed test runs.
 *
 * Asynchronous by necessity, not preference: the stub parks until the test
 * releases it, so a synchronous spawn deadlocks the two against each other.
 * `--session-key` is required — without a session target `openclaw agent`
 * refuses to run at all — and the model ref is passed explicitly so each test
 * states which backend it exercises instead of leaning on the config default.
 */
export function startTurn(
  sandbox: GatewaySandbox,
  sessionKey: string,
  timeoutMs?: number,
): AsyncRun {
  return runOpenclawAsync(
    sandbox,
    [
      "agent",
      "--session-key",
      sessionKey,
      "--message",
      TURN_PROMPT,
      "--model",
      sandbox.modelRef,
      "--json",
    ],
    timeoutMs,
  );
}

/** The message every turn sends. Asserted on wherever stdin is inspected. */
export const TURN_PROMPT = "integration probe";

/**
 * What the bridge must have done to the argv by the time the binary sees it.
 *
 * Both the stub and the real binary are checked against this. They are
 * different proofs — one that the plugin builds the right argv, one that
 * cursor-agent accepts it — but the property is the same, and stating it twice
 * invites the two copies to drift.
 */
export function assertBridgedArgv(argv: string[], seenBy: string): void {
  assert.ok(
    argv.includes("--approve-mcps"),
    `${seenBy}: --approve-mcps missing from ${JSON.stringify(argv)}`,
  );
  assert.ok(
    !argv.includes("--strict-mcp-config") && !argv.includes("--mcp-config"),
    `${seenBy}: Claude-only flags survived into ${JSON.stringify(argv)}`,
  );
}

/** Parses `--json` output, failing loudly with the raw text when it isn't JSON. */
export function parseJson<T>(result: RunResult, what: string): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(
      `${what} did not return JSON.\n--- stdout ---\n${result.stdout.slice(0, 2000)}\n--- stderr ---\n${result.stderr.slice(0, 2000)}`,
    );
  }
}

export type Gateway = { stop: () => Promise<void>; logs: () => string };

/**
 * Starts a gateway in the foreground and resolves once it answers.
 *
 * Readiness is polled with `openclaw gateway health` rather than slept on, so a
 * slow machine waits longer instead of flaking. The whole process group is
 * killed on stop: the gateway spawns backend children, and leaving those behind
 * would hold the port for the next test.
 */
export async function startGateway(
  sandbox: Sandbox,
  timeoutMs = 120_000,
): Promise<Gateway> {
  const child = spawn("openclaw", ["gateway", "run"], {
    env: sandbox.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const log: string[] = [];
  child.stdout?.on("data", (c) => log.push(String(c)));
  child.stderr?.on("data", (c) => log.push(String(c)));

  let exited = false;
  if (child.pid) liveGatewayGroups.add(child.pid);
  child.once("exit", () => {
    exited = true;
    if (child.pid) liveGatewayGroups.delete(child.pid);
  });

  /**
   * Whether anything is left in the gateway's process group.
   *
   * Signal 0 delivers nothing and only reports whether a target exists. The
   * target is the *group*, not the leader: the gateway's `exit` event says
   * nothing about the backend children it spawned, and those are what hold the
   * port. `detached: true` above is what makes the child a group leader, so
   * its pid doubles as the group id.
   */
  const groupAlive = (): boolean => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** Polls until the group is really gone, or the deadline passes. */
  const waitGone = async (timeout: number): Promise<boolean> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!groupAlive()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !groupAlive();
  };

  const stop = async () => {
    // Not `if (exited) return`. The gateway spawns the backend into its own
    // process group, and a stub parked on `FAKE_HOLD_MS` outlives a gateway
    // that died first — returning early there leaves it running and holding
    // the port. Signalling a group that is already gone raises ESRCH, which
    // the sender swallows, so the only cost of trying is the syscall.
    if (!child.pid) return;
    const signal = (sig: NodeJS.Signals) => {
      try {
        // Negative pid targets the group, so backend children go too.
        process.kill(-(child.pid as number), sig);
      } catch {
        // Already gone.
      }
    };
    signal("SIGTERM");
    // A gateway that ignores SIGTERM holds its port, and the next run in the
    // same suite would then fail for a reason that has nothing to do with it.
    if (await waitGone(10_000)) return;

    signal("SIGKILL");
    // Confirm the escalation rather than sleeping and trusting it. The `exit`
    // event alone is not proof — it can go unfired — so this asks the OS. When
    // the answer is still "alive", saying so here is the difference between
    // diagnosing this and diagnosing whatever the next test trips over.
    if (!(await waitGone(5_000)))
      process.stderr.write(
        `--- gateway pid ${child.pid} survived SIGKILL; it may still hold its port ---\n`,
      );
  };

  /** Everything the gateway printed, for a failure message worth reading. */
  const logs = () => log.join("");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `gateway exited before becoming ready:\n${log.join("").slice(-4000)}`,
      );
    }
    const health = runOpenclaw(sandbox, ["gateway", "health"], 20_000);
    if (health.status === 0) return { stop, logs };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await stop();
  throw new Error(
    `gateway did not become ready within ${timeoutMs}ms:\n${log.join("").slice(-4000)}`,
  );
}

/** Waits for `predicate` to hold, polling rather than sleeping a fixed time. */
export async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}
