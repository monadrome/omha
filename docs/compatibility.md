# Compatibility matrix

| Capability              | Required                                                                 | Fallback                                               |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| Skills                  | A host that reads `SKILL.md`                                             | Copy/link `skills/`                                    |
| Claude Code plugin      | Claude Code plugin support                                               | Portable skills; CLI installs separately               |
| CLI                     | Node 20+                                                                 | None; skills remain portable                           |
| Provider                | Claude, Codex, Kimi or Kiro CLI                                          | Memory and file handoff                                |
| Visible handoff         | cmux                                                                     | tmux, then Markdown file                               |
| Git identity            | Git repository                                                           | Canonical real path                                    |
| Operating system        | macOS or Linux                                                           | None; Windows is not supported                         |
| Upstream Kimi read-only | External sandbox wrapper                                                 | Workspace-write only                                   |
| Personal Kimi modes     | Explicit `kimiProtocol: "kimi-personal/1"` and native `--execution-mode` | Fail closed on absent or mismatched run evidence       |
| JSON frontmatter        | Node 20+ with `yaml`                                                     | No provider required                                   |
| Live supervision        | Codex/Kimi/Kiro or command JSONL                                         | Silence/deadline supervision for nonstreaming adapters |
| Host acceptance         | Fixed local executable and bounded regular artifact files                | Fail closed on changed harnesses/unsupported snapshots |
| Status/watch            | Existing local records                                                   | Read-only snapshots; no provider or terminal probe     |

Omha supports macOS and Linux only. Windows is not supported or tested, and the
npm package declares `"os": ["darwin", "linux"]`.

Kimi print mode uses `--output-format stream-json -m MODEL -p PROMPT`.
Kimi Code 2.3 rejects `--auto` together with `-p`; print mode already selects
automatic approval. Explicit `/goal` prompts pass through unchanged. Upstream
read-only execution still requires the host's external sandbox wrapper.
An opt-in personal profile uses its native tool restriction and verifies mode
and request identity in the run stream. Ordinary read-only execution retains a
Goal; explicit tool-free execution returns one text answer with no model tools
or autonomous Goal. A generated tool call in tool-free mode fails. Native tool
restrictions permit Kimi's own session/config writes and do not provide an OS sandbox.

Kiro CLI 2.34 runs headless through `kiro-cli chat --agent-engine v3
--output-format stream-json --no-interactive`; an install without the V3 engine
fails closed. Kiro still loads the user's global steering, skills, hooks and agent
configuration and may persist its own session. Read-only relies on
non-interactive tool denial plus the host's completed-tool check; user hooks that
run commands on tool events are outside that check.

The terminal probe treats cmux RPC/schema differences as a capability downgrade:
it records bounded command diagnostics, verifies a file handoff fallback, and
continues with exit status 0 when tmux and offline checks pass. A real cmux probe
still verifies full UUID ownership and preserves the pre-existing workspace set.
