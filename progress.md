# Progress

## Hardening audit (2026-10-12)

- Read AGENTS.md, README.md, docs/contracts.md, worker, terminal reader and tests.
- Restored existing planning records and added the authorized hardening phases.
- Priority 1 underway: real worker completion-file and stdout reader coverage.
- Real worker integration and all handoff tests pass (9 assertions/subtests).
- First full check: 72/74 pass; sandbox blocks the strict executor (EPERM) and
  process fingerprints (ps). Re-run the same full check with local OS access.
- Completion: handoff paths/final states, tmux/cmux ownership strings, memory
  topic extension and index layout, and task result references now have single
  definitions; malformed output reports its documented failure kind; incomplete
  usage reports retain budget reservations. Full check passes 83/83.

## GitHub delivery (2026-10-10)

- User authorized committing and pushing the implementation to GitHub.
- Initial gh account cache reported HuaTalk; the GitHub API confirms the current
  username is monadrome. The old username returned HTTP 404.
- Retaining candidate version 0.2.0-rc.1 and adding bilingual changelogs.
- Final checks passed: 50 offline tests, format/static/skill validation and
  tarball install, direct CLI/examples/API execution and uninstall.
- Commits record runtime implementation, skill/license contracts,
  documentation/CI and verified GitHub namespace metadata.
- Created the public repository https://github.com/monadrome/omha and pushed
  main to origin with upstream tracking (2026-10-10).

## Production implementation session (2026-10-09)

- Read all scaffold modules, CLI, five tests, skill contracts, manifests and docs.
- Confirmed clean starting worktree and no applicable AGENTS.md.
- Restored planning files with planning-with-files; no unsynced catchup reported.
- Phase 1 in progress. Earlier completion statements below describe MVP evidence
  only and are superseded by this implementation's acceptance gates.
- Phase 1 implemented: strict provider/profile checks, completion-aware adapters,
  separate failure classes, Retry-After/backoff, persistent circuit/concurrency
  gates, budget reservations, environment filtering and redacted metadata.
- `node --test tests/runtime.test.mjs`: 11/11 pass. Process fixtures confirm
  cancellation/timeout kill TERM-ignoring grandchildren. No metered calls used.
- Phase 2 started: durable task events, validated DAG and isolated blind votes.
- Tooling: an initial patch tried delete/add of the same path in one operation;
  apply_patch rejected it without changes. Subsequent patches use separate edits.
- Phase 2 implemented. Combined runtime/orchestration suite: 20/20 pass.
  Full suite initially had one legacy test expecting no retries; it now sets
  maxRetries:0 explicitly to preserve the intended immediate-fallback case.
- Phase 3 started: persisted ownership, private backend targets and worker
  completion files; no existing user terminal will be reused or closed.
- Handoff fake/file lifecycle suite: 5/5 pass.
- Scoped memory suite initially passed 9/9; broader concurrent full-suite load
  exposed a real lock race, now fixed and pending repeat verification.
- Butterfly chronological evidence wrapper implemented. A sensitive-history test
  found placeholder re-redaction; fixed to make redaction idempotent.
- Complete offline suite after fixes: 44/44 pass.
- Real tmux and cmux probes now pass detached printf and 2068-byte paste + Enter.
  cmux before/after workspace UUID sets match; all created targets were closed.
  Real-probe failures drove corrections for tmux option targets, canonical input
  truncation, cmux JSON creation and launch sequencing. No model calls used.
- Phase 4 implemented; phase 5 underway (schemas, examples, package API, bilingual
  docs and CI). Candidate version is 0.2.0-rc.1 across npm/plugin/marketplace.
- Added 3 host-crash/concurrency/event-log integration tests and exercised them
  under Node 20.20.2. Added runtime fingerprinting so recycled PIDs do not keep
  stale provider leases. Added external sandbox wrapper contract and Kimi/command
  read-only enforcement. The final rerun below supersedes the earlier interim
  status.

## Final release-candidate verification (2026-10-09)

- Added host SIGKILL/resume, cross-process provider concurrency, torn JSONL,
  automatic cmux/tmux-to-file degradation, sandbox wrapper, stale memory index,
  exact Retry-After JSON headers, and direct installed-bin checks.
- `npm run check` passed: 50 tests plus static syntax/skill/example validation.
- Node 20.20.2 `--test tests/*.test.mjs` passed all 50 tests.
- `npm run pack:check` passed: clean HOME install, direct `omha` launcher,
  public API, examples, and uninstall.
- Strict Claude marketplace validation passed.
- Real tmux/cmux probe passed detached printf, long paste + separate Enter, and
  pre-existing cmux workspace preservation. Probe-created resources were closed.
- Remaining documented limits: native process-group guarantees degrade on
  Windows; Kimi read-only/tool-free use requires an external sandbox wrapper;
  full-screen TUIs are outside the line-oriented handoff input mode; no actual
  conversation rewind is performed.
- Final security check rejects credential argv pairs such as `--api-key secret`
  and the complete Node 26/Node 20 check remains green after that change.
- Follow-up requested cmux compatibility behavior is implemented and tested:
  protocol failure is bounded, diagnosed, and degraded to file; tmux remains the
  hard terminal gate. Documentation now describes this release policy.

- 2026-10-09: Completed repository/CLI/license research with three parallel
  read-only subagents.
- 2026-10-09: Created Omha plugin manifests and migrated butterfly/hide
  skill contracts and references.
- 2026-10-09: Implemented memory identity/index/locking, provider adapters and
  rate-limit fallback, leader and blind roundtable, auto-butterfly hash
  wrapper, and cmux/tmux/file handoff.
- 2026-10-09: Added 5 offline tests; all pass. Strict plugin validation and npm
  dry-run pass.
- 2026-10-09: Installed with `install.sh`, added the local marketplace, and
  installed/enabled `omha@omha` in Claude. Plugin details report 7
  skills. A temporary npm tarball install and CLI doctor passed.
- 2026-10-09: Real tmux and cmux detached probes passed; each probe used a
  unique resource, read its output, and confirmed no probe session remained.
