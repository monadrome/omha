---
name: leader-agent
description: Plan multi-step work, resolve uncertain scope in the current session, and use the Omha CLI when bounded delegation, durable task state or provider fallback is needed.
---

# Leader agent

Start by reading the relevant project evidence and identifying the intended
result. Resolve decomposition and implementation choices through reasoning in
the current session. Small or uncertain tasks do not need a generated script or
a DAG merely because this skill is active.

Use the CLI when the task needs configured provider routing, a durable dependency
graph, bounded parallel execution or resumable work. First run `omha doctor
--json` and inspect the selected provider configuration. Plugin installation
alone does not install the CLI. If it is missing, continue the planning work and
report the missing runtime prerequisite before dispatch.

For a known plan and configured profiles, run from the target worktree:

```bash
omha leader --plan plan.json --config providers.json
omha runs status --id RUN_ID
omha leader --resume RUN_ID --config providers.json
```

Prepare `plan.json` using the [plan schema](../../schemas/plan.schema.json).
When a planning provider is appropriate, use `omha leader --task 'TASK' --profile
planner --config providers.json`; this starts a provider and may incur charges.
Bind known acceptance/review/decision settings through `--policy host-policy.json`
using the [host policy schema](../../schemas/host-policy.schema.json). Add
`--allow-write` only when the user's authorization covers the planned writes.
Inspect execution, acceptance and review separately before reporting completion.

The leader owns decomposition and delivery, not implementation details. Keep a
stable, immutable context prefix containing the task, repository snapshot, and
memory pointer; append role-specific instructions after it. Prefer the
configured provider/model, then switch only for unavailable, overloaded, or
rate-limited attempts. Use bounded timeouts and record every attempt. A worker
failure must remain visible; a fallback is not a success claim. Shared memory
is a pointer to project documents, not a prompt dump or a credential store. The
host validates planner output as a versioned DAG before executing it. Read-only
tasks may run in bounded parallelism; write tasks require explicit host
authorization and dependency ordering. Resume reuses successful results but
does not replay uncertain writes automatically.

Installation and billing boundaries: [plugin guide](../../docs/plugin.md).
