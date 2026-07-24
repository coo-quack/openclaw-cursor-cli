import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
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

    const mcpBridge = createCursorMcpBridge();
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

    const mcpBridge = createCursorMcpBridge();
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
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const prep1 = bridge.prepareCursorCliExecution({ workspaceDir } as any);

    // Simulate a write (what would happen between prepare and cleanup)
    writeFileSyncTest(mcpPath, JSON.stringify({ modified: true }));

    // Second concurrent prepare should NOT overwrite the backup with the
    // modified content; it should reuse the first backup (original: true)
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const prep2 = bridge.prepareCursorCliExecution({ workspaceDir } as any);

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

test("applyCursorMcpBridge warns when mcp-config file cannot be read", () => {
  const warnings: string[] = [];
  const bridge = createCursorMcpBridge({
    warn: (msg: string) => warnings.push(msg),
  });

  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-mcp-read-fail-"),
  );
  try {
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

test("prepareCursorCliExecution detects unreadable backup and cleanup does not touch file", async () => {
  // Fix 1 & 2: when a file exists but is unreadable (e.g., EACCES),
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
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const prep = bridge.prepareCursorCliExecution({ workspaceDir } as any);

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
  // Fix 3: when prepareCursorCliExecution was not called (info === undefined),
  // applyCursorMcpBridge attempts a fallback read of the current mcp.json.
  // If the read fails with a non-ENOENT error (e.g., EACCES), it should warn
  // and return stripClaudeMcpConfigArgs (no write, graceful degradation).
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

  // Create an unreadable file (no prepare was called, so info === undefined)
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
    // Apply without prepare: info === undefined, so fallback read is attempted
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

test("cleanup respects wrote flag: does not restore when apply did not write", async () => {
  // Fix 4: the backup tracking should include a wrote flag that tracks
  // whether applyCursorMcpBridge successfully wrote the file. Cleanup should
  // only restore/delete if wrote === true. If wrote === false, it means
  // apply failed to write (e.g., permission denied on .cursor dir), so cleanup
  // should leave the file as-is and just delete the backup entry.
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
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const prep = bridge.prepareCursorCliExecution({ workspaceDir } as any);

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

    // Cleanup should not restore the file (wrote === false), just delete the entry
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

test("Fix A: write failure with backup set wrote=true before write, so cleanup restores", async () => {
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
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const prep = bridge.prepareCursorCliExecution({ workspaceDir } as any);

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

test("Fix B: unreadable backup upgrade on fallback read success allows cleanup to restore", async () => {
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
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const prep = bridge.prepareCursorCliExecution({ workspaceDir } as any);

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
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    const prep = bridge.prepareCursorCliExecution({ workspaceDir } as any);

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
