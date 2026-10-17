# Omha release candidate implementation

## cmux butterfly continuation (2026-10-17)

Objective: support owned cmux session forks at an explicit historical checkpoint
or turn, structured continuation messages and successor-confirmed self-close,
connected to auto-butterfly-effect without weakening evidence or ownership gates.

- [complete] 1. Verify installed cmux fork/vault/message contracts and inspect
  existing terminal, butterfly, worker and CLI lifecycle boundaries.
- [complete] 2. Extend the existing handoff/backend path with validated historical
  fork, durable outcomes, messaging and safe source close; bind butterfly actions
  to explicit host-owned history locations rather than fabricated turn numbers.
- [complete] 3. Add offline success/failure/recovery coverage and update skills,
  contracts, examples and bilingual changelogs.
- [complete] 4. Run appropriate checks and installed CLI verification, review the
  final diff, commit task files and push main without version or release changes.

Acceptance: fork targets an exact validated history location; terminal billing
is retained; source and successor ownership are checked before messaging/close;
failure never closes the source; action claims survive restarts without replay;
no paid model calls or changes to unrelated user terminals during verification.

Verification: full offline check 150/150, final native protocol/cleanup/Leader
regressions 3/3, formatting and 51 syntax files, installed 77-file package with
native adopt/fork/message/accept plus plugin discovery and uninstall. Real cmux
read-only probing verifies the native source binding and checkpoint timeline.
Feature commit 7e6d023 was pushed directly to origin/main with an ordinary push.
No version bump, tag or package publication was performed. Final documentation
records the completed delivery and all verification evidence.

Error: the first planning patch used an incorrect progress heading and was
rejected atomically. Read the actual heading and reapplied the patch.
HTTPS cloning of the cmux reference timed out; SSH cloning succeeded. First
native-fork tests found that a pre-created empty target directory broke strict
handoff enumeration. Defer target creation until validation and admission pass.
One final test patch missed Prettier's line wrapping and was rejected atomically;
reread the formatted context before applying the failure-path additions.

## Automatic butterfly lifecycle (2026-10-17)

Objective: optimize Omha with automatic butterfly-effect observation, evidence
gating and bounded handoff through the existing execution lifecycle. Preserve
host authority, billing channels, replay authorization and offline guarantees.

- [complete] 1. Inspect lifecycle and butterfly contracts; define immutable
  host observation policy using existing acceptance and artifact evidence.
- [complete] 2. Subscribe to durable lifecycle events, detect supported rework,
  invoke existing butterfly/handoff logic, and recover without duplicate actions.
- [complete] 3. Cover success and failure paths offline; update bilingual docs,
  schemas, examples and changelogs; run checks and installed workflow verification.
- [complete] 4. Audit requirements against current evidence, commit task files
  and push directly to main without version bumps or publishing.

Completion requires automatic history collection and detection without manually
authored history JSON, observable evidence and action bounds, no inferred drift
from hashes alone, no automatic uncertain-write replay, and verified delivery.

Verified: `npm run check` passes 140/140 tests, formatting, 49 syntax files and
manifests/examples. Node 20 butterfly suites pass 15/15. The 75-file clean HOME
package verifies installed automatic collection/detection/file handoff/resume,
two worker requests only, plugin seven-skill discovery and uninstall. Requirement
mapping and residual source/session limits are in docs/automatic-butterfly.md.
Feature commit dff439d was pushed directly to origin/main and the worktree was
clean and synchronized after delivery. No version or package release was made.

Error: first planning patch assumed a different progress heading and was
rejected atomically; read the actual heading and corrected the patch.
Focused lifecycle tests initially rejected fake workers lacking write capability
and a planner fixture containing host acceptance. Correct the fixtures without
relaxing either existing authority check. A follow-up patch missed formatted
context and was rejected atomically; inspect current lines before retrying.
The fake sandbox enum is workspace-write, not write; corrected the fixture to
use the established profile vocabulary. New lifecycle suite then passed 6/6.
Final full-suite verification exposed an existing readiness race: a worker marker
precedes the host's durable task.process record. Wait for that specific record
before killing the host; keep all ownership/recovery assertions intact.

## CLI and Claude Code plugin delivery (2026-10-16)

Objective: pull the current project and deliver a usable CLI plus Claude Code
plugin. Keep open-ended reasoning in prompt skills; use fixed workflows only
where inputs, side effects and acceptance rules are explicit.

- [complete] 1. Pull main and inspect CLI, plugin manifests, skills and package
  checks; create an isolated detached worktree as requested.
- [complete] 2. Make plugin entry points actionable, document prompt/runtime
  boundaries and verify both install surfaces without a model invocation.
- [complete] 3. Run offline checks and clean installation checks, audit the user
  requirements, commit the task files, integrate with main and push.

Completion evidence: installed CLI commands and package exports; a clean local
`omha@omha` plugin install with seven skills discovered by Claude Code; accurate
bilingual installation/usage docs; no new scripts for open-ended work; appropriate
checks passing and the delivery commit on origin/main.

Final evidence: combined-main `npm run check` passes 131/131 offline tests and
static checks. Node 20 runs the 74-file clean HOME package check, including
installed CLI/API workflows and actual Claude installation, seven-skill discovery
and uninstall. Feature commit 5d7178a was fast-forwarded and pushed to main.

## Authorized optimization (2026-10-13)

Objective: implement the preceding project analysis recommendations end to end,
preserving every host, ownership, budget, concurrency and offline guarantee.
Deliver each bounded iteration directly to main without a version/release bump.

- [complete] 1. Coordinate readers/writers across runs in one worktree;
  cover independent processes, cancellation, dead owners and distinct worktrees.
- [complete] 2. Enforce reviewer independence against actual author attempts and
  every fallback candidate; preserve requested/served review provenance.
- [complete] 3. Reject stream framing errors even if completion parsing succeeds;
  add runner integration failure cases.
- [complete] 4. Add immutable host verification policy and artifact-bound test
  evidence; distinguish execution, acceptance and review outcomes.
- [complete] 5. Connect existing roundtable/review APIs to Leader lifecycle with
  host signals, durable evidence, shared budget, resume and CLI controls.
- [complete] 6. Consume realtime events with bounded supervision, notifications
  and read-only takeover; never automatically replay uncertain writes.
- [complete] 7. Extract verified run lessons, select scoped relevant memory for
  the next run and enforce freshness, provenance, privacy and injection caps.
- [complete] 8. Add consolidated status/watch and outcome metrics; benchmark and
  address repeated identity/event/index work without changing sources of truth.
- [complete] 9. Synchronize capability documentation, remove legacy config
  fallback, validate installed workflows, audit all requirements and push.

ACP remains subsequent protocol work as recommended: this optimization reuses
native provider channels and must never silently change subscription/API billing.

Acceptance evidence: offline failure-path tests for each phase, appropriate full
checks and bilingual changelogs per commit; installed CLI/API smoke checks for
new workflows; final clean main matching origin/main. Old completed tasks below
describe historical scope rather than authorization for this optimization.

Final acceptance (2026-10-16): `npm run check` passes 131/131 tests with formatting,
48 syntax files, manifests/examples; the full suite also passes 131/131 on Node 20.
The 73-file clean HOME package runs host-policy planning, acceptance, independent
review, memory feedback, status/watch and API export checks, then uninstalls.
See `docs/optimization-audit.md` for the requirement/evidence mapping and limits.

## Concurrency and security hardening (2026-10-12)

- [complete] 1. Preserve full logs for 20 suite repetitions and focused timing tests;
  reproduce the disclosed flaky assertion and make supervision deterministic in a
  ready-signal/MockTimers prototype.
- [complete] 2. Exercise cross-process storage/gates/memory and process supervision,
  then validate security, fail-closed errors and Open Arena paths with concrete inputs.
- [complete] 3. Check, commit and push each isolated fix; record counts, failure
  scenarios, improvements and verified areas without changes.

Do not repeat completed protocol audits or edit retained upstream skills. Keep
version/public API unchanged and use no paid providers. Logs live outside the
repository at /private/tmp/omha-hardening-20261012.

## Automatic group-decision trigger (2026-10-12)

- [complete] 1. Add host-owned risk, ambiguity and write-magnitude thresholds
  that decide whether to invoke the existing blind roundtable.
- [complete] 2. Persist trigger evidence, cover no-trigger and failure paths with
  offline tests, update contracts/changelogs and check the package.
- [complete] 3. Commit and push the bounded trigger change, then record residual
  capability gaps for the next iteration.

## Profile capability model (2026-10-12)

- [complete] 1. Validate explicit/inferred capability tiers without relaxing
  sandbox, budget or fallback guarantees.
- [complete] 2. Make routing honor `requires` capabilities and record rejected
  incompatible profiles without spawning them; cover offline failure paths.
- [complete] 3. Update schemas/contracts/changelogs, run checks, commit and push.

## Structured provider event evidence (2026-10-12)

- [complete] 1. Expose bounded summaries for structured provider events without
  persisting raw prompt/tool payloads.
- [complete] 2. Surface turn, tool, file, usage and input-wait signals through the
  existing runtime callback and result envelope with offline failure coverage.
- [complete] 3. Update contracts/changelogs, run checks, commit and push; document
  any remaining real-time supervision limits.

## Automatic task review (2026-10-12)

- [complete] 1. Add host-owned independent review of completed DAG results with
  frozen diff, test evidence and criterion validation.
- [complete] 2. Persist reviewer provenance and fail-closed invalid/failed review
  outcomes; cover self-review and malformed/spec-inconsistent paths offline.
- [complete] 3. Update API/docs/changelogs, run checks, commit and push; preserve
  task outcomes and existing write gates.

## Residual backlog

- [complete] Add an opt-in bounded provider stream for real JSONL adapters before
  adding automatic escalation/takeover; default and non-JSONL observation remains
  completion-time.
- [complete] Add a supervision loop that consumes live heartbeats/input-wait events
  and performs bounded notification/takeover decisions.
- [pending] Standardize provider JSON-RPC capabilities without crossing native
  subscription/API billing channels.

## Competitor-informed realtime observation (2026-10-12)

- [complete] 1. Compare four active, high-star related projects and record
  reusable capabilities with public evidence.
- [complete] 2. Add an opt-in bounded JSONL stream framer for Codex/Kimi by
  reusing the existing adapter and process callback paths.
- [complete] 3. Finish offline failure-path coverage, contracts/changelogs,
  full checks, then commit and push this bounded change.

## Hardening audit (2026-10-12)

- [done] 1. Run the real handoff worker and test completion file and stdout
  marker authentication through the terminal reader; check and commit.
- [done] 2. Audit derived offsets and paired protocols; remove drift risks,
  add regression tests, check and commit each concern.
- [done] 3. Map README/contracts claims to enforcing code and tests; add missing
  assertions, repair defects with documented judgments, check and commit.
- [done] 4. Verify delivery, push ordinary commits to origin/main and report
  evidence plus contracts verified without changes.

Constraints: retain public API, names, version and licenses; do not edit
skills/butterfly-effect or skills/hide. All verification remains offline.

## Goal

Replace the MVP scaffold with an installable, offline-tested open-source release
candidate. Preserve Omha names and upstream MIT contracts. No metered model
calls, publication, or changes to pre-existing terminal sessions.

## Phases

- [complete] 1. Runtime foundations: storage, process cleanup, profiles,
  adapters, classification, routing, retries, circuits, concurrency and budgets.
- [complete] 2. Durable DAG orchestration and blind structured roundtable decisions.
- [complete] 3. Owned terminal/file handoff lifecycle, polling and cancellation.
- [complete] 4. Evidence-based butterfly wrapper and scoped Markdown memory.
- [complete] 5. Integration/failure fixtures, schemas, bilingual docs, licensing,
  packaging, static checks and CI.
- [complete] 6. Complete suite, plugin validation, clean HOME tarball installation,
  Node 20 verification and owned tmux/cmux probes; record residual limitations.
- [complete] 7. Record candidate changes, verify the final worktree, commit,
  create the public GitHub repository and push main.

## Acceptance Gates

Runtime failures cannot be silently accepted or rerouted on configuration/task
errors. Cancellation and timeout clean up process groups. Durable events support
resume without automatically replaying uncertain write tasks. Votes are collected
blindly and evidence is validated. Terminal operations target owned unique refs.
Shared memory rejects secrets and transcript payloads, enforces scope and conflict
boundaries, and uses deterministic bounded indexes. Default checks are offline.

## Decisions

- Keep a dependency-light Node 20 ESM implementation and explicit runtime checks.
- Use a YAML parser for Markdown frontmatter rather than line-based extraction.
- Use fake adapters and local process/backend fixtures for reproducible tests.
- Treat OS user isolation and provider CLI sandbox enforcement as explicit limits.

## Final Evidence

- `npm run check`: formatting, 32 syntax files, 7 skill manifests/examples, and
  50/50 tests pass on Node 26.8.2.
- `npx --yes node@20 --test tests/*.test.mjs`: 50/50 pass on Node 20.20.2.
- `npm run pack:check`: 64-file `0.2.0-rc.1` tarball installed in a clean
  temporary HOME; direct installed bin/API/examples ran and uninstall verified.
- `claude plugin validate . --strict`: passed.
- `npm run probe:terminals`: tmux and cmux detached printf plus 2068-byte paste/
  separate Enter passed; pre-existing cmux workspace UUIDs were preserved.
- cmux protocol-failure simulation produced bounded diagnostics and completed the
  file fallback probe while tmux remained green.
- `git diff --check`: passed. No provider calls, credentials, or machine state
  were added to the repository.
- Public GitHub repository created at https://github.com/monadrome/omha;
  main pushed with origin tracking (2026-10-10).

## Errors Encountered

- Final restart audit reproduced stale approval: a new task.started/finished pair
  retained the previous completed review. Reset review/acceptance/progress state
  at each task.started and require a fresh review before recovery can complete.
- Phase 8 initial focused suite: 27/28 passed; a privacy assertion matched macOS
  `/private` in valid state paths. Assert the actual payload sentinels instead.
- Phase 7 focused suite: 31/32 passed; the cap test incorrectly assumed a short
  topic could not fit in 256 bytes. Use an oversized topic and assert whole-topic
  omission while preserving the existing injection limits.
- Phase 6 initial focused check: 26/27 passed; the live-progress fixture failed
  completion while all escalation paths passed. Inspect the bounded result and
  process exit before changing watchdog thresholds or repeating the suite.
  The cause was command JSONL fixture events missing required status/output;
  corrected the fixture to use the established adapter envelope.
- Phase 3 integration exposed `stream.complete:true` after an event-count error
  left an empty buffer. Completion now also requires absence of a framing error;
  the first framing failure is preserved through finalization.

- Optimization phase 2 first full check: 102/103 passed; a failed review changed
  the subject task to failed during runStatus replay. Fixed event-kind filtering
  and added assertions that failed/invalid review never changes execution state.

- Hardening first full check: two existing OS integration tests fail under the
  sandbox (temporary executor EPERM and ps fingerprint null); use unsandboxed
  local verification rather than weakening those assertions.

- Prior progress marked scaffold implementation complete based on five small
  tests. Those claims do not cover production contracts; acceptance gates above
  replace them.
