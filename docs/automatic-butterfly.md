# Automatic Butterfly

Leader now observes its own write-task lifecycle and automatically invokes the
existing butterfly detector. No manually authored transcript or additional model
call is needed. It generates advice and, by default, an owned file handoff with
the continuation prompt. It does not rewind a conversation or restore files.
An explicitly bound native cmux continuation can instead fork session history at
a real checkpoint, deliver the revised prompt and retire the source after
successor acceptance. See [cmux historical continuation](cmux-fork.md).

## Evidence And Trigger

1. A host supplies an acceptance command before execution. Omha freezes the
   command, arguments, executable and declared harness hashes in the saved run.
2. While holding the existing worktree lease, Omha takes a bounded metadata-only
   snapshot before the worker. Acceptance already snapshots the resulting
   candidate before and after the check. Raw file contents are not retained.
3. A completed worker that changed the worktree and failed a complete, stable
   acceptance check establishes a produced version and narrowly scoped host
   feedback: the original acceptance requirement was missed. The provider's exit
   status or prose cannot establish this feedback.
4. A later authorized attempt must begin with that same candidate and produce
   different content. The detector then checks the chronological requirement,
   feedback, version hashes and visible task action. Advice identifies the
   earliest supported task attempt and retains the original objective/context.
5. A deterministic report is persisted and an at-most-once claim precedes each
   handoff. Default handoffs use `file`, remain `awaiting`, and launch no model.

The lifecycle consumes durable host events at execution completion and resume.
It uses existing structured runtime and acceptance evidence, without polling
screens or introducing a second runner. Host feedback is marked `actor:host`
with acceptance policy, artifact and exit-code anchors; it is never represented
as a user conversation turn. Explicit user-history analysis remains available
through `omha auto-butterfly --input history.json`.

## Host Policy

Defaults apply to write tasks that already have host acceptance. To customize a
generated Leader plan, supply `--policy host-policy.json`:

```json
{
  "butterfly": {
    "enabled": true,
    "handoff": true,
    "backend": "file",
    "maxHandoffs": 3,
    "maxObservations": 256
  },
  "tasks": {
    "build": {
      "acceptance": {
        "command": "/absolute/path/to/node",
        "args": ["/absolute/path/to/verify.cjs"],
        "harnessFiles": ["/absolute/path/to/fixture.json"]
      }
    }
  }
}
```

Use task IDs from the plan and the real local verifier paths. A host-authored
plan can contain the same `butterfly` object and task `acceptance` directly.
The planner cannot supply or change either policy. `enabled:false` disables
collection; `handoff:false` keeps reports without handoffs. The run-wide bounds
are 0-3 handoff attempts and 1-1000 observations. Failed or uncertain handoffs
consume an attempt. Reaching an observation cap emits `butterfly.limit`.

Existing write replay authorization remains necessary:

```bash
omha leader --resume RUN_ID --allow-write --retry-failed --retry-interrupted-writes
omha runs status --id RUN_ID
omha status --watch
```

Rework can be detected even when the replacement still fails; the report does
not certify it as correct. Automatic handoff only prepares continuation through
the existing terminal/file API. Worker execution remains subject to its normal
budget, ownership, capability and authorization gates.

## Observability And Limits

`events.jsonl` retains observation hashes, acceptance metadata, attempts, report
origins and handoff outcomes. Existing request events retain requested/served
profile/model, budget and execution evidence. `runs status` exposes the latest
task `butterfly` report, handoff ID/status and run metrics
`butterflyDetections`, `butterflyHandoffs`, `butterflyUncertain`. A claim without
a completion is visible as uncertain; resume never silently retries it. History
that exceeds detector bounds emits `butterfly.skipped` and creates no action.

Readonly tasks and tasks without frozen host acceptance are not automatically
classified. Successful evolution, identical content, external changes between
attempts, provider failures, interrupted writes, unstable/changed harnesses,
checks that mutate candidates and incomplete checks cannot supply causal drift
evidence. Coverage is limited to the original host acceptance requirement, not
arbitrary semantic criticism or reviewer prose. Snapshots inherit the existing
acceptance limits and tracked/nonignored Git selection. Automatic observation
does not extend into arbitrary terminal sessions, and no background daemon is
installed. Explicit history is still needed for those sources.
The current-session skill can collect that evidence and use native cmux forks;
this is an invoked workflow, not an unattended watcher. Leader native forks also
require completed host gates, explicit write authorization and an exact host
`butterfly.forks` binding; a failed run only produces advice.

## Offline Verification

`tests/butterfly-lifecycle.test.mjs` covers automatic collection/detection/file
handoff, replay authorization, deduplication, authority and provenance, external
edits, identical content, accepted evolution, failed/incomplete checks, caps and
crash uncertainty, Unicode context and bounded-history no-op behavior.
`scripts/pack-check.mjs` exercises the installed CLI with local
providers. Default verification does not call a metered provider.

| Requirement                     | Authoritative Evidence                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Observe without manual history  | Scheduler pre-worker snapshot, `butterfly.observed` records and saved frozen acceptance policy                |
| Preserve the drift gate         | Existing `detectDrift`, explicit host authority anchors, continuity checks and no-op fixtures                 |
| Act automatically within bounds | Existing `handoff` API, durable request/result events and per-run observation/action caps                     |
| Recover safely                  | Deterministic report IDs, saved policy, explicit write replay gates and at-most-once crash tests              |
| Audit outcomes and billing      | Origin-linked reports, request provenance/budget events, status metrics and installed two-request fixture     |
| Preserve existing guarantees    | Full offline suite including capability, budget, worktree lease, review, decision and process recovery checks |
