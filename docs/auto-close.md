# Completed Session Auto-Close

Use `omha auto-close` as the final completion hook of a native cmux Claude/Codex
task or a live Omha-owned tmux worker, after a goal and its checks finish:

```bash
omha auto-close --completed --reason 'Goal completed; acceptance checks passed'
```

Run it inside the task's original cmux surface and worktree. It registers or
reuses the existing native handoff, persists an explicit completion and schedules
an independent closer. After 1.5 seconds, the closer rechecks ownership and native
session identity, then closes only that surface. Other tabs and splits in the
workspace stay open. cmux may remove a workspace when its last surface closes.
No provider is launched and the billing channel is unchanged.

For a task executed through Omha Leader, bind the host run:

```bash
omha auto-close --completed --run-id RUN_ID --reason 'Host run completed'
```

The run must belong to the same worktree and have completed every configured
acceptance, independent review and decision gate. The closer checks those gates
again and refuses closure if the bound evidence changes. Without `--run-id`, the
record says `caller-reported`; the caller must finish and verify its goal first.
An exit code, idle screen, ordinary reply or Stop event does not establish that
the goal is complete. This command does not inspect or certify a provider's
internal `/goal` state.

The Claude Code plugin exposes `/omha:auto-close` for retaining this cleanup
intent until the active task finishes. Prompt-only use still works without the
CLI, but cannot close a tab. No unconditional completion hooks or watchers are
installed. A provider-specific goal-complete hook can invoke the same command
when its completion contract is known; generic turn-complete payloads are refused.
Persist the final result and evidence before invoking it, because the current
agent is terminated when its tab closes.

Options: `--id HANDOFF_ID` selects an already registered calling session;
`--delay-ms N` adjusts the bounded grace period (100-10000 ms, default 1500).
The command refuses another caller, another worktree, missing native binding,
changed ownership/session, unaccepted forks and unresolved source retirement.
Only a completed owned surface uses cmux's `--force` close flag. The existing
active-session cancel/self-retirement checks remain in force.

Inspect the returned handoff ID from a surviving terminal:

```bash
omha handoff status --id HANDOFF_ID
```

`autoClose.state` is `scheduled`, `closing`, `closed` or `uncertain`. A scheduled
response confirms admission, not successful closure. The append-only handoff log
records `auto_close.requested`, `auto_close.closing`, `auto_close.closed` or
`auto_close.uncertain`. The detached process records its own close outcome even
after the task terminal disappears. Repeated identical requests reuse one claim;
failed, crashed or ambiguous close attempts never replay automatically. A crash
can leave `scheduled` or `closing`; inspect the native resource before manually
closing it. A worker more than ten seconds past its deadline cannot close a tab.
For tmux, after inspecting an `uncertain` claim, `omha handoff close --id ID`
explicitly resolves cleanup: a confirmed absent session can be archived, while
a reachable pane still requires unchanged ownership and process binding. This
never replays the close automatically and cannot close a replacement process.
Inside an Omha-owned tmux worker, the same command selects the calling handoff
from `OMHA_HANDOFF_ID`. It verifies the private socket and fixed pane ID. The
detached worker rechecks those bindings and host evidence before terminating a
still-live child process group and closing only that pane. If the owned pane is
already dead after the worker completed, the pane identity and owner token still
authorize removing that dead pane. Other panes stay open. A live changed worker
makes closure uncertain; it does not authorize closing a replacement process.
Unregistered user tmux sessions, file handoffs and headless providers cannot use
this hook. No cmux native binding is fabricated for a tmux worker. See
[terminal backends](terminal-backends.md) for capabilities and activity signals.

Offline verification: `tests/auto-close.test.mjs` exercises the real command and
detached worker against a local cmux fixture. `npm run pack:check` verifies the
installed command, worker, API export and plugin skill without paid model calls.
