# Architecture

> 可视化总览：[打开 HTML 架构图](architecture.html)。该页面用功能剖面、生命周期和信任边界解释下面的模块关系。

Omha keeps host-readable instructions separate from side effects:

The Claude Code plugin loads prompt skills from this same repository. Skills own
open-ended reasoning: decomposition, alternatives, evidence interpretation and
knowledge selection. The CLI owns fixed execution protocols once their inputs,
side effects and acceptance rules are known. Neither a skill nor model output can
replace host validation. The plugin's opt-in auto-compact Mod only runs for an
explicitly activated native session and uses CLI-owned admission. It does not
install the CLI; see the [plugin guide](plugin.md) and [ADRs](adr/README.md).

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
lib/arena.mjs           -> 2-8 isolated lanes, sealed fork tree, durable ledger
lib/fork.mjs            -> Session Fork API facade over Arena execution
lib/session-fork.mjs    -> deterministic names and fork/cache evidence helpers
lib/arena-artifacts.mjs -> bundle object audit, full snapshots, base/tree patches
lib/arena-isolation.mjs -> external write policies and local negative probes
lib/roundtable.mjs      -> blind proposals, evidence validation, chair record
lib/backends.mjs        -> owned cmux/tmux/file operations
lib/terminal.mjs        -> handoff state machine and lifecycle API
lib/tab-recovery.mjs    -> cmux tab discovery, bounded failure classification and recovery state
lib/compact.mjs         -> native maintenance claims, cache evidence and durable budgets
hooks/*.mjs            -> opt-in native Mod events and host-checked timers
lib/butterfly.mjs       -> lifecycle observation, chronological drift gate, bounded handoff
lib/frontmatter.mjs     -> YAML parser for Markdown memory records
lib/memory.mjs          -> scope boundaries, indexes, locks and freshness
lib/storage.mjs         -> no-follow atomic state and lock primitives
```

The provider runtime owns metered headless model launches. Native terminal
activation remains in the terminal lifecycle and keeps its billing channel. A profile is
validated before an executable starts. Adapter parsers require a completed
provider event and nonempty output. The runtime records every attempt and uses
failure kinds to decide whether retry or fallback is allowed.

Session Fork reuses Arena as its only execution path. It seals one public prefix,
creates two to eight named child nodes, and passes every child through the same
runtime, isolation, artifact and recovery code. The fork facade adds a stricter
same-route/model and full-reservation gate; it does not clone provider state.
Provider cache claims come only from normalized usage evidence. See
[Session Fork v1](session-fork.md).

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
