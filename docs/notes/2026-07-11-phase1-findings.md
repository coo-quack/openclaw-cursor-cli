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

## Follow-up: jsonlDialect + systemPromptWhen (2026-07-11, later same day)

Re-ran the smoke test after applying the two fixes both findings above called
for. Backup taken first:
`~/.openclaw/openclaw.json.bak-20260711-cursorcli-dialect` (600 perms).

### Config delta

```bash
jq '.agents.defaults.cliBackends["cursor-cli"] += {"jsonlDialect": "claude-stream-json", "systemPromptWhen": "never"}' ...
```

Resulting `cliBackends["cursor-cli"]` gained two keys on top of the Task-1
block (all prior fields unchanged):

```json
{
  "jsonlDialect": "claude-stream-json",
  "systemPromptWhen": "never"
}
```

`openclaw gateway restart` accepted the schema without error — `openclaw
gateway status` showed `Runtime: running (pid 55080, state active)`,
`Connectivity probe: ok` immediately after. No BLOCKED condition hit.

### Turn A (fresh session `agent:main:cursor-cli-smoke-test2`)

```bash
openclaw agent --session-key "agent:main:cursor-cli-smoke-test2" \
  --message "reply exactly: dialect ok" \
  --model cursor-cli/grok-4.5-fast-xhigh --json
```

`result.payloads[0].text` = `"dialect ok"` — clean, not raw JSONL.
`finalAssistantVisibleText`/`finalAssistantRawText` both `"dialect ok"` too.
**Finding 1 (JSONL extraction) is fixed**: `jsonlDialect: "claude-stream-json"`
correctly parses cursor-agent's `assistant.message.content[].text` /
`result.result` shape, confirming the brief's premise that cursor-agent's
stream-json event shape is Claude-compatible enough for this dialect to work
as-is (no bespoke cursor dialect needed).

Log line (turn A):

```
cli exec: provider=cursor-cli model=grok-4.5-fast-xhigh promptChars=54 trigger=user useResume=false session=none resumeSession=none reuse=none historyPrompt=none
```

`useResume=false`/`reuse=none` is expected and correct for a session's first
turn (nothing to resume yet). `agentMeta.sessionId` = `544179ea-5d34-4e27-8d87-d29bc68a669d`,
usage `input=38048` (full cold system prompt sent, as expected on turn 1).

### Turn B (same session key, follow-up question)

```bash
openclaw agent --session-key "agent:main:cursor-cli-smoke-test2" \
  --message "What did I ask you to reply in my previous message? Answer with that exact word pair." \
  --model cursor-cli/grok-4.5-fast-xhigh --json
```

`result.payloads[0].text` = `"dialect ok"` — correct recall, clean text.
`agentMeta.sessionId` unchanged (`544179ea-5d34-4e27-8d87-d29bc68a669d`,
same as turn A) and usage dropped to `input=205`/`output=39` (vs. 38048/91 on
turn A) — consistent with a genuinely resumed session (no cold 35K-char
system prompt resend), not agentic re-derivation like the Task-1 run showed.

Log line (turn B):

```
cli exec: provider=cursor-cli model=grok-4.5-fast-xhigh promptChars=114 trigger=user useResume=true session=present resumeSession=530bdeaecffd reuse=reusable historyPrompt=none
```

**Finding 2 (resume) is fixed**: `useResume=true`, `session=present`,
`resumeSession=530bdeaecffd`, `reuse=reusable` — a full flip from Task-1's
`useResume=false`/`reuse=invalidated:system-prompt`. `systemPromptWhen:
"never"` stabilized the (nonexistent, for this backend) system-prompt/
tool-policy/tool-names hash, so `resolveCliSessionReuse` no longer invalidates
the binding between turns.

Caveat: `/tmp/openclaw/openclaw-2026-07-11.log` does not log the literal
spawned argv/command line (grepped for `--resume` and `resumeArgs` across the
whole file: zero hits at the text level) — there is no line showing
`--resume 530bdeaecffd` verbatim. The evidence for `resumeArgs` actually
firing is the internal reuse-resolution state itself
(`useResume=true`/`session=present`/`resumeSession=530bdeaecffd`/
`reuse=reusable`), which is what gates whether OpenClaw's CLI backend chooses
`args` vs `resumeArgs` before spawning — plus the token-usage drop and stable
`agentMeta.sessionId` across turns. This is strong indirect confirmation but
not a literal argv-in-log match as the original brief phrased it.

Gateway remained healthy throughout (`Runtime: running`, `Connectivity probe:
ok`, final check after both turns).

### Conclusion for plugin defaults

Both fixes should ship as **plugin defaults** for the cursor-cli backend:

- `jsonlDialect: "claude-stream-json"` — verified clean extraction end-to-end,
  no bespoke parser needed contra the Task-1 recommendation; cursor-agent's
  event shape is close enough to Claude's dialect that reusing it is correct
  and simpler than writing a new one.
- `systemPromptWhen: "never"` — verified it unblocks resume by keeping the
  session-reuse hash stable turn-to-turn. This is a reasonable default given
  cursor-cli has no system-prompt transport (no `systemPromptArg`) — there is
  no other way to send a system prompt through this backend anyway, so
  declaring `"never"` simply matches reality and gets session continuity as a
  side benefit. Should Task 4 later add a `systemPromptArg`/injection path for
  cursor-cli, this default should be revisited (a real system prompt would
  then need its own stability handling rather than blanket suppression).
