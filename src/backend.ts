import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";

export const CURSOR_CLI_BACKEND_ID = "cursor-cli";
export const CURSOR_CLI_DEFAULT_MODEL_REF = "cursor-cli/grok-4.5-fast-xhigh";

const CURSOR_CLI_BASE_ARGS = ["-p", "--output-format", "stream-json", "--trust"] as const;

function stripResumeArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--resume" || arg === "--continue") {
      const next = args[i + 1];
      // Only consume the following token as --resume's value if it doesn't look like a flag,
      // so a missing/omitted session id doesn't cause the next flag to be swallowed.
      if (arg === "--resume" && typeof next === "string" && !next.startsWith("-")) i += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

export function resolveCursorCliExecutionArgs(context: {
  executionMode?: string;
  baseArgs: readonly string[];
}): string[] {
  if (context.executionMode === "side-question") {
    return [...stripResumeArgs(context.baseArgs), "--mode", "ask"];
  }
  return [...context.baseArgs];
}

export function buildCursorCliBackend(): CliBackendPlugin {
  return {
    id: CURSOR_CLI_BACKEND_ID,
    liveTest: {
      defaultModelRef: CURSOR_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: false,
      defaultMcpProbe: false,
    },
    nativeToolMode: "always-on",
    sideQuestionToolMode: "disabled",
    config: {
      command: "cursor-agent",
      args: [...CURSOR_CLI_BASE_ARGS],
      resumeArgs: [...CURSOR_CLI_BASE_ARGS, "--resume", "{sessionId}"],
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      input: "stdin",
      modelArg: "--model",
      sessionMode: "existing",
      sessionIdFields: ["session_id"],
      systemPromptWhen: "never",
      serialize: true,
    },
    resolveExecutionArgs: resolveCursorCliExecutionArgs,
  };
}
