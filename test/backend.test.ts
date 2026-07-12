import assert from "node:assert/strict";
import {
  chmodSync,
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
  applyCursorMcpBridge,
  buildCursorCliBackend,
  CURSOR_CLI_BACKEND_ID,
  CURSOR_MCP_BACKEND_ID,
  extractClaudeMcpConfigPath,
  isThisPackageCursorAgentWrapper,
  normalizeCursorCliConfig,
  pathsEqual,
  resetLegacyMcpBridgeEnvWarningForTest,
  resolveCursorAgentWrapperPath,
  resolveCursorCliExecutionArgs,
  stripClaudeMcpConfigArgs,
  warnIfLegacyMcpBridgeEnvSet,
} from "../src/backend.ts";
import { OPENCLAW_CURSOR_AGENT_BIN_ENV } from "../src/cursor-agent-wrapper.ts";
import { resolveCursorCommand } from "../src/entry-helpers.ts";

const BASE = ["-p", "--output-format", "stream-json", "--trust", "--force"];

test("agent mode keeps base args unchanged", () => {
  const args = resolveCursorCliExecutionArgs({
    executionMode: "agent",
    baseArgs: BASE,
  });
  assert.deepEqual(args, BASE);
});

test("side-question mode appends ask mode and strips resume", () => {
  const args = resolveCursorCliExecutionArgs({
    executionMode: "side-question",
    baseArgs: [...BASE, "--resume", "abc-123"],
  });
  assert.deepEqual(args, [...BASE, "--mode", "ask"]);
});

test("side-question mode strips --continue without consuming the following token", () => {
  const noExtra = resolveCursorCliExecutionArgs({
    executionMode: "side-question",
    baseArgs: [...BASE, "--continue"],
  });
  assert.deepEqual(noExtra, [...BASE, "--mode", "ask"]);

  const withExtra = resolveCursorCliExecutionArgs({
    executionMode: "side-question",
    baseArgs: [...BASE, "--continue", "extra-token"],
  });
  assert.deepEqual(withExtra, [...BASE, "extra-token", "--mode", "ask"]);
});

test("side-question mode strips a trailing --resume with no value", () => {
  const args = resolveCursorCliExecutionArgs({
    executionMode: "side-question",
    baseArgs: [...BASE, "--resume"],
  });
  assert.deepEqual(args, [...BASE, "--mode", "ask"]);
});

test("side-question mode strips --resume followed by a flag-like token without consuming it", () => {
  const args = resolveCursorCliExecutionArgs({
    executionMode: "side-question",
    baseArgs: [...BASE, "--resume", "--force"],
  });
  assert.deepEqual(args, [...BASE, "--force", "--mode", "ask"]);
});

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
    "cursor-cli/grok-4.5-fast-xhigh",
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
    "cursor-mcp/grok-4.5-fast-xhigh",
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

    const mcp = buildCursorCliBackend({
      id: CURSOR_MCP_BACKEND_ID,
      bundleMcp: true,
    });
    const mcpArgs = mcp.resolveExecutionArgs?.({
      workspaceDir,
      provider: CURSOR_MCP_BACKEND_ID,
      modelId: "grok-4.5-fast-xhigh",
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
      modelId: "grok-4.5-fast-xhigh",
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
  const workspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "cursor-cli-mcp-test-"),
  );
  try {
    assert.deepEqual(applyCursorMcpBridge(["-p", "--force"], workspaceDir), [
      "-p",
      "--force",
    ]);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("applyCursorMcpBridge writes .cursor/mcp.json, strips claude flags, and adds --approve-mcps", () => {
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
    const result = applyCursorMcpBridge(
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

test("applyCursorMcpBridge does not add a duplicate --approve-mcps", () => {
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
    const result = applyCursorMcpBridge(
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
    const result = applyCursorMcpBridge(
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
