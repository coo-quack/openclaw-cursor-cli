# The OpenClaw MCP tool bridge

How `cursor-mcp/<model>` gives `cursor-agent` access to OpenClaw's tool
surface, when it refuses to, and what it leaves behind if a run dies.

For the short version — what the bridge is and how to turn it on — see the
[README](../README.md#openclaw-mcp-tool-bridge). Read this one before relying
on the bridge in a workspace you care about.

## How it works

OpenClaw's CLI runner has a "bundle MCP" mechanism, used by its claude-cli,
codex-cli and gemini-cli backends: when a backend opts in with
`bundleMcp: true`, OpenClaw starts a loopback MCP server and writes its URL and
bearer token into a backend-specific shape before each run.

`cursor-agent` has no equivalent flag. It reads MCP servers from
`.cursor/mcp.json` in the workspace (or `~/.cursor/mcp.json`), and needs
`--approve-mcps` to accept them without an interactive prompt.

So the `cursor-mcp` backend opts into the `claude-config-file` bundle mode —
which produces a throwaway `--strict-mcp-config --mcp-config <path>` pair
pointing at a generated `{ mcpServers: { openclaw: { url, headers } } }` file —
purely as a way to obtain that config. Then, in `resolveExecutionArgs`, it:

1. reads the generated temp config,
2. merges its `openclaw` server entry into the workspace's `.cursor/mcp.json`,
   preserving servers already configured there and any top-level keys the
   bridge does not own, such as `$schema`,
3. strips the unsupported `--strict-mcp-config` and `--mcp-config` flags, and
4. adds `--approve-mcps`.

The original file is captured during `prepareExecution` and restored by its
cleanup once the run finishes.

`cursor-cli` never runs any of this. The bridge only applies when the backend
was constructed with `bundleMcp: true`, which is only `cursor-mcp`.

## When the bridge declines to run

Step 2 rewrites a file you own, so it proceeds only when it can parse and
re-serialize that file without losing anything. It declines in six situations:

| Situation | What happens |
|---|---|
| `.cursor/mcp.json` cannot be parsed — not JSON, not an object, or an `mcpServers` that is neither an object nor `null` | The file is left byte-for-byte as it was |
| The file exists but cannot be read (permissions) | Nothing is written |
| The generated temp config cannot be read or parsed | Nothing is written to the workspace at all |
| The write itself fails (permissions, no space) | Restored from the backup |
| `.cursor/mcp.json` is a symlink **and** cleanup would have to delete rather than rewrite | Refused — see below |
| Execution args were resolved without a prepare phase for that workspace | Refused — see below |

Each logs a warning, and the turn runs without the bridge.

Empty files, whitespace-only files, a leading byte-order mark, a missing
`mcpServers` key and an `mcpServers` of `null` are all fine. None of them holds
server data the bridge could destroy, so it merges into them normally.

**Comments are the case worth knowing about.** `.cursor/mcp.json` is parsed as
strict JSON, so a JSONC-style file with `//` comments counts as unparseable.
Strip the comments if you want the bridge to engage. Failing closed is
deliberate: the alternative is overwriting a file whose original content the
bridge could not read, and that content is only recoverable while the gateway
process lives.

### The symlink case

A symlink is refused only when prepare found nothing to restore — no file at
all, or a file holding nothing but a stale `openclaw` entry. Cleanup then
deletes rather than rewrites, and deleting through a symlink removes the link
while the bearer token stays in the file it pointed at.

A symlink to a real config is **not** refused: cleanup rewrites the original
bytes through the link, which is safe.

### The missing-prepare case

Prepare is what registers the backup and the cleanup. Without it, nothing would
ever remove what the write puts on disk. OpenClaw always runs prepare first, so
seeing this points at a change in the host's contract rather than at your
configuration.

### Two details of when the check applies

**The config the bridge merges into is the one captured at prepare time**, not
re-read at step 2, whenever prepare could read it. Editing `.cursor/mcp.json`
while a `cursor-mcp` turn is in flight therefore has no effect on that turn:
the edit is overwritten by the merge, then replaced by the prepare-time
snapshot at cleanup. Only when prepare found the file missing or unreadable
does step 2 read from disk.

**Declining is not always the same as running text-only.** Usually it is:
nothing is written, no `--approve-mcps` is added, and `cursor-mcp/<model>`
behaves like `cursor-cli/<model>` for that turn. The exception is a decline
that follows a *successful* write earlier in the same turn — OpenClaw can
resolve execution args more than once per turn. The bridged server is already
on disk then, so `--approve-mcps` is kept and the model still has OpenClaw's
tools, with the token caveat below applying in full. Dropping the flag instead
would leave `cursor-agent` waiting on an approval prompt it can never receive.

## The token on disk

While a bridged run is in flight, the loopback server's URL and bearer token
are in the workspace's `.cursor/mcp.json`. Any process sharing that workspace
during that window — including a concurrently running `cursor-cli` turn — can
read that file and reach the tool server. Do not treat the backend split as
isolation between concurrent runs in the same workspace.

How long the window lasts depends on how many runs share the workspace. Backups
are reference-counted per workspace: the first prepare captures the original
file, each further prepare increments the count, and **only the cleanup that
drops the count to zero restores or removes it.** Intermediate cleanups from
nested or concurrent runs deliberately leave the bridged file in place so the
still-running outer turn keeps working.

Two consequences:

- With overlapping runs, the token stays on disk until the *last* one finishes,
  not the first.
- If a cleanup never runs — the gateway is killed, the process crashes — the
  count never reaches zero and the bridged file is left behind.

The token itself stops working when the gateway that issued it exits, since its
loopback server goes with it.

### How a leftover file heals

A leftover usually clears itself, but only on a later `cursor-mcp` turn in the
same workspace that actually bridges. Prepare drops any `openclaw` entry it
finds from the backup it captures, so that turn's cleanup restores the file
**without** the stale entry — and removes the file outright if the entry was
all it held.

A turn that declines writes nothing and therefore cleans nothing.

One shape never heals: a symlinked `.cursor/mcp.json` whose target holds only a
leftover entry. That combination is refused every time. Replace the symlink
with a real file if you hit it.

Until it heals, the file sits there shadowing your own MCP config. Delete it by
hand if that workspace will not see another bridging turn soon.

## The `openclaw` server name is reserved

The bridge owns exactly one entry in `mcpServers`, named `openclaw`, and takes
responsibility for removing it. If a run's cleanup never fires and a later run
finds that entry still there, it treats it as a leftover and drops it rather
than preserving it.

A server of your own named `openclaw` would be dropped the same way. Pick a
different name.

Everything else in the file is left alone, with two limits:

- When prepare found no readable file, a config that appears or changes
  mid-turn is merged into and restored rather than overwritten, and cleanup
  will not delete it. The bridge recognises its own output by comparing against
  the exact bytes it last wrote, and leaves anything else alone with a warning.
- When prepare *did* read a file, the merge uses that snapshot, and a mid-turn
  edit is lost.

Dropping an `openclaw` entry is always logged, even when that means saying it
twice in one turn. A rewrite that quietly removes something you configured is
the worse outcome.

## Verification

The bridge is covered at two levels.

Unit tests mock the filesystem and cover the branches above: backup promotion,
reference counting across concurrent runs, symlink refusal, restore after a
failed write, and leftover-entry handling.

The integration suite drives a real gateway and a real loopback server. It
checks that `--approve-mcps` is added and the Claude-only flags are stripped in
the argv the binary actually receives, that the bridged server answers
`initialize`, `tools/list` and `tools/call`, that a pre-existing
`.cursor/mcp.json` comes back byte for byte, and that a workspace which had no
config is left with none.

See [CONTRIBUTING.md](../CONTRIBUTING.md#integration-tests) for how to run it,
and `docs/notes/2026-07-11-mcp-bridge-investigation.md` for the original
investigation and live verification transcript.
