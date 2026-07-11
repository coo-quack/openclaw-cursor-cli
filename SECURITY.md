# Security Policy

## Overview

`openclaw-cursor-cli` is an OpenClaw plugin that shells out to Cursor's
`cursor-agent` CLI on the local machine to serve it as an OpenClaw text
inference backend. It does not introduce its own network service: all
communication happens between the OpenClaw gateway process and the locally
installed `cursor-agent` binary via stdio.

- No data is sent anywhere beyond what `cursor-agent` itself sends to
  Cursor's backend as part of normal operation.
- The plugin does not persist prompts, responses, or session data beyond
  what OpenClaw's own session storage already retains.
- Session resume (`--resume {sessionId}`) relies on `cursor-agent`'s own
  session storage, not on anything this plugin manages independently.

## Threat Model / Limitations

- **`--force` auto-approval** — the backend invokes `cursor-agent` with
  `--force`, which auto-approves command execution so the CLI never emits an
  interactive approval prompt (a prompt would hang a headless/chat-driven
  run). Confirmation of risky or destructive actions is instead delegated to
  prompt-level guidance in the workspace `AGENTS.md`: the agent is expected
  to describe an action and wait for explicit user approval before executing
  it, rather than relying on a CLI-level confirmation gate. This is a
  cooperative, prompt-level control, not a hard security boundary — a
  sufficiently adversarial or malfunctioning model could execute a command
  without asking.
- **Trust boundary** — this plugin trusts the local `cursor-agent` binary
  and whatever credentials it is configured with. It does not sandbox or
  restrict what `cursor-agent` itself can do on the host.
- **Model catalog fetch** — the model catalog provider shells out to
  `cursor-agent models` and caches the result for one hour; on failure it
  falls back to a small static list. Neither path sends data anywhere beyond
  invoking the local CLI.

## Reporting Security Issues

- **GitHub:** [Open a security advisory](https://github.com/coo-quack/openclaw-cursor-cli/security/advisories/new)

Please do **not** open public GitHub issues for security vulnerabilities.
We aim to respond within 48 hours.

---

**Last Updated:** See Git history for this file.
