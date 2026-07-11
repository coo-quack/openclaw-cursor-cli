import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRuntimeBanner,
  resolveRuntimeBannerMeta,
  shouldInjectRuntimeBanner,
} from "../src/runtime-banner.ts";

test("resolveRuntimeBannerMeta reads OpenClaw MCP env vars", () => {
  const meta = resolveRuntimeBannerMeta({
    OPENCLAW_MCP_SESSION_KEY: "agent:main:tui-abc",
    OPENCLAW_MCP_AGENT_ID: "main",
    OPENCLAW_MCP_MESSAGE_CHANNEL: "webchat",
  });
  assert.deepEqual(meta, {
    sessionKey: "agent:main:tui-abc",
    agentId: "main",
    messageChannel: "webchat",
  });
});

test("resolveRuntimeBannerMeta falls back to unknown", () => {
  assert.deepEqual(resolveRuntimeBannerMeta({}), {
    sessionKey: "unknown",
    agentId: "unknown",
    messageChannel: "unknown",
  });
});

test("resolveRuntimeBannerMeta treats blank strings as unknown", () => {
  assert.deepEqual(
    resolveRuntimeBannerMeta({
      OPENCLAW_MCP_SESSION_KEY: "  ",
      OPENCLAW_MCP_AGENT_ID: "",
      OPENCLAW_MCP_MESSAGE_CHANNEL: "imessage",
    }),
    {
      sessionKey: "unknown",
      agentId: "unknown",
      messageChannel: "imessage",
    },
  );
});

test("buildRuntimeBanner matches the agreed template", () => {
  const text = buildRuntimeBanner({
    sessionKey: "agent:main:tui-abc",
    agentId: "main",
    messageChannel: "webchat",
  });
  assert.equal(
    text,
    [
      "[OpenClaw runtime]",
      "この会話は OpenClaw（gateway / TUI・iMessage 等）経由で cursor-agent に渡されている。",
      "",
      "session: agent:main:tui-abc",
      "agent: main",
      "channel: webchat",
      "",
      "方針:",
      "- OpenClaw の行動規範に従う（AGENTS.md、SOUL.md、USER.md、必要なら CRON-RULES.md / TOOLS.md）",
      "- OpenClaw MCP ツール（mcp_openclaw_*）を優先して使う",
      "- 外部送信（iMessage、投稿、メール等）は明示許可があるときだけ",
      "- 破壊的操作の前に確認する",
      "",
    ].join("\n"),
  );
});

test("shouldInjectRuntimeBanner is false when --resume is present", () => {
  assert.equal(shouldInjectRuntimeBanner(["-p", "--resume", "abc"]), false);
  assert.equal(shouldInjectRuntimeBanner(["-p", "--force"]), true);
});

test("shouldInjectRuntimeBanner is false for side-question ask mode", () => {
  assert.equal(shouldInjectRuntimeBanner(["-p", "--mode", "ask"]), false);
  assert.equal(shouldInjectRuntimeBanner(["-p", "--mode=ask"]), false);
});

test("shouldInjectRuntimeBanner is false for catalog / non-agent argv", () => {
  assert.equal(shouldInjectRuntimeBanner(["models"]), false);
  assert.equal(shouldInjectRuntimeBanner(["mcp", "list"]), false);
});
