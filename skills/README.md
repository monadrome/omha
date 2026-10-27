# Omha skills

The Claude Code plugin discovers the ten `*/SKILL.md` files in this directory.
Use `/omha:leader-agent`, `/omha:roundtable`, `/omha:agent-handoff`,
`/omha:auto-butterfly-effect`, `/omha:auto-close`, `/omha:multi-review`,
`/omha:concise-report`, `/omha:project-memory`, `/omha:butterfly-effect`
or `/omha:hide` in a session with the plugin enabled.

Skills guide reasoning: decomposition, evidence interpretation, decisions and
memory curation. Open-ended work can stay in the current agent session. Once
the inputs and execution boundary are explicit, use the CLI for durable DAGs,
provider routing, blind collection, terminal ownership and memory storage.
Prompt instructions cannot replace host permission or acceptance checks.
For example, `agent-handoff` may propose the opt-in native fork compact/rename
flags, but the CLI alone validates and orders them. It also writes the user's
verbatim requests and its own brief as separate files; the CLI assembles,
labels and sanitizes them and resolves `--agent` targets from the global
registry, which only the user maintains through `omha agents`.

Personal Codex selection is a CLI provider contract, configured through
`codexProtocol: "codex-personal/1"`; it does not change skill discovery or install
another executable. See [provider contracts](../docs/contracts.md).

Read-only personal Codex roles use the CLI's native tool ceiling as well as its
filesystem sandbox; prompt skills cannot grant additional tools.

`/omha:auto-close` retains the user's cleanup intent until a goal and its checks
finish, then invokes the CLI's owned completion hook to close the current cmux
surface or Omha-owned tmux worker pane. It needs the CLI and a verified calling
terminal binding; see the
[auto-close guide](../docs/auto-close.md). Ordinary replies do not trigger cleanup.

The opt-in [auto compact Mod](../docs/auto-compact.md) maintains an explicitly
activated native Claude session; no prompt skill or install starts it. It needs
the CLI and supported Claude version. Its configuration and execution are CLI-only
because prompts cannot provide timer, budget or ownership guarantees.

The plugin does not install the CLI. Run
`omha doctor --json` before using runtime commands; see the
[plugin guide](../docs/plugin.md) for installation, prerequisites and examples.
The retained `butterfly-effect` and `hide` skills keep their upstream contracts,
references and MIT licenses.

`/omha:hide` retains hiding-skill 1.0.0 and cleans selected files without the CLI.
Session previews stop at findings; credential findings include a rotation warning
before cleanup selection.

`/omha:multi-review` keeps triage, fixes and the final report in the current
session. `omha review` owns the frozen inputs, reviewer detection, owned
reviewer handoffs, normalized findings and the strict-majority vote tally; a
prompt cannot mark a reviewer as having run. See the
[review contract](../docs/contracts.md#multi-review).

`/omha:concise-report` formats final answers, status checks and handoff notes
without the CLI: a result-first brief report by default, or a full report with
the fixed Overview / Goal / User Intent / Decisions / Technical / Status / Next /
Conversation Outline sections for checkpoints and handoffs. A full report can be
the body of an `/omha:agent-handoff` prompt file. It cannot mark a skipped or blocked
check as passed.
