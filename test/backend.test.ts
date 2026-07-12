import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCursorCliBackend,
  resolveCursorCliExecutionArgs,
} from "../src/backend.ts";

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

// --- MCP bridge (applyCursorMcpBridge / extract / strip helpers) ---

import {
  mkdtempSync,
  readFileSync as readFileSyncTest,
  rmSync,
  writeFileSync as writeFileSyncTest,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyCursorMcpBridge,
  extractClaudeMcpConfigPath,
  stripClaudeMcpConfigArgs,
} from "../src/backend.ts";

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
