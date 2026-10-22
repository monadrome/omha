# Terminal Backends

Omha prefers cmux and falls back to tmux. Neither is an npm dependency. File
handoff remains the last resort for ordinary task handoffs; it persists context
without starting a process. Provider runtime, memory, review, decisions, Arena
Session Fork and native auto compact do not require cmux.

| Capability                                                                       | cmux                                | tmux                                            | file         |
| -------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------- | ------------ |
| Owned task start, input, capture, cancel and close                               | Yes                                 | Yes                                             | Context only |
| Connection recovery                                                              | Structured local tab discovery      | Registered Omha workers in the current worktree | No           |
| Completion auto-close                                                            | Calling native Claude/Codex surface | Calling owned live worker pane                  | No           |
| Native session adoption, checkpoint fork, structured agent messages and takeover | Verified cmux interfaces required   | Unavailable                                     | Unavailable  |

Native historical fork is different from Arena Session Fork: the latter seals a
public prefix and runs isolated lanes without cloning a provider conversation.
No terminal backend promises task correctness, cache hits, provider model
identity or billing that it cannot observe.

## Selection And Failure

```bash
omha handoff --prompt-file handoff.md --backend auto
omha handoff --prompt-file handoff.md --backend tmux
omha auto-recover check --backend auto
omha auto-recover list --backend tmux
```

Ordinary handoff tries cmux, tmux, then file. `requestedBackend` and
`launchAttempts` retain the selection and failures. Explicit backends do not
fall back. An explicit `handoff resume` starts a new worker with the default
cmux-first selection; it does not restore provider history.

If an owned target exists and starting the task returns an error, its outcome
is uncertain even if cleanup succeeds: it may already have written files. The
handoff becomes terminal `interrupted` and does not try another backend. Poll
returns that state for inspection rather than reclassifying it as a missing
worker completion marker. Ownership
failures, cancellation and uncertain cleanup also stop fallback. Inspect status
and artifacts before explicitly deciding whether to resume.

tmux distinguishes failures before its worker launch from failures after
`respawn-pane` was requested. If no task launch was requested and the private
terminal was cleaned up, auto selection can continue to file. An uncertain
launch never uses that exception.

After inspecting an interrupted tmux record, explicit `handoff close --id ID`
can archive a confirmed absent session. It still terminates any fingerprint-bound
surviving child. A reachable resource must pass ownership validation. For an
uncertain auto-close claim, explicit close preserves the pane/process binding;
pending `scheduled`/`closing` claims and live replacements remain refused.

Recovery selects cmux when its discovery interfaces work, including an empty
catalog. Only an unavailable backend/transport causes auto selection to try
tmux. It does not switch backends after input starts, or on an ownership error.
Reports and pass events retain requested/selected backend and discovery attempts.

## Owned tmux Workers

tmux handoffs use a private socket, an owner token and a fixed pane ID. They do
not attach to or adopt unrelated user sessions. `record.socket`, `record.session`
and `record.surfaceRef` identify the created terminal; they can be used for a
manual `tmux -S SOCKET attach-session -t SESSION` after inspecting handoff status.

The worker supplies `OMHA_HANDOFF_ID`, `OMHA_HOME`, `OMHA_PROMPT_FILE`, `TMUX`
and `TMUX_PANE` to its child. Terminal identity values come from the managed
terminal, rather than an environment allowlist override. Ordinary credential
selection continues to use the existing environment allowlist; switching
terminal backends never switches to a headless provider.

The existing interactive worker is line-oriented and uses pipes to its child.
It is not a general full-screen TUI/PTY adapter. Native interactive launch,
provider-specific checkpoints and rich message receipts must not be inferred
from tmux's terminal capabilities. The current native cmux integration remains
the path for those verified session operations.

## Activity Integration

An authorized worker's provider integration can publish a structured signal:

```bash
omha handoff activity --input - <<'JSON'
{"agent":"codex","state":"idle"}
JSON
```

The ID defaults to `OMHA_HANDOFF_ID`; `--id ID` is also accepted. Supported agent
labels are `claude`, `codex`, `kimi`; states are `idle`, `working`, `waiting`,
`ended`. This command is intended for a provider event/hook integration, not for
an LLM to declare idle merely because it saw an error. Omha installs no hooks.
The signal is explicitly `caller-reported`, not a verified provider identity.

The host verifies terminal ownership, the exact calling pane/private socket,
live worker and child process fingerprints, and that the reporter descends from
the child. Completion cleanup additionally accepts the same owned pane after
its worker has exited and the pane is marked dead; a live replacement still
requires matching process fingerprints. Unrelated processes cannot report
activity just by supplying an ID.
Activity and its audit event are separate from the handoff state, so polling
cannot overwrite the signal. Activity never completes a task or grants writes.

Recovery requires an interactive worker and an idle signal at most one minute
past the larger of the configured watcher interval and 25 minutes, bound to the
same live processes. Each signal permits one submission and
is consumed durably before input. Missing, stale, waiting, working, ended or
consumed activity never authorizes input. Recheck the same activity before
Enter; a state change leaves pending input uncertain rather than submitting it.
A subsequent provider idle event can publish a new signal. Screen capture uses
only the current tmux viewport, not scrollback. See [recovery](auto-recover.md).

Offline tests cover backend preference, failure/ownership refusal, real tmux
activity, freshness, input, changed process bindings, and detached pane-only
auto-close. Real tmux tests skip when the executable is absent. No provider is
launched by the default tests.
