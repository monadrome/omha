# Compatibility matrix

| Capability            | Required                                                  | Fallback                                               |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| Skills                | A host that reads `SKILL.md`                              | Copy/link `skills/`                                    |
| Claude Code plugin    | Claude Code plugin support                                | Portable skills; CLI installs separately               |
| CLI                   | Node 20+                                                  | None; skills remain portable                           |
| Provider              | Claude, Codex, or Kimi CLI                                | Memory and file handoff                                |
| Visible handoff       | cmux                                                      | tmux, then Markdown file                               |
| Git identity          | Git repository                                            | Canonical real path                                    |
| Native process groups | POSIX                                                     | Windows uses file/fake degradation                     |
| Kimi read-only        | External sandbox wrapper                                  | Workspace-write only                                   |
| JSON frontmatter      | Node 20+ with `yaml`                                      | No provider required                                   |
| Live supervision      | Codex/Kimi or command JSONL                               | Silence/deadline supervision for nonstreaming adapters |
| Host acceptance       | Fixed local executable and bounded regular artifact files | Fail closed on changed harnesses/unsupported snapshots |
| Status/watch          | Existing local records                                    | Read-only snapshots; no provider or terminal probe     |

On Windows, npm places the global launcher directly under the configured prefix
instead of `<prefix>/bin`; native process groups, tmux and cmux probes are
skipped and file handoff remains available.

Kimi print mode uses `--output-format stream-json -m MODEL -p PROMPT`.
Kimi Code 2.3 rejects `--auto` together with `-p`; print mode already selects
automatic approval. Explicit `/goal` prompts pass through unchanged. Read-only
execution still requires the host's external sandbox wrapper.

The terminal probe treats cmux RPC/schema differences as a capability downgrade:
it records bounded command diagnostics, verifies a file handoff fallback, and
continues with exit status 0 when tmux and offline checks pass. A real cmux probe
still verifies full UUID ownership and preserves the pre-existing workspace set.
