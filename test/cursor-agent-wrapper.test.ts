import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  isExecutedAsMain,
  OPENCLAW_CURSOR_AGENT_BIN_ENV,
  resolveCursorAgentBin,
  runCursorAgentWrapper,
} from "../src/cursor-agent-wrapper.ts";

function makeFakeBin(dir: string): string {
  const bin = path.join(dir, "fake-cursor-agent");
  writeFileSync(
    bin,
    `#!/bin/bash
printf 'ARGV:%s\\n' "$*"
cat
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function collectStream(): { stream: Writable; promise: Promise<string> } {
  const chunks: Buffer[] = [];
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
    final(cb) {
      resolve(Buffer.concat(chunks).toString("utf8"));
      cb();
    },
  });
  return { stream, promise };
}

test("resolveCursorAgentBin requires OPENCLAW_CURSOR_AGENT_BIN", () => {
  assert.throws(() => resolveCursorAgentBin({}), /OPENCLAW_CURSOR_AGENT_BIN/);
  assert.equal(
    resolveCursorAgentBin({
      [OPENCLAW_CURSOR_AGENT_BIN_ENV]: "/tmp/cursor-agent",
    }),
    "/tmp/cursor-agent",
  );
});

test("isExecutedAsMain accepts relative argv paths", () => {
  const abs = path.resolve("src/cursor-agent-wrapper.ts");
  const metaUrl = pathToFileURL(abs).href;
  assert.equal(isExecutedAsMain(abs, metaUrl), true);
  assert.equal(
    isExecutedAsMain(path.relative(process.cwd(), abs) || ".", metaUrl),
    true,
  );
  assert.equal(isExecutedAsMain(undefined, metaUrl), false);
  assert.equal(isExecutedAsMain("/tmp/other.ts", metaUrl), false);
});

test("wrapper prepends banner on fresh -p turn", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-wrapper-"));
  try {
    const bin = makeFakeBin(dir);
    const out = collectStream();
    const err = collectStream();
    const code = await runCursorAgentWrapper({
      argv: ["-p", "--output-format", "stream-json", "--trust", "--force"],
      env: { ...process.env, [OPENCLAW_CURSOR_AGENT_BIN_ENV]: bin },
      stdin: Readable.from(["user says hi"]),
      stdout: out.stream,
      stderr: err.stream,
    });
    out.stream.end();
    err.stream.end();
    assert.equal(code, 0);
    const printed = await out.promise;
    assert.match(
      printed,
      /^ARGV:-p --output-format stream-json --trust --force\n/,
    );
    assert.match(printed, /\[OpenClaw runtime\]/);
    assert.match(printed, /user says hi/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapper does not prepend on --resume", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-wrapper-"));
  try {
    const bin = makeFakeBin(dir);
    const out = collectStream();
    const err = collectStream();
    const code = await runCursorAgentWrapper({
      argv: ["-p", "--resume", "sess-1", "--force"],
      env: { ...process.env, [OPENCLAW_CURSOR_AGENT_BIN_ENV]: bin },
      stdin: Readable.from(["follow up"]),
      stdout: out.stream,
      stderr: err.stream,
    });
    out.stream.end();
    err.stream.end();
    assert.equal(code, 0);
    const printed = await out.promise;
    assert.equal(printed.includes("[OpenClaw runtime]"), false);
    assert.match(printed, /follow up/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapper passes models argv through without reading banner path", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-wrapper-"));
  try {
    const bin = makeFakeBin(dir);
    const out = collectStream();
    const err = collectStream();
    const code = await runCursorAgentWrapper({
      argv: ["models"],
      env: { ...process.env, [OPENCLAW_CURSOR_AGENT_BIN_ENV]: bin },
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: err.stream,
    });
    out.stream.end();
    err.stream.end();
    assert.equal(code, 0);
    const printed = await out.promise;
    assert.match(printed, /^ARGV:models\n/);
    assert.equal(printed.includes("[OpenClaw runtime]"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapper reports missing cursor-agent bin to stderr", async () => {
  const out = collectStream();
  const err = collectStream();
  const code = await runCursorAgentWrapper({
    argv: ["-p"],
    env: {},
    stdin: Readable.from(["ignored"]),
    stdout: out.stream,
    stderr: err.stream,
  });
  out.stream.end();
  err.stream.end();
  assert.equal(code, 1);
  assert.match(await err.promise, /missing OPENCLAW_CURSOR_AGENT_BIN/);
});

test("wrapper reports spawn failures to stderr", async () => {
  const out = collectStream();
  const err = collectStream();
  const code = await runCursorAgentWrapper({
    argv: ["-p"],
    env: {
      ...process.env,
      [OPENCLAW_CURSOR_AGENT_BIN_ENV]: "/definitely/not/cursor-agent",
    },
    stdin: Readable.from(["ignored"]),
    stdout: out.stream,
    stderr: err.stream,
  });
  out.stream.end();
  err.stream.end();
  assert.equal(code, 1);
  assert.match(await err.promise, /spawn .*cursor-agent/);
});

test("wrapper reports synchronous spawn throws to stderr", async () => {
  const out = collectStream();
  const err = collectStream();
  const code = await runCursorAgentWrapper({
    argv: ["-p"],
    env: {
      ...process.env,
      [OPENCLAW_CURSOR_AGENT_BIN_ENV]: "/tmp/cursor-agent",
    },
    stdin: Readable.from(["ignored"]),
    stdout: out.stream,
    stderr: err.stream,
    spawnImpl: (() => {
      throw new Error("invalid spawn options");
    }) as typeof import("node:child_process").spawn,
  });
  out.stream.end();
  err.stream.end();
  assert.equal(code, 1);
  assert.match(await err.promise, /invalid spawn options/);
});
