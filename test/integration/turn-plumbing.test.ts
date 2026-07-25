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
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type AsyncRun,
  assertBridgedArgv,
  createGatewaySandbox,
  cursorAgentIsAuthenticated,
  type GatewaySandbox,
  gatewayPort,
  integrationSkipReason,
  requireIntegrationEnvironment,
  startGateway,
  startTurn,
  which,
} from "./harness.ts";

requireIntegrationEnvironment({ cursorAgent: true });

const MODEL = "cursor-grok-4.5-high-fast";

function realBinarySkipReason(): string | undefined {
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

const skip = realBinarySkipReason();

/**
 * A shim that records the argv it was handed, then becomes the real binary.
 *
 * Without it these tests can only observe what `cursor-agent` printed, and the
 * bridge's whole output — flags added, flags stripped — is invisible: the
 * decline path produces the same authentication error as the success path, so
 * an assertion on the message alone holds either way.
 *
 * It lives outside the sandbox because the backend command has to be named in
 * the config the sandbox is built from.
 */
function createArgvRecorder(): {
  command: string;
  argv: () => string[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-argv-"));
  const command = path.join(dir, "record-argv.sh");
  const argvPath = path.join(dir, "argv.txt");
  const real = which("cursor-agent") as string;
  // One argument per line: cursor-agent takes no argument containing a newline,
  // so this needs no quoting scheme to parse back.
  writeFileSync(
    command,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvPath)}\nexec ${JSON.stringify(real)} "$@"\n`,
    "utf-8",
  );
  chmodSync(command, 0o755);
  return {
    command,
    argv: () => readFileSync(argvPath, "utf-8").split("\n").slice(0, -1),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Runs one real-binary turn, with `assertions` inside the try.
 *
 * They belong there rather than at the call site: the gateway log is the only
 * record of why a turn never reached the binary, and it has to be dumped while
 * the gateway is still up. Asserting after this function returns puts every
 * failure past both the catch and the teardown.
 */
async function probe(
  backendId: string,
  port: number,
  command: string,
  assertions: (output: string, sandbox: GatewaySandbox) => void,
): Promise<void> {
  const sandbox = createGatewaySandbox({
    backendId,
    model: MODEL,
    command,
    port,
  });

  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let turn: AsyncRun | undefined;
  try {
    gateway = await startGateway(sandbox);
    turn = startTurn(sandbox, `agent:main:${backendId}`, 180_000);
    const result = await turn.done;
    assertions(`${result.stdout}\n${result.stderr}`, sandbox);
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
  // cursor-agent's own wording, not a generic /auth/ match. The sandbox config
  // carries `auth: { mode: "token" }` of its own, so a loose pattern is
  // satisfied by an OpenClaw-side gateway auth failure — the opposite of what
  // this asserts. Observed: "Error: Authentication required. Please run
  // 'agent login' first, or set CURSOR_API_KEY environment variable."
  assert.match(
    output,
    /authentication required|agent login|CURSOR_API_KEY/i,
    `expected cursor-agent's own authentication error, got:\n${output.slice(0, 2000)}`,
  );
}

test("a cursor-cli turn reaches the real cursor-agent and surfaces its auth error", {
  skip,
  timeout: 420_000,
}, async () => {
  await probe(
    "cursor-cli",
    gatewayPort(0),
    which("cursor-agent") as string,
    (output) => {
      assertReachedAuth(output);
    },
  );
});

test("the real cursor-agent accepts the argv the cursor-mcp bridge rewrites", {
  skip,
  timeout: 420_000,
}, async () => {
  // The bridge's argv is only ever handed to the stub, which accepts anything.
  // Whether the real binary accepts `--approve-mcps` — and tolerates the
  // Claude-only flags being stripped rather than translated — is not provable
  // from that. It is provable here because cursor-agent parses flags *before*
  // it checks credentials: a flag it does not know produces
  // `error: unknown option '...'` while `--approve-mcps` produces the
  // authentication error.
  //
  // Reaching the auth error is necessary but not sufficient. The bridge's
  // decline path strips the same flags and adds nothing, and its turn ends in
  // the same error, so the recorder is what separates "the binary accepted the
  // bridged argv" from "the bridge produced no argv to accept".
  const recorder = createArgvRecorder();
  try {
    await probe("cursor-mcp", gatewayPort(3), recorder.command, (output) => {
      assert.doesNotMatch(
        output,
        /unknown option|unknown argument|unrecognized/i,
        `cursor-agent rejected a flag the bridge produced:\n${output.slice(0, 2000)}`,
      );
      assertReachedAuth(output);

      assertBridgedArgv(recorder.argv(), "the real cursor-agent");
    });
  } finally {
    recorder.cleanup();
  }
});
