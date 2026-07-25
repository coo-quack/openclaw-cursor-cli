export type RuntimeBannerMeta = {
  sessionKey: string;
  agentId: string;
  messageChannel: string;
};

function readMeta(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

export function resolveRuntimeBannerMeta(
  env: NodeJS.ProcessEnv,
): RuntimeBannerMeta {
  return {
    sessionKey: readMeta(env, "OPENCLAW_MCP_SESSION_KEY"),
    agentId: readMeta(env, "OPENCLAW_MCP_AGENT_ID"),
    messageChannel: readMeta(env, "OPENCLAW_MCP_MESSAGE_CHANNEL"),
  };
}

export function buildRuntimeBanner(meta: RuntimeBannerMeta): string {
  return [
    "[OpenClaw runtime]",
    "この会話は OpenClaw（gateway / TUI・iMessage 等）経由で cursor-agent に渡されている。",
    "",
    `session: ${meta.sessionKey}`,
    `agent: ${meta.agentId}`,
    `channel: ${meta.messageChannel}`,
    "",
    "方針:",
    "- OpenClaw の行動規範に従う（AGENTS.md、SOUL.md、USER.md、必要なら CRON-RULES.md / TOOLS.md）",
    "- OpenClaw MCP ツール（mcp_openclaw_*）を優先して使う",
    "- 外部送信（iMessage、投稿、メール等）は明示許可があるときだけ",
    "- 破壊的操作の前に確認する",
    "",
  ].join("\n");
}

function hasArg(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function modeIsAsk(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode" && argv[i + 1] === "ask") return true;
    if (arg === "--mode=ask") return true;
  }
  return false;
}

/** True only for fresh headless agent turns that should receive the banner. */
export function shouldInjectRuntimeBanner(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  if (!argv.includes("-p")) return false;
  if (hasArg(argv, "--resume") || hasArg(argv, "--continue")) return false;
  if (modeIsAsk(argv)) return false;
  return true;
}
