# 0006: Classify Native Goal Stops Before Provider Text

Accepted: 2026-10-24. Extends [0004](0004-personal-kimi-modes.md).

- Parse personal Kimi exit codes 3/6 with the existing structured completion
  validator. A stopped Goal remains a non-retryable task failure; nonzero exits
  cannot become successful responses.
- Assistant/tool output and timing numbers are not provider diagnostics. Searching
  them for capacity words can replay a write after its Goal already stopped.
  Preserve process/stream failures and ordinary upstream provider classification.

Contract: [provider completion](../contracts.md).
