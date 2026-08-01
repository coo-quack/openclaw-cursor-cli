import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync as readFileSyncTest,
  rmSync,
  symlinkSync,
  writeFileSync as writeFileSyncTest,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CliBackendConfig } from "openclaw/plugin-sdk/cli-backend";
import {
  applyCursorAgentModelToArgs,
  buildCursorCliBackend,
  CURSOR_CLI_BACKEND_ID,
  CURSOR_GROK_MODEL_ALIASES,
  CURSOR_MCP_BACKEND_ID,
  createCursorMcpBridge,
  extractClaudeMcpConfigPath,
  isThisPackageCursorAgentWrapper,
  normalizeCursorCliConfig,
  pathsEqual,
  resetLegacyMcpBridgeEnvWarningForTest,
  resolveCursorAgentWrapperPath,
  stripClaudeMcpConfigArgs,
  warnIfLegacyMcpBridgeEnvSet,
} from "../src/backend.ts";
import { OPENCLAW_CURSOR_AGENT_BIN_ENV } from "../src/cursor-agent-wrapper.ts";
import { resolveCursorCommand } from "../src/entry-helpers.ts";

/**
 * OpenClaw runs the prepare phase before resolving execution args, and the
 * bridge declines to write without the backup entry prepare registers — so
 * every apply below needs one. Keeps the fixture cast in one place.
 */
function prepareBridge(
  bridge: ReturnType<typeof createCursorMcpBridge>,
  workspaceDir: string,
) {
  // `workspaceDir` is the only field the bridge reads; the rest of OpenClaw's
  // execution context is irrelevant here and expensive to fabricate. Narrowed
  // through `unknown` rather than `any`, so the literal above is still checked
  // against nothing more than itself.
  type PrepareContext = Parameters<typeof bridge.prepareCursorCliExecution>[0];
  return bridge.prepareCursorCliExecution({
    workspaceDir,
  } as unknown as PrepareContext);
}

const BASE = ["-p", "--output-format", "stream-json", "--trust", "--force"];

test("backend defaults match the verified phase-1 contract", () => {
  const backend = buildCursorCliBackend();
  assert.equal(backend.id, "cursor-cli");
  assert.equal(backend.nativeToolMode, "always-on");
  assert.equal(backend.sideQuestionToolMode, "disabled");
  assert.equal(backend.config.command, "cursor-agent");
  assert.deepEqual(backend.config.args, BASE);
  assert.deepEqual(backend.config.resumeArgs, [
    ...BASE,
    "--resume",
    "{sessionId}",
  ]);
  assert.equal(backend.config.output, "jsonl");
  assert.equal(backend.config.input, "stdin");
  assert.equal(backend.config.modelArg, "--model");
  assert.deepEqual(backend.config.modelAliases, {
    ...CURSOR_GROK_MODEL_ALIASES,
  });
  assert.equal(backend.config.sessionMode, "existing");
  assert.deepEqual(backend.config.sessionIdFields, ["session_id"]);
  assert.equal(backend.config.serialize, true);
  assert.equal(backend.config.jsonlDialect, "claude-stream-json");
  assert.equal(backend.config.systemPromptWhen, "never");
});

test("buildCursorCliBackend() defaults to cursor-cli with bundleMcp off", () => {
  const backend = buildCursorCliBackend();
  assert.equal(backend.id, CURSOR_CLI_BACKEND_ID);
  assert.equal(backend.bundleMcp, undefined);
  assert.equal(backend.bundleMcpMode, undefined);
  assert.equal(backend.prepareExecution, undefined);
  assert.equal(
    backend.liveTest?.defaultModelRef,
    "cursor-cli/grok-4.5-high-fast",
  );
});

test("buildCursorCliBackend({ id: cursor-cli, bundleMcp: false }) has no MCP bridge wiring", () => {
  const backend = buildCursorCliBackend({
    id: CURSOR_CLI_BACKEND_ID,
    bundleMcp: false,
  });
  assert.equal(backend.id, "cursor-cli");
  assert.equal(backend.bundleMcp, undefined);
  assert.equal(backend.bundleMcpMode, undefined);
  assert.equal(backend.prepareExecution, undefined);
});

test("buildCursorCliBackend({ id: cursor-mcp, bundleMcp: true }) wires the MCP bridge", () => {
  const backend = buildCursorCliBackend({
    id: CURSOR_MCP_BACKEND_ID,
    bundleMcp: true,
  });
  assert.equal(backend.id, "cursor-mcp");
  assert.equal(backend.bundleMcp, true);
  assert.equal(backend.bundleMcpMode, "claude-config-file");
  assert.equal(typeof backend.prepareExecution, "function");
  assert.equal(
    backend.liveTest?.defaultModelRef,
    "cursor-mcp/grok-4.5-high-fast",
  );
});

test("both backends keep jsonlDialect/systemPromptWhen/argv defaults identical", () => {
  const cli = buildCursorCliBackend({
    id: CURSOR_CLI_BACKEND_ID,
    bundleMcp: false,
  });
  const mcp = buildCursorCliBackend({
    id: CURSOR_MCP_BACKEND_ID,
    bundleMcp: true,
  });
  for (const backend of [cli, mcp]) {
    assert.equal(backend.config.jsonlDialect, "claude-stream-json");
    assert.equal(backend.config.systemPromptWhen, "never");
    assert.deepEqual(backend.config.args, BASE);
    assert.equal(backend.nativeToolMode, "always-on");
    assert.equal(backend.sideQuestionToolMode, "disabled");
  }
});

test("applyCursorAgentModelToArgs rewrites an existing --model value", () => {
  assert.deepEqual(
    applyCursorAgentModelToArgs(
      ["-p", "--model", "grok-4.5-high-fast", "--force"],
      "--model",
      "grok-4.5-high-fast",
    ),
    ["-p", "--model", "cursor-grok-4.5-high-fast", "--force"],
  );
});

test("applyCursorAgentModelToArgs appends --model when absent", () => {
  assert.deepEqual(
    applyCursorAgentModelToArgs(["-p", "--force"], "--model", "grok-4.5-low"),
    ["-p", "--force", "--model", "cursor-grok-4.5-low"],
  );
});

test("applyCursorAgentModelToArgs inserts model id when --model is followed by another flag", () => {
  assert.deepEqual(
    applyCursorAgentModelToArgs(
      ["-p", "--model", "--force"],
      "--model",
      "grok-4.5-low",
    ),
    ["-p", "--model", "cursor-grok-4.5-low", "--force"],
  );
});

test("applyCursorAgentModelToArgs inserts model id after trailing --model", () => {
  assert.deepEqual(
    applyCursorAgentModelToArgs(
      ["-p", "--force", "--model"],
      "--model",
      "grok-4.5-low",
    ),
    ["-p", "--force", "--model", "cursor-grok-4.5-low"],
  );
});

test("buildCursorCliBackend.resolveExecutionArgs maps OpenClaw grok ids to cursor-agent ids", () => {
  const backend = buildCursorCliBackend({
    id: CURSOR_CLI_BACKEND_ID,
    bundleMcp: false,
  });
  const args = backend.resolveExecutionArgs?.({
    executionMode: "agent",
    baseArgs: BASE,
    workspaceDir: "/tmp",
    provider: CURSOR_CLI_BACKEND_ID,
    modelId: "grok-4.5-high-fast",
    useResume: false,
  });
  assert.deepEqual(args, [...BASE, "--model", "cursor-grok-4.5-high-fast"]);
});

test("cursor-mcp backend's resolveExecutionArgs applies the MCP bridge; cursor-cli's does not", () => {
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-mcp-backend-test-"),
  );
  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1/mcp" } },
    }),
  );
  try {
    const injectedArgs = [
      ...BASE,
      "--strict-mcp-config",
      "--mcp-config",
      genPath,
    ];

    const mcpBridge = createCursorMcpBridge();
    prepareBridge(mcpBridge, workspaceDir);
    const mcp = buildCursorCliBackend({
      id: CURSOR_MCP_BACKEND_ID,
      bundleMcp: true,
      mcpBridge,
    });
    const mcpArgs = mcp.resolveExecutionArgs?.({
      workspaceDir,
      provider: CURSOR_MCP_BACKEND_ID,
      modelId: "cursor-grok-4.5-high-fast",
      useResume: false,
      baseArgs: injectedArgs,
    });
    assert.deepEqual(mcpArgs, [
      ...BASE,
      "--approve-mcps",
      "--model",
      "cursor-grok-4.5-high-fast",
    ]);
    const written = JSON.parse(
      readFileSyncTest(path.join(workspaceDir, ".cursor", "mcp.json"), "utf-8"),
    );
    assert.equal(written.mcpServers.openclaw.url, "http://127.0.0.1:1/mcp");

    const cli = buildCursorCliBackend({
      id: CURSOR_CLI_BACKEND_ID,
      bundleMcp: false,
    });
    const cliArgs = cli.resolveExecutionArgs?.({
      workspaceDir,
      provider: CURSOR_CLI_BACKEND_ID,
      modelId: "cursor-grok-4.5-high-fast",
      useResume: false,
      baseArgs: injectedArgs,
    });
    // No bridge: the Claude-shaped mcp-config flags pass through untouched
    // (cursor-agent itself will just ignore/reject them if ever reached;
    // cursor-cli's config never asks OpenClaw's runner to inject them). The
    // mapped --model pair is still appended.
    assert.deepEqual(cliArgs, [
      ...injectedArgs,
      "--model",
      "cursor-grok-4.5-high-fast",
    ]);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("buildCursorCliBackend.resolveExecutionArgs handles side-question mode", () => {
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-side-question-mode-"),
  );
  try {
    const backend = buildCursorCliBackend({
      id: CURSOR_CLI_BACKEND_ID,
      bundleMcp: false,
    });

    // Side-question mode: strips --resume and appends --mode ask
    const sideQuestionArgs = backend.resolveExecutionArgs?.({
      executionMode: "side-question",
      baseArgs: [...BASE, "--resume", "abc-123"],
      workspaceDir,
      provider: CURSOR_CLI_BACKEND_ID,
      modelId: "cursor-grok-4.5-high-fast",
      useResume: false,
    });
    assert.deepEqual(sideQuestionArgs, [
      ...BASE,
      "--mode",
      "ask",
      "--model",
      "cursor-grok-4.5-high-fast",
    ]);

    // Normal agent mode: baseArgs plus the mapped --model pair
    const agentArgs = backend.resolveExecutionArgs?.({
      executionMode: "agent",
      baseArgs: BASE,
      workspaceDir,
      provider: CURSOR_CLI_BACKEND_ID,
      modelId: "cursor-grok-4.5-high-fast",
      useResume: false,
    });
    assert.deepEqual(agentArgs, [
      ...BASE,
      "--model",
      "cursor-grok-4.5-high-fast",
    ]);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("buildCursorCliBackend.resolveExecutionArgs applies bridge for bundleMcp backend in side-question", () => {
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-side-question-"),
  );
  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-side-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:2/mcp" } },
    }),
  );
  try {
    const injectedArgs = [
      ...BASE,
      "--strict-mcp-config",
      "--mcp-config",
      genPath,
      "--resume",
      "old-session",
    ];

    const mcpBridge = createCursorMcpBridge();
    prepareBridge(mcpBridge, workspaceDir);
    const mcp = buildCursorCliBackend({
      id: CURSOR_MCP_BACKEND_ID,
      bundleMcp: true,
      mcpBridge,
    });
    const mcpArgs = mcp.resolveExecutionArgs?.({
      executionMode: "side-question",
      workspaceDir,
      baseArgs: injectedArgs,
      provider: CURSOR_MCP_BACKEND_ID,
      modelId: "cursor-grok-4.5-high-fast",
      useResume: false,
    });
    // Both transformations applied:
    // 1. side-question: --resume removed, --mode ask added
    // 2. bridge: Claude flags stripped, --approve-mcps added
    // 3. model mapping: --model appended with the cursor-agent id
    assert.deepEqual(mcpArgs, [
      ...BASE,
      "--mode",
      "ask",
      "--approve-mcps",
      "--model",
      "cursor-grok-4.5-high-fast",
    ]);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("warnIfLegacyMcpBridgeEnvSet warns once when the legacy env var is set, and is silent when unset", () => {
  resetLegacyMcpBridgeEnvWarningForTest();
  const warnings: string[] = [];
  const logger = { warn: (message: string) => warnings.push(message) };

  warnIfLegacyMcpBridgeEnvSet({}, logger);
  assert.deepEqual(warnings, []);

  warnIfLegacyMcpBridgeEnvSet({ OPENCLAW_CURSOR_CLI_MCP_BRIDGE: "1" }, logger);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /deprecated/);
  assert.match(warnings[0] ?? "", /cursor-mcp\//);

  // Called again in the same process: latch prevents a second warning.
  warnIfLegacyMcpBridgeEnvSet({ OPENCLAW_CURSOR_CLI_MCP_BRIDGE: "1" }, logger);
  assert.equal(warnings.length, 1);

  resetLegacyMcpBridgeEnvWarningForTest();
});

test("normalizeCursorCliConfig rewrites command to wrapper and stashes real binary", () => {
  const wrapper = resolveCursorAgentWrapperPath();
  const normalized = normalizeCursorCliConfig({
    command: "/Users/ai/.local/bin/cursor-agent",
    args: BASE,
    output: "jsonl",
    input: "stdin",
  } as CliBackendConfig);
  assert.equal(normalized.command, wrapper);
  assert.equal(
    normalized.env?.[OPENCLAW_CURSOR_AGENT_BIN_ENV],
    "/Users/ai/.local/bin/cursor-agent",
  );
});

test("normalizeCursorCliConfig is idempotent when already wrapped", () => {
  const wrapper = resolveCursorAgentWrapperPath();
  const once = normalizeCursorCliConfig({
    command: "/Users/ai/.local/bin/cursor-agent",
    output: "jsonl",
    input: "stdin",
  } as CliBackendConfig);
  const twice = normalizeCursorCliConfig(once);
  assert.equal(twice.command, wrapper);
  assert.equal(
    twice.env?.[OPENCLAW_CURSOR_AGENT_BIN_ENV],
    "/Users/ai/.local/bin/cursor-agent",
  );
});

test("normalizeCursorCliConfig rewrites foreign same-basename wrapper paths", () => {
  const wrapper = resolveCursorAgentWrapperPath();
  const normalized = normalizeCursorCliConfig({
    command: "/tmp/other/cursor-agent-wrapper.ts",
    env: {
      [OPENCLAW_CURSOR_AGENT_BIN_ENV]: "/Users/ai/.local/bin/cursor-agent",
    },
    output: "jsonl",
    input: "stdin",
  } as CliBackendConfig);
  assert.equal(normalized.command, wrapper);
  assert.equal(
    normalized.env?.[OPENCLAW_CURSOR_AGENT_BIN_ENV],
    "/Users/ai/.local/bin/cursor-agent",
  );
});

test("normalizeCursorCliConfig treats a cwd-relative package wrapper as already wrapped", () => {
  const wrapper = resolveCursorAgentWrapperPath();
  const relativeWrapper = path.relative(process.cwd(), wrapper);
  const normalized = normalizeCursorCliConfig({
    command: relativeWrapper,
    env: {
      [OPENCLAW_CURSOR_AGENT_BIN_ENV]: "/Users/ai/.local/bin/cursor-agent",
    },
    output: "jsonl",
    input: "stdin",
  } as CliBackendConfig);
  assert.equal(normalized.command, relativeWrapper);
  assert.equal(
    normalized.env?.[OPENCLAW_CURSOR_AGENT_BIN_ENV],
    "/Users/ai/.local/bin/cursor-agent",
  );
});

test("backend registers normalizeConfig and keeps systemPromptWhen never", () => {
  const backend = buildCursorCliBackend();
  assert.equal(typeof backend.normalizeConfig, "function");
  assert.equal(backend.config.systemPromptWhen, "never");
});

test("resolveCursorCommand prefers OPENCLAW_CURSOR_AGENT_BIN after normalize", () => {
  const wrapper = resolveCursorAgentWrapperPath();
  const cmd = resolveCursorCommand({
    agents: {
      defaults: {
        cliBackends: {
          "cursor-cli": {
            command: wrapper,
            env: {
              [OPENCLAW_CURSOR_AGENT_BIN_ENV]:
                "/Users/ai/.local/bin/cursor-agent",
            },
          },
        },
      },
    },
  });
  assert.equal(cmd, "/Users/ai/.local/bin/cursor-agent");
});

// --- MCP bridge (applyCursorMcpBridge / extract / strip helpers) ---

test("pathsEqual resolves relative and absolute forms of the same path", () => {
  const abs = resolveCursorAgentWrapperPath();
  const rel = path.relative(process.cwd(), abs);
  assert.equal(pathsEqual(abs, rel), true);
  assert.equal(pathsEqual(abs, "/tmp/other/cursor-agent-wrapper.ts"), false);
});

test("isThisPackageCursorAgentWrapper rejects foreign same-basename paths", () => {
  assert.equal(
    isThisPackageCursorAgentWrapper(resolveCursorAgentWrapperPath()),
    true,
  );
  assert.equal(
    isThisPackageCursorAgentWrapper("/tmp/other/cursor-agent-wrapper.ts"),
    false,
  );
});

test("extractClaudeMcpConfigPath finds --mcp-config value (space and = forms)", () => {
  assert.equal(
    extractClaudeMcpConfigPath(["-p", "--mcp-config", "/tmp/foo.json"]),
    "/tmp/foo.json",
  );
  assert.equal(
    extractClaudeMcpConfigPath(["-p", "--mcp-config=/tmp/bar.json"]),
    "/tmp/bar.json",
  );
  assert.equal(extractClaudeMcpConfigPath(["-p", "--force"]), undefined);
});

test("stripClaudeMcpConfigArgs removes --strict-mcp-config and --mcp-config <path>", () => {
  assert.deepEqual(
    stripClaudeMcpConfigArgs([
      "-p",
      "--strict-mcp-config",
      "--mcp-config",
      "/tmp/foo.json",
      "--force",
    ]),
    ["-p", "--force"],
  );
  assert.deepEqual(
    stripClaudeMcpConfigArgs(["-p", "--mcp-config=/tmp/foo.json", "--force"]),
    ["-p", "--force"],
  );
});

test("applyCursorMcpBridge is a no-op (aside from stripping) when no bundle config was injected", () => {
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-mcp-test-"),
  );
  try {
    prepareBridge(bridge, workspaceDir);
    assert.deepEqual(
      bridge.applyCursorMcpBridge(["-p", "--force"], workspaceDir),
      ["-p", "--force"],
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("applyCursorMcpBridge writes .cursor/mcp.json, strips claude flags, and adds --approve-mcps", () => {
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-mcp-test-"),
  );
  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: {
        openclaw: {
          url: "http://127.0.0.1:1234/mcp",
          headers: { Authorization: "Bearer xyz" },
        },
      },
    }),
  );
  try {
    prepareBridge(bridge, workspaceDir);
    const result = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );
    assert.deepEqual(result, ["-p", "--force", "--approve-mcps"]);
    const written = JSON.parse(
      readFileSyncTest(path.join(workspaceDir, ".cursor", "mcp.json"), "utf-8"),
    );
    assert.equal(written.mcpServers.openclaw.url, "http://127.0.0.1:1234/mcp");
    assert.equal(
      written.mcpServers.openclaw.headers.Authorization,
      "Bearer xyz",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("applyCursorMcpBridge merges existing mcp.json servers with generated servers (regression: backup format)", async () => {
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-mcp-regression-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  mkdirSync(mcpDir, { recursive: true });
  const mcpPath = path.join(mcpDir, "mcp.json");

  // Pre-existing mcp.json with a custom server
  writeFileSyncTest(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        custom: {
          url: "http://localhost:3000/mcp",
          headers: { "X-Custom": "value" },
        },
      },
    }),
  );

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: {
        openclaw: {
          url: "http://127.0.0.1:1234/mcp",
        },
      },
    }),
  );

  try {
    // Backup the existing mcp.json first (simulating prepareCursorCliExecution)
    const prep = prepareBridge(bridge, workspaceDir);

    // Now apply the bridge, which should merge existing + generated
    bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    const written = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));

    // Both servers should be present
    assert.ok(
      written.mcpServers.custom,
      "existing custom server should be preserved",
    );
    assert.equal(written.mcpServers.custom.url, "http://localhost:3000/mcp");
    assert.equal(written.mcpServers.custom.headers["X-Custom"], "value");

    assert.ok(
      written.mcpServers.openclaw,
      "generated openclaw server should be present",
    );
    assert.equal(written.mcpServers.openclaw.url, "http://127.0.0.1:1234/mcp");

    // Cleanup
    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("applyCursorMcpBridge does not add a duplicate --approve-mcps", () => {
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-mcp-test-"),
  );
  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1/mcp" } },
    }),
  );
  try {
    prepareBridge(bridge, workspaceDir);
    const result = bridge.applyCursorMcpBridge(
      ["--mcp-config", genPath, "--approve-mcps"],
      workspaceDir,
    );
    assert.deepEqual(result, ["--approve-mcps"]);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("applyCursorMcpBridge strips flags when writing mcp.json fails", () => {
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-mcp-test-"),
  );
  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1/mcp" } },
    }),
  );
  // Make the workspace itself unwritable so `.cursor/mcp.json` cannot be created.
  chmodSync(workspaceDir, 0o500);
  try {
    prepareBridge(bridge, workspaceDir);
    const result = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );
    assert.deepEqual(result, ["-p", "--force"]);
  } finally {
    chmodSync(workspaceDir, 0o700);
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("prepareCursorCliExecution handles concurrent prepare: first backup is reused, not overwritten", async () => {
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-concurrent-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    // Simulate original mcp.json in the workspace
    mkdirSync(mcpDir, { recursive: true });
    writeFileSyncTest(mcpPath, JSON.stringify({ original: true }));

    // First prepare backs up the original state
    const prep1 = prepareBridge(bridge, workspaceDir);

    // Simulate a write (what would happen between prepare and cleanup)
    writeFileSyncTest(mcpPath, JSON.stringify({ modified: true }));

    // Second concurrent prepare should NOT overwrite the backup with the
    // modified content; it should reuse the first backup (original: true)
    const prep2 = prepareBridge(bridge, workspaceDir);

    // Apply the bridge to set the wrote flag (simulating the production flow)
    bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    // Write something else (simulating second execution's modifications)
    writeFileSyncTest(mcpPath, JSON.stringify({ another_modification: true }));

    // Both cleanups run, but restoration only happens on the last one
    assert.ok(prep1.cleanup, "prep1 should have cleanup");
    assert.ok(prep2.cleanup, "prep2 should have cleanup");

    // First cleanup (refCount 2→1): should NOT restore the file
    await prep1.cleanup();
    const afterFirstCleanup = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      afterFirstCleanup,
      { another_modification: true },
      "first cleanup should not restore the file (not the last one)",
    );

    // Second cleanup (refCount 1→0): SHOULD restore the file to original
    await prep2.cleanup();
    const restored = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      restored,
      { original: true },
      "last cleanup should restore to ORIGINAL state",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("applyCursorMcpBridge declines to write when prepareCursorCliExecution never ran", () => {
  // Without a prepare, no cleanup is registered, so nothing would ever remove
  // the bearer token the bridge writes. Decline instead.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-mcp-fallback-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  mkdirSync(mcpDir, { recursive: true });
  const mcpPath = path.join(mcpDir, "mcp.json");

  // Pre-existing mcp.json with a custom server (no prepareCursorCliExecution called)
  writeFileSyncTest(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        myServer: { url: "http://localhost:9000/mcp" },
      },
    }),
  );

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: {
        openclaw: { url: "http://127.0.0.1:1234/mcp" },
      },
    }),
  );

  try {
    const before = readFileSyncTest(mcpPath, "utf-8");
    // Call applyCursorMcpBridge directly without prepareCursorCliExecution
    const result = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );
    assert.deepEqual(
      result,
      ["-p", "--force"],
      "flags are stripped but --approve-mcps is not added",
    );
    assert.equal(
      readFileSyncTest(mcpPath, "utf-8"),
      before,
      "the workspace config is left untouched",
    );
    assert.ok(
      warnings.some((msg) => msg.includes("no prepared execution")),
      `expected a warning about the missing prepare, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("applyCursorMcpBridge warns when mcp-config file cannot be read", () => {
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });

  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-mcp-read-fail-"),
  );
  try {
    prepareBridge(bridge, workspaceDir);
    // Reference a non-existent mcp-config file
    const nonexistentPath = path.join(workspaceDir, "nonexistent.json");
    const result = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", nonexistentPath, "--force"],
      workspaceDir,
    );

    // Should strip the unsupported flags and warn
    assert.deepEqual(result, ["-p", "--force"]);

    // Should have called warn with a message about the read failure
    assert.ok(
      warnings.length > 0,
      "should emit a warning when mcp-config read fails",
    );
    assert.ok(
      warnings[0]?.includes("failed to read mcp-config"),
      "warning should mention mcp-config read failure",
    );
    assert.ok(
      warnings[0]?.includes(nonexistentPath),
      "warning should include the path",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("regression: buildCursorCliBackend ensures prepare and apply use same bridge instance", async () => {
  // This test verifies that when a backend is built with bundleMcp: true,
  // the prepareExecution and resolveExecutionArgs methods both reference the
  // same bridge factory instance. If they didn't, backup state captured by
  // prepare would be invisible to apply, breaking the entire design.
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-instance-unity-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  mkdirSync(mcpDir, { recursive: true });
  const mcpPath = path.join(mcpDir, "mcp.json");

  // Pre-existing custom server before any prepare/apply
  const originalContent = JSON.stringify({
    mcpServers: { customServer: { url: "http://localhost:3000/mcp" } },
  });
  writeFileSyncTest(mcpPath, originalContent);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    // Build a cursor-mcp backend (bundleMcp: true), which internally creates
    // a bridge instance shared by both prepareExecution and resolveExecutionArgs
    const backend = buildCursorCliBackend({
      id: CURSOR_MCP_BACKEND_ID,
      bundleMcp: true,
    });

    // Simulate the prepare → modify → apply → cleanup lifecycle
    const prepResult = await backend.prepareExecution?.({
      workspaceDir,
      modelId: "test-model",
      provider: CURSOR_MCP_BACKEND_ID,
    });

    assert.ok(
      prepResult,
      "prepareExecution should return a prepared execution",
    );
    const prep = prepResult;

    // Modify the file between prepare and apply (simulating user/other process)
    writeFileSyncTest(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          customServer: { url: "http://localhost:3000/mcp" },
          modified: true,
        },
      }),
    );

    // Apply the bridge: inject the generated MCP config
    const injectedArgs = [
      ...BASE,
      "--strict-mcp-config",
      "--mcp-config",
      genPath,
    ];
    const resolvedArgs = backend.resolveExecutionArgs?.({
      workspaceDir,
      provider: CURSOR_MCP_BACKEND_ID,
      modelId: "cursor-grok-4.5-high-fast",
      useResume: false,
      baseArgs: injectedArgs,
    });

    assert.ok(resolvedArgs, "resolveExecutionArgs should return args");
    assert.deepEqual(
      resolvedArgs,
      [...BASE, "--approve-mcps", "--model", "cursor-grok-4.5-high-fast"],
      "should strip Claude flags and add --approve-mcps",
    );

    // File should now have both original custom server and generated openclaw server
    const afterApply = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.ok(
      afterApply.mcpServers.customServer,
      "custom server from backup should be preserved",
    );
    assert.equal(
      afterApply.mcpServers.customServer.url,
      "http://localhost:3000/mcp",
    );
    assert.ok(
      afterApply.mcpServers.openclaw,
      "generated openclaw server should be present",
    );
    assert.equal(
      afterApply.mcpServers.openclaw.url,
      "http://127.0.0.1:1234/mcp",
    );

    // Cleanup: should restore the file to original state (what prepare captured)
    await prep.cleanup?.();
    const restored = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      restored,
      JSON.parse(originalContent),
      "cleanup should restore file to original state (not the modified state between prepare/apply)",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("prepareCursorCliExecution detects unreadable backup and cleanup does not touch file", async () => {
  // When a file exists but is unreadable (e.g., EACCES),
  // prepareCursorCliExecution should mark it as unreadable, warn about it,
  // and cleanup should NOT attempt to restore/delete it (to avoid corrupting
  // or deleting a file we couldn't even read).
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-unreadable-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  mkdirSync(mcpDir, { recursive: true });
  const mcpPath = path.join(mcpDir, "mcp.json");

  // Create a file, then make it unreadable
  writeFileSyncTest(mcpPath, JSON.stringify({ original: true }));
  chmodSync(mcpPath, 0o000);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    // Prepare should detect the file as unreadable, mark it with kind="unreadable"
    const prep = prepareBridge(bridge, workspaceDir);

    // Should have warned about the unreadable file during prepare
    assert.ok(
      warnings.some((w) => w.includes("failed to read") && w.includes(mcpPath)),
      "prepare should warn when file is unreadable",
    );

    // Apply will attempt fallback read, which also fails (file still unreadable)
    // Since fallback read fails with non-ENOENT, apply warns and does NOT write
    const result = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );
    // Apply should strip flags but NOT add --approve-mcps (no successful write)
    assert.deepEqual(result, ["-p", "--force"]);

    // Verify file was NOT written by checking its content after making it readable
    chmodSync(mcpPath, 0o644);
    const afterApply = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      afterApply,
      { original: true },
      "file should not be modified by apply (write failed)",
    );

    // Make unreadable again before cleanup
    chmodSync(mcpPath, 0o000);

    // Cleanup should NOT attempt to restore/delete the unreadable file
    // (the backup was marked unreadable, so cleanup should skip it).
    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();

    // Make readable again to check it wasn't deleted or restored
    chmodSync(mcpPath, 0o644);
    const afterCleanup = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      afterCleanup,
      { original: true },
      "file should be unchanged (cleanup should not have touched unreadable backup)",
    );
  } finally {
    chmodSync(mcpPath, 0o644); // make readable so cleanup can work
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("applyCursorMcpBridge fallback read warns on non-ENOENT failure and strips args", () => {
  // Prepare records the file as unreadable, so applyCursorMcpBridge retries it
  // with a fallback read. If that read also fails with a non-ENOENT error
  // (EACCES here), it should warn and return stripClaudeMcpConfigArgs (no
  // write, graceful degradation).
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });

  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-fallback-read-fail-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  mkdirSync(mcpDir, { recursive: true });
  const mcpPath = path.join(mcpDir, "mcp.json");

  // Create an unreadable file, so prepare records backup.kind === "unreadable"
  writeFileSyncTest(mcpPath, JSON.stringify({ original: true }));
  chmodSync(mcpPath, 0o000);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    prepareBridge(bridge, workspaceDir);
    // The fallback read will fail with EACCES, triggering the warning path
    const result = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    // Should strip the Claude flags and NOT add --approve-mcps (no successful write)
    assert.deepEqual(result, ["-p", "--force"]);

    // Should have warned about the fallback read failure
    assert.ok(
      warnings.length > 0,
      "should emit a warning when fallback read fails",
    );
    assert.ok(
      warnings.some((w) => w.includes("failed to read") && w.includes(mcpPath)),
      "warning should mention the fallback read failure for the mcp.json path",
    );
  } finally {
    chmodSync(mcpPath, 0o644); // cleanup
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("cleanup respects wrote flag: does not touch the file when apply never attempted a write", async () => {
  // The backup tracking includes a wrote flag that tracks whether
  // applyCursorMcpBridge attempted to write the file. Cleanup should
  // only restore/delete if wrote === true. If wrote === false, it means
  // apply never ran or bundle MCP was not injected (this plugin wrote nothing),
  // so cleanup should leave the file as-is and just delete the backup entry.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-wrote-flag-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  mkdirSync(mcpDir, { recursive: true });
  const mcpPath = path.join(mcpDir, "mcp.json");

  // Pre-existing mcp.json
  const originalContent = JSON.stringify({ original: true });
  writeFileSyncTest(mcpPath, originalContent);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    // Prepare captures the original mcp.json
    const prep = prepareBridge(bridge, workspaceDir);

    // Delete the mcp.json file and then make the .cursor directory read-only
    // This forces apply to try creating a new file, which will fail
    rmSync(mcpPath);
    chmodSync(mcpDir, 0o500);

    // Apply will fail to write mcp.json (mkdir will fail or writeFileSync will fail)
    const result = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    // Should strip flags (graceful degradation on write failure)
    assert.deepEqual(result, ["-p", "--force"]);

    // Should have warned about write failure
    assert.ok(
      warnings.some((w) => w.includes("failed to write")),
      "should warn when write fails",
    );

    // Restore writeability so we can restore the original file for cleanup
    chmodSync(mcpDir, 0o755);
    writeFileSyncTest(mcpPath, originalContent);

    // Cleanup should not restore the file (write was never attempted), just delete the entry
    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();

    // File should still contain the original content (unchanged - not deleted or restored)
    const afterCleanup = readFileSyncTest(mcpPath, "utf-8");
    assert.deepEqual(
      JSON.parse(afterCleanup),
      JSON.parse(originalContent),
      "cleanup should not have deleted file when apply failed to write",
    );
  } finally {
    chmodSync(mcpDir, 0o755); // cleanup
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("write failure still sets wrote=true beforehand, so cleanup restores the backup", async () => {
  // When writeFileSync fails (e.g., ENOSPC), we should have already set
  // wrote=true (before the write attempt), so cleanup still restores the
  // original backup. This prevents partial write failures from leaving
  // truncated files with wrote=false.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-wrote-before-fix-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  mkdirSync(mcpDir, { recursive: true });
  const mcpPath = path.join(mcpDir, "mcp.json");

  // Pre-existing mcp.json
  const originalContent = JSON.stringify({ original: true });
  writeFileSyncTest(mcpPath, originalContent);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    // Prepare captures the original state
    const prep = prepareBridge(bridge, workspaceDir);

    // Delete the file and make the directory read-only to force write failure
    rmSync(mcpPath);
    chmodSync(mcpDir, 0o500);

    // Apply will fail to write, but wrote=true is already set before the write
    const result = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    // Apply stripped flags and warned
    assert.deepEqual(result, ["-p", "--force"]);
    assert.ok(
      warnings.some((w) => w.includes("failed to write")),
      "should warn on write failure",
    );

    // Restore writeability
    chmodSync(mcpDir, 0o755);

    // Cleanup should restore the original file because wrote=true was set
    // even though the write actually failed
    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();

    const restored = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      restored,
      JSON.parse(originalContent),
      "cleanup should restore original content even when write failed (wrote was set before attempt)",
    );
  } finally {
    chmodSync(mcpDir, 0o755); // cleanup
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("unreadable backup upgraded on fallback read success allows cleanup to restore", async () => {
  // When prepareCursorCliExecution detects an unreadable file, backup.kind
  // is set to "unreadable". Later, if applyCursorMcpBridge's fallback read
  // succeeds (file became readable), we upgrade backup to "content" so cleanup
  // can restore the original file instead of leaving the bridged config.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-unreadable-upgrade-fix-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  mkdirSync(mcpDir, { recursive: true });
  const mcpPath = path.join(mcpDir, "mcp.json");

  // Create a file with original content, then make it unreadable
  const originalContent = JSON.stringify({ original: true });
  writeFileSyncTest(mcpPath, originalContent);
  chmodSync(mcpPath, 0o000);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    // Prepare detects the file as unreadable (EACCES)
    const prep = prepareBridge(bridge, workspaceDir);

    // Prepare warned about unreadable file
    assert.ok(
      warnings.some((w) => w.includes("failed to read") && w.includes(mcpPath)),
      "prepare should warn when file is unreadable",
    );
    warnings.length = 0; // clear for next phase

    // Now make the file readable so apply can do the fallback read
    chmodSync(mcpPath, 0o644);

    // Apply will attempt fallback read, which succeeds
    // After successful read, backup should be upgraded to "content"
    const result = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    // Apply should succeed this time (fallback read worked)
    assert.deepEqual(result, ["-p", "--force", "--approve-mcps"]);

    // Verify the merged config was written
    const afterApply = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.ok(
      afterApply.mcpServers.openclaw,
      "openclaw server should be in the merged config",
    );

    // Cleanup should restore the original file content because the backup
    // was upgraded to "content" type during apply's fallback read
    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();

    // Verify the file was restored to original content
    const restored = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      restored,
      JSON.parse(originalContent),
      "cleanup should have restored original content (backup was upgraded to content on fallback read success)",
    );
  } finally {
    chmodSync(mcpPath, 0o644); // cleanup
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("regression: unreadable → apply fallback gets ENOENT → cleanup deletes file", async () => {
  // When prepareCursorCliExecution detects an unreadable file (kind="unreadable"),
  // and later applyCursorMcpBridge's fallback read gets ENOENT (file was deleted),
  // we upgrade backup to "absent" so cleanup will delete the bridged mcp.json.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-unreadable-enoent-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  mkdirSync(mcpDir, { recursive: true });
  const mcpPath = path.join(mcpDir, "mcp.json");

  // Create a file, then make it unreadable
  writeFileSyncTest(mcpPath, JSON.stringify({ original: true }));
  chmodSync(mcpPath, 0o000);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    // Prepare detects the file as unreadable
    const prep = prepareBridge(bridge, workspaceDir);

    // Make file readable, then delete it (simulating file getting removed before apply)
    chmodSync(mcpPath, 0o644);
    rmSync(mcpPath);

    // Apply will attempt fallback read, which gets ENOENT
    // Backup should be upgraded to "absent"
    const result = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    // Apply should succeed (ENOENT is handled gracefully)
    assert.deepEqual(result, ["-p", "--force", "--approve-mcps"]);

    // Verify the bridged config was written (file created anew)
    const afterApply = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.ok(
      afterApply.mcpServers.openclaw,
      "openclaw server should be present",
    );

    // Cleanup should delete the file because backup was upgraded to "absent"
    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();

    // File should be deleted
    assert.equal(
      !existsSync(mcpPath),
      true,
      "cleanup should have deleted the file (backup upgraded to absent on ENOENT)",
    );
  } finally {
    if (existsSync(mcpPath)) {
      chmodSync(mcpPath, 0o644);
    }
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("external file created between prepare and apply is restored by cleanup (backup promotion)", async () => {
  // Regression: when prepare finds no file (backup=absent), but an external
  // process creates the file before apply, the fallback read succeeds. If backup
  // is promoted to content, cleanup will restore the external file instead of
  // deleting it. This test verifies that the external content is preserved.
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-external-file-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    // Prepare finds no file (backup = absent)
    const prep = prepareBridge(bridge, workspaceDir);

    // External process creates the file with custom content BEFORE apply
    mkdirSync(mcpDir, { recursive: true });
    const externalContent = {
      mcpServers: { externalServer: { url: "http://localhost:5000/mcp" } },
    };
    writeFileSyncTest(mcpPath, JSON.stringify(externalContent));

    // Apply: fallback read should succeed and preserve external content
    const result = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    // Apply should strip flags and add --approve-mcps (write succeeded)
    assert.deepEqual(result, ["-p", "--force", "--approve-mcps"]);

    // File should have both external and generated servers
    const afterApply = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.ok(
      afterApply.mcpServers.externalServer,
      "external server from pre-existing file should be preserved",
    );
    assert.equal(
      afterApply.mcpServers.externalServer.url,
      "http://localhost:5000/mcp",
    );
    assert.ok(
      afterApply.mcpServers.openclaw,
      "generated openclaw server should be present",
    );

    // Cleanup should restore the file to its external state (not delete it)
    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();

    const restored = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      restored,
      externalContent,
      "cleanup should restore external file content (not delete)",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("repeated apply in same run promotes absent backup on first call, cleanup restores", async () => {
  // When apply is called twice in the same run with absent backup:
  // - first apply: fallback reads external content, backup promoted to content (wrote=false)
  // - second apply: fallback reads again, backup already promoted so no change
  // - cleanup: restores external content (backup.kind === content)
  // The backup is promoted on first apply (before wrote=true), so external
  // content is restored rather than deleted.
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-repeated-apply-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    // Prepare: file doesn't exist (backup = absent)
    const prep = prepareBridge(bridge, workspaceDir);

    // External file created
    mkdirSync(mcpDir, { recursive: true });
    writeFileSyncTest(
      mcpPath,
      JSON.stringify({
        mcpServers: { external: { url: "http://localhost:5000/mcp" } },
      }),
    );

    // First apply: merges generated with external content
    bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    const afterFirstApply = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.ok(
      afterFirstApply.mcpServers.external,
      "after first apply: external server preserved",
    );
    assert.ok(
      afterFirstApply.mcpServers.openclaw,
      "after first apply: openclaw server added",
    );

    // Second apply: called again with same absent backup
    // Should NOT promote backup even if fallback read succeeds
    bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    const afterSecondApply = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.ok(
      afterSecondApply.mcpServers.openclaw,
      "after second apply: openclaw server present",
    );

    // Cleanup: backup was promoted to content (on first apply, before wrote=true),
    // so file should be restored to its external state
    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();

    const restored = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      restored,
      {
        mcpServers: { external: { url: "http://localhost:5000/mcp" } },
      },
      "cleanup should restore external content (backup was promoted)",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("absent backup with a prior write does not merge the bridge's own output back in", async () => {
  // With backup.kind === "absent" and wrote === true, whatever sits at
  // .cursor/mcp.json is this bridge's own output from an earlier apply in the
  // same run. Re-reading it would carry that run's generated servers — including
  // entries the new config no longer has — into the merged file.
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-absent-wrote-"),
  );
  const mcpPath = path.join(workspaceDir, ".cursor", "mcp.json");

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const firstGenPath = path.join(genDir, "first.json");
  const secondGenPath = path.join(genDir, "second.json");
  writeFileSyncTest(
    firstGenPath,
    JSON.stringify({
      mcpServers: {
        openclaw: { url: "http://127.0.0.1:1111/mcp" },
        stale: { url: "http://127.0.0.1:2222/mcp" },
      },
    }),
  );
  writeFileSyncTest(
    secondGenPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:3333/mcp" } },
    }),
  );

  try {
    // Prepare while the file is absent, so backup.kind === "absent".
    const prep = prepareBridge(bridge, workspaceDir);

    bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", firstGenPath, "--force"],
      workspaceDir,
    );
    const afterFirst = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      Object.keys(afterFirst.mcpServers).sort(),
      ["openclaw", "stale"],
      "first apply writes the first generated config",
    );

    // Second apply in the same run, with a generated config that dropped "stale".
    bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", secondGenPath, "--force"],
      workspaceDir,
    );
    const afterSecond = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      afterSecond.mcpServers,
      { openclaw: { url: "http://127.0.0.1:3333/mcp" } },
      "second apply must not resurrect the first apply's own servers",
    );

    // Backup is still "absent", so cleanup removes the file entirely.
    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();
    assert.equal(
      existsSync(mcpPath),
      false,
      "cleanup deletes the bridged file when the backup was absent",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

for (const [label, original] of [
  ["truncated JSON", '{ "mcpServers": { "external": '],
  [
    "JSONC comments",
    '{\n  // internal tools\n  "mcpServers": { "external": { "url": "http://localhost:5000/mcp" } }\n}',
  ],
  ["not an object", '["not", "an", "object"]'],
  ["mcpServers is not an object", '{ "mcpServers": ["nope"] }'],
] as const) {
  test(`existing mcp.json the bridge can't parse (${label}) is left untouched`, async () => {
    const warnings: string[] = [];
    const bridge = createCursorMcpBridge({
      warn: (msg: string) => warnings.push(msg),
    });
    const workspaceDir = mkdtempSync(
      path.join(os.tmpdir(), "cursor-cli-unparseable-"),
    );
    const mcpDir = path.join(workspaceDir, ".cursor");
    const mcpPath = path.join(mcpDir, "mcp.json");
    mkdirSync(mcpDir, { recursive: true });
    writeFileSyncTest(mcpPath, original);

    const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
    const genPath = path.join(genDir, "mcp.json");
    writeFileSyncTest(
      genPath,
      JSON.stringify({
        mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
      }),
    );

    try {
      const prep = prepareBridge(bridge, workspaceDir);

      const args = bridge.applyCursorMcpBridge(
        ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
        workspaceDir,
      );

      // Rewriting would drop content the bridge failed to understand, and the
      // raw backup is only restored if cleanup runs. Skip the bridge instead.
      assert.deepEqual(
        args,
        ["-p", "--force"],
        "unsupported flags are stripped and --approve-mcps is not added",
      );
      assert.equal(
        readFileSyncTest(mcpPath, "utf-8"),
        original,
        "the file is never written",
      );
      assert.ok(
        // Naming the workspace file, not the generated one: the two messages
        // give different advice, so mixing them up must fail here.
        warnings.some((msg) => msg.includes(mcpPath)),
        `expected a warning naming ${mcpPath}, got ${JSON.stringify(warnings)}`,
      );

      assert.ok(prep.cleanup, "prep should have cleanup");
      await prep.cleanup();
      assert.equal(
        readFileSyncTest(mcpPath, "utf-8"),
        original,
        "cleanup leaves the untouched file alone",
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(genDir, { recursive: true, force: true });
    }
  });
}

test("keys the bridge does not own survive the rewrite and the restore", async () => {
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-toplevel-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");
  const original = JSON.stringify(
    {
      $schema: "https://example.test/mcp.schema.json",
      version: 2,
      mcpServers: { external: { url: "http://localhost:5000/mcp" } },
    },
    null,
    2,
  );
  mkdirSync(mcpDir, { recursive: true });
  writeFileSyncTest(mcpPath, original);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    const prep = prepareBridge(bridge, workspaceDir);
    bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    const written = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.equal(
      written.$schema,
      "https://example.test/mcp.schema.json",
      "$schema survives the bridged write",
    );
    assert.equal(written.version, 2, "unknown top-level keys survive");
    assert.deepEqual(Object.keys(written.mcpServers).sort(), [
      "external",
      "openclaw",
    ]);

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();
    assert.equal(
      readFileSyncTest(mcpPath, "utf-8"),
      original,
      "cleanup restores the original bytes",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("unparseable generated mcp-config skips the bridge without touching the workspace", () => {
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-bad-generated-"),
  );
  const mcpPath = path.join(workspaceDir, ".cursor", "mcp.json");

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(genPath, "{ this is not json");

  try {
    prepareBridge(bridge, workspaceDir);
    const args = bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );
    assert.deepEqual(args, ["-p", "--force"]);
    assert.equal(existsSync(mcpPath), false, "no file is created");
    assert.ok(
      warnings.some((msg) => msg.includes(genPath)),
      `expected a warning naming the generated config, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("restore failure during cleanup warns instead of throwing", async () => {
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-restore-fail-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");
  mkdirSync(mcpDir, { recursive: true });
  writeFileSyncTest(
    mcpPath,
    JSON.stringify({
      mcpServers: { external: { url: "http://localhost:5000/mcp" } },
    }),
  );

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    const prep = prepareBridge(bridge, workspaceDir);
    bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    // Make the restore write fail: swap the file for a directory (EISDIR).
    rmSync(mcpPath, { force: true });
    mkdirSync(mcpPath, { recursive: true });

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();

    assert.ok(
      warnings.some((msg) => msg.includes("failed to restore")),
      `expected a restore warning, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("unparseable file appearing between prepare and apply is left untouched", async () => {
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-late-unparseable-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    // Prepare sees no file at all, so the backup is "absent".
    const prep = prepareBridge(bridge, workspaceDir);

    // Something else writes a file the bridge can't parse before apply runs.
    const external = '{\n  // added by hand\n  "mcpServers": {}\n}';
    mkdirSync(mcpDir, { recursive: true });
    writeFileSyncTest(mcpPath, external);

    const args = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    assert.deepEqual(args, ["-p", "--force"], "the bridge is skipped");
    assert.equal(
      readFileSyncTest(mcpPath, "utf-8"),
      external,
      "the file that appeared is not overwritten",
    );
    assert.ok(
      warnings.some((msg) => msg.includes("mcpServers")),
      `expected an unparseable warning, got ${JSON.stringify(warnings)}`,
    );

    // The backup is still "absent" but nothing was written, so cleanup must
    // not delete the file someone else put there.
    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();
    assert.equal(
      readFileSyncTest(mcpPath, "utf-8"),
      external,
      "cleanup leaves the file alone because the bridge never wrote",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("a config with no mcpServers key keeps its other keys and gains the bridge entry", async () => {
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-no-servers-key-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");
  const original = JSON.stringify(
    { $schema: "https://example.test/mcp.schema.json" },
    null,
    2,
  );
  mkdirSync(mcpDir, { recursive: true });
  writeFileSyncTest(mcpPath, original);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    const prep = prepareBridge(bridge, workspaceDir);
    const args = bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );
    assert.ok(
      args.includes("--approve-mcps"),
      "a missing mcpServers key is a valid config, not an unparseable one",
    );

    const written = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.equal(written.$schema, "https://example.test/mcp.schema.json");
    assert.deepEqual(written.mcpServers, {
      openclaw: { url: "http://127.0.0.1:1234/mcp" },
    });

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();
    assert.equal(readFileSyncTest(mcpPath, "utf-8"), original);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("top-level keys survive when the config is picked up by the fallback read", async () => {
  // Backup is "absent", so existing content comes from applyCursorMcpBridge's
  // own read rather than from the prepare-time snapshot. That is a separate
  // path to the document, and it must preserve unowned keys too.
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-fallback-doc-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    // Prepare sees nothing; the file appears afterwards.
    const prep = prepareBridge(bridge, workspaceDir);
    const external = JSON.stringify(
      {
        $schema: "https://example.test/mcp.schema.json",
        mcpServers: { external: { url: "http://localhost:5000/mcp" } },
      },
      null,
      2,
    );
    mkdirSync(mcpDir, { recursive: true });
    writeFileSyncTest(mcpPath, external);

    bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    const written = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.equal(
      written.$schema,
      "https://example.test/mcp.schema.json",
      "$schema read through the fallback path survives",
    );
    assert.deepEqual(Object.keys(written.mcpServers).sort(), [
      "external",
      "openclaw",
    ]);

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();
    assert.equal(
      readFileSyncTest(mcpPath, "utf-8"),
      external,
      "cleanup restores the promoted backup verbatim",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("declining after a successful write keeps --approve-mcps so the run can't hang", async () => {
  // The bridged server is on disk from the first apply. Dropping
  // --approve-mcps on a later decline would leave cursor-agent waiting on an
  // interactive approval prompt, which is the headless hang the flag prevents.
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-decline-after-write-"),
  );
  const mcpPath = path.join(workspaceDir, ".cursor", "mcp.json");

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const goodGen = path.join(genDir, "good.json");
  const brokenGen = path.join(genDir, "broken.json");
  writeFileSyncTest(
    goodGen,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );
  writeFileSyncTest(brokenGen, "{ broken");

  try {
    const prep = prepareBridge(bridge, workspaceDir);

    const first = bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", goodGen],
      workspaceDir,
    );
    assert.deepEqual(first, ["-p", "--approve-mcps"]);
    assert.ok(existsSync(mcpPath), "the first apply wrote the bridged config");

    const second = bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", brokenGen],
      workspaceDir,
    );
    assert.deepEqual(
      second,
      ["-p", "--approve-mcps"],
      "the server is still on disk, so it must stay approved",
    );

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();
    assert.equal(existsSync(mcpPath), false, "cleanup still removes the file");
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("declining after a failed write does not add --approve-mcps", () => {
  // `wrote` is set before the write so cleanup can restore on partial failure,
  // but nothing reached disk, so there is no server to approve.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-decline-after-fail-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  mkdirSync(mcpDir, { recursive: true });

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const goodGen = path.join(genDir, "good.json");
  const brokenGen = path.join(genDir, "broken.json");
  writeFileSyncTest(
    goodGen,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );
  writeFileSyncTest(brokenGen, "{ broken");

  try {
    prepareBridge(bridge, workspaceDir);
    chmodSync(mcpDir, 0o500);

    const first = bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", goodGen],
      workspaceDir,
    );
    assert.deepEqual(first, ["-p"], "the write failed, so no approval flag");

    const second = bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", brokenGen],
      workspaceDir,
    );
    assert.deepEqual(second, ["-p"], "still nothing on disk to approve");
  } finally {
    chmodSync(mcpDir, 0o700);
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

// Configs that carry no server data the bridge could lose. Declining over
// these would disable cursor-mcp's whole reason for existing to protect
// nothing, so they must be treated as an empty config and still bridge.
for (const [label, original, expectedKept] of [
  ["an empty file", "", []],
  ["a whitespace-only file", "\n  \n", []],
  ["mcpServers: null", JSON.stringify({ mcpServers: null }), []],
  [
    "a BOM before valid JSON",
    `\uFEFF${JSON.stringify({ mcpServers: { mine: { url: "http://localhost:7000/mcp" } } })}`,
    ["mine"],
  ],
] as const) {
  test(`${label} still bridges, and cleanup restores it byte-for-byte`, async () => {
    const bridge = createCursorMcpBridge();
    const workspaceDir = mkdtempSync(
      path.join(os.tmpdir(), "cursor-cli-benign-"),
    );
    const mcpDir = path.join(workspaceDir, ".cursor");
    const mcpPath = path.join(mcpDir, "mcp.json");
    mkdirSync(mcpDir, { recursive: true });
    writeFileSyncTest(mcpPath, original);

    const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
    const genPath = path.join(genDir, "mcp.json");
    writeFileSyncTest(
      genPath,
      JSON.stringify({
        mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
      }),
    );

    try {
      const prep = prepareBridge(bridge, workspaceDir);
      const args = bridge.applyCursorMcpBridge(
        ["-p", "--mcp-config", genPath, "--force"],
        workspaceDir,
      );
      assert.ok(
        args.includes("--approve-mcps"),
        "there is nothing to protect here, so the bridge must engage",
      );

      const written = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
      assert.deepEqual(
        Object.keys(written.mcpServers).sort(),
        [...expectedKept, "openclaw"].sort(),
        "the user's own servers, if any, survive alongside the bridge entry",
      );

      assert.ok(prep.cleanup, "prep should have cleanup");
      await prep.cleanup();
      assert.equal(
        readFileSyncTest(mcpPath, "utf-8"),
        original,
        "cleanup puts the original bytes back, BOM and all",
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(genDir, { recursive: true, force: true });
    }
  });
}

test("an mcpServers that is a non-null non-object is still treated as unparseable", () => {
  // Unlike null, an array or string there is data the bridge cannot interpret,
  // so rewriting would discard something the user meant.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-servers-array-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");
  mkdirSync(mcpDir, { recursive: true });
  const original = JSON.stringify({ mcpServers: ["nope"] });
  writeFileSyncTest(mcpPath, original);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    prepareBridge(bridge, workspaceDir);
    const args = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );
    assert.deepEqual(args, ["-p", "--force"]);
    assert.equal(readFileSyncTest(mcpPath, "utf-8"), original);
    assert.ok(warnings.some((msg) => msg.includes(mcpPath)));
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("bundle MCP flags with no usable path are stripped, not passed to cursor-agent", () => {
  // cursor-agent rejects --strict-mcp-config/--mcp-config outright, so leaving
  // them on the argv turns a missing path into a failed run.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-pathless-flags-"),
  );

  try {
    prepareBridge(bridge, workspaceDir);

    for (const args of [
      ["-p", "--strict-mcp-config", "--mcp-config"],
      ["-p", "--strict-mcp-config", "--mcp-config="],
      ["-p", "--strict-mcp-config"],
    ]) {
      assert.deepEqual(
        bridge.applyCursorMcpBridge(args, workspaceDir),
        ["-p"],
        `expected the flags to be stripped from ${JSON.stringify(args)}`,
      );
    }
    assert.equal(warnings.length, 3, "each malformed call warns once");

    // No bundle MCP at all is a different case: leave the argv alone.
    assert.deepEqual(
      bridge.applyCursorMcpBridge(["-p", "--force"], workspaceDir),
      ["-p", "--force"],
    );
    assert.equal(warnings.length, 3, "an ordinary turn does not warn");
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
test("a leftover openclaw entry is not restored, so the next run cleans up after a crashed one", async () => {
  // A previous run wrote the bridged config and never cleaned up. Its entry is
  // still in the file, pointing at a dead loopback server with a dead token.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-orphan-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");
  mkdirSync(mcpDir, { recursive: true });
  writeFileSyncTest(
    mcpPath,
    JSON.stringify({
      $schema: "https://example.test/mcp.schema.json",
      mcpServers: {
        myServer: { url: "http://localhost:9000/mcp" },
        openclaw: {
          url: "http://127.0.0.1:1111/mcp",
          headers: { Authorization: "Bearer STALE" },
        },
      },
    }),
  );

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: {
        openclaw: {
          url: "http://127.0.0.1:2222/mcp",
          headers: { Authorization: "Bearer FRESH" },
        },
      },
    }),
  );

  try {
    const prep = prepareBridge(bridge, workspaceDir);
    bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    const during = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.equal(
      during.mcpServers.openclaw.headers.Authorization,
      "Bearer FRESH",
      "the run uses its own entry, not the leftover",
    );

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();

    const restored = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      Object.keys(restored.mcpServers),
      ["myServer"],
      "the leftover entry is gone, not restored alongside the user's server",
    );
    assert.equal(
      restored.$schema,
      "https://example.test/mcp.schema.json",
      "unowned top-level keys still survive",
    );
    assert.ok(
      warnings.some(
        (msg) => msg.includes("already present") && msg.includes(mcpPath),
      ),
      `expected a warning naming the dropped entry and ${mcpPath}, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("a file containing only a leftover openclaw entry is removed by cleanup", async () => {
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-orphan-only-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");
  mkdirSync(mcpDir, { recursive: true });
  writeFileSyncTest(
    mcpPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1111/mcp" } },
    }),
  );

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:2222/mcp" } },
    }),
  );

  try {
    const prep = prepareBridge(bridge, workspaceDir);
    bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();

    // Nothing of the user's was in the file, so restoring an empty shell would
    // be worse than removing what the crashed run created.
    assert.equal(existsSync(mcpPath), false);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("a config created during the turn is preserved, not mistaken for the bridge's own output", async () => {
  // The absent-backup path used to assume anything on disk after its own write
  // was its own output. A file someone else creates mid-turn is not, and it
  // must survive both the merge and cleanup.
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-user-file-midturn-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    // Prepare sees no file at all.
    const prep = prepareBridge(bridge, workspaceDir);
    bridge.applyCursorMcpBridge(["-p", "--mcp-config", genPath], workspaceDir);

    // Someone replaces the file with their own config mid-turn.
    const userConfig = `${JSON.stringify(
      { mcpServers: { mine: { url: "http://localhost:9000/mcp" } } },
      null,
      2,
    )}\n`;
    writeFileSyncTest(mcpPath, userConfig);

    bridge.applyCursorMcpBridge(["-p", "--mcp-config", genPath], workspaceDir);
    const merged = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.deepEqual(
      Object.keys(merged.mcpServers).sort(),
      ["mine", "openclaw"],
      "the config that appeared mid-turn is merged into, not discarded",
    );

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();
    assert.equal(
      readFileSyncTest(mcpPath, "utf-8"),
      userConfig,
      "cleanup restores what the user put there, rather than deleting it",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("a dangling symlink at .cursor/mcp.json is refused rather than written through", async () => {
  // writeFileSync would create the link's target, but cleanup's unlink removes
  // the link — leaving the bearer token behind under a name never tracked.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-dangling-link-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");
  mkdirSync(mcpDir, { recursive: true });
  const linkTarget = path.join(workspaceDir, "nowhere.json");
  symlinkSync(linkTarget, mcpPath);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: {
        openclaw: {
          url: "http://127.0.0.1:1234/mcp",
          headers: { Authorization: "Bearer SECRET" },
        },
      },
    }),
  );

  try {
    const prep = prepareBridge(bridge, workspaceDir);
    const args = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath],
      workspaceDir,
    );

    assert.deepEqual(args, ["-p"], "the bridge is skipped");
    assert.equal(
      existsSync(linkTarget),
      false,
      "the link target is never created, so no token is written",
    );
    assert.ok(
      warnings.some((msg) => msg.includes("symlink")),
      `expected a symlink warning, got ${JSON.stringify(warnings)}`,
    );

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();
    assert.equal(existsSync(linkTarget), false);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("a symlinked mcp.json holding only a leftover entry is declined, not silently unlinked", async () => {
  // The backup resolves to "absent" (the leftover is all there was), so cleanup
  // would `unlink` the path — removing the link and leaving the token in the
  // file it pointed at. Declining is sticky here: this workspace stays
  // un-bridged until the symlink is replaced.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-link-leftover-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  mkdirSync(mcpDir, { recursive: true });
  const linkPath = path.join(mcpDir, "mcp.json");
  const realPath = path.join(workspaceDir, "shared-mcp.json");
  const leftover = `${JSON.stringify(
    { mcpServers: { openclaw: { url: "http://stale/mcp" } } },
    null,
    2,
  )}\n`;
  writeFileSyncTest(realPath, leftover);
  symlinkSync(realPath, linkPath);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    const prep = prepareBridge(bridge, workspaceDir);
    const args = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath],
      workspaceDir,
    );

    assert.deepEqual(args, ["-p"], "the bridge is skipped");
    assert.ok(
      warnings.some((msg) => msg.includes("symlink")),
      `expected a symlink warning, got ${JSON.stringify(warnings)}`,
    );
    assert.ok(
      // The target exists here, so the warning must explain the real reason —
      // that cleanup would delete the link rather than the file it wrote.
      warnings.some((msg) => msg.includes("deletes the link instead")),
      `the warning must give the real reason, got ${JSON.stringify(warnings)}`,
    );

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();
    assert.equal(existsSync(linkPath), true, "the link is left in place");
    assert.equal(
      readFileSyncTest(realPath, "utf-8"),
      leftover,
      "and so is the file it points at",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("dropping an existing openclaw entry is announced, once, when prepare read the file", async () => {
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-leftover-once-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");
  mkdirSync(mcpDir, { recursive: true });
  writeFileSyncTest(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        mine: { url: "http://localhost:9000/mcp" },
        openclaw: { url: "http://stale/mcp" },
      },
    }),
  );

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    const prep = prepareBridge(bridge, workspaceDir);
    bridge.applyCursorMcpBridge(["-p", "--mcp-config", genPath], workspaceDir);
    bridge.applyCursorMcpBridge(["-p", "--mcp-config", genPath], workspaceDir);
    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();

    assert.equal(
      warnings.filter((msg) => msg.includes("already present")).length,
      1,
      `expected exactly one drop warning, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("dropping an existing openclaw entry is announced on the fallback path too", async () => {
  // Prepare found no file, so it never saw the entry. If apply's own read is
  // the first to see it, apply has to be the one that says so — otherwise the
  // entry disappears from the user's config with nothing in the log.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-fallback-drop-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  const mcpPath = path.join(mcpDir, "mcp.json");
  mkdirSync(mcpDir, { recursive: true });

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    const prep = prepareBridge(bridge, workspaceDir);
    // The file appears only after prepare, carrying an entry of its own.
    writeFileSyncTest(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          mine: { url: "http://localhost:9000/mcp" },
          openclaw: { url: "http://stale/mcp" },
        },
      }),
    );

    bridge.applyCursorMcpBridge(["-p", "--mcp-config", genPath], workspaceDir);
    assert.ok(
      warnings.some(
        (msg) => msg.includes("already present") && msg.includes(mcpPath),
      ),
      `the drop must be announced, got ${JSON.stringify(warnings)}`,
    );

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();
    assert.deepEqual(
      Object.keys(JSON.parse(readFileSyncTest(mcpPath, "utf-8")).mcpServers),
      ["mine"],
      "and the user's own server survives",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("a symlink pointing at a real config still bridges and is restored", async () => {
  // Only an `absent` backup makes cleanup unlink, so this shape is safe: the
  // restore writes the original bytes back through the link.
  const bridge = createCursorMcpBridge();
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-link-real-"),
  );
  const mcpDir = path.join(workspaceDir, ".cursor");
  mkdirSync(mcpDir, { recursive: true });
  const linkPath = path.join(mcpDir, "mcp.json");
  const realPath = path.join(workspaceDir, "shared-mcp.json");
  const original = `${JSON.stringify(
    { mcpServers: { mine: { url: "http://localhost:9000/mcp" } } },
    null,
    2,
  )}\n`;
  writeFileSyncTest(realPath, original);
  symlinkSync(realPath, linkPath);

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    const prep = prepareBridge(bridge, workspaceDir);
    const args = bridge.applyCursorMcpBridge(
      ["-p", "--mcp-config", genPath],
      workspaceDir,
    );
    assert.ok(args.includes("--approve-mcps"), "this shape is bridged");
    assert.deepEqual(
      Object.keys(
        JSON.parse(readFileSyncTest(realPath, "utf-8")).mcpServers,
      ).sort(),
      ["mine", "openclaw"],
      "the write goes through the link into the real file",
    );

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();
    assert.equal(
      readFileSyncTest(realPath, "utf-8"),
      original,
      "and the restore puts the original bytes back through it",
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});

test("cleanup leaves a file that changed since the bridge wrote it", async () => {
  // The backup says "absent", so cleanup would normally unlink. But the bytes
  // on disk are no longer the bridge's own, and deleting content it never read
  // is exactly what it must not do.
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-foreign-file-"),
  );
  const mcpPath = path.join(workspaceDir, ".cursor", "mcp.json");

  const genDir = mkdtempSync(path.join(os.tmpdir(), "cursor-cli-mcp-gen-"));
  const genPath = path.join(genDir, "mcp.json");
  writeFileSyncTest(
    genPath,
    JSON.stringify({
      mcpServers: { openclaw: { url: "http://127.0.0.1:1234/mcp" } },
    }),
  );

  try {
    const prep = prepareBridge(bridge, workspaceDir);
    bridge.applyCursorMcpBridge(["-p", "--mcp-config", genPath], workspaceDir);

    // Something the bridge cannot even parse replaces the file mid-turn.
    const foreign = "{\n  // hand-written\n}\n";
    writeFileSyncTest(mcpPath, foreign);

    assert.ok(prep.cleanup, "prep should have cleanup");
    await prep.cleanup();

    assert.equal(existsSync(mcpPath), true, "the file is not deleted");
    assert.equal(readFileSyncTest(mcpPath, "utf-8"), foreign, "nor rewritten");
    assert.ok(
      warnings.some((msg) => msg.includes("leaving")),
      `expected a warning that it was left alone, got ${JSON.stringify(warnings)}`,
    );
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
  }
});
