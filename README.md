# Omha

[中文](README-zh.md) | [Contracts](docs/contracts.md) | [Security](docs/security.md)

Omha is a local, provider-neutral runtime for agent collaboration. It routes
Claude/Codex/Kimi jobs, executes validated task DAGs, collects blind roundtable
votes, manages owned terminal handoffs, diagnoses supported artifact rework, and
maintains scoped Markdown memory. Seven portable Agent Skills accompany the CLI.

**0.2.0-rc.2 is a release candidate.** Default verification is offline. Real model
behavior, billing and sandbox enforcement remain dependent on the installed
provider CLI. A successful CLI exit is validated output, not proof that a coding
task is correct; run the project's own acceptance checks.

## Install, Update, Uninstall

Requires Node 20+ and npm. Git, provider CLIs, tmux and cmux are optional.
From a checkout, these commands install a versioned tarball:

```bash
npm ci --ignore-scripts
npm run check
npm pack
npm install -g ./huatalk-omha-0.2.0-rc.2.tgz --ignore-scripts
omha doctor --json
```

For a user-local checkout installation: `./install.sh`, then add `$HOME/.local/bin`
to PATH. Override its prefix with `OMHA_NPM_PREFIX`. The script installs the CLI
only and does not overwrite a Claude marketplace. Keep the checkout in place.

When published, use `npm install -g @huatalk/omha@<version> --ignore-scripts`
to install or update. For this candidate, build and install the new tarball with
the same commands above. No npm release is implied by this repository.

```bash
npm uninstall -g @huatalk/omha --ignore-scripts
# For the user-local install:
npm uninstall -g --prefix "$HOME/.local" @huatalk/omha --ignore-scripts
```

Uninstall retains memory and run records. Close owned handoffs first with
`omha handoff close --id <id>`. `omha doctor --json` reports the state
directory; review it before manually removing any retained data.

### Claude Plugin and Agent Skills

For a one-session checkout plugin: `claude --plugin-dir .`.
For a persistent local marketplace, run `claude plugin marketplace add .` and
`claude plugin install omha@omha` from the checkout. Update a registered
marketplace with `claude plugin marketplace update omha` and reinstall the
plugin if required by your host. Remove it with
`claude plugin uninstall omha@omha` and
`claude plugin marketplace remove omha`.

Other hosts can discover or copy `skills/*/SKILL.md` and its adjacent references
and LICENSE files. Skills are instructions; hosts need an installed `omha`
CLI to perform deterministic runtime operations. The upstream `butterfly-effect`
and `hide` contracts are retained, with their MIT notices.

## Offline Examples

All commands below run from this checkout without a paid provider:

```bash
node bin/omha.mjs run --profile fake --prompt 'Check the local runtime'
node bin/omha.mjs leader --plan examples/plan.json --config examples/providers.fake.json
node bin/omha.mjs runs list
node bin/omha.mjs roundtable --input examples/decision.json --config examples/providers.fake.json
node bin/omha.mjs auto-butterfly --input examples/history.json --handoff --backend file
node bin/omha.mjs memory put --name api-contract --type decision --content 'Validate plans before executing them.'
node bin/omha.mjs memory inject --topics api-contract
node bin/omha.mjs memory doctor
```

`npm run pack:check` installs a tarball in a clean temporary HOME, runs these
workflows through the installed CLI/API, and verifies uninstall. Terminal probes
are separate: `npm run probe:terminals` creates unique owned resources, tests
detached printf and long paste/Enter, and closes only those resources.
When a local cmux RPC schema differs, the probe records bounded diagnostics and
verifies a completed file fallback; tmux and offline checks remain the release
gate.

## Providers and Routing

Use `--config providers.json`, `.omha/providers.json`, or
`$OMHA_HOME/providers.json` (in that order). `agents.json` is a legacy filename
alias, but its contents must use the version 1 schema. Invalid configuration fails
closed. See [examples/providers.json](examples/providers.json) and
[schemas/providers.schema.json](schemas/providers.schema.json).

Profiles specify adapter, executable/argv, model, effort, sandbox, timeout,
concurrency, budget reservations, environment variable **names**, retry policy,
circuit cooldown and fallback profiles. They also expose host-checked
`interactive`, `headless`, `tool-free` and `read-only` capabilities; dispatch
requests can require a subset before any provider is spawned. `sandboxCommand`/`sandboxArgs` can wrap
an adapter in an external read-only sandbox; Kimi read-only profiles require
that wrapper. Never put API keys in JSON, argv, prompts
or memory. Authenticate through the CLI's credential store or explicitly allow
the required environment variable. Configure models available to your account.

Headless JSON/JSONL providers expose bounded event summaries through the runtime
callback and result envelope, including turn types, tool/file evidence, usage and
input-wait signals. Raw provider payloads remain untrusted and are not persisted
as event summaries. Pass `streamEvents: true` through the API to receive the same
redacted summaries while Codex or Kimi JSONL is running; the stream is opt-in and
bounded, and `result.stream` records support, delivery and completion. Claude
continues using its native JSON invocation. A streamed event is observation
evidence only; completion parsing, host acceptance, budget gates and billing
channels remain authoritative.

Completed DAG results can be sent to `reviewTask()` with a frozen diff, test
evidence and review criteria. The host requires an independent reviewer profile,
checks every criterion and records failed or malformed reviews without changing
the task result.

```bash
# This is a real provider call and may be billed:
omha run --profile reviewer --config examples/providers.json --prompt 'Review the public task evidence'
```

Only rate limit, capacity, timeout, transport, missing executable and open circuit
failures can trigger fallback. Auth, malformed output, task, budget and
configuration failures stop routing. Transient retries honor Retry-After and
bounded exponential backoff with jitter. Shared provider gates coordinate local
processes under the same state directory. Native aliases share the gate for their
adapter/executable; separate command/fake profiles have separate gates.

Results include requested/served profile/provider/model, request IDs, all attempts,
latency, exit/signal, SHA-256, failure stage and usage accounting. `servedModel:null`
and `modelVerified:false` mean the CLI did not identify the actual model. Unknown
usage is conservatively charged at the configured reservation. Reservations are
admission controls, not a universal billing cap; see [limitations](docs/security.md).

## Lifecycles

`omha status` shows runs, decision gates, owned handoffs and outcome metrics.
`omha status --watch --wait-ms 30000` emits changed snapshots as JSONL for a
bounded watch; Ctrl-C stops it. Execution, host acceptance and review remain
separate outcomes, including when older runs have no acceptance evidence.

- **Open Arena:** import reviewed `OPEN_ARENA.md` and references as frozen knowledge
  without starting a provider. A separately authorized Git/POSIX batch runs two
  independent bundle clones with one write attempt each, a shared durable budget
  and host verification. Reports retain all outcomes and multiple artifacts;
  strict execution requires a verified external write executor. See
  [Open Arena contracts and CLI](docs/open-arena.md).
- **Leader:** a low-effort planning call produces a JSON DAG; a supplied `--plan`
  bypasses that call. The host validates profiles, dependencies, timeouts and write
  authorization. Readers run in bounded parallelism; writes are dependency-ordered
  and run alone in the shared worktree. `runs cancel --id <id>` is durable.
  `leader --resume <id>` reuses successful task results and the immutable public
  prefix. Uncertain writes remain interrupted; replay requires
  `--allow-write --retry-failed --retry-interrupted-writes` after inspecting changes.
  Plans can add host `acceptance` commands and independent `review` blocks per
  task. A plan-level `decision` block automatically invokes the existing
  evidence-bound roundtable when risk, ambiguity or write magnitude crosses its
  threshold; pending human gates leave the run awaiting approval before tasks
  start.
  Generated plans cannot authorize acceptance or lifecycle policy; bind those
  host settings with `leader --policy host-policy.json` (global `decision`,
  `supervision`, `memory`, plus `tasks: {taskId: {acceptance, review}}`).
  Optional `supervision: {stallMs, inputWaitMs, maxTakeovers}` consumes live JSONL
  progress, emits escalation notifications on stderr and bounds read-only
  takeover to configured fallbacks. All values default to 0 (disabled); the
  takeover cap is 3. Stalled writes remain interrupted and are never taken over.
- **Roundtable:** 2-3 fresh voters receive identical public evidence and separate
  private suffixes. No vote is persisted until collection finishes. Quotes must
  match supplied anchors. Majority or configured weights require over half the
  total voter weight, including abstentions/invalid votes. The chair runs afterward
  and cannot change the host tally. Minority reasons and failures remain recorded.
  A human gate is advisory and must be approved through `decision approve` before
  downstream systems choose to act; Omha never applies a decision itself.
- **Handoff:** the prompt is written first. `auto` tries cmux, tmux, then file.
  Records retain full cmux UUIDs or private tmux sockets, ownership, PID and hashes.
  `handoff read|poll|send|resume|cancel|close --id <id>` manage only owned targets.
  Terminal workers require an authenticated final JSON marker or completion file;
  file handoffs allow `handoff complete`. Resume after termination creates a new
  handoff. Completed terminals remain visible until explicitly closed; timeouts
  and cancellation clean them up. Pipe-supervised interactive input supports
  line-oriented programs, not arbitrary full-screen TUIs.
- **Butterfly:** explicit chronological JSON history must show production,
  authoritative feedback on pre-existing requirements, and changed rework.
  Hash change alone, ordinary evolution, acceptance followed by new work, and
  missing history are no-op. Independent drifts keep separate boundaries.
  `--analyze` invokes the retained contract through a configured provider only for
  supported evidence. The result is advice; no conversation is actually rewound.

## Memory

Markdown/frontmatter topics are the source of truth. `MEMORY.md` is a deterministic
pointer index capped at 200 lines / 24,000 bytes. Injection caps at 200 lines /
16,000 bytes, includes only requested topics, and reports stale records.
Leader also selects relevant fresh project/worktree topics automatically and
freezes their source hashes in the run context. Successful host acceptance plus
any required review records a worktree lesson containing the verified recipe and
run provenance, without provider output or transcripts. `plan.memory` controls
selection caps, freshness and read/write switches; private scopes require explicit
manual selection.

`memory init|status|list|read|search|put|forget|inject|doctor` supports these scopes:

| Scope                    | Boundary                                                      |
| ------------------------ | ------------------------------------------------------------- |
| `project` (default)      | canonical common Git directory, shared by sibling worktrees   |
| `worktree`               | one real worktree root                                        |
| `user`                   | OS user, shared across projects only when explicitly selected |
| `session --session <id>` | project plus explicit session ID                              |
| `role --role <id>`       | project plus explicit agent role                              |

Non-Git projects use their real path. Project-shared means shared among local
agents under the same state directory, not a network/multi-user service. User
memory injection additionally requires `--include-private`. Topics carry type,
provenance, created/updated time, freshness and status. `--expected-hash <sha256>`
detects stale edits; `--create-only` rejects existing topics. `memory doctor
--rebuild` reconstructs the index. Credentials and raw shared transcripts are
rejected. Traversal, null bytes, symlinks and hardlinked records are rejected;
writes use fsync/rename and live-owner locks are never aged out.

## Security, Compatibility and Contribution

State defaults to `$XDG_STATE_HOME/omha` or `$HOME/.local/state/omha`;
`OMHA_HOME` overrides it. Omha is a local trusted-user tool, not an
isolation boundary against hostile processes running as that same OS user.
Review commands and provider tool permissions. POSIX process groups supervise
native workers; Windows degrades to fake providers, memory, skills and file
handoffs. Kimi needs an external sandbox for read-only use and is excluded from
tool-free planning/voting until a verified CLI mode exists.

See [security](docs/security.md), [contracts/API](docs/contracts.md),
[compatibility](docs/compatibility.md), [contributing](CONTRIBUTING.md), and
[release checks](docs/releasing.md). Runtime dependencies: `yaml` for frontmatter;
development dependency: Prettier. CI checks Node 20/22 on Linux/macOS/Windows,
syntax, formatting, manifests/skill discovery, offline tests and tarball installs.

Apache-2.0. [NOTICE](NOTICE) and [THIRD_PARTY.md](THIRD_PARTY.md) identify retained upstream
work and newly authored Omha code.
