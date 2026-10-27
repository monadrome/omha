---
name: agent-handoff
description: Transfer an agent task to a new terminal session, a named registry agent or a file pointer using cmux, tmux, or a portable fallback. Use when another agent or a human must continue work.
---

# Agent handoff

Use a written handoff when another session or person needs context; a context
note alone does not require a terminal.

## Write the note

A handoff carries two different kinds of text. Keep them apart, because the next
agent trusts what it reads and will not re-check it:

- **Requests file** (`requests.json`): a JSON array of the user's own messages
  that define the task, copied verbatim, never paraphrased. Include the original
  task and every later message that changed it. Reference large pasted content
  by path instead of copying it.
- **Brief file** (`brief.md`): four or five short lines about the work so far,
  written about "the previous agent", never "I" or "we": what it did and which
  files it created or edited. Do not claim the task is finished or correct, and
  do not state a test result or exit code that was not actually observed. Point
  to specs, plans, ADRs, commits and diffs by path instead of copying them; the
  workspace is the source of truth.

The CLI assembles both into `<user_request>` and `<compacted_content>` blocks,
labels the brief as an unverified self-report, strips forged delimiter tags from
either input and records hashes on the handoff. It rejects an empty request, a
request over 16 KiB or a brief over 4000 characters. Without the CLI, write the
same two blocks and labels by hand and report that no managed worker started.

## Hand off

Check `omha doctor --json`, then run from the target worktree:

```bash
omha handoff --requests-file requests.json --brief-file brief.md --backend file
omha handoff status --id HANDOFF_ID
omha handoff read --id HANDOFF_ID
```

`--prompt-file handoff.md` remains available for free-form prompts; it cannot be
combined with the note files. File mode preserves context without starting a
provider. To open an owned terminal, use `--backend auto`; the default command
is an interactive shell.

To continue with a named agent from the global registry, run `omha agents list`
and add `--agent NAME`. The registry entry supplies the command, argv and model;
the record keeps the agent name and requested model as evidence. A user defines
an agent once, for example a Kimi Code reviewer pinned to `kimi-code/k3.1-pro`,
with `omha agents add NAME --input agent.json`; review-role agents also join
`omha review`. Never add or change a registry entry unless the user asked for it.
For an unregistered worker, specify its authorized executable with `--command
/absolute/path/to/worker` and argv as `--args '["ARGUMENT"]'`. Handoff manages
that process; provider profile routing and budget gates belong to `omha run` or
`omha leader`. Preserve the user's selected billing channel. Use `poll`, `send`,
`cancel` and `close` with the returned handoff id, never a guessed terminal
reference.

Write the note files and Omha memory pointer before starting the backend.
Prefer cmux when available for a visible handoff, then tmux for headless work,
then a file-only handoff. Detect capabilities rather than assuming either
terminal exists. Use a unique name and retain the full cmux workspace reference
or private tmux socket. The created session is owned by this handoff; do not
close another session. Report backend, full reference, ownership token, PID,
prompt path/hash, agent, memory pointer and cwd. Poll for a token-bound final
JSON marker or explicit completion record; a process exit without that marker is
a failure. Timeout/cancel/close only resources owned by this handoff.

## Native cmux continuation

For an existing native cmux Claude/Codex session, use `handoff adopt`, then
`handoff checkpoints` and `handoff fork --id SOURCE_ID --turn N --prompt-file
handoff.md --allow-write`. `--close-source` requests retirement only after the
successor runs `handoff accept --id FORK_ID`; never close the source early.
For long sessions, `--compact source|target` and `--rename-target|--rename-source
TITLE` are explicit opt-ins; the CLI enforces their order and fails closed when
compaction cannot be confirmed through structured events. Run source compaction
from a different surface than the source agent.
Use `handoff message` for structured follow-up delivery. Native sessions use
cmux's verified session binding and takeover acknowledgement rather than the
pipe worker's final marker. See the [native fork contract](../../docs/cmux-fork.md).

Installation and input contracts: [plugin guide](../../docs/plugin.md) and
[agent registry](../../docs/contracts.md#agent-registry-and-handoff-notes).
