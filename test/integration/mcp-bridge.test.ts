/**
 * The MCP bridge, exercised through a real gateway.
 *
 * This is the seam the unit tests cannot reach. They mock the filesystem and
 * the argv OpenClaw hands over; what they cannot check is whether OpenClaw
 * still hands over that shape, or whether the loopback server the bridge points
 * `cursor-agent` at is actually reachable with the credentials written into the
 * config.
 *
 * No LLM traffic: `cursor-agent` is replaced by a stub that records what the
 * bridge gave it and then blocks, which is also what holds the loopback server
 * up long enough for this test to connect to it as the client.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import {
  type AsyncRun,
  assertBridgedArgv,
  createGatewaySandbox,
  FAKE_CURSOR_AGENT,
  type GatewaySandbox,
  gatewayPort,
  integrationSkipReason,
  type RunResult,
  requireIntegrationEnvironment,
  startGateway,
  startTurn,
  TURN_PROMPT,
  waitFor,
} from "./harness.ts";

requireIntegrationEnvironment();
const skip = integrationSkipReason();

const MODEL = "cursor-grok-4.5-high-fast";

/**
 * A floor, not the exact count.
 *
 * Measured at 28 against the `openclaw` this suite installs. Pinning 28 would
 * turn every upstream tool addition into a red run here, which is not what this
 * test is for; a floor still fails the case worth catching, a bridge that comes
 * up serving almost nothing.
 */
const MIN_BRIDGED_TOOLS = 25;

/** A read-only listing, chosen so invoking it changes nothing anywhere. */
const HARMLESS_TOOL = "agents_list";

type McpServerEntry = {
  type?: string;
  url: string;
  headers?: Record<string, string>;
};

/** Minimal MCP client: JSON-RPC over HTTP POST, using the config's own headers. */
function mcpPost(
  server: McpServerEntry,
  body: unknown,
): Promise<{ status: number; text: string }> {
  const url = new URL(server.url);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          ...server.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": String(payload.length),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

type BridgeTurn = {
  sandbox: GatewaySandbox;
  /** Where the stub wrote what it was handed. */
  capture: string;
  /** The agent's working directory — where the bridged config appears. */
  workspace: string;
  /** The `.cursor/mcp.json` the bridge writes and cleanup has to undo. */
  mcpPath: string;
  turn: AsyncRun;
  /** Lets the parked stub finish, then waits for the turn to exit. */
  release: () => Promise<RunResult>;
};

/**
 * Runs a bridged turn and owns everything around it.
 *
 * The two tests below differ only in what they assert while the stub is parked
 * and what they expect of the workspace afterwards. Everything else — start the
 * gateway, fire the turn, wait for the stub, dump diagnostics on failure,
 * release the stub, kill the turn, stop the gateway, delete the sandbox — is
 * the same either way, and getting any step of it wrong leaves orphans behind
 * rather than failing outright. It lives here once.
 */
async function withBridgeTurn(
  options: {
    captureDir: string;
    sessionKey: string;
    port: number;
    /** Runs before the gateway starts, e.g. to seed an existing config. */
    seed?: (ctx: { workspace: string; mcpPath: string }) => void;
  },
  body: (ctx: BridgeTurn) => Promise<void>,
): Promise<void> {
  const sandbox = createGatewaySandbox({
    backendId: "cursor-mcp",
    model: MODEL,
    command: FAKE_CURSOR_AGENT,
    port: options.port,
    env: { FAKE_HOLD_MS: "120000" },
  });
  const capture = path.join(sandbox.root, options.captureDir);
  const workspace = sandbox.workspace;
  const mcpPath = path.join(workspace, ".cursor", "mcp.json");
  // The capture dir has to be named before the gateway spawns the backend,
  // which inherits this env.
  sandbox.env.FAKE_OUT_DIR = capture;

  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let turn: AsyncRun | undefined;
  try {
    options.seed?.({ workspace, mcpPath });
    gateway = await startGateway(sandbox);
    turn = startTurn(sandbox, options.sessionKey);

    await waitFor(
      () => existsSync(path.join(capture, "READY")),
      "the stub cursor-agent to be spawned",
      120_000,
    );

    const release = async () => {
      writeFileSync(path.join(capture, "RELEASE"), "");
      const finished = await (turn as AsyncRun).done;
      assert.equal(
        finished.status,
        0,
        `the turn failed:\n${finished.stderr.slice(0, 1500)}`,
      );
      return finished;
    };

    await body({ sandbox, capture, workspace, mcpPath, turn, release });
  } catch (error) {
    // The gateway's own log is usually the only place that says why a turn
    // never reached the backend, and CI has no other way to see it. The
    // workspace config is the other half: what cleanup did or failed to do.
    if (gateway)
      process.stderr.write(`--- gateway log ---\n${gateway.logs()}\n`);
    if (existsSync(mcpPath))
      process.stderr.write(
        `--- .cursor/mcp.json as left behind ---\n${readFileSync(mcpPath, "utf-8")}\n`,
      );
    throw error;
  } finally {
    // Release the stub even when an assertion above threw, or it holds the
    // turn open until its own deadline. The capture directory only exists once
    // the stub has run, so a miss here is expected and must not mask the real
    // failure.
    try {
      writeFileSync(path.join(capture, "RELEASE"), "");
    } catch {
      // the stub never started
    }
    // Without this a failed assertion leaves `openclaw agent` and the stub
    // running, reparented to init, while cleanup deletes the config beneath
    // them. Measured: four orphans and a 130s test.
    turn?.kill();
    await gateway?.stop();
    sandbox.cleanup();
  }
}

test("a cursor-mcp turn bridges a reachable loopback MCP server", {
  skip,
  timeout: 300_000,
}, async (t) => {
  await withBridgeTurn(
    {
      captureDir: "__capture__",
      sessionKey: "agent:main:integration",
      port: gatewayPort(1),
    },
    async ({ capture, workspace, release }) => {
      // 1. OpenClaw still hands over the shape the bridge rewrites.
      const argv: string[] = JSON.parse(
        readFileSync(path.join(capture, "argv.json"), "utf-8"),
      );
      assertBridgedArgv(argv, "the stub");
      // The allowed model actually resolved, all the way to the flag the binary
      // is launched with — and stripped of the `cursor-mcp/` prefix, which is
      // OpenClaw's addressing and means nothing to cursor-agent. Catalog listing
      // and allowlist listing are both upstream of this and neither implies it.
      const modelFlag = argv.indexOf("--model");
      assert.deepEqual(
        argv.slice(modelFlag, modelFlag + 2),
        ["--model", MODEL],
        `the turn did not reach the backend as ${MODEL}: ${JSON.stringify(argv)}`,
      );

      // 2. The bridged config is on disk, and is a config cursor-agent could use.
      const bridgedPath = path.join(capture, "cursor-mcp.json");
      const missing = path.join(capture, "cursor-mcp.MISSING");
      assert.ok(
        existsSync(bridgedPath),
        `the bridge never wrote .cursor/mcp.json; the stub looked at ${
          existsSync(missing)
            ? readFileSync(missing, "utf-8").trim()
            : "(unknown)"
        }`,
      );
      const bridged = JSON.parse(readFileSync(bridgedPath, "utf-8"));
      const server: McpServerEntry = bridged.mcpServers?.openclaw;
      assert.ok(server?.url, "no openclaw server entry in the bridged config");
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\//);
      assert.ok(
        server.headers?.Authorization,
        "the openclaw entry carries no Authorization header",
      );

      // 3. The interesting part: that server answers, with those credentials.
      const initialize = await mcpPost(server, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "openclaw-cursor-cli-integration", version: "0" },
        },
      });
      assert.equal(
        initialize.status,
        200,
        `initialize failed: ${initialize.status} ${initialize.text.slice(0, 400)}`,
      );
      assert.match(initialize.text, /"serverInfo"/);

      await mcpPost(server, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      });

      const listed = await mcpPost(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      assert.equal(
        listed.status,
        200,
        `tools/list failed: ${listed.status} ${listed.text.slice(0, 400)}`,
      );
      const tools: { name: string }[] = JSON.parse(listed.text).result.tools;
      const names = tools.map((tool) => tool.name);
      t.diagnostic(
        `loopback exposed ${names.length} tools: ${names.join(", ")}`,
      );
      assert.ok(
        names.length >= MIN_BRIDGED_TOOLS,
        `the bridge came up serving ${names.length} tools, below the ${MIN_BRIDGED_TOOLS} floor: ${names.join(", ")}`,
      );
      // `sessions_spawn` is the capability the README warns about when it tells
      // you to pick `cursor-mcp` only for sessions you trust.
      assert.ok(
        names.includes("sessions_spawn"),
        `expected sessions_spawn among: ${names.join(", ")}`,
      );

      // Listing tools only proves the server describes itself. Invoke one — the
      // most inert on the list — to show the bridge reaches something that can
      // actually run, which is the whole reason cursor-agent is pointed at it.
      assert.ok(
        names.includes(HARMLESS_TOOL),
        `${HARMLESS_TOOL} is gone; pick another read-only tool from: ${names.join(", ")}`,
      );
      const called = await mcpPost(server, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: HARMLESS_TOOL, arguments: {} },
      });
      assert.equal(
        called.status,
        200,
        `tools/call ${HARMLESS_TOOL} failed: ${called.status} ${called.text.slice(0, 400)}`,
      );
      const callResult = JSON.parse(called.text);
      assert.equal(
        callResult.error,
        undefined,
        `tools/call ${HARMLESS_TOOL} returned an error: ${called.text.slice(0, 400)}`,
      );
      assert.ok(
        callResult.result,
        `tools/call ${HARMLESS_TOOL} returned no result: ${called.text.slice(0, 400)}`,
      );

      // The residue check below is only meaningful if the stub ran in the
      // workspace we are about to inspect.
      // Compare resolved paths: on macOS the temp root reaches the child as
      // /private/var while this side still holds the /var symlink.
      assert.equal(
        realpathSync(
          readFileSync(path.join(capture, "cwd.txt"), "utf-8").trim(),
        ),
        realpathSync(workspace),
        "the stub ran somewhere other than the workspace under test",
      );

      // Let the stub finish so the turn completes and cleanup runs.
      await release();

      // 4. The prompt travelled over stdin, not argv. The plugin wraps it with a
      //    runtime banner, so this is also the only place that shows the banner
      //    reaching the binary rather than just being built.
      const stdin = readFileSync(path.join(capture, "stdin.txt"), "utf-8");
      assert.match(
        stdin,
        new RegExp(TURN_PROMPT),
        `the prompt never reached the binary's stdin:\n${stdin.slice(0, 800)}`,
      );

      // 5. Cleanup put the workspace back. The backup was "absent", so the
      //    bridged file — bearer token and all — must be gone.
      await waitFor(
        () => !existsSync(path.join(workspace, ".cursor", "mcp.json")),
        "cleanup to remove the bridged .cursor/mcp.json",
        // Cleanup lands in well under a second once the turn returns; the rest is
        // headroom for a loaded runner. Measured with cleanup disabled, this is
        // what a real failure costs, so it is kept short enough to be tolerable.
        30_000,
      );
    },
  );
});

test("the bridge gives a pre-existing .cursor/mcp.json back untouched", {
  skip,
  timeout: 300_000,
}, async () => {
  // The test above covers the branch where the workspace had no `.cursor/mcp.json`
  // and cleanup deletes what the bridge wrote. The other branch is the one a
  // real Cursor user is in: a config already on disk, which has to survive the
  // turn with its own servers intact and the bridged entry gone. Unit tests
  // cover the backup bookkeeping against a mocked filesystem; what they cannot
  // check is that OpenClaw actually reaches the cleanup hook on a real turn.
  // Deliberately not the shape the plugin writes: a top-level key it knows
  // nothing about, and trailing whitespace inside a value. Restoring means
  // giving these bytes back, not re-serialising an equivalent document.
  const original = `${JSON.stringify(
    {
      $schema: "https://example.invalid/mcp.schema.json",
      mcpServers: {
        "user-notes": { command: "note-server", args: ["--stdio "] },
      },
    },
    null,
    4,
  )}\n`;

  await withBridgeTurn(
    {
      captureDir: "__capture-restore__",
      sessionKey: "agent:main:restore",
      port: gatewayPort(2),
      seed: ({ mcpPath }) => {
        mkdirSync(path.dirname(mcpPath), { recursive: true });
        writeFileSync(mcpPath, original, "utf-8");
      },
    },
    async ({ capture, mcpPath, release }) => {
      // Mid-turn: the user's server and the bridged one coexist, and the parts
      // of the document the plugin does not model are still there.
      const bridged = JSON.parse(
        readFileSync(path.join(capture, "cursor-mcp.json"), "utf-8"),
      );
      assert.ok(
        bridged.mcpServers?.openclaw?.url,
        "the bridge did not add its own server to the existing config",
      );
      assert.deepEqual(
        bridged.mcpServers?.["user-notes"],
        { command: "note-server", args: ["--stdio "] },
        "the user's own server did not survive the merge",
      );
      assert.equal(bridged.$schema, "https://example.invalid/mcp.schema.json");

      await release();

      // After cleanup: byte-for-byte what was there before, so no token is left
      // behind and no reformatting is imposed on the user's file.
      await waitFor(
        () =>
          existsSync(mcpPath) && readFileSync(mcpPath, "utf-8") === original,
        "cleanup to restore .cursor/mcp.json exactly as it was",
        30_000,
      );
    },
  );
});
