---
name: concise-report
description: Write result-first reports for final answers, status checks, checkpoints and handoff notes, using a fixed section layout modeled on Kiro CLI v3 compaction summaries. Use when the user cares about outcomes rather than process, for long-running tasks, or when another session must continue the work.
---

# Concise report

The reader wants the outcome, not the steps that produced it. Give the result
first, then what was verified, what is still open and what the user needs to
decide. Leave out narration ("first I…, then I…"), restated plans, tool logs and
closing recaps. Write in the user's language and keep identifiers as they are.

Pick one of two layouts.

## Brief report

The default at the end of a turn or a task. Use plain prose or terse lines:

1. **Result** in the first sentence: what now exists, what changed, or the
   answer. If the task failed or is incomplete, say so first.
2. **Status**, only the parts that apply: verified checks with how each was
   verified, checks that were skipped or blocked with the reason, and remaining
   work.
3. **Decisions** the user must make, or choices you made that they would want
   to reverse, with the rejected alternative.
4. **Next**: one action, or a question that waits for the user.

Include paths, commands, error text, IDs and links only when the reader needs
them to act. A simple answer can be one to three sentences without headings.

## Full report

Use this layout for checkpoints, handoffs, context compaction, or when the user
asks for a full report. Every section is required; write `(none)` when one is
empty, so the reader can tell "nothing" from "forgot".

```markdown
## Overview

2-4 sentences: what the work is about, where it stands, and anything the
sections below cannot capture.

## Goal

One line: the objective and its constraints.

## User Intent

The user's key requests, quoting their exact words for names, files, values
and constraints.

## Decisions

Each choice made, the rejected alternatives and why.

## Technical

Exact paths, commands, errors, function names, IDs and versions.

## Status

Done: completed items
Now: the current task
Blocked: issues, with the reason

## Next

Ordered action items.

## Appendix - Conversation Outline

Oldest first, one line per turn: "user: <request>" / "agent: <what it did or
found>".
```

Rules for both layouts:

- One fact per line. No greetings and no reprinting code that is already on disk.
- Copy file paths, error messages, commands, names and values exactly; do not
  paraphrase them.
- Mark what you verified apart from what you inferred. Name the evidence for
  each verified claim: a test run, command output, a file you read.
- Report each check separately. A check that was skipped, blocked, timed out or
  only partly ran is never "passed".
- Do not drop bad news to keep the report short: failures, failing tests,
  security warnings and destructive-action confirmations stay in full.

A full report can be the body of the prompt file for
[agent-handoff](../agent-handoff/SKILL.md). This skill only formats the report.
It grants no permission, starts nothing, and cannot stand in for a host
acceptance or review gate. It needs no CLI.
