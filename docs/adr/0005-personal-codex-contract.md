# 0005: Qualify Explicit Personal Codex Sessions

Accepted: 2026-10-24.

- Require `codexProtocol: "codex-personal/1"` and a fork-only CLI flag before
  qualifying tool-free Codex roles. Unknown config keys in upstream Codex do not
  enforce a boundary. Preserve explicit host sandbox selection.
- Keep worker Goals and durable history; tool-free reasoning uses one response,
  an empty startup tool ceiling and no autonomous Goal. Validate matching startup
  metadata and completion evidence without treating Goal status as acceptance.
- Read-only workers must restrict external and mutating model tools as well as
  terminal filesystem access. A native allowlist and matching startup evidence
  enforce that boundary while retaining Goal and Code Mode controls.

Contracts: [providers and completion](../contracts.md),
[security limits](../security.md).
