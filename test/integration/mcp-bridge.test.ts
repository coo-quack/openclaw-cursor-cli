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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import {
  createSandbox,
  FAKE_CURSOR_AGENT,
  integrationSkipReason,
  REPO_ROOT,
  runOpenclawAsync,
  startGateway,
  waitFor,
} from "./harness.ts";

const skip = integrationSkipReason();

/** A distinct port per run, so a leftover listener can't silently be reused. */
const GATEWAY_PORT = 19_600 + (process.pid % 300);

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

test("a cursor-mcp turn bridges a reachable loopback MCP server", {
  skip,
  timeout: 300_000,
}, async (t) => {
  const captureDir = "__capture__";
  const sandbox = createSandbox({
    plugins: {
      load: { paths: [REPO_ROOT] },
      // Loading the plugin from a path is not enough to make its backend run
      // a turn — it also has to be enabled. Measured: without this entry the
      // plugin still reports `status: loaded`, but the turn bypasses the
      // backend entirely and the stub is handed the bare prompt with no
      // `--approve-mcps` and no bridged config. `plugins install --link` adds
      // the equivalent to `plugins.allow` for real installs.
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
        model: "cursor-mcp/cursor-grok-4.5-high-fast",
        models: { "cursor-mcp/cursor-grok-4.5-high-fast": {} },
        cliBackends: {
          "cursor-mcp": {
            command: FAKE_CURSOR_AGENT,
            env: { FAKE_HOLD_MS: "120000" },
          },
        },
      },
    },
  });
  const capture = path.join(sandbox.root, captureDir);
  const workspace = path.join(sandbox.root, "ws");
  // The workspace and the capture dir have to exist before the gateway spawns
  // the backend, which inherits this env.
  sandbox.env.FAKE_OUT_DIR = capture;

  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    const configured = JSON.parse(readFileSync(sandbox.configPath, "utf-8"));
    configured.agents.defaults.workspace = workspace;
    writeFileSync(
      sandbox.configPath,
      `${JSON.stringify(configured, null, 2)}\n`,
      "utf-8",
    );

    gateway = await startGateway(sandbox, GATEWAY_PORT);

    // Fire the turn without waiting for it. It must not block the event loop:
    // the stub parks until this test releases it, so a synchronous spawn here
    // would deadlock the two against each other.
    // `--session-key` is required: without a session target `openclaw agent`
    // refuses to run at all. The model ref is passed explicitly so the test
    // states which backend it is exercising rather than depending on the
    // config default.
    const turn = runOpenclawAsync(sandbox, [
      "agent",
      "--session-key",
      "agent:main:integration",
      "--message",
      "integration probe",
      "--model",
      "cursor-mcp/cursor-grok-4.5-high-fast",
      "--json",
    ]);

    await waitFor(
      () => existsSync(path.join(capture, "READY")),
      "the stub cursor-agent to be spawned",
      120_000,
    );

    // 1. OpenClaw still hands over the shape the bridge rewrites.
    const argv: string[] = JSON.parse(
      readFileSync(path.join(capture, "argv.json"), "utf-8"),
    );
    assert.ok(
      argv.includes("--approve-mcps"),
      `--approve-mcps missing from ${JSON.stringify(argv)}`,
    );
    assert.ok(
      !argv.includes("--strict-mcp-config") && !argv.includes("--mcp-config"),
      `Claude-only flags survived into ${JSON.stringify(argv)}`,
    );

    // 2. The bridged config is on disk, and is a config cursor-agent could use.
    const bridgedPath = path.join(capture, "cursor-mcp.json");
    assert.ok(
      existsSync(bridgedPath),
      "the bridge never wrote .cursor/mcp.json",
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
    t.diagnostic(`loopback exposed ${names.length} tools`);
    assert.ok(names.length > 0, "the loopback server exposed no tools at all");
    // `sessions_spawn` is the capability the README warns about when it tells
    // you to pick `cursor-mcp` only for sessions you trust.
    assert.ok(
      names.includes("sessions_spawn"),
      `expected sessions_spawn among: ${names.join(", ")}`,
    );

    // Let the stub finish so the turn completes and cleanup runs.
    writeFileSync(path.join(capture, "RELEASE"), "");
    await turn;

    // 4. Cleanup put the workspace back. The backup was "absent", so the
    //    bridged file — bearer token and all — must be gone.
    await waitFor(
      () => !existsSync(path.join(workspace, ".cursor", "mcp.json")),
      "cleanup to remove the bridged .cursor/mcp.json",
      60_000,
    );
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
    await gateway?.stop();
    sandbox.cleanup();
  }
});
