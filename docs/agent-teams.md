# Agent teams: mailboxes, claimable tasks, coordinator and dashboard

Omha's answer to Claude Code's experimental Agent Teams (coordinator mode) is
built from parts it already trusts: the agent registry, durable state under
the project directory, host-validated transitions and append-only events.
This document records the contracts. It is deliberately narrower than Claude
Code's feature: omha never gives an agent permission, and "coordinator" is a
proposal source, not an authority.

## Teams: membership, task list, mailboxes

A team binds registered agents into a named group with a shared task list and
one mailbox per member. State lives under
`<projectDir>/teams/<teamId>/`:

```
team.json     version 1 record: teamId, name, objective?, members, createdAt
tasks.json    version 1 shared task list
events.jsonl  append-only audit of every transition
inbox/<member>.jsonl  append-only mailbox per member
```

Contracts:

- **Membership comes from the registry.** `omha teams create --agents a,b`
  validates every member against `agents.json`; unknown names fail closed.
  `host` is an implicit sender (the CLI itself) and never has a mailbox.
- **Task lifecycle is host-recorded, claimant-bounded.** Tasks move
  `pending → claimed → completed | failed`. `claim` requires the task to be
  pending with every dependency completed (derived views expose
  `waiting`/`ready`/`blocked`). `complete` requires the caller to be the
  claiming agent (`ownership` error otherwise) and only records what the
  claimant reports — it is never treated as acceptance or correctness.
- **Mailboxes are bounded and tamper-evident.** Messages are capped in size
  and count, screened for credentials, written append-only with a content
  hash, and verified on read; a changed message fails closed with
  `corrupt_state`. Reads take a cursor (`--since MESSAGE_ID`) for incremental
  polls, mirroring how a worker checks its inbox between attempts.
- **Every transition is an event.** `team.created`, `task.added`,
  `task.claimed`, `task.completed`, `task.failed`, `message.created` land in
  `events.jsonl`, so a new process can reconstruct state the same way runs
  and handoffs already do.

Messages are data. A message never grants permission, never satisfies an
acceptance harness and never counts as a user request; workers that receive
one still go through the same host validation for anything they do.

## Coordinator: advisory only

`omha leader --coordinator PROFILE [--coordinator-max-consults N]` attaches a
validated tool-free, read-only profile between scheduling rounds. The host
sends a bounded snapshot (objective, per-task status, recent events) and the
coordinator may answer with three proposal fields:

| Field      | Host validation                                                 | Effect                                                                                           |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `order`    | ids must be a subset of the current ready set, no repeats       | reorders this round's launches; readiness, parallelism and write exclusion still gate everything |
| `messages` | target must be a pending task; content bounded, secret-screened | delivered as data-only worker messages (`sender: coordinator`) for the next attempt              |
| `abort`    | must be boolean                                                 | recorded as `coordinator.abort_requested` plus one stderr notification; nothing is cancelled     |

Invalid or malformed proposals are dropped per entry with a recorded reason;
a malformed response never touches the run. Each consult is appended as a
`coordinator.consulted` event with the served profile, applied actions and
drops. The coordinator cannot spend beyond the run's existing budget gates
(its dispatch goes through the same runtime), cannot start tasks the scheduler
would not, and cannot stop one. `--coordinator-max-consults 0` disables
consulting without changing the plan.

## Dashboard: `omha ui`

`omha ui [--host 127.0.0.1] [--port 7800] [--interval-ms 1000]
[--allow-actions]` serves a local HTML dashboard over the state directory:
runs with per-task DAG status, teams with derived task states and mailbox
depth, handoffs, decisions and reviews, and the agent registry. A change-fed
SSE stream (`/api/stream`) pushes redacted `projectStatus` snapshots.

Contracts:

- **Loopback by default.** The server binds `127.0.0.1` unless the operator
  passes an explicit `--host`. It reads state files only; it never launches a
  provider, so it never moves work across the scripted/interactive billing
  line.
- **Read-only by default.** POST endpoints answer `403 forbidden` unless the
  server was started with `--allow-actions`.
- **Actions reuse the CLI's own functions.** With `--allow-actions`, exactly
  two actions exist: `cancel_run` and `send_task_message`. Both call
  `cancelRun`/`sendTaskMessage` — the same host-validated functions the CLI
  uses — so the UI is never a second, weaker boundary. Request bodies are
  JSON, bounded at 64 KiB, and every field is validated before any state
  changes.
- **Live readiness stays with the CLI.** `needs_input` and screen diagnosis
  require capturing a live terminal; the dashboard shows durable handoff
  state, and `omha handoff report`/`wait-ready` remain the source for
  liveness classification.

## What was intentionally not copied

Claude Code's hook-exit-code quality gates are replaced by omha's host-enforced
acceptance, review and roundtable gates; its non-resumable in-process
teammates are replaced by durable events and `leader --resume`; and its
single-provider lockup is replaced by the registry's per-agent launch specs.
Teammates may be any registered CLI, not one vendor.
