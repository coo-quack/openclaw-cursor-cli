/**
 * Turns that reach the real `cursor-agent`.
 *
 * The bridge test substitutes a stub, which proves the plugin's own logic but
 * says nothing about whether the binary can be launched the way the backend
 * definition describes. These use the real thing and assert on the error it
 * comes back with: an authentication failure raised *inside* `cursor-agent`
 * means argv construction, spawn, the stdin handoff and error propagation all
 * worked. Everything past that point is between `cursor-agent` and Cursor.
 *
 * Both backends are covered, because they hand the binary different argv.
 * Neither ever gets far enough to run inference, and both refuse to try where
 * that would be possible — see the skip conditions below.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  createGatewaySandbox,
  cursorAgentIsAuthenticated,
  gatewayPort,
  integrationSkipReason,
  requireIntegrationEnvironment,
  runOpenclawAsync,
  startGateway,
  which,
} from "./harness.ts";

requireIntegrationEnvironment({ cursorAgent: true });

const MODEL = "cursor-grok-4.5-high-fast";

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

/** Drives one real-binary turn and returns everything the CLI printed. */
async function probe(backendId: string, port: number): Promise<string> {
  const sandbox = createGatewaySandbox({
    backendId,
    model: MODEL,
    command: which("cursor-agent") as string,
    port,
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
        `agent:main:${backendId}`,
        "--message",
        "integration probe",
        "--model",
        `${backendId}/${MODEL}`,
        "--json",
      ],
      180_000,
    );
    const result = await turn.done;
    return `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    // Whatever stopped the turn short of cursor-agent is usually recorded only
    // here, and CI has no other way to see it.
    if (gateway)
      process.stderr.write(`--- gateway log ---\n${gateway.logs()}\n`);
    throw error;
  } finally {
    turn?.kill();
    await gateway?.stop();
    sandbox.cleanup();
  }
}

/** The binary ran and got as far as its own auth check. */
function assertReachedAuth(output: string): void {
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
}

test("a cursor-cli turn reaches the real cursor-agent and surfaces its auth error", {
  skip,
  timeout: 300_000,
}, async () => {
  assertReachedAuth(await probe("cursor-cli", gatewayPort(0)));
});

test("the real cursor-agent accepts the argv the cursor-mcp bridge rewrites", {
  skip,
  timeout: 300_000,
}, async () => {
  // The bridge's argv is only ever handed to the stub, which accepts anything.
  // Whether the real binary accepts `--approve-mcps` — and tolerates the
  // Claude-only flags being stripped rather than translated — is not provable
  // from that. It is provable here because cursor-agent parses flags *before*
  // it checks credentials: a flag it does not know produces
  // `error: unknown option '...'` while `--approve-mcps` produces the
  // authentication error. So the auth error is the passing outcome, and a
  // usage error is the failure this test exists to catch.
  const output = await probe("cursor-mcp", gatewayPort(3));

  assert.doesNotMatch(
    output,
    /unknown option|unknown argument|unrecognized/i,
    `cursor-agent rejected a flag the bridge produced:\n${output.slice(0, 2000)}`,
  );
  assertReachedAuth(output);
});
