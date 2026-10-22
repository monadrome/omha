# 0003: Prefer cmux, Fall Back To Owned tmux Workers

Accepted: 2026-10-22.

- Keep cmux first for new handoffs and recovery discovery; extend the existing
  tmux backend for owned worker activity and completion cleanup. Native history
  and structured agent messages remain cmux-only until a provider adapter can
  verify equivalent session and checkpoint evidence.
- Fall back only before a task may have started. Ownership failures, uncertain
  launches, uncertain cleanup and recovery submissions never cause automatic
  replay on another backend. A fresh worker-bound idle report permits one tmux
  recovery submission; terminal output alone cannot authorize input.

Contracts: [terminal backends](../terminal-backends.md),
[recovery](../auto-recover.md), [completion cleanup](../auto-close.md).
