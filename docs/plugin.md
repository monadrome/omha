# Claude Code Plugin

Auto compact is an opt-in native Mod in this same plugin. It defaults to a
57-minute cache timer and 20% context floor, with host budget/ownership checks;
see [activation and limits](auto-compact.md). It is inert without an explicit
`omha compact start` activation and requires Claude Code 2.1.290+. Missing CLI or
older Claude leaves prompt skills usable. The Mod never silently installs tools.

Omha has two install surfaces from one repository. The Claude Code plugin loads
prompt skills; the Node CLI owns deterministic execution and durable state. You
can use the prompt skills without installing the CLI. Runtime operations require
Node 20+, an installed `omha` executable and any selected provider/terminal tools.

## Install

From a checkout, install the CLI using [the README](../README.md#install-update-uninstall)
or `./install.sh`, then verify `omha doctor --json`. Load the plugin for one
session with `claude --plugin-dir /absolute/path/to/omha`.

For a persistent plugin installation, use the public Git marketplace:

```bash
claude plugin marketplace add monadrome/omha
claude plugin install omha@omha
```

For a local checkout, run `claude plugin marketplace add /absolute/path/to/omha`
instead. The local path must remain available for marketplace updates. The plugin
does not run npm, modify your provider configuration or install a global command.
Restart Claude Code after installing or updating to load the new skills.

Check the installed plugin with `claude plugin list --json`. On Claude versions
that support it, `claude plugin details omha@omha` lists the eight skills and
their token costs without a model call. Both manifests can be checked offline:

```bash
claude plugin validate /absolute/path/to/omha/.claude-plugin/plugin.json --strict
claude plugin validate /absolute/path/to/omha/.claude-plugin/marketplace.json --strict
```

## Use

Type a skill command in Claude Code, followed by your task:

```text
/omha:leader-agent Plan the investigation of this intermittent test failure.
/omha:roundtable Compare the two designs using the supplied measurements.
/omha:agent-handoff Prepare a continuation for another session.
/omha:project-memory Record the verified API decision for the next session.
/omha:auto-butterfly-effect Check whether this rework has a supported restart point.
/omha:auto-close Close this cmux surface or owned tmux worker pane after the goal and its checks finish.
```

The retained `/omha:butterfly-effect` and `/omha:hide` skills also remain available
with their upstream references and licenses. Claude can select relevant skills
from their descriptions. Skills receive the task as prompt context; no plugin
hook dispatches a provider by default. Explicit auto-compact activation allows
only the bounded native maintenance operation described above.
With an authorized cmux continuation, `auto-butterfly-effect` can gather history
evidence, bind a real checkpoint and drive the CLI fork/message/accept workflow.
The successor confirms takeover before optional source retirement; see
[cmux historical continuation](cmux-fork.md).
For completion cleanup, `auto-close` invokes the explicit CLI hook only after the
task is finished. The host verifies the calling owned surface and any supplied
run gates; a detached worker records the outcome and closes that surface or owned pane. It
installs no unconditional Stop hook. See [auto-close](auto-close.md).

`auto-recover` is deliberately CLI-only. It needs a durable timer, per-surface
deduplication across passes and cmux agent-state proof or a fresh worker-bound
tmux activity report before typing; a prompt skill cannot supply those guarantees. Run
`omha auto-recover --watch --allow-send --interval-ms 1500000` from a dedicated
terminal and inspect `omha auto-recover status`. See
[auto-recover](auto-recover.md) for classification and bounds.

| Work      | Prompt skill owns                               | CLI owns when needed                                  |
| --------- | ----------------------------------------------- | ----------------------------------------------------- |
| Planning  | Scope, decomposition, implementation choices    | Validated DAG, write gate, budgets, resume            |
| Decisions | Question, alternatives, evidence interpretation | Independent blind collection and host tally           |
| Handoff   | Continuation context and next action            | Owned terminal/file lifecycle and completion evidence |
| Drift     | Causal interpretation and revised prompt        | Host lifecycle observation, evidence gate and handoff |
| Memory    | Selection and wording of durable knowledge      | Scope, hashes, locks, indexes and bounded injection   |

Start uncertain work in the current session. Introduce a fixed workflow when its
inputs, side effects and acceptance rules are known. A prompt can propose a plan
or interpret evidence; host checks still decide permission, budgets, independence
and acceptance. See [contracts](contracts.md) for versioned inputs and API details.

## Runtime Prerequisites

Run runtime commands from the target project or worktree, rather than from the
plugin cache. Inspect provider profiles before dispatch: requested profile/model,
sandbox, timeout, budget and fallback must match the task and the user's chosen
billing channel. A scripted provider invocation can use API credit; a terminal
session can use subscription quota. Do not silently switch between them.

`omha doctor --json`, memory operations, explicit-history checks and file handoff
need no paid provider. Commands selecting real providers can incur charges. A
provider's successful exit proves a validated response, while project acceptance
and any required independent review determine whether the result is usable.

If `omha` is missing, continue useful reasoning and report that runtime operations
could not run. If a CLI operation fails, retain its result and evidence; a prompt
must never simulate a successful host gate or replace it with direct shell writes.

## Update And Remove

```bash
claude plugin marketplace update omha
claude plugin update omha@omha
claude plugin uninstall omha@omha
claude plugin marketplace remove omha
```

CLI updates and uninstall are separate; use the tarball/npm instructions in the
README. Plugin removal preserves CLI run records and memory. Candidate versions
are not implicitly npm releases, and no release or package publication is needed
to install from this Git repository.
