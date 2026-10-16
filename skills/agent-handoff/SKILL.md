---
name: agent-handoff
description: Transfer an agent task to a new terminal session or a file pointer using cmux, tmux, or a portable fallback. Use when another agent or a human must continue work.
---

# Agent handoff

Use a written handoff when another session or person needs context. Summarize
the goal, verified state, changed files, evidence, unresolved decisions and next
action through reasoning; a context note alone does not require a terminal.

For an owned, observable handoff, check `omha doctor --json`, write a prompt file
and run from the target worktree:

```bash
omha handoff --prompt-file handoff.md --backend file
omha handoff status --id HANDOFF_ID
omha handoff read --id HANDOFF_ID
```

File mode preserves context without starting a provider. To open an owned
terminal for continuation, use `omha handoff --prompt-file handoff.md --backend
auto`; the default command is an interactive shell. For a known worker, specify
its authorized executable with `--command /absolute/path/to/worker` and argv as
`--args '["ARGUMENT"]'`. Handoff manages that process; provider profile routing
and budget gates belong to `omha run` or `omha leader`. Preserve the user's
selected billing channel. Use `poll`, `send`, `cancel` and `close` with the returned
handoff id, never a guessed terminal reference. If the CLI is unavailable, return
the written handoff and report that no managed worker was started.

Write the prompt and Omha memory pointer before starting the backend.
Prefer cmux when available for a visible handoff, then tmux for headless work,
then a file-only handoff. Detect capabilities rather than assuming either
terminal exists. Use a unique name and retain the full cmux workspace reference
or private tmux socket. The created session is owned by this handoff; do not
close another session. Report backend, full reference, ownership token, PID,
prompt path/hash, memory pointer and cwd. Poll for a token-bound final JSON
marker or explicit completion record; a process exit without that marker is a
failure. Timeout/cancel/close only resources owned by this handoff.

Installation and input contracts: [plugin guide](../../docs/plugin.md).
