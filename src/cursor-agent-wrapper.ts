#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  buildRuntimeBanner,
  resolveRuntimeBannerMeta,
  shouldInjectRuntimeBanner,
} from "./runtime-banner.ts";

export const OPENCLAW_CURSOR_AGENT_BIN_ENV = "OPENCLAW_CURSOR_AGENT_BIN";

export function resolveCursorAgentBin(env: NodeJS.ProcessEnv): string {
  const value = env[OPENCLAW_CURSOR_AGENT_BIN_ENV]?.trim();
  if (!value) {
    throw new Error(
      `openclaw-cursor-cli wrapper: missing ${OPENCLAW_CURSOR_AGENT_BIN_ENV} (real cursor-agent path)`,
    );
  }
  return value;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function writeError(stderr: NodeJS.WritableStream, error: unknown): void {
  stderr.write(`${formatError(error)}\n`);
}

export async function runCursorAgentWrapper(options: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  spawnImpl?: typeof spawn;
}): Promise<number> {
  let bin: string;
  try {
    bin = resolveCursorAgentBin(options.env);
  } catch (error) {
    writeError(options.stderr, error);
    return 1;
  }

  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(bin, options.argv, {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    writeError(options.stderr, "openclaw-cursor-cli wrapper: failed to create child stdio pipes");
    return 1;
  }

  child.stdout.pipe(options.stdout, { end: false });
  child.stderr.pipe(options.stderr, { end: false });

  const closePromise = new Promise<number>((resolve) => {
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };

    child.once("error", (error) => {
      writeError(options.stderr, error);
      settle(1);
    });
    child.once("close", (code, signal) => {
      if (signal) {
        writeError(options.stderr, `openclaw-cursor-cli wrapper: child killed by ${signal}`);
        settle(1);
        return;
      }
      settle(code ?? 1);
    });
  });

  if (shouldInjectRuntimeBanner(options.argv)) {
    child.stdin.write(buildRuntimeBanner(resolveRuntimeBannerMeta(options.env)));
  }

  options.stdin.pipe(child.stdin);
  options.stdin.on("error", (error) => {
    writeError(options.stderr, error);
    child.stdin?.destroy(error);
  });
  child.stdin.on("error", () => {
    // The child may exit before reading stdin, for example when spawn fails.
  });

  return await closePromise;
}

const scriptPath = process.argv[1];
const isMain = scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href;

if (isMain) {
  // Avoid top-level await: OpenClaw loads this module via jiti when
  // backend.ts imports OPENCLAW_CURSOR_AGENT_BIN_ENV, and top-level await
  // breaks that CommonJS-shaped transform ("await is only valid...").
  void runCursorAgentWrapper({
    argv: process.argv.slice(2),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  }).then((code) => {
    process.exitCode = code;
  });
}
