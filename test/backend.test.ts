import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCursorCliBackend,
  resolveCursorCliExecutionArgs,
} from "../src/backend.ts";

const BASE = ["-p", "--output-format", "stream-json", "--trust"];

test("agent mode keeps base args unchanged", () => {
  const args = resolveCursorCliExecutionArgs({ executionMode: "agent", baseArgs: BASE });
  assert.deepEqual(args, BASE);
});

test("side-question mode appends ask mode and strips resume", () => {
  const args = resolveCursorCliExecutionArgs({
    executionMode: "side-question",
    baseArgs: [...BASE, "--resume", "abc-123"],
  });
  assert.deepEqual(args, [...BASE, "--mode", "ask"]);
});

test("backend defaults match the verified phase-1 contract", () => {
  const backend = buildCursorCliBackend();
  assert.equal(backend.id, "cursor-cli");
  assert.equal(backend.nativeToolMode, "always-on");
  assert.equal(backend.sideQuestionToolMode, "disabled");
  assert.equal(backend.config.command, "cursor-agent");
  assert.deepEqual(backend.config.args, BASE);
  assert.deepEqual(backend.config.resumeArgs, [...BASE, "--resume", "{sessionId}"]);
  assert.equal(backend.config.output, "jsonl");
  assert.equal(backend.config.input, "stdin");
  assert.equal(backend.config.modelArg, "--model");
  assert.equal(backend.config.sessionMode, "existing");
  assert.deepEqual(backend.config.sessionIdFields, ["session_id"]);
  assert.equal(backend.config.serialize, true);
  assert.equal(backend.config.jsonlDialect, "claude-stream-json");
  assert.equal(backend.config.systemPromptWhen, "never");
});
