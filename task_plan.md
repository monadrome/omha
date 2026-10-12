# Omha release candidate implementation

## Concurrency and security hardening (2026-10-12)

- [complete] 1. Preserve full logs for 20 suite repetitions and focused timing tests;
  reproduce the disclosed flaky assertion and make supervision deterministic in a
  ready-signal/MockTimers prototype.
- [complete] 2. Exercise cross-process storage/gates/memory and process supervision,
  then validate security, fail-closed errors and Open Arena paths with concrete inputs.
- [in_progress] 3. Check, commit and push each isolated fix; record counts, failure
  scenarios, improvements and verified areas without changes.

Do not repeat completed protocol audits or edit retained upstream skills. Keep
version/public API unchanged and use no paid providers. Logs live outside the
repository at /private/tmp/omha-hardening-20261012.

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

- Hardening first full check: two existing OS integration tests fail under the
  sandbox (temporary executor EPERM and ps fingerprint null); use unsandboxed
  local verification rather than weakening those assertions.

- Prior progress marked scaffold implementation complete based on five small
  tests. Those claims do not cover production contracts; acceptance gates above
  replace them.
