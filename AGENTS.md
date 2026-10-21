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
| Session fork        | sealed prefix and snapshot         | same-route/model + budget/name gates    | 2-8 isolated Arena lanes    |

| Layer                     | Status                                                                                            | Gap                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Execution channel**     | native headless adapters plus owned cmux / tmux / file handoffs                                   | Codex/Kimi JSONL stream live summaries; Claude remains native completion JSON. Preserve billing channels.               |
| **Cross-CLI integration** | adapter argv per provider (`lib/adapters.mjs`)                                                    | No ACP (Agent Client Protocol, JSON-RPC over stdio). Standardizing here removes per-agent glue                          |
| **Capability model**      | validated interactive / headless / tool-free / read-only tiers                                    | Host routing rejects incompatible and excluded profiles before launch. External wrappers cannot claim unverified tiers. |
| **Auto rewind**           | Leader detects rework; native cmux forks message successors and retire sources after acceptance   | Native forks need real checkpoints; semantic feedback needs evidence. No in-place transcript or file restore.           |
| **Auto review**           | isolated, author-independent review with frozen diff/test/acceptance evidence                     | Host policy chooses reviewer/criteria; pending reviews resume without replaying writes.                                 |
| **Auto group decision**   | host thresholds automatically invoke blind voters and valid chair before tasks                    | Human gates and failed/split/invalid outcomes remain closed until resolved; policies cannot come from the planner.      |
| **Escalation / takeover** | live event watchdog, durable escalation and CLI stderr notifications                              | Read-only takeover uses existing fallbacks only, at most 3 times. Writes become interrupted and need explicit replay.   |
| **Input-wait detection**  | structured inputWait summaries from live JSONL events                                             | Nonstreaming adapters and terminal handoffs retain timeout/manual observation; no inferred live signal is claimed.      |
| **Session fork**          | sealed byte-identical host prefix, deterministic names, isolated lanes and normalized cache usage | Hidden CLI prompt/tool bytes and provider KV lifetime remain unknown; only explicit usage proves cache reads.           |

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

- Context pointers: read [ADR index](docs/adr/README.md) before changing an
  architectural boundary. ADRs record only key accepted/rejected decisions and
  one or two rationale bullets; keep detailed contracts in feature docs.
- For auto compact, read [runtime contract](docs/auto-compact.md) and the linked
  ADRs; use [review](docs/auto-compact-review.md) for historical tradeoffs.
- For execution, terminal and memory boundaries, read
  [architecture](docs/architecture.md), [contracts](docs/contracts.md) and
  [security](docs/security.md) when touching those modules.

- Extend the existing modules (`lib/runner.mjs`, `lib/orchestrator.mjs`,
  `lib/terminal.mjs`, `lib/memory.mjs`, `lib/backends.mjs`). Do not build a second
  parallel implementation of something already here.
- Every new capability needs an offline test covering its failure paths.
  Default verification never calls a metered provider.
- Keep one bounded change per iteration. Run the checks, update the docs and
  changelogs, then commit and push.

## Claude Code Plugin

The Claude Code plugin is a first-class distribution surface, not an optional
extra. The repository must stay loadable both as `claude --plugin-dir <repo>`
and as `omha@omha` from the Git marketplace. Prompt-only use must work without
the CLI; runtime commands may require it.

- **Shipped files.** Keep `.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`, `skills/*/SKILL.md`, `skills/README.md` and
  `docs/plugin.md` present and consistent. `package.json` must keep
  `.claude-plugin` and `skills` in `files`.
- **One identity.** Plugin and marketplace names stay `omha`; the marketplace
  source stays `./`; every manifest version matches `package.json`. A release
  version bump updates all three together. Never add a second plugin manifest or
  a provider-specific fork of the skill set.
- **Skill contract.** Skills own open-ended reasoning and discovery; the CLI
  owns validated execution. Every `SKILL.md` has valid frontmatter, references
  only commands that exist, tolerates an absent CLI or provider, and contains no
  secrets, machine-specific absolute paths, automatic hooks or silent installs.
- **Host boundary applies to prompts.** A skill may propose an action but cannot
  grant permission, bypass budget/concurrency/ownership gates, or turn a host
  check into prompt text. Execution always routes through CLI validation.
- **No capability inflation.** Do not claim a capability, cache hit or provider
  guarantee in plugin docs that the CLI cannot validate. Unknown stays unknown.
- **Capability coverage.** A new user-facing lifecycle capability needs either a
  discoverable skill entry point or an explicit note in `docs/plugin.md`
  explaining why it is CLI-only.
- **Verification.** Plugin-affecting changes pass
  `claude plugin validate .claude-plugin/plugin.json --strict`,
  `claude plugin validate .claude-plugin/marketplace.json --strict` and
  `npm run pack:check`. The pack check covers tarball contents plus plugin
  install/list in a clean home. If `claude` is unavailable or the local npm
  cannot run the pack check, run the offline manifest and packaging checks and
  report the skipped check; never claim it passed.
- **Docs stay linked.** Changing a skill or a plugin-visible workflow updates
  `docs/plugin.md` and `skills/README.md`. New skills need an offline test of
  every CLI path they reference, when that path is executable.

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
