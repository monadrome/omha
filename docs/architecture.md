# Architecture

Omha keeps host-readable instructions separate from side effects:

```text
skills/*/SKILL.md       -> portable trigger/evidence contracts
bin/omha.mjs       -> strict CLI and signal boundary
lib/profiles.mjs        -> versioned provider/profile validation
lib/adapters.mjs        -> Claude/Codex/Kimi/fake argv and output parsers
lib/process.mjs         -> process groups, deadlines, output bounds
lib/runner.mjs          -> retry, fallback, circuit, concurrency, budgets
lib/plans.mjs           -> task DAG validation
lib/orchestrator.mjs    -> durable events, resume, dependency scheduling
lib/open-arena.mjs      -> frozen knowledge, authority/evidence and source hashes
lib/arena-spec.mjs      -> separately authorized implementation specification
lib/arena.mjs           -> two independent attempts, durable ledger, all outcomes
lib/arena-artifacts.mjs -> bundle object audit, full snapshots, base/tree patches
lib/arena-isolation.mjs -> external write policies and local negative probes
lib/roundtable.mjs      -> blind proposals, evidence validation, chair record
lib/backends.mjs        -> owned cmux/tmux/file operations
lib/terminal.mjs        -> handoff state machine and lifecycle API
lib/butterfly.mjs       -> explicit chronological drift evidence wrapper
lib/frontmatter.mjs     -> YAML parser for Markdown memory records
lib/memory.mjs          -> scope boundaries, indexes, locks and freshness
lib/storage.mjs         -> no-follow atomic state and lock primitives
```

The provider runtime is the only module that launches model CLIs. A profile is
validated before an executable starts. Adapter parsers require a completed
provider event and nonempty output. The runtime records every attempt and uses
failure kinds to decide whether retry or fallback is allowed.

The host owns orchestration. A planner may produce a plan, but the host validates
its graph, profiles, write mode and limits. One immutable public context file is
written at run creation. Role-specific prompts append after that prefix; private
dependency output lives in result references. Events are append-only JSONL so a
new host can reconstruct task state after a crash. Interrupted write tasks need an
explicit replay option.

Roundtable prompts are built from the same public context and evidence anchors.
Each voter runs in a fresh temporary cwd and receives no other vote. Only after
all voters finish does the chair receive the proposals. The host tally and chair
record preserve invalid votes, abstention and dissent.

Handoffs write their prompt before creating a terminal. cmux gets a full workspace
and surface UUID; tmux gets a private socket and unique session. Both carry an
owner token and verify it before input, capture or close. A worker writes a final
token-bound JSON marker. File mode uses the same record and can be completed by a
host command.

Memory uses Markdown topics with YAML frontmatter as the source of truth.
`MEMORY.md` is a bounded deterministic index. Git projects use the canonical
common Git directory so sibling worktrees share project scope; worktree/session/
role/user scopes require explicit selection. Atomic no-follow writes and
expected hashes make concurrent updates visible.
