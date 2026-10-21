# Omha Contracts

Open Arena knowledge import and the separately authorized multi-implementation
batch have an additive version 1 contract described in
[Open Arena Content and Independent Implementations](open-arena.md).
`validateArenaSpec()` and the knowledge importer validate those records. They
preserve the existing string public-context and leader write-exclusion contracts.

Session Fork v1 is the stricter 2-8 lane projection documented in
[Session Fork v1](session-fork.md). `omha fork create|run` atomically seals and
executes a tree through `runArena()`; `status`, `tree`, `cancel` and report-only
`resume` use the same records. All children must use the same adapter invocation
shape and requested model, and shared/per-profile budgets must reserve every
child before any launch. `warmFirst` may serialize the first existing child but
cannot add an unbudgeted request; it defaults on for three or more children and
records the effective mode on the creation event. Names, roles, workspaces and instructions are
suffix-only. Status verifies the sealed root and immutable node events against
the exact `context.md` and suffix bytes.

Provider usage retains `raw` fields and adds normalized input/output/total and
cache creation/read/miss token counts. Positive read is `hit`, explicit zero is
`miss`, and missing evidence is `unknown`. Prefix equality is never cache proof;
unknown/interrupted usage keeps its reservation.

All JSON inputs use version `1` and reject unknown fields. Paths are resolved
relative to the supplied working directory, while durable state is under
`OMHA_HOME`.

Provider configuration is `schemas/providers.schema.json`. A profile names an
adapter (`claude`, `codex`, `kimi`, `command`, or `fake`), executable, model,
effort, sandbox, timeout, concurrency, budgets, environment allowlist, retry
policy, circuit cooldown, fallback profiles and capability tiers. Capabilities
are `interactive`, `headless`, `tool-free` and `read-only`; known adapters and
sandbox settings infer the enforceable subset, while unsupported declarations
fail validation. A dispatch request can set `requires` to route only to profiles
that satisfy those host-checked capabilities. `sandboxCommand` and
`sandboxArgs` can wrap an adapter in an external read-only sandbox; Kimi
read-only profiles require them. `fake.responses` is for tests only. A provider
response is successful only when the adapter parser sees a
completed result with nonempty text. Claude JSON, Codex JSONL and Kimi JSONL are
accepted according to their observed CLI event shapes; unrecognized or partial
events fail with `malformed_output`.

Structured results also expose bounded event summaries through the runtime result
and `onProviderEvent`. Each summary preserves the adapter event type, request/model
provenance, tool name, changed file paths, numeric usage and an `inputWait` flag;
raw provider payloads are not copied into the summary. Event parsing is evidence
only: a successful exit still requires the adapter's completed nonempty result,
and an event stream never replaces host acceptance checks.

Pass `streamEvents: true` to `dispatch()` or `ProviderRuntime.attempt()` to receive
the same redacted summary envelope while a real Codex or Kimi JSONL process is
still running. Each streamed callback has `realtime: true` and a zero-based
sequence. The host bounds each line to 512 KiB, the incomplete buffer to 1 MiB,
and a request to 4,096 events; malformed or incomplete frames fail closed and
the existing process-group cleanup path runs. The option is opt-in and does not
change Claude's JSON invocation, provider billing channel, completion validation,
retry policy or budget settlement. `result.stream` records whether streaming was
requested, supported, delivered and complete. A stream callback may be
synchronous or return a promise; a rejected callback is a host task failure.
Framing failure is authoritative even if the accumulated JSON can otherwise be
parsed as a completed result. A missing final newline, oversized frame or excess
event count yields `malformed_output`, retains its reservation, and never triggers
fallback. Host callback failures remain distinct from framing failures.

Dispatch and plans can set `supervision: {stallMs, inputWaitMs, maxTakeovers}`.
The two deadlines are milliseconds (0 disables that deadline); takeovers are
bounded to 0-3, default 0. Supervision automatically requests the existing live
JSONL channel where supported. A progress summary refreshes the silence deadline;
an input-wait summary starts its separate deadline until progress resumes. Other
adapters retain silence/deadline supervision without claiming live input detection.
Monitoring ends at process exit, before bounded process-group cleanup.

Each escalation aborts only that provider attempt, retains its reservation and
records `request.stalled`/`request.input_wait`. Read-only requests may continue to
an existing configured fallback within the takeover limit; write requests never
take over. Leader persists `task.progress`, `task.input_wait`, `task.escalated`
and `task.takeover` evidence. `onNotification` receives escalation metadata; the
CLI writes it as JSONL to stderr. Notification failures stop routing. Supervised
writes become `interrupted` and require explicit interrupted-write replay approval.
The task deadline, cancellation and worktree lease cover execution, acceptance
and review together, including cancellation of local acceptance process groups.

`reviewTask()` reviews only a completed successful DAG task. The host freezes the
task output hash, diff, test evidence and criteria in a packet, requires a
different reviewer profile with `headless`, `tool-free` and `read-only`
capabilities, and computes approval only when every criterion is reported as
`pass`. Failed, malformed or incomplete reviews are persisted as non-approved;
the task result and write state are never changed by review.

Reviewer independence follows actual execution: the planned author, served author
and all author attempt profiles are excluded from the full reviewer fallback
route before admission. Excluded candidates record an `authority` routing failure
and consume no reservation. Review acceptance checks the served reviewer again.
Packets retain requested/served author and reviewer provenance. Runtime callers
can supply `excludeProfiles` for the same host-owned routing restriction.

The result envelope has these fields when available:

```json
{
  "ok": true,
  "requestedProvider": "planner",
  "servedProvider": "planner",
  "requestedModel": "haiku",
  "servedModel": "haiku",
  "requestedProfile": "planner",
  "servedProfile": "planner",
  "attempts": [],
  "requestId": "provider-or-local-id",
  "latencyMs": 12,
  "code": 0,
  "signal": null,
  "responseHash": "sha256",
  "failureStage": null
}
```

Failure kinds are `rate_limit`, `capacity`, `auth`, `timeout`, `transport`,
`spawn`, `configuration`, `cancellation`, `task`, `malformed_output`, `budget`,
`circuit_open`, and `backend`. Only the retryable capacity classes are eligible
for fallback. `configuration`, `task`, `auth`, malformed output, and budget
failures stop the route.

Plans use [schemas/plan.schema.json](../schemas/plan.schema.json). The host checks
the DAG, profile and fallback names, dependency cycles, timeout/retry limits,
write authorization and write ordering. The planner is untrusted input; it never
executes a tool. Events are append-only JSONL and task results are separate JSON
references. The immutable context file is written once and its hash is checked on
resume. Dependency outputs and worker messages are references, not dynamic public
prefix content.

Generated planner output cannot set `acceptance`, `review`, `decision`,
`supervision` or `memory`; those fields are rejected before any worker starts.
For generated plans, `leader(..., {policy})` / `leader --policy host-policy.json`
binds host-owned global policy and `tasks: {taskId: {acceptance, review}}` after
planning. A supplied `--plan` is itself a host execution specification. The bound
policy is frozen with the run; prompts cannot create or replace host permission.
Pending reviews resume independently of completed execution, including completed
writes, and dependencies wait for approval. Review/decision request reservations
are appended as they occur so interrupted lifecycle work retains its charged budget.

A plan may include a host-owned `decision` block with bounded risk, ambiguity and
write signals, thresholds, evidence anchors, two or three voters, an optional
chair, voting method and human gate. Below threshold, the plan records a no-op
trigger and launches no provider. When triggered, the existing blind roundtable
runs before any task; a split, abstention, failed chair or pending human gate
leaves the run in `awaiting_decision`. `decision approve` followed by resume is
required before execution continues. The decision id, trigger, tally and gate
state are durable run evidence and use the same runtime budget.

Tasks may declare a host `acceptance` command with an absolute executable, fixed
arguments, timeout, output cap and optional `harnessFiles`. The host freezes
executable/file-argument hashes plus declared harness dependencies when creating
the run, checks them before and after acceptance, and binds the outcome to a
metadata-only artifact snapshot. `harnessFiles` must list imported check resources
that are not direct file arguments. Changed harnesses, unsupported artifacts,
snapshot-limit failures or candidate changes during acceptance cannot pass.
Git snapshots cover tracked and untracked nonignored files; non-Git snapshots
cover regular worktree files, with the state directory excluded. Existing Arena
collector limits apply (4,096 files, one MiB/file, eight MiB total); raw artifact
contents are not persisted by DAG acceptance. It runs after provider execution with a
filtered environment and is recorded separately from the provider result. A
provider can therefore finish successfully while host acceptance fails; the task
is then ineligible for dependent tasks. Acceptance exit status is evidence only,
not a correctness proof, and acceptance output is persisted only as bounded hashes
and sizes. Acceptance never invokes a model or fallback route.

Tasks may also declare `review` with a reviewer profile, frozen diff, test
evidence and criteria. The host performs that independent review immediately
after execution and before releasing dependent tasks. A rejection keeps the task
execution result intact, records `reviewApproved:false`, and makes the run fail
while dependent tasks remain blocked.

Runs under the same state directory coordinate task admission by canonical
worktree identity. Readers can share a worktree lease; a writer excludes all
other readers/writers, including tasks in other runs and CLI processes. Waiting
counts toward the task deadline and cancellation removes queued admission without
launching a provider. Different worktrees remain independent. Dead host leases
are recovered only after fingerprint-checked cleanup of recorded workers; live
leases are never expired by age.

`projectStatus(cwd)` / `omha status` consolidate project runs, decision gates,
owned handoff records and outcome metrics without starting providers or probing
terminals. `runStatus()` derives current task execution, acceptance, review,
last progress and escalation state from the append-only log. Metrics distinguish
completed tasks from accepted tasks, review approval/rejection, worker attempts,
failures, retries, profile transitions, takeovers, escalations, recorded lessons
and summed worker-provider latency. Budget totals include the complete lifecycle;
worker attempt metrics count worker dispatch events only. Historical events that
lack acceptance fields remain unknown rather than becoming accepted.

`watchStatus(cwd, {intervalMs, durationMs, signal})` yields changed snapshots only.
`omha status --watch --wait-ms 30000 --interval-ms 1000` emits one JSON object per
line, runs for a bounded duration (default 30 seconds) and stops on SIGINT/SIGTERM.
Each poll rereads authoritative state; no durable cache can hide external updates.
Run listing reuses one project identity within the read, and memory status/injection
reuse one validated scope/index instead of resolving and reading it repeatedly.

Roundtable voters return [schemas/proposal.schema.json](../schemas/proposal.schema.json).
An evidence item must quote the supplied public anchor exactly. `abstention:true`
requires `recommendation:null`; every non-abstention needs at least one anchor.
The host tally is majority or weighted-over-half. A chair runs after blind
collection and cannot alter the tally. A decision record includes every vote,
provider metadata, response hash, latency, invalid reasons, minority reasons and
optional human gate.

`autoRoundtable()` adds a host-owned trigger around that same protocol. It accepts
bounded `risk` and `ambiguity` scores in `[0,1]`, plus `writeFiles` and `writeBytes`
counts. The defaults trigger at `risk >= 0.7`, `ambiguity >= 0.5`, ten files or
one MiB. A missing signal set triggers with `signals_unavailable`; otherwise a
below-threshold assessment creates no decision and launches no provider. Trigger
signals and thresholds are persisted with the decision, so an automatic launch
has the same evidence trail as a manual one.

Butterfly input uses [schemas/history.schema.json](../schemas/history.schema.json).
The transcript is strictly chronological. A supported drift requires a previous
agent-produced version, later authoritative feedback tied to requirements that existed
before it, a changed replacement version, and a visible causal action. No-op
results are explicit and carry an evidence gap. `conversationRewound` is always
`false` because the wrapper only produces advice.

Leader automatically records `butterfly.observed` events for write tasks with
host acceptance. The default host `butterfly` policy enables observation and file
handoff, with `maxHandoffs:3` (0-3) and `maxObservations:256` (1-1000) per run.
`enabled:false` disables the lifecycle; `handoff:false` retains advice only.
`backend` accepts `file` (default), `auto`, `cmux` or `tmux`. Generated planners
cannot set this policy; bind it using the host policy file. Resume retains it.
Host history events have `actor:host` and explicit `authority` with
`source:acceptance`, the frozen `policyHash`, and for feedback/acceptance the
matching `artifactHash` and `exitCode`. Only complete, unchanged-harness,
unchanged-candidate checks qualify; failed execution, timeout and cancellation
remain evidence gaps. Consecutive attempts must preserve the prior candidate
before writing, and a produced version must show an actual artifact change.
Detection emits `butterfly.detected` with origin-linked advice. A durable
`butterfly.handoff_requested` claim precedes the existing owned handoff API;
missing completion remains uncertain and is never automatically repeated.
Neither detection nor handoff alters task, review or decision outcomes or
replays writes. See [automatic butterfly](automatic-butterfly.md) for examples,
observability and limits.

Native historical continuation uses [schemas/fork.schema.json](../schemas/fork.schema.json)
and [the cmux fork contract](cmux-fork.md). `handoff adopt` registers the calling
Claude/Codex surface; `checkpoints`, `fork`, `message` and `accept` retain exact
native history, ownership and receipt evidence. `auto-butterfly --fork` requires
an exact detector `actionId` binding and host write authorization. Leader host
`butterfly.forks` maps task IDs to those same bindings and only launches after
all configured run gates pass. Native sessions preserve their source arguments
and terminal billing channel. A queued message is not a takeover; successor
identity and prompt hash authorize optional source-surface closure. Uncertain
fork/close claims never replay automatically, and file restoration is not implied.

`auto-close --completed --reason TEXT` is an explicit completion hook for the
calling native cmux surface. It persists caller-reported completion, or binds
verified host gates with `--run-id RUN_ID`, then detaches a bounded close worker.
The worker rechecks the same session, ownership and run evidence before closing
only that surface. Duplicate requests reuse their claim; uncertain requests are
never replayed. See the [auto-close contract](auto-close.md).

Memory topic frontmatter is parsed as YAML and validated by `lib/memory.mjs`.
Leader automatically selects relevant active, fresh `worktree`/`project` topics
for its immutable context. `plan.memory` controls `read`, `write`, `scopes`,
`maxTopics` (default 4), `maxBytes` (8000), `maxLines` (100) and `ttlDays` (30).
Private user/session/role scopes are never selected automatically. Selection
uses word overlap with the objective, deterministic ordering and whole-topic
caps; it excludes stale records and records selected topic hashes/provenance in
`run.created.memory`. Resume reuses that frozen context rather than rereading it.

After host acceptance and any configured review pass, Leader records a bounded
worktree procedure describing the observed acceptance recipe and its run/task,
result digest, response hash and served profile. Provider output, prompts and
transcripts are never copied into the observation. A reservation, exit status or
unreviewed model claim alone cannot create a verified lesson. These are historical
observations to revalidate, not proof about the next artifact. Conflicting writes
and sensitive records are rejected with `memory.rejected` evidence. Set both
memory flags to false to disable the lifecycle integration. Explicit memory CLI
injection retains its requested-topic and private-opt-in behavior.

`MEMORY.md` is an index; topic Markdown is the source of truth. Handoff records
use an owner token, full backend reference and a final marker with the same token.
The final state is successful only for exit code `0` and a valid marker.
