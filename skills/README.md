# Omha skills

The Claude Code plugin discovers the eight `*/SKILL.md` files in this directory.
Use `/omha:leader-agent`, `/omha:roundtable`, `/omha:agent-handoff`,
`/omha:auto-butterfly-effect`, `/omha:auto-close`, `/omha:project-memory`, `/omha:butterfly-effect`
or `/omha:hide` in a session with the plugin enabled.

Skills guide reasoning: decomposition, evidence interpretation, decisions and
memory curation. Open-ended work can stay in the current agent session. Once
the inputs and execution boundary are explicit, use the CLI for durable DAGs,
provider routing, blind collection, terminal ownership and memory storage.
Prompt instructions cannot replace host permission or acceptance checks.

Personal Codex selection is a CLI provider contract, configured through
`codexProtocol: "codex-personal/1"`; it does not change skill discovery or install
another executable. See [provider contracts](../docs/contracts.md).

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
