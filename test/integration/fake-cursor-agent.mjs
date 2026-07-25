#!/usr/bin/env node
// Stands in for the real cursor-agent so the MCP bridge can be inspected while
// a turn is still live.
//
// The real binary would need credentials and would spend the user's Cursor
// quota, and it exits too fast to catch the bridged `.cursor/mcp.json` in
// place. This one records what the bridge handed it, then blocks until the
// test releases it — which is what keeps the loopback MCP server reachable
// long enough to connect to.
// 1. records argv and cwd
// 2. snapshots the workspace .cursor/mcp.json to a durable dir, or notes where
//    it looked when there was nothing there
// 3. blocks (holding the turn open) until a RELEASE sentinel appears or the deadline passes
// 4. emits claude-stream-json so the OpenClaw turn finishes cleanly
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = process.env.FAKE_OUT_DIR;
if (!OUT) {
  process.stderr.write("fake-cursor-agent: FAKE_OUT_DIR is required\n");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
writeFileSync(
  path.join(OUT, "argv.json"),
  `${JSON.stringify(argv, null, 2)}\n`,
);
writeFileSync(path.join(OUT, "cwd.txt"), `${process.cwd()}\n`);

const mcpPath = path.join(process.cwd(), ".cursor", "mcp.json");
if (existsSync(mcpPath)) {
  copyFileSync(mcpPath, path.join(OUT, "cursor-mcp.json"));
} else {
  writeFileSync(path.join(OUT, "cursor-mcp.MISSING"), `${mcpPath}\n`);
}

writeFileSync(path.join(OUT, "READY"), `${new Date().toISOString()}\n`);

// Drain stdin (the plugin wrapper writes a runtime banner + the prompt).
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.resume();

const sentinel = path.join(OUT, "RELEASE");
const deadline = Date.now() + Number(process.env.FAKE_HOLD_MS || 120000);

function finish() {
  try {
    writeFileSync(path.join(OUT, "stdin.txt"), Buffer.concat(chunks));
  } catch {}
  const sid = "fake-session-0001";
  const lines = [
    { type: "system", subtype: "init", session_id: sid },
    {
      type: "assistant",
      session_id: sid,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fake ok" }],
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "fake ok",
      session_id: sid,
    },
  ];
  process.stdout.write(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  setTimeout(() => process.exit(0), 150);
}

const timer = setInterval(() => {
  if (existsSync(sentinel) || Date.now() > deadline) {
    clearInterval(timer);
    finish();
  }
}, 250);
