# Progress

## Authorized optimization (2026-10-13)

- Restored existing planning records and verified clean main at 1a615ae.
- User authorized implementing the full analysis recommendations. Added nine
  bounded phases, each with offline verification, documentation and main push.
- Starting cross-run worktree admission; version remains 0.2.0-rc.2. No paid
  provider, publication or unrelated terminal operation is authorized or needed.
- Worktree admission now coordinates readers/writers across runs and independent
  provider gates. Queued cancellation/deadlines launch no providers; dead owners
  require fingerprint-checked worker cleanup. Focused tests pass 21/21 and full
  `npm run check` passes 102/102 offline tests. Next: fallback reviewer authority.
- Worktree coordination delivered as af4380a and pushed to main.
- Review now excludes the actual author attempt lineage before routing and
  validates served reviewer authority again. Failed/invalid reviews preserve
  execution state during replay. Focused tests pass 42/42; full check passes
  103/103, including both disclosed fallback paths and post-dispatch refusal.
- Review authority delivered as 4929172 and pushed to main.
- Stream framing failures now override valid completion JSON, retain the first
  parse failure, stay incomplete and never fall back. Full check passes 104/104
  with missing-newline, truncated, oversized-line and excess-event fixtures.
- Next: share the existing Arena fixed-harness observation with DAG acceptance;
  keep planner output unable to authorize tests or promote CLI success.
- Added bounded absolute host acceptance commands to plan tasks. Provider success
  is recorded as `executionOk`; acceptance runs afterward with filtered env,
  deadline/output bounds, hashes and no provider fallback. Failed acceptance
  blocks dependent tasks. Focused orchestration tests pass 19/19; full check is
  next before commit. Full check passes 105/105 after host acceptance integration;
  version remains 0.2.0-rc.2 and acceptance uses only local fixed commands.
- Leader now accepts validated task review blocks and plan decision blocks. High
  risk decisions run before tasks and persist `awaiting_decision` until the
  existing human approval command is followed by resume; failed reviews block
  dependents. Focused orchestration tests pass 21/21.
- Restored on 2026-10-16: phase 5 is delivered at 541affd. Phase 6 now reuses live
  provider summaries, records progress/escalation and retains request reservations
  across bounded read-only takeover. Supervised writes stay interrupted.
- Focused runtime/orchestration/supervision tests pass 52/52 after correcting a
  command JSONL fixture. Added cancellation and lease coverage for acceptance;
  the full task lifetime now remains under the task deadline/worktree admission.
- Phase 6 full check passes 114/114 offline tests, formatting and 44 syntax files.
  Preserve framing failures ahead of supervision failures; notification failure
  also leaves an uncertain supervised writer interrupted. Proceeding to phase 7.
- Phase 6 delivered at 1990150. Phase 7 adds bounded relevance selection, frozen
  source provenance and deterministic verified acceptance observations using the
  existing memory records and injection path. Focused initial check: 31/32; the
  sole failure was an incorrect short-topic cap assertion, now corrected.
- Phase 7 full check passes 118/118 offline tests and formatting/static validation.
  Verified provenance, next-run injection, failed/missing acceptance, review
  rejection, scope isolation, freshness, topic/byte/line caps and disable flags.
- Phase 7 delivered at 1c98eb5. Phase 8 adds status/watch and event-replayed
  metrics; benchmark improved the 20-run/2,000-event read from mean 248ms to 16ms
  by reusing identity within a call. Sources of truth remain files and logs.
- Phase 8 full check passes 121/121 offline tests. Unified status excludes payloads
  and unrelated handoffs; watch observes external append-only events, yields only
  changed snapshots and respects duration/cancellation. Starting final audit.
- Phase 8 delivered at fdda382. Final audit found planner authority and pending
  review restart gaps; added host policy binding and review-only recovery, plus
  immediate review/decision reservation events and durable decision cancellation.
- Host authority/recovery audit passes full check: 123/123 offline tests, including
  planner policy refusal and pending-review recovery without write replay. Next
  audit item is binding acceptance evidence to immutable harness/artifact hashes.
- Artifact binding focused check passes 15/15. It rejects provider-modified frozen
  harnesses, candidate-modifying checks, changed saved policy and unsupported/
  oversized artifacts using the existing collector; no raw candidate bytes persist.
- Artifact/harness binding passes full check: 128/128 offline tests and formatting/
  static validation. Acceptance checks executable and file arguments plus explicit
  harness dependencies, preserves artifact/policy digests and rejects self-modification.
- Final decision audit adds explicit successful/valid-chair gating: a majority
  tally alone cannot release downstream tasks after a failed/malformed chair.
- Decision gate focused suite passes 24/24 offline orchestration tests, including
  malformed/failed chair with majority and no downstream worker invocation.
- Canonical configuration/docs/installed-flow check passes 130/130 offline tests,
  48 syntax files and formatting. Node 20 passes 43/43 changed-lifecycle tests.
  Clean HOME pack check passes with 72 files, generated host-policy workflow,
  acceptance/review/memory/status/watch, API exports and uninstall verification.
  Remaining final audit: reset review approval when a new execution attempt starts,
  then rerun affected checks and verify clean main against origin/main.

## Concurrency and security hardening (2026-10-12)

- Restored planning context; starting commit cce12eb, no user changes.
- Baseline stress: 20 complete-suite repetitions plus focused repeats, with
  full per-run logs and exit codes under /private/tmp/omha-hardening-20261012.
- Local OS access is needed for ps fingerprints and executable sandbox fixtures,
  as documented by the previous hardening run.
- Two local-OS verification requests were not executed: automatic approval service
  returned HTTP 503 (no model channel). A third full-check request is pending.
- Reproduction evidence retained in slow-start-runtime/*.log, repro-before.log,
  escaped-secret-before.log and sandbox-full/01.log. The concurrent atomic-write
  experiment failed before repair; expected-hash CAS portion passed.
- Hardening fixes now pass `npm run check`: 89/89 offline tests, including the
  queue deadline, cross-process atomic replacement/CAS, JSON-escaped secret
  redaction, readiness-synchronized process cleanup and Open Arena paths.
- Updated security documentation and bilingual Unreleased changelog entries;
  version and public API remain unchanged. Hardening commit `18dd77a` is pushed
  to `origin/main`.
- Fixed storage zero-link race, provider queue late admission, and credential
  redaction/argv bypasses. Focused 32 tests pass; storage repeated 30/30 passes.
- `npm run format:check`, `npm run validate` and `git diff --check` pass. Full
  `npm run check` still reaches the known sandbox-only EPERM failures in strict
  executor and ps fingerprint tests; no code assertion failed in the focused set.

## Automatic group-decision trigger (2026-10-12)

- Added `assessRoundtableTrigger()` and `autoRoundtable()` with bounded host
  signals, conservative `signals_unavailable` triggering and no-provider no-op
  behavior below thresholds.
- Persisted validated trigger signals and thresholds in the decision record and
  exported the API from `index.mjs` and the orchestrator.
- Added offline tests for threshold boundaries, unknown fields, invalid ranges,
  no-trigger provider suppression and triggered evidence persistence.

## Profile capability model (2026-10-12)

- Added inferred and explicitly validated `interactive`, `headless`, `tool-free`
  and `read-only` profile capabilities, with schema, README and contract docs.
- Added host-side `requires` routing: incompatible profiles produce a routing
  attempt record, are never spawned, and compatible fallback candidates can run.
- Added offline tests for inferred tiers, impossible declarations, compatible
  routing and the all-incompatible fail-closed result.

## Structured provider event evidence (2026-10-12)

- Added `parseEvents()` and bounded `summarizeEvent()` output for JSON/JSONL
  adapters, including turn type, tool/file evidence, numeric usage and input-wait.
- Runtime results and `onProviderEvent` callbacks expose summaries while keeping
  raw provider payloads out of durable evidence; completion validation remains
  unchanged.
- Focused runtime tests pass 20/20; full `npm run check` passes 94/94 offline
  tests, 43 syntax files and all examples. Commit/push is the remaining phase.

## Automatic task review (2026-10-12)

- Added host-owned `reviewTask()` for completed successful DAG tasks. It freezes
  task output, diff, test evidence and criteria into a packet and runs an
  independent reviewer with required read-only/tool-free/headless capabilities.
- Approval is computed by the host only when every criterion is `pass`; failed,
  malformed and incomplete reviews persist as non-approved records and leave the
  task result unchanged.
- Focused orchestration tests pass 15/15, including self-review rejection,
  malformed reviewer output and provider configuration drift refusal.
- Final check for this phase passes: 95/95 offline tests, 43 syntax files and all
  examples validated. Version remains `0.2.0-rc.2`.

## Delivery verification (2026-10-12)

- `npm run pack:check` passed with a 71-file tarball, clean HOME install,
  examples executed and uninstall verified.
- `npx --yes node@20 --test tests/*.test.mjs` passed 95/95 offline tests.
- Main is clean and synchronized with origin at `ce7f770`; residual real-time
  escalation and ACP limits are recorded in `findings.md`.

## Competitor-informed realtime observation (2026-10-12)

- Three subagents independently compared the active high-star projects; the
  detailed evidence and selection are in `docs/research.md`.
- Added an opt-in bounded JSONL framer and runner integration for live Codex/Kimi
  event summaries. The callback carries `realtime: true`; the result records
  stream requested/supported/delivered/complete state.
- Added offline coverage for chunk framing, callback-before-completion behavior,
  incomplete/oversized streams and callback-triggered process cancellation.
- Focused runtime check passes 23/23. `npm run check` passes 98/98 offline tests;
  Node 20 passes 98/98, and `npm run pack:check` verifies the 71-file package,
  clean HOME examples and uninstall.
- Capability phase check passed: `npm run check` reports 93/93 offline tests,
  43 syntax files and all examples validated. Version remains `0.2.0-rc.2`.

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
