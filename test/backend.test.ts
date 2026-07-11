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
