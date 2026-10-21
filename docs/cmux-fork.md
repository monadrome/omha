# cmux Historical Continuation

Omha can fork a registered native Claude/Codex session at an exact cmux Vault
checkpoint or turn, send a continuation through cmux agent messages, and retire
the source after the successor confirms takeover. This uses the terminal channel;
it does not invoke a headless provider or move work onto an API billing channel.

## Register And Inspect

Run from the source agent's cmux terminal and its original worktree:

```bash
omha handoff adopt
omha handoff checkpoints --id SOURCE_HANDOFF_ID
```

`adopt` registers only the calling surface, using full workspace/surface UUIDs,
the OS user, a surface-specific owner token, the worktree and cmux's verified
native session binding. It does not launch a provider or adopt a guessed target.
An existing owner cannot be overwritten. Checkpoint output contains real cmux
IDs, turns and anchors; an Omha action ID is not a native session turn.

## Fork And Retire

Write the complete continuation to a prompt file, then use exactly one selector:

```bash
omha handoff fork --id SOURCE_HANDOFF_ID --turn 2 \
  --prompt-file continuation.md --allow-write --close-source
```

Alternatively pass `--checkpoint` with an ID from `handoff checkpoints`.
The command uses `vault.fork` to copy history through that location, creates an
owned cmux workspace, and resumes the copied session using the source's structured
native arguments. Permission/model options are preserved; no bypass flag is added.
The bare provider command keeps cmux's wrapper and hooks in the launch path;
its `CMUX_CUSTOM_CODEX_PATH` or `CMUX_CUSTOM_CLAUDE_PATH` retains the source's
exact executable. A short positional startup prompt initiates the takeover
protocol, so continuation does not depend on an idle agent waking for an inbox
message. The agent must wait for the host's ready state and accept before work.
Generated protocol commands use the same Node/Omha installation and state home
that created the fork, including when `OMHA_HOME` is customized.
Captured Claude provider/auth-selection settings are explicitly preserved through
cmux's wrapper. Credential values in captured launch configuration are rejected
before forking, rather than copied into state or changed silently.
Missing or incompatible structured resume records fail closed.

The successor receives an agent message pointing to the persisted prompt and its
SHA-256. That message tells it to run, before task actions:

```bash
omha handoff accept --id FORK_HANDOFF_ID
```

Host checks require the actual successor surface, matching native session,
matching prompt hash and unchanged source ownership/session. Only then does
`--close-source` close the source surface. Other surfaces in its workspace remain
untouched. Without that option, the source remains open. Queued messages alone
never authorize source closure. The source can request its own retirement by
forking with `--close-source`; the successor performs the final close.
Cancelling an active calling native surface is refused; use that takeover path
so closure cannot terminate the host before it records the outcome. After a task
has finished, the explicit [auto-close completion hook](auto-close.md) instead
persists completion and delegates self-close to an independent recorder.

Send follow-up context through the same structured channel:

```bash
omha handoff message --id FORK_HANDOFF_ID --prompt 'Additional verified context.'
omha handoff status --id FORK_HANDOFF_ID
```

Native `handoff send` also uses agent messages. Omha never types continuation
text into an arbitrary TUI. Messages must fit 32 KiB; longer context stays in
the hashed prompt file. Agent hooks/message delivery must be available in cmux.

## Butterfly Integration

For an evidence-supported rewind action, supply a host-authored
[fork binding](../schemas/fork.schema.json):

```json
{
  "sourceHandoffId": "SOURCE_HANDOFF_ID",
  "actionId": "draft",
  "checkpoint": "turn:ordinal:8",
  "closeSource": true
}
```

The action must match the detector's causal boundary. The checkpoint must be
selected from the source's actual timeline at the intended continuation boundary;
the host validates the declared mapping and refuses missing or conflicting
selectors. It never interprets a task attempt number as a cmux turn.

```bash
omha auto-butterfly --input history.json --fork fork.json --allow-write
```

Insufficient drift evidence remains a no-op and starts nothing. The Omha-authored
`auto-butterfly-effect` skill can gather the current session's chronological
artifact/feedback evidence and select the native checkpoint without another
user prompt when that continuation is already authorized.

For a Leader lifecycle, set host policy
`butterfly.forks: {taskId: FORK_BINDING}`. `actionId` is required, for example
`action-1` for a supported first task attempt; a native checkpoint must still be
bound explicitly. Native continuation requires `--allow-write` and a completed
run with its configured acceptance, review and decision gates passed. A failed
replacement can produce advice but cannot launch this native continuation.
The existing observation/action caps and write replay gates remain in force.

## Recovery And Limits

Prompts are written before launch. Append-only handoff events record fork claims,
native parent/child sessions, checkpoint anchors, launch arguments, message IDs,
acceptance and source-close outcomes. Environment values are not copied into
Omha state; only their names are retained. Session usage/model identity are not
invented when the native terminal channel cannot report them.

The same source/binding/prompt produces a deterministic handoff ID. Failed or
uncertain requests are returned on repetition rather than automatically replayed.
Each source permits at most three attempts and chains permit at most three forks.
A crash after a fork or source-close claim leaves observable uncertainty; source
closure is never retried silently. Repeated acceptance with an unresolved source
close fails, so it cannot report exclusive takeover. Inspect status and native
resources first.

This copies conversation history into a new session. It does not restore files,
reset Git, mutate the original transcript, or certify task correctness. Native
interactive continuation retains the source's terminal permissions and is not a
DAG task with metered-provider usage accounting. No background session watcher is
installed; automatic observation still uses the existing Leader lifecycle or
explicit current-session skill invocation. Unsupported providers/platforms and
unavailable cmux capabilities fail without switching billing channels.

Offline verification: `tests/cmux-fork.test.mjs` exercises the actual CLI/backend
protocol against a local cmux fixture, including failure, tampering, authority,
takeover, bounds and installed-package checks. It launches no paid provider.
