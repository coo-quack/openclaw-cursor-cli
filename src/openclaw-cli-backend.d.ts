/**
 * Type declarations for openclaw/plugin-sdk/cli-backend.
 *
 * The types are excluded from the openclaw package in 2026.9.x,
 * so we provide minimal declarations here based on actual usage.
 */

declare module "openclaw/plugin-sdk/cli-backend" {
  /** Configuration for a CLI backend. */
  export type CliBackendConfig = {
    command: string;
    args?: string[];
    resumeArgs?: string[];
    output?: "json" | "jsonl" | "text";
    jsonlDialect?: "claude-stream-json" | "gemini-stream-json";
    input?: "arg" | "stdin";
    modelArg?: string | undefined;
    modelAliases?: Record<string, string>;
    env?: Record<string, string>;
    sessionMode?: "always" | "existing" | "none";
    sessionIdFields?: string[];
    systemPromptWhen?: "always" | "first" | "never";
    serialize?: boolean;
    [key: string]: unknown;
  };

  /** Context passed to prepare execution hook. */
  export type CliBackendPrepareExecutionContext = {
    workspaceDir: string;
    modelId?: string;
    provider?: string;
    [key: string]: unknown;
  };

  /** Return type of the prepare execution hook. */
  export type CliBackendPreparedExecution = {
    cleanup: () => Promise<void>;
  };

  /** Resolved execution context. */
  export type CliBackendExecutionContext = {
    executionMode?: "agent" | "side-question" | "turn";
    baseArgs: readonly string[];
    workspaceDir?: string;
    modelId: string;
    provider?: string;
    useResume?: boolean;
    [key: string]: unknown;
  };

  /** The plugin interface for CLI backends. */
  export type CliBackendPlugin = {
    id: string;
    modelProvider?: string;
    config: CliBackendConfig;
    subscriptionAuthDispatch?: boolean;
    liveTest?: {
      defaultModelRef?: string;
      defaultImageProbe?: boolean;
      defaultMcpProbe?: boolean;
    };
    nativeToolMode?: "none" | "always-on" | "selectable";
    sideQuestionToolMode?: "disabled";
    normalizeConfig?: (config: CliBackendConfig) => CliBackendConfig;
    resolveExecutionArgs?: (context: CliBackendExecutionContext) => string[];
    prepareExecution?: (
      context: CliBackendPrepareExecutionContext,
    ) =>
      | CliBackendPreparedExecution
      | Promise<CliBackendPreparedExecution | null | undefined>
      | null
      | undefined;
    bundleMcp?: boolean;
    bundleMcpMode?:
      | "claude-config-file"
      | "codex-config-overrides"
      | "gemini-system-settings";
    [key: string]: unknown;
  };
}
