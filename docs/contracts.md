# Omha Contracts

Open Arena knowledge import and the separately authorized two-implementation
batch have an additive version 1 contract described in
[Open Arena Content and Independent Implementations](open-arena.md).
`validateArenaSpec()` and the knowledge importer validate those records. They
preserve the existing string public-context and leader write-exclusion contracts.

All JSON inputs use version `1` and reject unknown fields. Paths are resolved
relative to the supplied working directory, while durable state is under
`OMHA_HOME`.

Provider configuration is `schemas/providers.schema.json`. A profile names an
adapter (`claude`, `codex`, `kimi`, `command`, or `fake`), executable, model,
effort, sandbox, timeout, concurrency, budgets, environment allowlist, retry
policy, circuit cooldown, fallback profiles and capability tiers. Capabilities
are `interactive`, `headless`, `tool-free` and `read-only`; known adapters and
sandbox settings infer the enforceable subset, while unsupported declarations
fail validation. A dispatch request can set `requires` to route only to profiles
that satisfy those host-checked capabilities. `sandboxCommand` and
`sandboxArgs` can wrap an adapter in an external read-only sandbox; Kimi
read-only profiles require them. `fake.responses` is for tests only. A provider
response is successful only when the adapter parser sees a
completed result with nonempty text. Claude JSON, Codex JSONL and Kimi JSONL are
accepted according to their observed CLI event shapes; unrecognized or partial
events fail with `malformed_output`.

Structured results also expose bounded event summaries through the runtime result
and `onProviderEvent`. Each summary preserves the adapter event type, request/model
provenance, tool name, changed file paths, numeric usage and an `inputWait` flag;
raw provider payloads are not copied into the summary. Event parsing is evidence
only: a successful exit still requires the adapter's completed nonempty result,
and an event stream never replaces host acceptance checks.

Pass `streamEvents: true` to `dispatch()` or `ProviderRuntime.attempt()` to receive
the same redacted summary envelope while a real Codex or Kimi JSONL process is
still running. Each streamed callback has `realtime: true` and a zero-based
sequence. The host bounds each line to 512 KiB, the incomplete buffer to 1 MiB,
and a request to 4,096 events; malformed or incomplete frames fail closed and
the existing process-group cleanup path runs. The option is opt-in and does not
change Claude's JSON invocation, provider billing channel, completion validation,
retry policy or budget settlement. `result.stream` records whether streaming was
requested, supported, delivered and complete. A stream callback may be
synchronous or return a promise; a rejected callback is a host task failure.

`reviewTask()` reviews only a completed successful DAG task. The host freezes the
task output hash, diff, test evidence and criteria in a packet, requires a
different reviewer profile with `headless`, `tool-free` and `read-only`
capabilities, and computes approval only when every criterion is reported as
`pass`. Failed, malformed or incomplete reviews are persisted as non-approved;
the task result and write state are never changed by review.

The result envelope has these fields when available:

```json
{
  "ok": true,
  "requestedProvider": "planner",
  "servedProvider": "planner",
  "requestedModel": "haiku",
  "servedModel": "haiku",
  "requestedProfile": "planner",
  "servedProfile": "planner",
  "attempts": [],
  "requestId": "provider-or-local-id",
  "latencyMs": 12,
  "code": 0,
  "signal": null,
  "responseHash": "sha256",
  "failureStage": null
}
```

Failure kinds are `rate_limit`, `capacity`, `auth`, `timeout`, `transport`,
`spawn`, `configuration`, `cancellation`, `task`, `malformed_output`, `budget`,
`circuit_open`, and `backend`. Only the retryable capacity classes are eligible
for fallback. `configuration`, `task`, `auth`, malformed output, and budget
failures stop the route.

Plans use [schemas/plan.schema.json](../schemas/plan.schema.json). The host checks
the DAG, profile and fallback names, dependency cycles, timeout/retry limits,
write authorization and write ordering. The planner is untrusted input; it never
executes a tool. Events are append-only JSONL and task results are separate JSON
references. The immutable context file is written once and its hash is checked on
resume. Dependency outputs and worker messages are references, not dynamic public
prefix content.

Roundtable voters return [schemas/proposal.schema.json](../schemas/proposal.schema.json).
An evidence item must quote the supplied public anchor exactly. `abstention:true`
requires `recommendation:null`; every non-abstention needs at least one anchor.
The host tally is majority or weighted-over-half. A chair runs after blind
collection and cannot alter the tally. A decision record includes every vote,
provider metadata, response hash, latency, invalid reasons, minority reasons and
optional human gate.

`autoRoundtable()` adds a host-owned trigger around that same protocol. It accepts
bounded `risk` and `ambiguity` scores in `[0,1]`, plus `writeFiles` and `writeBytes`
counts. The defaults trigger at `risk >= 0.7`, `ambiguity >= 0.5`, ten files or
one MiB. A missing signal set triggers with `signals_unavailable`; otherwise a
below-threshold assessment creates no decision and launches no provider. Trigger
signals and thresholds are persisted with the decision, so an automatic launch
has the same evidence trail as a manual one.

Butterfly input uses [schemas/history.schema.json](../schemas/history.schema.json).
The transcript is strictly chronological. A supported drift requires a previous
agent-produced version, later user feedback tied to requirements that existed
before it, a changed replacement version, and a visible causal action. No-op
results are explicit and carry an evidence gap. `conversationRewound` is always
`false` because the wrapper only produces advice.

Memory topic frontmatter is parsed as YAML and validated by `lib/memory.mjs`.
`MEMORY.md` is an index; topic Markdown is the source of truth. Handoff records
use an owner token, full backend reference and a final marker with the same token.
The final state is successful only for exit code `0` and a valid marker.
