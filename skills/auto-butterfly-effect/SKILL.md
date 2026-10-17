---
name: auto-butterfly-effect
description: Detect causal artifact rework and continue from a supported history point using cmux forks, structured agent messages and successor-confirmed source closure. Use when a long-running task drifted or the user requests automatic butterfly-effect continuation; never claim files or the original session were restored.
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

## Native cmux continuation

When the user authorizes continuing from an earlier session location, carry the
workflow through the existing CLI. Read the
[native fork contract](../../docs/cmux-fork.md). Keep the retained upstream
butterfly-effect skill unchanged: it identifies the causal boundary; Omha owns
fork execution, ownership, messaging and source retirement.

1. Run `omha handoff adopt` in the source agent's cmux terminal and original
   worktree, then `omha handoff checkpoints --id SOURCE_ID`. Use actual UUIDs,
   native session binding and timeline anchors. Do not guess a session, convert
   task attempt IDs into turn numbers, or scrape screens when structured history
   exists.
2. Establish chronological artifact versions, applicable original requirements,
   authoritative feedback, actual rework and the causal action from the available
   session. Preserve objective and accepted decisions. If the boundary cannot be
   aligned to a real native checkpoint, return advice and name the evidence gap.
3. Persist the supported history and host fork binding (`sourceHandoffId`,
   detector `actionId`, exactly one real `checkpoint` or `turn`, `closeSource`).
   Use `omha auto-butterfly --input history.json --fork fork.json --allow-write`.
   Choose `closeSource:true` when the user requested replacing/retiring this
   session. Existing task authorization carries forward; do not request the same
   permission again. An unresolved write authorization or human gate stays closed.
4. Inspect the returned handoff state. `awaiting_acceptance` means the new session
   has received a queued continuation request, not that it has taken over. The
   successor must run `omha handoff accept --id FORK_ID` before task actions;
   that host check validates its native identity and prompt hash, then closes
   only the owned source surface if requested. The source must stop task writes
   after requesting takeover. Never close it before successor acceptance.
5. Use `omha handoff message --id FORK_ID --prompt TEXT` for follow-up context.
   Do not inject keystrokes into the TUI or silently launch a headless provider.
   Report the native checkpoint, fork handoff ID, message receipt and whether
   source closure is pending, confirmed or uncertain. Never repeat an uncertain
   fork or claim a conversation/file restoration.

The supported native providers are Claude and Codex with structured cmux resume
records. Missing capabilities, ownership conflicts and failed message delivery
retain the source. History forks do not reset the current worktree; the successor
must inspect and verify files before writing. No background watcher is installed.

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
