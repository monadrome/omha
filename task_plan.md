# Omha release candidate implementation

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

- Prior progress marked scaffold implementation complete based on five small
  tests. Those claims do not cover production contracts; acceptance gates above
  replace them.
