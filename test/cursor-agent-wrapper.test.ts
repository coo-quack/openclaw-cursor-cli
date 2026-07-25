import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
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

test("wrapper reports synchronous stdin write throws to stderr", async () => {
  const out = collectStream();
  const err = collectStream();
  const fakeChild = {
    stdin: {
      write() {
        throw new Error("stdin write failed");
      },
      destroy() {},
      on() {
        return this;
      },
    },
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    once(event: string, listener: (...args: unknown[]) => void) {
      if (event === "close") {
        queueMicrotask(() => listener(1, null));
      }
      return this;
    },
    kill() {},
  };
  const code = await runCursorAgentWrapper({
    argv: ["-p"],
    env: {
      ...process.env,
      [OPENCLAW_CURSOR_AGENT_BIN_ENV]: "/tmp/cursor-agent",
    },
    stdin: Readable.from(["user says hi"]),
    stdout: out.stream,
    stderr: err.stream,
    spawnImpl: (() =>
      fakeChild) as unknown as typeof import("node:child_process").spawn,
  });
  out.stream.end();
  err.stream.end();
  assert.equal(code, 1);
  assert.match(await err.promise, /stdin write failed/);
});

test("wrapper reports child killed by signal to stderr with exit code 1", async () => {
  const out = collectStream();
  const err = collectStream();
  const fakeChild = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    once(event: string, listener: (...args: unknown[]) => void) {
      if (event === "close") {
        // Simulate child killed by SIGTERM (code null, signal "SIGTERM")
        queueMicrotask(() => listener(null, "SIGTERM"));
      }
      return this;
    },
    kill() {},
  };
  const code = await runCursorAgentWrapper({
    argv: ["-p"],
    env: {
      ...process.env,
      [OPENCLAW_CURSOR_AGENT_BIN_ENV]: "/tmp/cursor-agent",
    },
    stdin: Readable.from(["ignored"]),
    stdout: out.stream,
    stderr: err.stream,
    spawnImpl: (() =>
      fakeChild) as unknown as typeof import("node:child_process").spawn,
  });
  out.stream.end();
  err.stream.end();
  assert.equal(code, 1);
  assert.match(await err.promise, /killed by SIGTERM/);
});

test("wrapper reports child error event to stderr with exit code 1", async () => {
  const out = collectStream();
  const err = collectStream();
  const fakeChild = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    once(event: string, listener: (...args: unknown[]) => void) {
      if (event === "error") {
        // Simulate a child error (e.g., bad file descriptor)
        queueMicrotask(() => listener(new Error("bad file descriptor")));
      }
      if (event === "close") {
        // Prevent hanging; close is not reached
      }
      return this;
    },
    kill() {},
  };
  const code = await runCursorAgentWrapper({
    argv: ["-p"],
    env: {
      ...process.env,
      [OPENCLAW_CURSOR_AGENT_BIN_ENV]: "/tmp/cursor-agent",
    },
    stdin: Readable.from(["ignored"]),
    stdout: out.stream,
    stderr: err.stream,
    spawnImpl: (() =>
      fakeChild) as unknown as typeof import("node:child_process").spawn,
  });
  out.stream.end();
  err.stream.end();
  assert.equal(code, 1);
  assert.match(await err.promise, /bad file descriptor/);
});

test("wrapper fails when the child exposes no stdio pipes", async () => {
  const out = collectStream();
  const err = collectStream();
  const fakeChild = {
    stdin: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    once() {
      return this;
    },
    kill() {},
  };
  const code = await runCursorAgentWrapper({
    argv: ["-p"],
    env: {
      ...process.env,
      [OPENCLAW_CURSOR_AGENT_BIN_ENV]: "/tmp/cursor-agent",
    },
    stdin: Readable.from(["ignored"]),
    stdout: out.stream,
    stderr: err.stream,
    spawnImpl: (() =>
      fakeChild) as unknown as typeof import("node:child_process").spawn,
  });
  out.stream.end();
  err.stream.end();
  assert.equal(code, 1);
  assert.match(await err.promise, /failed to create child stdio pipes/);
});

test("wrapper reports a stdin error and tears down the child's stdin", async () => {
  const out = collectStream();
  const err = collectStream();
  const closeListeners: Array<(...args: unknown[]) => void> = [];
  const childStdin = new PassThrough();
  const fakeChild = {
    stdin: childStdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    once(event: string, listener: (...args: unknown[]) => void) {
      if (event === "close") closeListeners.push(listener);
      return this;
    },
    kill() {},
  };
  const stdin = new PassThrough();
  const running = runCursorAgentWrapper({
    argv: ["-p"],
    env: {
      ...process.env,
      [OPENCLAW_CURSOR_AGENT_BIN_ENV]: "/tmp/cursor-agent",
    },
    stdin,
    stdout: out.stream,
    stderr: err.stream,
    spawnImpl: (() =>
      fakeChild) as unknown as typeof import("node:child_process").spawn,
  });

  // Let the wrapper wire up its stdin handlers before failing the stream.
  await new Promise((resolve) => setImmediate(resolve));
  stdin.emit("error", new Error("stdin exploded"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(childStdin.destroyed, true, "child stdin should be destroyed");
  for (const listener of closeListeners) listener(0, null);

  const code = await running;
  out.stream.end();
  err.stream.end();
  assert.equal(code, 0);
  assert.match(await err.promise, /stdin exploded/);
});
