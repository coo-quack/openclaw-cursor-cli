# MCP bridge hardening investigation (2026-07-12)

Read-only investigation. No config/gateway changes made. Follows up on
`2026-07-11-mcp-bridge-investigation.md`, which proved the bridge works.
This one asks: how do we make it safe without losing capability.

## 1. OpenClaw loopback MCP tool inventory

Live probe (`docs/notes/2026-07-11-...md`, live verification section) with
the bridge on enumerated the full tool set the `openclaw` MCP server exposes
to a bridged backend:

```
agents_list, browser, create_goal, cron, gateway, get_goal, image_generate,
memory_get, memory_search, message, music_generate, nodes, session_status,
sessions_history, sessions_list, sessions_send, sessions_spawn,
sessions_yield, skill_workshop, subagents, tts, update_goal, video_generate,
web_fetch, web_search
```

24 tools total (plus whatever other MCP servers, e.g. `playwright_browser_*`,
`serena_*`, happen to be configured in the workspace — those are a separate
concern, not OpenClaw's).

Classification (by name/obvious purpose; exact side-effect surface not
individually re-verified beyond `session_status` in the 07-11 doc):

- **Read-only / low risk**: `agents_list`, `get_goal`, `memory_get`,
  `memory_search`, `session_status`, `sessions_history`, `sessions_list`,
  `web_fetch`, `web_search`, `gateway` (likely status/info; verify if used
  for control), `nodes` (likely topology read)
- **Side-effecting (state mutation / external action)**: `create_goal`,
  `update_goal`, `cron` (schedule create/edit — analogous to blocked
  `CronCreate` in claude-cli), `message` (send messages out real channels —
  iMessage/etc.), `sessions_send`, `sessions_spawn`, `sessions_yield`,
  `subagents`, `browser` (drives real browser), `image_generate`,
  `music_generate`, `video_generate` (cost + external API calls),
  `tts` (external API call), `skill_workshop` (can write/install skills —
  effectively code execution surface)

The riskiest cluster given `--force` + `--trust` + no per-tool filtering is
`message` (can message real humans unattended), `cron` (can schedule future
unattended actions), `sessions_spawn`/`subagents`/`sessions_send` (can drive
other agent sessions), and `skill_workshop` (can create/modify skills, i.e.
new code paths).

## 2. Subagent / other-model invocation tool

**Yes, exposed via MCP.** `sessions_spawn` and `subagents` are present in
the enumerated tool list and by name match OpenClaw's own
session/subagent-spawning primitives (the same primitives that back
`sessions_send`/`sessions_yield`/`sessions_history`). These almost certainly
accept a model reference (OpenClaw sessions are always bound to a model),
so a cursor-agent session with the bridge on very likely *can* delegate a
turn to `zai/glm-*` (or any other configured model) directly through the MCP
tool call — no need to shell out to `openclaw agent --model zai/...`. This
was not independently re-verified by an isolated live call in this
investigation (time-boxed); if a definitive answer is needed, run: session
with model `cursor-cli/...`, prompt "call sessions_spawn to start a session
with model zai/glm-5-turbo and report the tool schema before calling it."
Absent that MCP path, the fallback is indeed shelling out to
`openclaw agent --model zai/...`, which requires `--force` (shell) and is a
separate, coarser risk (arbitrary CLI invocation) than a scoped MCP call.

## 3. cursor-agent tool restriction capabilities

`cursor-agent --help` (binary `~/.local/bin/cursor-agent`, installed version
`2026.07.09-a3815c0`) has **no `--allowedTools`/`--disallowedTools` flag**
and **no argv-level MCP tool filter**. Available argv-level controls:

- `--mode plan` / `--mode ask`: both documented as read-only (no edits, no
  shell). This plugin's `resolveExecutionArgs` already forces `--mode ask`
  for `side-question` execution mode.
- `--sandbox enabled|disabled`: OS-level sandbox for shell/file access;
  orthogonal to MCP tool calls.
- `--approve-mcps`: only auto-approves whole MCP *servers*, not individual
  tools.
- `mcp enable/disable <identifier>`: server-level allow/deny, not per-tool.
- `-f/--force` / `--yolo`: "Force allow commands unless explicitly denied" —
  the operative phrase is **"unless explicitly denied"**, meaning an
  explicit deny entry still wins even under `--force`.

**Real per-tool deny mechanism found (undocumented by `--help`, discovered
by reading the installed bundle
`~/.local/share/cursor-agent/versions/2026.07.09-a3815c0/index.js`):**
cursor-agent has an internal `permissionsService.shouldBlockMcp()` that is
driven by a `permissions.deny` / `permissions.allow` list stored in
`~/.cursor/cli-config.json` (per-user, global; format also used for
`Shell(...)`/`Write(...)`/`WebFetch(...)` entries — this is the same file
already present at `~/.cursor/cli-config.json` with
`permissions: {allow: ["Shell(**)","Read(**)","Write(**)","Mcp(**)"], deny: []}`).
Entry syntax (from `matchesMcpEntry`/`matchesMcpPattern` in the bundle):

```
Mcp(<serverGlobPattern>:<toolGlobPattern>)
```

e.g. `Mcp(openclaw:cron)`, `Mcp(openclaw:message)`, `Mcp(openclaw:sessions_spawn)`,
`Mcp(openclaw:skill_workshop)`, or `Mcp(openclaw:*)` to block the whole
server, with glob matching (`*` wildcard) on both server id and tool name.
Confirmed in the bundle: `isMcpExplicitlyDenied` is checked **first**, before
approvalMode/force/readonly logic, and unconditionally returns "BLOCKED" —
i.e. an explicit deny entry is honored even with `--force`/`--trust`/
`--approve-mcps` and even in `unrestricted` approvalMode. This is the
mechanism to use; it is real and enforced in-process, not merely advisory.

Caveat: this file is **global to the OS user** (`~/.cursor/cli-config.json`),
not scoped to the OpenClaw-launched workspace/session — any deny list
written there affects all cursor-agent invocations by this user, including
interactive/manual ones. (A workspace-local override was not confirmed to
exist in the time available; `.cursor/mcp.json` is workspace-scoped but that
file only lists servers, not per-tool permissions.)

Also noted in passing: `~/.cursor/cli-config.json.bak-20260712-unrestricted`
exists on disk (a backup file with today's suffix), while the live file's
`approvalMode` is currently `"unrestricted"` and `sandbox.mode` is
`"disabled"`. This investigation did not create that backup and made no
edits to the file — it was already present before this session started.
Whoever/whatever created it should be asked what state it was backing up
from and whether the intended tightening (approvalMode away from
`unrestricted`, and/or an `Mcp()` deny list) still needs to be applied.

## 4. claude-cli's existing restriction pattern (for comparison)

From `/opt/homebrew/lib/node_modules/openclaw/dist/cli-backend-CkQ4PBJi.js`,
the built-in `claude-cli` backend hard-codes into argv:

```
--allowedTools mcp__openclaw__*
--disallowedTools ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor
```

`--allowedTools mcp__openclaw__*` doesn't actually narrow anything (it's
already "all openclaw MCP tools"); the real restriction is the 4-item
`--disallowedTools` blocklist, which blocks specific named tools/native
capabilities regardless of `--force`-equivalent settings. This is a
narrower blocklist than what full side-effect classification above would
suggest is prudent (it doesn't block `message`, goal mutation, media-gen
tools, etc.) — treat it as prior art for the *mechanism* (an argv-level
disallow list), not as a complete or exemplary blocklist to imitate as-is.

cursor-agent has no argv equivalent of `--disallowedTools`; the closest
equivalent is the `~/.cursor/cli-config.json` `permissions.deny` `Mcp()`
list described in §3, which is more powerful (glob patterns, real
enforcement layer) but lives in a different place (a JSON config file, not
argv) and is user-global rather than per-invocation.

## 5. OpenClaw-side tool restriction options

- `tools.byProvider` exists as a real, still-supported mechanism in OpenClaw
  core (`agent-tools.policy-Bvvs8fk8.js`: `byProvider: globalTools?.byProvider`,
  `byProvider: agentTools?.byProvider`; also referenced in
  `audit.nondeep.runtime-CX_11pJt.js` with example shape
  `byProvider["provider/model"].deny=["group:web", ...]`). This was used
  historically for the gpt-oss deny-list (per MEMORY.md,
  `2026-07-06` security pass — later fully removed when gpt-oss was dropped,
  not because the mechanism stopped working).
- Current `~/.openclaw/openclaw.json` has **no `tools.byProvider` entry** at
  all right now (only `tools.web.search.enabled` / `tools.web.fetch.enabled`
  at the top level, and an unrelated `contextPruning.tools.deny` list for
  memory-pruning behavior, not access control).
- This mechanism governs which tools OpenClaw's own agent loop calls
  natively — it does **not** reach into what a bridged external CLI (cursor
  -agent) can call once the MCP server itself hands it tool definitions. The
  bridge hands cursor-agent a URL + bearer token to the *whole* loopback MCP
  server; OpenClaw's `tools.byProvider` deny-list, if any, would need to be
  enforced **server-side inside the loopback MCP tool dispatcher** (per
  bearer-token/session) to matter here, not just client-side. Whether the
  loopback MCP server actually consults `tools.byProvider` (or any per-agent
  policy) when *serving* a tool call to an external MCP client (as opposed
  to gating OpenClaw's own native tool-calling loop) was not confirmed in
  the time available — this is the single most important open question
  before trusting `tools.byProvider` as a defense for the bridge path. If it
  only gates OpenClaw's native loop, it provides **zero** protection here,
  and cursor-agent-side `Mcp()` deny (§3) is the only real control point.

## Design recommendation

**Single backend, tools-enabled by default, hardened via a layered deny —
not two backends.** Rationale: the bridge is genuinely useful (this is the
whole point of the plugin), the risk is concentrated in a small, enumerable
set of side-effecting tool names, and there is now a real enforcement
mechanism (§3) to block exactly those regardless of `--force`. A second
"text-only, no bridge" backend adds maintenance surface without adding
safety once the deny list exists — someone will just use the risky one to
get real work done, and now there are two configs to keep in sync. If the
maintainers want an explicit "safe mode," it's cheaper as a config toggle
than a whole second backend registration.

Concretely, recommend:

1. **Keep `--force`/`--trust`/`--approve-mcps`** for the shell/file/command
   side of the tool (that's cursor-agent's normal headless posture and
   orthogonal to MCP) but **add a curated `Mcp()` deny list** to
   `~/.cursor/cli-config.json` `permissions.deny`, e.g.:
   ```json
   "deny": [
     "Mcp(openclaw:message)",
     "Mcp(openclaw:cron)",
     "Mcp(openclaw:sessions_spawn)",
     "Mcp(openclaw:sessions_send)",
     "Mcp(openclaw:subagents)",
     "Mcp(openclaw:skill_workshop)",
     "Mcp(openclaw:create_goal)",
     "Mcp(openclaw:update_goal)",
     "Mcp(openclaw:browser)"
   ]
   ```
   This preserves read/query tools (`memory_get`, `memory_search`,
   `web_search`, `web_fetch`, `session_status`, `sessions_history`,
   `sessions_list`, `agents_list`, `get_goal`, `nodes`, `gateway`) plus
   media-gen tools if the team decides those are acceptable cost-only risk
   (`image_generate`/`tts`/`music_generate`/`video_generate` — not
   included above; add them to the deny list too if unattended API spend is
   a concern). This is a config-file change outside this plugin's code —
   the plugin itself doesn't need to change to benefit from it, but the
   plugin's docs/README should document this as the *required* companion
   setup whenever `OPENCLAW_CURSOR_CLI_MCP_BRIDGE=1` is turned on, since the
   bridge is otherwise unconditionally all-or-nothing.
2. Note the deny list is **user-global**, not per-session — accept that
   trade-off (it also protects interactive/manual cursor-agent use, which
   is a feature not a bug) or investigate a workspace-local
   `.cursor/cli-config.json` override before relying on it (not confirmed
   to exist).
3. Verify server-side enforcement question in §5 before considering this
   fully closed — if the loopback MCP server would honor a
   `tools.byProvider` deny keyed to the bridged session/token, that would
   be defense-in-depth on top of (1), independent of cursor-agent's own
   permission file being correctly maintained.
4. Do **not** rely on `--mode ask`/`--mode plan` as the safety mechanism for
   a "tools" variant — those are about edit/shell read-onlyness, not MCP
   tool gating, and this plugin already uses `--mode ask` only for the
   unrelated `side-question` execution path.

## What remains impossible / unconfirmed

- No cursor-agent argv flag can filter individual MCP tools (only whole
  servers via `mcp enable/disable`, or the config-file `Mcp()` deny/allow
  list in §3).
- No per-invocation (as opposed to per-OS-user) MCP tool permission scoping
  was found for cursor-agent.
- Whether OpenClaw's loopback MCP server enforces `tools.byProvider` (or
  any policy) against externally-bridged MCP clients, vs. only against its
  own native tool-calling loop, was **not confirmed** — this is the key
  remaining unknown and should be resolved (by reading the loopback MCP
  server's tool-dispatch code, not covered in this pass) before treating
  OpenClaw-side config as a real second line of defense for the bridge.
- Whether `sessions_spawn`/`subagents` actually accept a `model` parameter
  (confirming direct cursor→glm delegation via MCP) was inferred from
  naming/context, not independently re-verified with a live call in this
  session.
