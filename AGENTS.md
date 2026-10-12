# Omha Agent Instructions

## Goal

Omha exists to **maximize agent automation**: a user states intent, and the
system carries out detection, routing, execution, review, group decision and
escalation without further prompting — while every automatic step stays bounded,
observable, and auditable.

The target is not "an LLM can operate this CLI". It is **the CLI drives the
lifecycle itself**. Automation raises trigger coverage and observability. It never
lowers an existing guarantee.

## Automation Capability Map

Each target has three parts: **observe** (know when it applies), **decide** (choose
an action), **act** (carry it out). Read "Status" and "Gap" as the backlog.

| Target              | Observe                          | Decide                                  | Act                        |
| ------------------- | -------------------------------- | --------------------------------------- | -------------------------- |
| Auto execution      | user intent, run state           | `leader` plan validation + write gate   | PTY handoff, DAG (exists)  |
| Auto handoff        | task type, load, rate limit      | backend choice (cmux→tmux→file, exists) | owned terminal (exists)    |
| Auto rewind         | artifact hash drift              | butterfly evidence gate (exists)        | handoff to earliest point  |
| Auto review         | change exists, author identified | **not implemented**                     | **not implemented**        |
| Auto group decision | risk, ambiguity, write magnitude | roundtable tally (exists)               | **manual invocation only** |
| Auto escalation     | stall, long silence, input wait  | **not implemented**                     | notify + takeover          |

| Layer                     | Status                                                                        | Gap                                                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Execution channel**     | terminal only (`lib/backends.mjs`: cmux / tmux / file)                        | No headless structured channel. `claude -p --output-format stream-json` and `codex exec --json` give exact turn boundaries, tool calls, file changes and usage — strictly better than screen scraping, and usable for cheap parallel fan-out |
| **Cross-CLI integration** | adapter argv per provider (`lib/adapters.mjs`)                                | No ACP (Agent Client Protocol, JSON-RPC over stdio). Standardizing here removes per-agent glue                                                                                                                                               |
| **Capability model**      | profiles declare adapter, model, sandbox, budget, retry, circuit              | No declared capability tiers such as interactive / headless / tool-free / read-only, so routing cannot reason about them                                                                                                                     |
| **Auto rewind**           | `butterfly` / `auto-butterfly` require an explicit chronological history JSON | No automatic detection loop. Turn "explicit evidence in" into "subscribe to an event stream, detect drift, act"                                                                                                                              |
| **Auto review**           | review is only a task type                                                    | No review pipeline: isolated reviewer, diff plus test evidence, spec-consistency check, and a rule that the party under review never rules on its own result                                                                                 |
| **Auto group decision**   | blind voters plus host tally (exists)                                         | No automatic trigger. The system should invoke a roundtable when risk, ambiguity or write magnitude crosses a threshold, not ask a human at every step                                                                                       |
| **Escalation / takeover** | notifications (`set-progress`, `notify`), timeouts, `handoff cancel`          | No supervision loop. Detect stall, no-progress or input-wait and notify proactively instead of relying on a human polling the screen                                                                                                         |
| **Input-wait detection**  | indirect heuristics (see `send` / `read-screen` in `lib/backends.mjs`)        | "The agent is waiting for an answer" is inferred from timeout or paste verification, not from a structured signal                                                                                                                            |

## Automation Invariants

Automation must never bypass an existing safety layer. It only lowers the trigger
threshold.

- Every present guarantee stays: fail-closed validation, ownership tokens,
  budget and concurrency gates, append-only event logs, and offline-by-default
  checks. **Reject any change that relaxes a guarantee in order to automate.**
- **The host owns the boundary; prompts only inform.** Whether an action is
  permitted is decided by host validation, never delegated to a prompt. An LLM may
  propose, but the host decides. Conversely, do not turn a host check into prompt
  text.
- **Screen scraping is the last resort, not the default.** Prefer structured
  channels (provider event streams, status APIs, ACP). New capability first asks
  whether an event stream already exists; only fall back to reading scrollback.
- **Billing follows the channel.** Scripted invocation consumes API credit, while
  a process inside a terminal may consume subscription quota. Automation must not
  silently move work across that line.
- **CLI exit status is validated output, never correctness.** Automation must not
  treat an exit code as proof that a coding task is right; acceptance checks are
  separate.
- An automated action must leave the same evidence trail a manual one would:
  requested versus served profile/model, attempts, budget, hashes, and outcome.

## Working On This

- Extend the existing modules (`lib/runner.mjs`, `lib/orchestrator.mjs`,
  `lib/terminal.mjs`, `lib/memory.mjs`, `lib/backends.mjs`). Do not build a second
  parallel implementation of something already here.
- Every new capability needs an offline test covering its failure paths.
  Default verification never calls a metered provider.
- Keep one bounded change per iteration. Run the checks, update the docs and
  changelogs, then commit and push.

## Naming

The project is **Omha** (`omha`). Use it consistently across every surface:

| Surface               | Value                                              |
| --------------------- | -------------------------------------------------- |
| CLI binary            | `omha` (`bin/omha.mjs`)                            |
| npm package           | `@huatalk/omha`                                    |
| GitHub repository     | `monadrome/omha`                                   |
| Plugin / marketplace  | `omha` / `omha@omha`                               |
| Environment variables | `OMHA_HOME`, `OMHA_NPM_PREFIX`, `OMHA_PROMPT_FILE` |
| Project configuration | `.omha/providers.json`                             |
| State directory       | `$XDG_STATE_HOME/omha`, `$HOME/.local/state/omha`  |
| Worker final marker   | `OMHA_FINAL:`                                      |
| Terminal ownership    | `@omha-owner` (tmux), `omha-owner` (cmux)          |
| Skill namespace       | `omha:*`                                           |

- **Keep exactly one active implementation.** Do not add aliases, renamed-symbol
  shims, legacy configuration fallbacks, or migration paths for earlier names.
- The worker completion marker is defined once as `FINAL_MARKER` in
  `lib/core.mjs`. Always derive offsets from `FINAL_MARKER.length`; never
  hardcode the prefix length.

## Git Delivery

- This project must automatically commit and push completed changes.
- **Commit and push directly to `main`.** Omha is in early development; do not
  open branches or pull requests for ordinary changes.
- Run the checks appropriate to the changes, commit the task's files, and push.
  A push to `main` is standing user authorization; do not ask for confirmation.
- Preserve unrelated changes: commit only what the task touched and leave other
  work in progress alone.
- Use ordinary pushes without force. If `main` has moved, reconcile before
  pushing.
- Version bumps, release tags and package publishing still require their own
  task authorization. Read `docs/releasing.md` when performing a release.
