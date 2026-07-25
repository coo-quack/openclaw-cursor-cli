/**
 * A turn that reaches the real `cursor-agent`.
 *
 * The bridge test substitutes a stub, which proves the plugin's own logic but
 * says nothing about whether the binary can be launched the way the backend
 * definition describes. This one uses the real thing and asserts on the error
 * it comes back with: an authentication failure raised *inside* `cursor-agent`
 * means argv construction, spawn, the stdin handoff and error propagation all
 * worked. Everything past that point is between `cursor-agent` and Cursor.
 *
 * It never gets far enough to run inference, and it refuses to try where that
 * would be possible — see the skip conditions below.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  createSandbox,
  cursorAgentIsAuthenticated,
  integrationSkipReason,
  REPO_ROOT,
  requireIntegrationEnvironment,
  runOpenclawAsync,
  startGateway,
  which,
} from "./harness.ts";

requireIntegrationEnvironment();

const GATEWAY_PORT = 19_300 + (process.pid % 200);

function skipReason(): string | undefined {
  const base = integrationSkipReason();
  if (base) return base;
  const binary = which("cursor-agent");
  if (!binary) return "cursor-agent is not installed";
  // The whole point is to stop at the auth error. A logged-in binary would sail
  // past it and spend the developer's Cursor subscription on a throwaway turn,
  // so this only runs where no credentials exist — CI, in practice. macOS keeps
  // them in the login keychain, which an isolated HOME does not hide.
  if (cursorAgentIsAuthenticated())
    return "cursor-agent is logged in here; running this would spend real quota";
  return undefined;
}

const skip = skipReason();

test("a cursor-cli turn reaches the real cursor-agent and surfaces its auth error", {
  skip,
  timeout: 300_000,
}, async () => {
  const cursorAgent = which("cursor-agent");
  const sandbox = createSandbox({
    plugins: {
      load: { paths: [REPO_ROOT] },
      entries: { "cursor-cli": { enabled: true } },
    },
    gateway: {
      mode: "local",
      port: GATEWAY_PORT,
      bind: "loopback",
      auth: { mode: "token", token: "integration-suite-token" },
    },
    agents: {
      defaults: {
        skipBootstrap: true,
        model: "cursor-cli/cursor-grok-4.5-high-fast",
        models: { "cursor-cli/cursor-grok-4.5-high-fast": {} },
        cliBackends: { "cursor-cli": { command: cursorAgent } },
      },
    },
  });

  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let turn: ReturnType<typeof runOpenclawAsync> | undefined;
  try {
    mkdirSync(path.join(sandbox.root, "ws"), { recursive: true });
    gateway = await startGateway(sandbox);

    turn = runOpenclawAsync(
      sandbox,
      [
        "agent",
        "--session-key",
        "agent:main:plumbing",
        "--message",
        "integration probe",
        "--model",
        "cursor-cli/cursor-grok-4.5-high-fast",
        "--json",
      ],
      180_000,
    );
    const result = await turn.done;
    const output = `${result.stdout}\n${result.stderr}`;

    // The failure has to come from cursor-agent, not from OpenClaw failing to
    // find or launch it — those would mean the plumbing never ran.
    assert.doesNotMatch(
      output,
      /ENOENT|command not found|spawn .* failed/i,
      `the binary was never launched:\n${output.slice(0, 1500)}`,
    );
    assert.match(
      output,
      /auth|login|credential|unauthor|sign in|not logged/i,
      `expected cursor-agent's own authentication error, got:\n${output.slice(0, 2000)}`,
    );
  } finally {
    turn?.kill();
    await gateway?.stop();
    sandbox.cleanup();
  }
});
