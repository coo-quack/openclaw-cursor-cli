import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync as readFileSyncTest,
  rmSync,
  writeFileSync as writeFileSyncTest,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CliBackendConfig } from "openclaw/plugin-sdk/cli-backend";
import {
  buildCursorCliBackend,
  CURSOR_CLI_BACKEND_ID,
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
    "cursor-cli/cursor-grok-4.5-high-fast",
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
    "cursor-mcp/cursor-grok-4.5-high-fast",
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

    const mcpFactory = createCursorMcpBridge();
    const mcp = buildCursorCliBackend({
      id: CURSOR_MCP_BACKEND_ID,
      bundleMcp: true,
      mcpBridgeFactory: mcpFactory,
    });
    const mcpArgs = mcp.resolveExecutionArgs?.({
      workspaceDir,
      provider: CURSOR_MCP_BACKEND_ID,
      modelId: "cursor-grok-4.5-high-fast",
      useResume: false,
      baseArgs: injectedArgs,
    });
    assert.deepEqual(mcpArgs, [...BASE, "--approve-mcps"]);
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
    // cursor-cli's config never asks OpenClaw's runner to inject them).
    assert.deepEqual(cliArgs, injectedArgs);
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
    assert.deepEqual(sideQuestionArgs, [...BASE, "--mode", "ask"]);

    // Normal agent mode: baseArgs unchanged
    const agentArgs = backend.resolveExecutionArgs?.({
      executionMode: "agent",
      baseArgs: BASE,
      workspaceDir,
      provider: CURSOR_CLI_BACKEND_ID,
      modelId: "cursor-grok-4.5-high-fast",
      useResume: false,
    });
    assert.deepEqual(agentArgs, BASE);
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

    const mcpFactory = createCursorMcpBridge();
    const mcp = buildCursorCliBackend({
      id: CURSOR_MCP_BACKEND_ID,
      bundleMcp: true,
      mcpBridgeFactory: mcpFactory,
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
    assert.deepEqual(mcpArgs, [...BASE, "--mode", "ask", "--approve-mcps"]);
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
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const prep = bridge.prepareCursorCliExecution({ workspaceDir } as any);

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

  try {
    // Simulate original mcp.json in the workspace
    mkdirSync(mcpDir, { recursive: true });
    writeFileSyncTest(mcpPath, JSON.stringify({ original: true }));

    // First prepare backs up the original state
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const prep1 = bridge.prepareCursorCliExecution({ workspaceDir } as any);

    // Simulate a write (what would happen between prepare and cleanup)
    writeFileSyncTest(mcpPath, JSON.stringify({ modified: true }));

    // Second concurrent prepare should NOT overwrite the backup with the
    // modified content; it should reuse the first backup (original: true)
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const prep2 = bridge.prepareCursorCliExecution({ workspaceDir } as any);

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
  }
});

test("applyCursorMcpBridge preserves existing servers when called without prepareCursorCliExecution (fallback read)", () => {
  const bridge = createCursorMcpBridge();
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
    // Call applyCursorMcpBridge directly without prepareCursorCliExecution
    const result = bridge.applyCursorMcpBridge(
      ["-p", "--strict-mcp-config", "--mcp-config", genPath, "--force"],
      workspaceDir,
    );
    assert.deepEqual(result, ["-p", "--force", "--approve-mcps"]);

    const written = JSON.parse(readFileSyncTest(mcpPath, "utf-8"));
    assert.ok(
      written.mcpServers.myServer,
      "pre-existing server should be preserved via fallback read",
    );
    assert.equal(written.mcpServers.myServer.url, "http://localhost:9000/mcp");
    assert.ok(
      written.mcpServers.openclaw,
      "generated openclaw server should be present",
    );
    assert.equal(written.mcpServers.openclaw.url, "http://127.0.0.1:1234/mcp");
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(genDir, { recursive: true, force: true });
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
      [...BASE, "--approve-mcps"],
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
