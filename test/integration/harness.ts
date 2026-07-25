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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * that failed to install `openclaw` reports four skips and a green job.
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
 * Creates an isolated openclaw home plus a config that loads this checkout.
 *
 * `extraConfig` is merged shallowly over the defaults, so a test can add
 * `agents` or `gateway` blocks without restating the plugin wiring.
 */
export function createSandbox(
  extraConfig: Record<string, unknown> = {},
): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-integration-"));
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");

  const config = {
    plugins: { load: { paths: [REPO_ROOT] } },
    ...extraConfig,
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

  return {
    root,
    configPath,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      // Keep the CLI's own noise out of the assertions.
      NO_COLOR: "1",
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The bearer token every gateway-backed test authenticates with. */
export const GATEWAY_TOKEN = "integration-suite-token";

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

/**
 * A sandbox wired for a turn that has to reach one of this plugin's backends.
 *
 * Both gateway-backed tests need the same shape, and the parts that look like
 * boilerplate are the parts that break quietly when they drift: the plugin has
 * to be *enabled*, not merely loaded, and the model has to be allowed as well
 * as present in the catalog.
 */
export function createGatewaySandbox(options: {
  /** `cursor-cli` or `cursor-mcp` — which backend the turn should route to. */
  backendId: string;
  /** Bare model id; the caller passes `<backendId>/<model>` to `--model`. */
  model: string;
  /** What the backend should spawn: the real binary, or the stub. */
  command: string;
  port: number;
  /** Extra environment for the spawned backend, e.g. the stub's hold time. */
  env?: Record<string, string>;
}): Sandbox {
  const modelRef = `${options.backendId}/${options.model}`;
  return createSandbox({
    plugins: {
      load: { paths: [REPO_ROOT] },
      // Loading the plugin from a path is not enough to make its backend run a
      // turn — it also has to be enabled. Measured: without this entry the
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
      auth: { mode: "token", token: GATEWAY_TOKEN },
    },
    agents: {
      defaults: {
        skipBootstrap: true,
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
  });
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
  child.once("exit", () => {
    exited = true;
  });

  /** Signal 0 asks whether the process exists without delivering anything. */
  const alive = (): boolean => {
    if (!child.pid) return false;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** Polls until the gateway is really gone, or the deadline passes. */
  const waitGone = async (timeout: number): Promise<boolean> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      // Either half is enough on its own: `exited` means Node saw it die (the
      // pid can linger a moment as an unreaped zombie), `!alive()` means the
      // OS no longer has it even if the event never arrived.
      if (exited || !alive()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return exited || !alive();
  };

  const stop = async () => {
    if (!child.pid || exited) return;
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
