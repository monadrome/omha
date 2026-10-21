# ADR 0001: Native Auto Compact

Status: Accepted

Decision: Use the existing Omha plugin's Claude Mod for local timers and native
`session.compact`, with the CLI owning admission. Activation is explicit and
disables only native idle compaction for that session.

Rationale:

- A native operation preserves the current session, permissions and billing channel.
- Host validation keeps configuration, budgets and ownership outside prompts.

Rejected: Sending `/compact` as model text, simulating TUI keys, disabling normal
context-limit recovery, or starting another headless provider to summarize.

Context: [Auto Compact](../auto-compact.md).
