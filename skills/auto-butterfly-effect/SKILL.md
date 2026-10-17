---
name: auto-butterfly-effect
description: Detect a changed or reworked task artifact, preserve the evidence, and invoke butterfly-effect analysis with an optional terminal handoff. Use when a long-running agent task may have drifted; never claim that history was actually rewound.
---

# Auto butterfly effect

Interpret the available history in the current session first. If the evidence is
in conversation form, the retained
[butterfly-effect skill](../butterfly-effect/SKILL.md) can diagnose it directly;
do not write a parser or fabricate chronology to force a runtime workflow.

When explicit chronological artifact/feedback records are available, check
`omha doctor --json`, prepare `history.json` using the
[history schema](../../schemas/history.schema.json), and run:

```bash
omha auto-butterfly --input history.json
```

The default check is offline advice. `--analyze --profile analyst --config
providers.json` invokes a provider and may incur charges; `--handoff --backend
file` preserves a supported continuation prompt without launching a worker.
Leader automatically observes write tasks with frozen host acceptance checks,
detects supported rework on completion/resume, and prepares a bounded file
handoff without history JSON or another model call. See
[automatic butterfly](../../docs/automatic-butterfly.md) for host policy and
limits. This does not install a background watcher or perform a session rewind.
Return no-op when the evidence is insufficient; explain the missing evidence
without treating every hash change as drift.

Use `omha auto-butterfly` (or the equivalent host shell command) as a
wrapper around the `butterfly-effect` contract. Supply a versioned artifact and
chronological transcript input. Record artifact versions, hashes, authoritative
feedback, causal actions and the time. A changed file alone is evidence of
change, not proof of causal drift. Ask the rewind skill to diagnose whether the
artifact was reworked because it missed its expected outcome.

If a reliable rewind point exists, return the upstream recommendation and
updated prompt. With `--handoff`, create a new cmux/tmux/file session;
it must preserve the prompt and pointer and must never delete or close an
existing user workspace.

Installation and runtime boundaries: [plugin guide](../../docs/plugin.md).
