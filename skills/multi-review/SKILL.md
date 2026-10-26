---
name: multi-review
description: Run an independent multi-agent code review of a commit, branch range or working tree with every installed reviewer CLI (Claude, Codex, Kimi Code, Kiro, Open Code Review or configured commands), triage the merged findings, settle disputes by blind vote and fix only verified issues. Use for parallel or cross-agent code review.
---

# Multi-review

You orchestrate: write one shared review context, launch independent reviewers,
verify and triage their findings yourself, put disputed items to a blind vote,
fix what is verified, then report only the outcome. Reviewers and voters never
see each other's output or your leaning.

Check `omha doctor --json`, then `omha review detect` from the target worktree.
Detection reports each reviewer as available or skipped with a reason (missing
command, disabled, unconfigured model). Use every available reviewer and ignore
the skipped ones; at least one is required, two or more give independence.
Reviewers come from `.omha/review.json` in the project, else `review.json` in
the Omha state directory, else built-in defaults; see the
[review example](../../examples/review.json) and [contracts](../../docs/contracts.md).
Reviewers are real provider CLIs and may incur charges on the user's selected
accounts.

## 1. Prepare

```bash
omha review prepare --commit SHA        # or --base REF [--head REF], or --working
```

It freezes the diff, creates a disposable read-only worktree and writes a context
skeleton. Without a stated target, review uncommitted changes with `--working`,
otherwise `HEAD`.

## 2. Write the shared context

Replace every `TODO(omha-review)` section of the returned `context` file: goal,
requirements and acceptance, constraints and settled decisions with source paths,
non-goals, and the two to five riskiest points. Draw on the conversation, commit
messages, issues, project rule files such as `AGENTS.md` or `CLAUDE.md`, and the
diff; mark inferences as inferred. `review start` refuses an unfinished context.

## 3. Review in parallel

```bash
omha review start --id REVIEW_ID [--reviewers claude,codex,kimi]
omha review wait --id REVIEW_ID --max-ms 1500000
omha review status --id REVIEW_ID
```

Each reviewer is an owned handoff: cmux first, then tmux, then a file handoff.
`status` shows whether each reviewer really runs: backend, full reference, PID,
liveness, exit code and idle time (`running`, `stalled`, `done`, `failed`,
`awaiting_handoff`). A file handoff starts nothing; give its `resumeCommand` to
the user or another agent. The wait budget defaults to 51 minutes from launch.
Repeat `wait` when the host limits one call; the deadline does not move. When
`outcome` is `deadline`, continue with the results that exist: running reviewers
are never cancelled, and you can merge again later. Relaunch a failed reviewer
once with `--reviewers NAME`; if it still fails, report it as absent.

## 4. Merge and triage

```bash
omha review merge --id REVIEW_ID
```

Return to the code for every cluster in `findings.md`. Classify each once:
**obvious** (you confirmed the defect with code evidence and the fix is unique and
respects the context), **disputed** (you cannot settle it, reviewers conflict, or
the fix has trade-offs or changes external behavior), **false positive** or
**noise** (behavior-neutral style). Reviewer severity is only a hint.

## 5. Vote on disputes

Write disputed items as `[{"id":"D1","file":"...","line":42,"title":"...",
"claim":"...","counter":"...","proposed_fix":"..."}]`. State your doubts in
`counter`, not your conclusion.

```bash
omha review vote --id REVIEW_ID --input disputed.json [--voters claude,codex,kimi]
omha review wait --id REVIEW_ID --kind vote --max-ms 1500000
omha review tally --id REVIEW_ID
```

The host fixes an item only with at least two valid ballots and a strict `fix`
majority; ties and missing ballots do not fix. Tally again when late ballots
arrive.

## 6. Fix, report, close

Fix obvious items and passed votes with minimal changes in the user's checkout,
add or adjust tests, run the project's own checks and commit per project rules.
Revert an item you cannot make pass and report it as unfixed. Report fixed items
(file:line, issue, source P0 or vote x:y, commit, test result), disputed items
left unfixed (issue, vote, main reason) and absent reviewers with reasons. Omit
false positives and noise. Finally run `omha review close --id REVIEW_ID`; it
refuses while reviewers still run unless the user accepts `--force`, and keeps the
evidence directory.

If the CLI is unavailable, review in the current session and say no independent
reviewers ran; never present one agent's opinions as a multi-agent review.
Installation and runtime contracts: [plugin guide](../../docs/plugin.md).
