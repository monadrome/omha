# Architecture Decisions

ADRs record only consequential accepted or rejected decisions and one or two
reasons. Keep implementation details in the linked feature documents. Add a new
record when changing a decision; mark the old record superseded rather than
silently rewriting its history.

| Record                                          | Decision                                                                         | Context                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| [0001](0001-native-auto-compact.md)             | Use a native Claude Mod with host admission for auto compact                     | [Runtime contract](../auto-compact.md)       |
| [0002](0002-compact-evidence-and-recovery.md)   | Re-arm from cache evidence; persist intent and budget before native execution    | [Reviewed design](../auto-compact-review.md) |
| [0003](0003-terminal-fallback.md)               | Prefer cmux, fall back to owned tmux workers without replaying uncertain actions | [Terminal backends](../terminal-backends.md) |
| [0004](0004-personal-kimi-modes.md)             | Qualify explicit personal Kimi modes with tool restrictions and run evidence     | [Provider contract](../contracts.md)         |
| [0005](0005-personal-codex-contract.md)         | Qualify personal Codex with durable Goals and enforced tool-free roles           | [Provider contract](../contracts.md)         |
| [0006](0006-native-goal-stop-classification.md) | Classify native Goal stops before incidental provider words                      | [Provider contract](../contracts.md)         |
