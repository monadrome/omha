# Changelog

## Unreleased

### Fixes

- Wait for durable worker ownership before SIGKILL recovery assertions, avoiding
  a readiness race when the child starts before the host finishes recording it.

### Features

- Default Session Fork `warmFirst` on for three or more branches and record the
  effective scheduling mode on the tree creation event. Upgrade root cache
  evidence to `write-reported` with a persisted epoch only when the warm branch
  usage reports a positive provider cache write; status and resume verify that
  record against its event digest. Cover mixed-route rejection, the 9-branch
  bound and tampered suffix evidence with fail-closed tests.

- Add owned native cmux Claude/Codex historical forks, checkpoint discovery,
  structured messages and successor-confirmed source-surface retirement. Bind
  auto-butterfly actions to real host-selected checkpoints, retain source launch
  permissions/billing, and persist bounded claims without uncertain replay.

- Add Session Fork v1 as a 2-8 lane projection of Open Arena, with sealed
  prefix/suffix evidence, deterministic observable names, full reservation
  gates, optional warm-first ordering and `fork` lifecycle commands. Normalize
  raw Anthropic, OpenAI-compatible, DeepSeek and Kimi cache usage without
  inferring hits from prefix equality.

- Automatically observe Leader write tasks with frozen acceptance evidence,
  detect supported rework without manual history JSON, and prepare bounded file
  handoffs with durable claims, explicit host provenance and restart deduplication.
  Preserve write replay gates and expose report, handoff and uncertainty metrics.

- Make the CLI and Claude Code plugin entry points explicit, with actionable
  prompt skills that keep uncertain work in the current agent session.
- Verify packed plugin installation and skill discovery in an isolated Claude
  config directory when the CLI is available, without model calls.

- Add consolidated project status, bounded JSONL watching and event-derived
  outcome metrics; reuse project identity and memory index reads within a read.

- Feed verified host acceptance observations into scoped worktree memory and
  select relevant fresh topics for the next immutable run with hashes and caps.

- Supervise live progress and input waits with bounded escalation notifications
  and read-only fallback takeover; uncertain writes remain interrupted.
- Keep task deadlines, cancellation and worktree exclusion active through host
  acceptance and independent review, and record owned acceptance workers.

- Connect plan-level roundtable gates and task-level independent reviews to the
  Leader lifecycle; durable decisions block execution until approval and failed
  reviews block dependent tasks without rewriting execution results.

- Add bounded host acceptance commands to DAG tasks, recording execution and
  acceptance separately and blocking dependencies on failed acceptance.

- Import frozen Open Arena knowledge and reference packages with authority,
  evidence, semantic-review provenance and original/sanitized hashes.
- Run separately authorized two-implementation Git/POSIX batches using independent
  bundle clones, one attempt per lane, a shared durable admission ledger, complete
  artifacts, fixed host verification and report-only recovery/review.
- Add external write wrapper policies with strict capability/probe refusal and
  offline acceptance coverage. Existing leader write exclusion remains intact.

### Fixes

- Invalidate previous review approval at each new task execution so restart cannot
  reuse an approval belonging to an earlier attempt.

- Restrict automatic provider configuration discovery to `providers.json`, keeping
  one canonical naming contract and removing legacy filename fallback.

- Keep automatic decision gates closed when the chair fails or returns an invalid
  synthesis, even when the independent host tally has a majority.

- Bind DAG acceptance to frozen harness hashes and bounded artifact snapshots;
  changed harnesses or candidates cannot pass or seed verified run memory.

- Reject planner-supplied host policies, resume pending independent reviews without
  replaying completed writes, and persist review/decision reservations immediately.

- Reject incomplete or oversized realtime streams even when accumulated provider
  output contains valid completion JSON; preserve parse failures without fallback.

- Enforce review independence using actual author attempts, exclude authors from
  implicit reviewer fallbacks before launch, and record served reviewer provenance.
- Keep failed/invalid review events from overwriting the reviewed task's execution
  status during event replay.

- Coordinate shared-worktree reads and writes across independent runs/processes,
  with bounded cancellable admission and owned-worker cleanup after host loss.

- Enforce provider queue deadlines before admitting a newly released lease and
  keep the remaining wait bounded by the request timeout.
- Make concurrent atomic replacement tolerant of transient zero-link filesystem
  stats while continuing to reject actual hardlinks.
- Redact allowlisted secrets in both literal and JSON-escaped provider output,
  and reject credential flags supplied with inline values.
- Stabilize process supervision fixtures with an explicit child readiness signal
  so timeout and cancellation tests exercise group cleanup rather than startup
  timing.
- Add host-owned automatic roundtable triggers for risk, ambiguity and write
  magnitude, with no-provider no-trigger results and persisted trigger evidence.
- Add validated profile capability tiers and `requires` routing so incompatible
  profiles are recorded and skipped before provider launch.
- Expose bounded structured provider event summaries and input-wait signals via
  the runtime callback/result envelope without persisting raw payloads.
- Add opt-in bounded realtime JSONL event framing for Codex/Kimi, with fail-closed
  incomplete/oversized streams and callback failures routed through process cleanup.
- Add independent `reviewTask()` records with frozen diff/test evidence,
  criterion coverage checks and host-owned approval; self-review and malformed
  reviews fail closed without changing task results.

## 0.2.0-rc.1 - 2026-10-10

### Features

- Add validated Claude, Codex, Kimi, command and fake provider profiles with
  failure classification, bounded retries, circuits, concurrency, budgets and
  process-group supervision.
- Execute validated task DAGs with durable events, dependency results, worker
  messages, cancellation and restart recovery. Interrupted writes require an
  explicit replay decision.
- Collect blind roundtable proposals with evidence validation, majority or
  weighted decisions, minority reasons and optional human gates.
- Manage owned cmux, private tmux and file handoffs through capture, polling,
  completion, send, resume, cancel and close operations.
- Diagnose artifact drift using explicit chronological production, feedback and
  rework evidence. Return supported rewind advice without changing conversations.
- Maintain scoped Markdown memory with deterministic capped indexes, freshness
  warnings, conflict checks and concurrent-writer protection.

### Fixes

- Reject malformed configuration and incomplete provider output instead of
  treating them as success or silently falling back.
- Clean up child process groups on timeout and cancellation, recover torn event
  logs, and protect storage against path, symlink and hardlink attacks.
- Record bounded cmux protocol diagnostics and verify file fallback when the
  installed RPC version is incompatible.

### Documentation and Validation

- Add bilingual installation, lifecycle and security documentation, versioned
  schemas, executable offline examples, contribution and release instructions.
- Preserve upstream MIT license texts for butterfly-effect and hide.
- Add offline failure-injection tests, Node 20 coverage, manifest and skill
  validation, clean tarball installation checks and owned terminal probes.

### Compatibility

- Version 1 provider configuration, plans and butterfly history replace the MVP
  input contracts. See `docs/contracts.md` and `examples/`.
- Native provider supervision requires POSIX. Windows supports fake providers,
  memory and file handoffs. Kimi read-only execution requires an external sandbox;
  tool-free planning and voting remain unsupported for Kimi.
- Interactive handoffs support line-oriented programs; full-screen TUIs require
  a host-native integration. Budget reservations cannot guarantee provider bills.
