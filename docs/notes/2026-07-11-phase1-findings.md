# Phase-1 findings: cursor-cli via `agents.defaults.cliBackends` (2026-07-11)

Live smoke test of `cursor-agent` wired through OpenClaw's generic CLI-backend
config (no plugin code), run against the production gateway on
Chataclaws-Mac-mini. Config edits, restarts, and test calls are logged below;
findings answer the four open questions from the task-1 brief.

## Config used

```json
{
  "agents": {
    "defaults": {
      "cliBackends": {
        "cursor-cli": {
          "command": "/Users/ai/.local/bin/cursor-agent",
          "args": ["-p", "--output-format", "stream-json", "--trust"],
          "resumeArgs": ["-p", "--output-format", "stream-json", "--trust", "--resume", "{sessionId}"],
          "output": "jsonl",
          "input": "stdin",
          "modelArg": "--model",
          "sessionMode": "existing",
          "sessionIdFields": ["session_id"],
          "serialize": true
        }
      },
      "models": {
        "cursor-cli/grok-4.5-fast-xhigh": {}
      }
    }
  }
}
```

The model ref had to be added to `agents.defaults.models` before use — it was
rejected with `Model override "cursor-cli/grok-4.5-fast-xhigh" is not allowed
for agent "main"` until allowlisted, exactly per the brief's documented
fallback.

## 1. Does OpenClaw's JSONL parser read cursor-agent events correctly?

**No.** With plain `output: "jsonl"` and no `jsonlDialect`, OpenClaw did not
extract the final assistant message. Both turns returned the entire raw
multi-line JSONL stream (`system/init`, `user`, `thinking.delta` x N,
`thinking.completed`, `assistant`, `result`) concatenated as the reply
text — this showed up both in `result.payloads[0].text` and in
`finalAssistantVisibleText`/`finalAssistantRawText` in the `openclaw agent
--json` output. Example (turn 1, full text returned instead of just `backend
ok`):

```
{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/Users/ai/.openclaw/workspace","session_id":"707e7112-...","model":"Cursor Grok 4.5 High Fast","permissionMode":"default"}
{"type":"user","message":{...}}
{"type":"thinking","subtype":"delta","text":"Replying exactly with","session_id":"707e7112-...","timestamp_ms":1783767843260}
{"type":"thinking","subtype":"delta","text":" \"backend ok\".","session_id":"707e7112-...","timestamp_ms":1783767843261}
{"type":"thinking","subtype":"completed","session_id":"707e7112-...","timestamp_ms":1783767843261}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"backend ok"}]},"session_id":"707e7112-..."}
{"type":"result","subtype":"success","duration_ms":7767,...,"result":"backend ok","session_id":"707e7112-...",...}
```

The `docs/gateway/cli-backends.md` page documents `jsonlDialect:
"claude-stream-json"` and `"gemini-stream-json"` as the two supported
dialects; there is no `cursor-stream-json` dialect. cursor-agent's event
shapes (`system/init`, `assistant.message.content[].text`,
`thinking.delta`/`thinking.completed`, `result.result`) are close to Claude's
shape but distinct enough (notably the `thinking` delta/completed pair and
`timestamp_ms` per-event field, which Claude's dialect apparently
disambiguates differently or ignores) that the generic parser fell back to
raw passthrough rather than raising an error. **This confirms Task 4 needs a
plugin-registered `jsonlDialect` (or a bespoke parser) to extract
`assistant.message.content[].text` / `result.result` and to treat
`thinking.delta`/`thinking.completed` as non-final internal events** — the
generic backend does not know how to do this out of the box.

No hard parse *errors* were observed (no exceptions, no malformed-JSON
warnings in `/tmp/openclaw/openclaw-2026-07-11.log`) — the failure mode is
silent under-extraction, not a crash.

## 2. Does resume work through OpenClaw session state?

**No, not with this config.** Both turns against the same
`--session-key agent:main:cursor-cli-smoke-test` produced entirely different
`session_id`s from cursor-agent (`707e7112-...` on turn 1, `7d053ba3-...` on
turn 2), and the gateway logs show why:

```
cli exec: provider=cursor-cli model=grok-4.5-fast-xhigh promptChars=54  trigger=user useResume=false session=none resumeSession=none reuse=none                     historyPrompt=none
cli exec: provider=cursor-cli model=grok-4.5-fast-xhigh promptChars=114 trigger=user useResume=false session=none resumeSession=none reuse=invalidated:system-prompt historyPrompt=none
```

`useResume=false` on both calls — `resumeArgs` (`--resume {sessionId}`) was
never invoked. Turn 2 explicitly shows `reuse=invalidated:system-prompt`:
OpenClaw detected the rebuilt system prompt differed from what it had
associated with the stored cursor-agent session and discarded the stored
session id rather than resuming, so cursor-agent started cold both times.
The model's own turn-2 thinking trace confirms this from the other side:
`"No prior message exists in this conversation... This may be a meta-test."`

Turn 2 still produced a plausible-looking answer
(`前のメッセージの内容を確認します。backend ok` — "Let me check the content
of the previous message... backend ok") but at a cost that gives away how it
got there: `outputTokens: 1305` (vs. 98 on turn 1) and
`cacheReadTokens: 249344` against `inputTokens: 16171`. That is consistent
with cursor-agent, running agentically inside `/Users/ai/.openclaw/workspace`
(its `cwd` per the `system/init` event), searching its own tool-accessible
context/logs for a "backend ok" string rather than genuinely recalling turn 1
via conversational memory. **This is not evidence of working resume** — it is
evidence of an agentic CLI improvising when handed a fresh, contextless
prompt. Real resume needs the `reuse=invalidated:system-prompt` cause fixed
(most likely by not regenerating/varying the system prompt hash between
serialized turns of the same session, or by explicitly excluding
system-prompt drift from invalidation for this backend) before `useResume`
will ever flip to `true` and exercise `resumeArgs`.

## 3. Observable impact of the dropped/rebuilt system prompt

OpenClaw *did* build and send a full OpenClaw-style system prompt to
cursor-agent on both turns (`systemPromptReport.systemPrompt.chars: 35104`,
including injected `AGENTS.md`/`SOUL.md`/`TOOLS.md`/`IDENTITY.md`/`USER.md`/
`HEARTBEAT.md` workspace files and the skills catalog) — it was not silently
dropped in this config. The problem is instability, not absence: the prompt
apparently varies enough turn-to-turn (e.g. the `[Sat 2026-07-11 20:0x GMT+9]`
timestamp prefix baked into the user message, and/or the rebuilt skills/
workspace content) that OpenClaw's system-prompt hash changed between turn 1
and turn 2, which is exactly what triggered `invalidated:system-prompt` and
killed resume (see finding 2). This is the concrete, observable harm of an
unstable system prompt with this backend shape: it does not corrupt a single
reply, but it silently prevents session continuity on every turn.

Because the raw JSONL passthrough bug (finding 1) means the "final reply" is
currently the whole event stream rather than clean text, we could not fully
evaluate formatting impact for a real channel (e.g. iMessage) in isolation
from that bug — but the raw JSONL dump itself is obviously malformed for any
chat channel (multi-KB of escaped JSON instead of "backend ok"). This
compounds with the missing session continuity: each turn, cursor-agent gets
a full 35K-char system prompt *and* a cold session, so both problems must be
fixed together for the plugin to be viable.

## 4. Watchdog timeouts

None observed. Turn 1 took ~13.2s (`cli turn: ... durationMs=13236`), turn 2
took ~36.5s (`durationMs=36536`, `outBytes=97431` — the large output was the
model's own agentic exploration inside its workspace, per finding 2). Both
are well under the default 600s agent timeout; no watchdog/timeout errors
appeared in `/tmp/openclaw/openclaw-2026-07-11.log` for either run.

## Test session / isolation

Both turns used `openclaw agent --session-key agent:main:cursor-cli-smoke-test
--model cursor-cli/grok-4.5-fast-xhigh`, a dedicated key that does not
collide with the live `agent:main:main` iMessage session. `openclaw agent
--help` exposes `--session-key`/`--session-id` for exactly this purpose; no
concerns about isolation.

## Config state left on the gateway

The `cliBackends.cursor-cli` block and the `cursor-cli/grok-4.5-fast-xhigh`
model allowlist entry were left in `~/.openclaw/openclaw.json` (not reverted)
since they are inert for the main agent — `agents.defaults.model.primary`
is still `zai/glm-5-turbo` with its existing fallbacks, unchanged (diff'd
against the pre-change backup). Gateway is healthy (`openclaw gateway
status`: running, connectivity probe ok) after both restarts. Backups:
`~/.openclaw/openclaw.json.bak-20260711-cursorcli` (pre-cliBackends) and
`~/.openclaw/openclaw.json.bak-20260711-cursorcli-model` (pre-model-allowlist),
both `chmod 600`.

## Summary for Task 4

The verified `CliBackendConfig` shape above is a valid starting point for
plugin defaults, but the plugin must additionally:

1. Register a cursor-agent-specific JSONL dialect (or equivalent parser) that
   extracts `assistant.message.content[].text` (or `result.result`) and skips
   `thinking.*`/`system.*` events, instead of relying on the generic parser.
2. Stabilize the system prompt (or otherwise avoid `invalidated:system-prompt`)
   so that `useResume` actually flips to `true` and `resumeArgs` gets
   exercised — this smoke test never observed a real `--resume <uuid>` call.
