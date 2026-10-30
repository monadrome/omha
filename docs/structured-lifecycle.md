# Structured lifecycle

Omha uses a small structured-concurrency kernel for work that crosses provider
execution, worktree admission, acceptance, review and cleanup boundaries. The
kernel is deliberately host-owned: a provider response can supply evidence, but
it cannot create permission, extend a deadline or declare its own completion.

## Mechanisms

`ExecutionScope` is the lifetime boundary. A scope has one monotonic deadline,
an `AbortSignal`, and a first-wins reason. A child inherits the tighter parent
deadline and keeps the parent cancellation code, so a timeout remains a timeout
through nested scopes. The `parent` source identifies propagation; `external`
identifies a caller signal. `close()` rejects new children while allowing work
already created in the scope to finish or reach its deadline. `cancel()` is the
explicit stop operation and clears the deadline timer.

`ProviderRuntime.dispatch()` accepts a scope. Retries, fallbacks, provider
processes and backoff waits observe the same signal and remaining budget. When
no scope is supplied, the runtime creates a request scope from the configured
timeout and caller signal, then disposes it after the attempt. A supplied scope
is the parent of a runtime-owned attempt child, so per-attempt timeout still
works for adapters such as `fake`; the caller scope is never cancelled by the
runtime.

`executePlan()` creates a run scope and derives one task scope per launched task.
The task scope covers worktree admission, provider execution, acceptance and
review. A task timeout therefore cannot be bypassed by waiting for a worktree,
switching to a fallback profile, or starting acceptance after provider success.
The cancellation file and caller signal enter through the run scope. Normal
completion disposes task scopes so deadline timers do not keep the process alive.

`TaskHandle` is the caller-visible state machine for adapters that need a more
detailed record than an `AbortSignal`. Its phases are:

```text
prepared -> admitted -> queued -> running -> exited -> settled
                                \-> cancel_requested -> exited|skipped -> settled
```

An unstarted task may be skipped after cancellation. A running task must record
body exit before settlement. Completion snapshots are immutable and retain the
first cancellation reason, timestamps, bounded failure text and the final
outcome. `success` means that the adapter completed; host acceptance and
independent review remain separate gates.

## Current Omha and vformation mechanisms

The following mechanisms are already present in Omha or are now represented by
the lifecycle kernel:

| Mechanism                    | Omha surface                                             | vformation idea carried over          | Use                                                          |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| Parent deadline inheritance  | `ExecutionScope.child()`                                 | Min(parent, requested) deadline       | Prevent descendants from extending a run                     |
| First-wins cancellation      | `ExecutionScope.cancel()`                                | Stable cancellation attribution       | Keep timeout, caller stop and external abort distinguishable |
| Admission-aware cancellation | task scope around `acquireWorktree()` and provider queue | Prepared/admitted/queued phases       | Skip work that never reached a worker                        |
| Caller-visible lifecycle     | `TaskHandle`                                             | Prepared through settled task views   | Expose progress without exposing provider internals          |
| Bounded cleanup              | scope disposal plus existing process-group cleanup       | Cleanup under the owner boundary      | Avoid orphan processes and timer leaks                       |
| Evidence gates               | acceptance, review and decision records                  | Execution separate from acceptance    | Prevent provider success from becoming host approval         |
| Immutable state              | completion snapshots, append-only run events             | Terminal snapshots and durable events | Make resume and post-run inspection deterministic            |
| Bounded supervision          | provider stream/silence supervision                      | Body-exited and interrupt rules       | Abort stalled work while preserving failure attribution      |

## Skill routing

Skills remain reasoning and interaction contracts. They should select or explain
a mechanism; the CLI and host scopes enforce it.

| Skill              | Mechanism to use                                           | Scope and evidence boundary                                                  |
| ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `leader-agent`     | plan validation, task DAG, `executePlan()`                 | run scope; write authorization, acceptance and review are host-owned         |
| `task-preflight`   | six-signal shadow classification                           | advisory only; never grants routing, budget or permission                    |
| `roundtable`       | blind voters and chair tally                               | one decision scope; failed, abstained and dissenting votes stay visible      |
| `multi-review`     | frozen diff, independent reviewers and verified fixes      | review scope; reviewer independence and approval are separate from execution |
| `agent-handoff`    | owned terminal/file handoff and token-bound completion     | handoff scope; only the owner may send, cancel or close                      |
| `auto-close`       | explicit completion hook                                   | run scope must be completed and acceptance gates must pass before close      |
| `project-memory`   | scoped Markdown memory with expected hashes                | memory scope; stale or conflicting records are surfaced, never overwritten   |
| `auto-butterfly`   | chronological drift detection and successor-confirmed fork | artifact evidence scope; no implicit rewind or source closure                |
| `butterfly-effect` | conversational causal diagnosis                            | advice only unless a host fork is explicitly requested                       |
| `hide`             | bounded file cleanup and credential warning                | file scope; no lifecycle authority and no silent deletion                    |

## Candidate extensions

The next useful additions should parameterize these existing mechanisms before
adding new abstractions:

1. Add task lifecycle events to the durable run ledger so status can distinguish
   `prepared`, `queued`, `running`, `cancel_requested`, `skipped` and `settled`
   without inferring them from provider events.
2. Derive explicit acceptance and review child scopes from a task scope while
   preserving the task's remaining deadline and cancellation code.
3. Add fail-fast policy as a scope option: one task failure can cancel siblings
   only when the plan opts in, and the ledger must record the triggering task.
4. Add bounded, interrupt-safe cleanup scopes for handoffs, Arena/Fork lanes and
   auto-close; cleanup failure must remain distinct from task success.
5. Add a context carrier for run/task identifiers only when an API needs implicit
   correlation. Prefer explicit scope parameters first; Node `AsyncLocalStorage`
   should not become a hidden permission or cancellation channel.

These extensions preserve the core rule: skills may recommend a workflow, while
the host validates inputs, owns side effects and publishes the final evidence.
