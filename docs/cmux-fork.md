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

## Compact, Rename And Close Lifecycle

Long-session continuation can additionally compact context and retitle both
sides. All options default off; without them requests, handoff IDs, records,
events and cmux calls are unchanged.

```bash
omha handoff fork --id SOURCE_HANDOFF_ID --turn 2 \
  --prompt-file continuation.md --allow-write --close-source \
  --compact source --rename-target 'Task (continued)' --rename-source 'Task (retired)'
```

The order is fixed by the host:

```text
compact source -> revalidate checkpoint -> fork -> [compact target] ->
rename target -> rename source -> continuation -> successor accept -> close source
```

- `--compact source` submits the provider's native compaction command
  (`/compact` for Claude Code) to the registered source surface and waits for a
  structured cmux event: `agent.hook.SessionStart` with `source: "compact"` for
  the exact source session and surface. `agent.hook.PreCompact` is recorded when
  seen. The selected checkpoint must be the timeline tail. Afterwards the host
  re-reads the timeline, requires every earlier entry to be unchanged and exactly
  one new tail, and forks at that tail; it never reuses the pre-compaction turn.
  The source session/ownership is re-verified first. Compacting the calling
  surface is refused because its agent cannot finish compaction while it waits
  for this command; run the fork from another surface.
- `--compact target` forks first, launches the successor without the positional
  startup prompt, waits for its structured `SessionStart` readiness event,
  compacts only the successor, then submits the fixed host takeover line. The
  continuation itself remains in the hashed prompt file and agent message. The
  source history is not compacted.
- `--compact-wait-ms` bounds the completion wait (default 120000, at most 600000).
- `--rename-target` renames the successor's Omha-owned workspace
  (`rename-workspace`). `--rename-source` renames the source tab
  (`rename-tab`), or its workspace when Omha created that workspace. Both verify
  ownership and the native session first.
- Closure still happens only inside `handoff accept`, after its successor,
  prompt-hash, ownership and lifecycle checks; compaction and renaming never
  close anything.

Compaction and the typed protocol line are the only terminal input Omha submits
to a native agent, always to a verified owned surface. Completion is accepted
only from the structured event stream. Screen scraping is not used as a
fallback: no verified screen marker exists for compaction completion, so a
missing event channel is reported as `signal_unavailable` instead of guessed.

Fail-closed outcomes, each recorded and returned under the same deterministic
handoff ID without replaying side effects:

| Condition                                       | Outcome                                                    |
| ----------------------------------------------- | ---------------------------------------------------------- |
| Provider without verified compaction (Codex)    | Refused before any record or input; `fork.compact_refused` |
| Calling surface or non-tail checkpoint (source) | Refused before any record or input; `fork.compact_refused` |
| Event channel unavailable                       | No compaction, fork, rename or close; `signal_unavailable` |
| No completion event before the deadline         | No fork, rename or close; `compact.timed_out`              |
| Timeline prefix changed or ambiguous tail       | No fork; `checkpointResolution.state: mismatch`            |
| Rename failure                                  | No continuation or close; successor kept; `rename.failed`  |

The record's `fork.lifecycle` holds the applicable `order`, `compact` (mode,
state, signal, cursor, start/completion sequence, `waitedMs`),
`checkpointResolution` (requested, resolved, added entries, prefix check),
`renameTarget`/`renameSource` (title, scope, state), `bootstrap` delivery for
target compaction and `close` timing (`afterAcceptance`, `requestedAt`,
`closedAt`). Events add `compact.requested|completed|timed_out|failed|signal_unavailable`,
`fork.checkpoint_resolved`, `fork.successor_ready`, `rename.requested|completed|failed`,
`fork.bootstrap_submitted` and acceptance/closure timestamps.

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

The action must match the detector's causal boundary. The binding may also carry
`compact` (`none|source|target`), `renameTarget` and `renameSource`, with the
same lifecycle and fail-closed rules as the CLI flags. The checkpoint must be
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
