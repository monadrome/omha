# Scope and reuse decisions

Omha was designed after auditing the independent projects in the parent
workspace. `butterfly-effect-skill` supplies artifact-first drift diagnosis and
`hiding-skill` supplies security-sensitive output cleanup. The workspace
`skills` plugin supplies the root-level discovery layout. `agent-cord` supplies
useful evidence about structured provider drivers, cancellation, and blind
voting, but Omha keeps a smaller local CLI instead of copying its server.

`loop-engine` demonstrates task loops and durable logs but has machine-specific
paths and no redistribution license, so its behavior is reimplemented behind a
provider-neutral adapter. `all-local-skills` similarly has no license for
republication; only general ideas were used. Existing memory experiments use
vector and graph stores, while this plugin intentionally starts with auditable
Markdown pointers and lexical search.

The name Omha shortens `oh-my-harness-auto` to a short CLI form. The scoped npm
name avoids the occupied bare `oh-my-harness` package. Before public release,
verify the GitHub namespace and trademark availability independently.

## Related projects reviewed (2026-10-12)

The following four active projects were selected by GitHub stars and functional
overlap with Omha. Star counts are the observed public counts on 2026-10-12;
they are evidence for the comparison, not a compatibility claim.

| Project                                                                                                                                                                                                                                                                                                                                                                          | Observed stars | Relevant capability                                                                                                              | What Omha can borrow                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------: | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [OpenHands](https://github.com/OpenHands/OpenHands)                                                                                                                                                                                                                                                                                                                              |         90,711 | Self-hosted agent control center with local, remote and cloud backends, automation entry points, and explicit sandbox boundaries | Keep a host-owned backend boundary while making run state and automation triggers inspectable.                                                               |
| [Cline](https://github.com/cline/cline) ([CLI](https://github.com/cline/cline/blob/main/apps/cli/README.md), [SDK](https://github.com/cline/cline/blob/main/sdk/README.md))                                                                                                                                                                                                      |         70,213 | Shared agent core across CLI/SDK/IDE, headless NDJSON, live events, usage hooks, checkpoints, approvals and schedules            | Expose a bounded event callback for headless providers so supervision can observe progress without screen scraping.                                          |
| [Goose](https://github.com/aaif-goose/goose) ([architecture](https://github.com/aaif-goose/goose/blob/main/documentation/docs/goose-architecture/goose-architecture.md), [streaming](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/running-tasks.md), [ACP](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/acp-providers.md)) |         55,197 | Local CLI/Desktop/API, native `stream-json`, session logs, MCP extensions and ACP provider/server modes                          | Preserve native provider billing channels while standardizing payload-free summaries first; defer ACP until its lifecycle and billing contract are explicit. |
| [LangGraph](https://github.com/langchain-ai/langgraph)                                                                                                                                                                                                                                                                                                                           |         43,138 | Durable execution, checkpointed state, interrupt/resume, memory and tracing                                                      | Extend Omha's existing append-only DAG events and resume path with stronger event-derived supervision, without replacing host validation.                    |

AutoGen was not selected despite higher historical popularity because its public
repository currently describes maintenance mode. The four selected projects
show the strongest combination of current activity and the execution,
observation and recovery surfaces Omha is targeting.

The first implementation borrowed from the Cline/Goose event model: an opt-in,
bounded JSONL framer now emits redacted summaries while Codex or Kimi is still
running. It reuses the existing adapter parser and process callback, enforces
line/buffer/event limits, and leaves completion parsing, budgets, retries,
sandbox checks and provider billing unchanged. OpenHands-style backend
selection, LangGraph-style supervision and Goose ACP remain follow-up work;
they require additional host contracts before they can be automated safely.
