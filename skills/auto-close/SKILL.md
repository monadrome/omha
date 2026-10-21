---
name: auto-close
description: Close the current cmux task tab after the user's goal and acceptance checks are complete. Use when the user requests automatic session cleanup or self-close on completion.
---

# Auto-close

Use this when the user has requested closing the current task tab on completion.
If work remains, retain that cleanup intent and finish the active goal first.
Do not interpret a single reply ending, idleness, input wait, failed check or
interrupted goal as completion. Keep execution and acceptance under the existing
host gates; this skill grants no additional task permissions.

Before closing, persist the result, test evidence and any handoff the user needs.
Check `omha doctor --json`. If the CLI or native cmux session binding is absent,
keep the tab open and report the unavailable cleanup. Do not install tools,
change provider settings or replace validation with a direct terminal command.

As the final task operation, from the original cmux session and worktree, run:

```bash
omha auto-close --completed --reason 'Goal completed; acceptance checks passed'
```

For work executed as an Omha Leader run, include `--run-id RUN_ID` so the host
verifies its configured acceptance, review and decision gates. Without a run ID,
completion is explicitly caller-reported and does not certify correctness.
Omit `--id` to register or reuse the calling native surface; never supply another
session's ID. The command schedules a detached close after 1.5 seconds and only
targets that surface. It preserves other tabs and splits. A repeated request
does not start another closer; uncertainty requires inspection and manual cleanup.

The command is the explicit completion hook. Do not attach it unconditionally to
Stop or generic turn-complete events, which do not prove that a goal is finished.
No global hooks are installed by this skill.

Contract and status inspection: [auto-close guide](../../docs/auto-close.md).
