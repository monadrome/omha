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

| Target              | Observe                            | Decide                                  | Act                         |
| ------------------- | ---------------------------------- | --------------------------------------- | --------------------------- |
| Auto execution      | user intent, run state             | `leader` plan validation + write gate   | PTY handoff, DAG (exists)   |
| Auto handoff        | task type, load, rate limit        | backend choice (cmux→tmux→file, exists) | owned terminal (exists)     |
| Auto rewind         | artifact hash drift                | butterfly evidence gate (exists)        | handoff to earliest point   |
| Auto review         | task completion, frozen evidence   | host review criteria + author exclusion | lifecycle review + resume   |
| Auto group decision | host risk/ambiguity/write signals  | threshold trigger + blind host tally    | Leader decision gate        |
| Auto escalation     | live progress, silence, input wait | bounded supervision policy              | notify + read-only takeover |

| Layer                     | Status                                                                                          | Gap                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Execution channel**     | native headless adapters plus owned cmux / tmux / file handoffs                                 | Codex/Kimi JSONL stream live summaries; Claude remains native completion JSON. Preserve billing channels.               |
| **Cross-CLI integration** | adapter argv per provider (`lib/adapters.mjs`)                                                  | No ACP (Agent Client Protocol, JSON-RPC over stdio). Standardizing here removes per-agent glue                          |
| **Capability model**      | validated interactive / headless / tool-free / read-only tiers                                  | Host routing rejects incompatible and excluded profiles before launch. External wrappers cannot claim unverified tiers. |
| **Auto rewind**           | Leader observes frozen acceptance/artifact evidence, detects rework and hands off automatically | Arbitrary terminal sessions and semantic feedback still need explicit chronological evidence; no actual session rewind. |
| **Auto review**           | isolated, author-independent review with frozen diff/test/acceptance evidence                   | Host policy chooses reviewer/criteria; pending reviews resume without replaying writes.                                 |
| **Auto group decision**   | host thresholds automatically invoke blind voters and valid chair before tasks                  | Human gates and failed/split/invalid outcomes remain closed until resolved; policies cannot come from the planner.      |
| **Escalation / takeover** | live event watchdog, durable escalation and CLI stderr notifications                            | Read-only takeover uses existing fallbacks only, at most 3 times. Writes become interrupted and need explicit replay.   |
| **Input-wait detection**  | structured inputWait summaries from live JSONL events                                           | Nonstreaming adapters and terminal handoffs retain timeout/manual observation; no inferred live signal is claimed.      |

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
