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

function which(command: string): string | undefined {
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
 * Why the suite cannot run here, or undefined when it can.
 *
 * A missing `openclaw` is the normal case on a fresh clone, so these tests skip
 * rather than fail. CI runs them in a container that has it.
 */
export function integrationSkipReason(): string | undefined {
  if (!which("openclaw"))
    return "openclaw is not on PATH (npm install -g openclaw, or run via npm run test:integration:docker)";
  return undefined;
}

export type Sandbox = {
  /** Temp root; everything below lives here and is removed by `cleanup`. */
  root: string;
  /** The agent workspace, i.e. where `.cursor/mcp.json` would be written. */
  workspaceDir: string;
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
  const workspaceDir = path.join(root, "ws");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");

  const config = {
    plugins: { load: { paths: [REPO_ROOT] } },
    ...extraConfig,
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

  return {
    root,
    workspaceDir,
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
export function runOpenclawAsync(
  sandbox: Sandbox,
  args: string[],
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("openclaw", args, {
      env: sandbox.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout?.on("data", (c) => out.push(String(c)));
    child.stderr?.on("data", (c) => err.push(String(c)));
    child.once("close", (status) =>
      resolve({ status, stdout: out.join(""), stderr: err.join("") }),
    );
  });
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

export type Gateway = { port: number; stop: () => Promise<void> };

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
  port: number,
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

  const stop = async () => {
    if (child.pid && !exited) {
      try {
        // Negative pid targets the group, so backend children go too.
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `gateway exited before becoming ready:\n${log.join("").slice(-4000)}`,
      );
    }
    const health = runOpenclaw(sandbox, ["gateway", "health"], 20_000);
    if (health.status === 0) return { port, stop };
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
