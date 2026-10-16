# Optimization Acceptance Audit

The authorized nine-phase optimization is defined in `task_plan.md`. This audit
maps its requirements to the implementation and offline evidence. ACP and an
automatic causal-rewind subscription remain explicitly deferred protocol work.
Native provider billing channels and version `0.2.0-rc.2` are preserved.

| Requirement                         | Implementation                                                                                                                                 | Evidence                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Cross-run worktree admission     | `lib/orchestrator.mjs` worktree leases, queued deadlines/cancellation, owned worker cleanup                                                    | orchestration/integration tests cover independent processes, readers, writers, roots, dead owners and queues                                                         |
| 2. Independent review authority     | actual author lineage, excluded fallback profiles, served-reviewer validation                                                                  | orchestration tests cover author/reviewer fallback, excluded routing without reservation and post-dispatch refusal                                                   |
| 3. Fail-closed realtime framing     | bounded existing JSONL framer; parse errors override otherwise valid completion                                                                | runtime tests cover missing newline, truncation, oversized lines, event limits and no fallback                                                                       |
| 4. Host acceptance                  | host policy binding, immutable executable/file/dependency hashes, bounded metadata-only snapshots                                              | acceptance tests cover candidate/harness modification, changed saved policy, unsupported and oversized artifacts; execution remains distinct from acceptance/review  |
| 5. Leader review/decision lifecycle | threshold trigger, blind tally, valid-chair gate, human approval/resume, independent review before dependencies                                | orchestration tests cover no-trigger, approval, invalid/failed chair, review rejection, pending-review recovery and stale-approval reset                             |
| 6. Live supervision                 | existing runtime callback, per-attempt controller, bounded read-only configured fallback takeover, durable escalation plus stderr notification | supervision tests cover progress, input waits, stall takeover, cap, cancellation, notification failure and interrupted writes without replay                         |
| 7. Memory feedback                  | deterministic host acceptance observations, scoped fresh relevance selection and immutable context provenance                                  | auto-memory/memory tests cover missing/failed acceptance, review rejection, privacy, unrelated/stale topics, caps, hash conflicts and concurrent writers             |
| 8. Status/watch/metrics             | replay authoritative logs, consolidate project records, bounded changed-snapshot watch, reuse identities/indexes within reads                  | status tests cover payload omission, project isolation, external events, cancellation and CLI JSONL; offline benchmark mean 248ms to 16ms for 20 runs / 2,000 events |
| 9. Canonical contracts/delivery     | `providers.json` discovery only; bilingual README/changelogs, capability map, schemas and installed workflows                                  | runtime discovery test, static validation and clean HOME tarball installation/uninstallation                                                                         |

New paths extend the existing runner, orchestrator, memory, process and Arena
collector modules. No second provider channel, durable cache, metered verification,
branch, release tag, package publication or force push is introduced.

`npm run check` verifies formatting, syntax, examples/manifests and all offline
failure-path tests. `npm run pack:check` installs the tarball into a clean
HOME, executes the installed host-policy planning/acceptance/review/memory workflow,
checks status/watch and API exports, then uninstalls. The final suite passes
131/131 on the local Node 26 runtime and Node 20. Formatting, 48 syntax files,
manifests/examples and the latest 73-file package all pass; delivery commits and
the complete verification history are recorded in `progress.md` and Git.

Acceptance remains bounded observation about a particular artifact, not a proof of
all correctness. Imported harness dependencies must be declared in `harnessFiles`;
Git-ignored files are outside the DAG snapshot. External sandbox enforcement and
same-OS-user trust remain documented limits. Nonstreaming adapters and terminal
handoffs do not claim live input-wait detection. No live paid-provider, Windows
runtime or new terminal-backend integration was exercised for this optimization.
