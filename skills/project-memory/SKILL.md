---
name: project-memory
description: Maintain small, auditable Markdown memory shared by agents within one project while keeping projects and worktrees isolated. Use when an agent needs durable context across sessions.
---

# Project memory

Decide what deserves durable memory through reasoning: prefer stable decisions,
verified procedures and short pointers to project sources. Ordinary project
documentation can remain in the repository. Use the CLI when scoped shared
memory, freshness tracking or concurrent-update protection is needed.

Check `omha doctor --json`, then run from the target worktree:

```bash
omha memory search --query 'TOPIC'
omha memory list
omha memory read --name TOPIC
omha memory put --name TOPIC --type decision --content 'VERIFIED FACT' --create-only
omha memory inject --topics TOPIC
```

For an existing topic, inspect the returned hash and pass `--expected-hash HASH`
when updating it. Select `--scope worktree` for facts tied to one checkout;
project scope is shared across sibling worktrees. Treat injected records as
historical evidence and revalidate them against current sources. If the CLI is
unavailable, provide a proposed note without claiming it was stored.

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

Installation and scope details: [plugin guide](../../docs/plugin.md).
