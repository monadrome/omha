# Changelog

## Unreleased

### Features

- Import frozen Open Arena knowledge and reference packages with authority,
  evidence, semantic-review provenance and original/sanitized hashes.
- Run separately authorized two-implementation Git/POSIX batches using independent
  bundle clones, one attempt per lane, a shared durable admission ledger, complete
  artifacts, fixed host verification and report-only recovery/review.
- Add external write wrapper policies with strict capability/probe refusal and
  offline acceptance coverage. Existing leader write exclusion remains intact.

### Fixes

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
