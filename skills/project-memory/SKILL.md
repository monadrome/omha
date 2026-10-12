---
name: project-memory
description: Maintain small, auditable Markdown memory shared by agents within one project while keeping projects and worktrees isolated. Use when an agent needs durable context across sessions.
---

# Project memory

Use `omha memory` to initialize, read, search, and write memory. The
canonical Git root determines the project identity, so worktrees share a
project index; non-Git workspaces use a real-path identity. `MEMORY.md` is an
index of pointers and topic files contain the content. Include provenance,
type, scope, freshness and update time. Use expected hashes for concurrent
updates and surface
`memory_conflict` rather than overwriting another agent. Never write secrets,
transcripts, or private user memory into project-shared topics. Reject path
traversal, symlink/hardlink records and stale-lock ownership changes. Inject
only bounded pointers/topics and report stale warnings.
