# 0004: Qualify Explicit Personal Kimi Execution Modes

Accepted: 2026-10-24.

- A profile must opt in to `kimi-personal/1` before Kimi can supply native
  read-only or tool-free execution. Pass the mode explicitly and require
  matching opening/final run evidence. Preserve upstream Kimi behavior.
- Full and read-only execution keep native Goal completion. Tool-free is one
  context-only response with zero model tools and no autonomous Goal, so it can
  serve blind planning/review without exposing a Goal tool. This exception is
  host-selected and cannot be granted by provider output. Tool restrictions do
  not claim OS isolation; executable provenance remains trusted configuration.

Contracts: [providers and completion](../contracts.md),
[security limits](../security.md).
