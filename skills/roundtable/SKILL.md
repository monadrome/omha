---
name: roundtable
description: Run independent multi-agent proposals, preserve evidence and dissent, and synthesize a decision with an explicit confidence. Use when a choice needs several perspectives rather than one agent's answer.
---

# Roundtable

Clarify the question, alternatives and available evidence in the current session.
Use direct reasoning for a discussion that needs one agent's judgment. Use the
CLI when independent blind votes and a durable host tally are required; a single
agent simulating several opinions cannot provide that independence.

Check `omha doctor --json` and the configured voter profiles before dispatch.
Prepare `decision.json` following the
[decision example](../../examples/decision.json), with identical public evidence
anchors and two or three voter profiles, then run from the target worktree:

```bash
omha roundtable --input decision.json --config providers.json
omha decision status --id DECISION_ID
```

This invokes configured providers and may incur charges. Resolve a pending human
gate only when the user explicitly authorizes that decision; invoking this skill
does not itself approve a decision.
For a plan's automatic trigger, bind its risk/ambiguity/write signals and decision
block as host policy rather than asking a planner to invent that authority.
If the CLI or independent providers are unavailable, report that limitation and
give a single-agent analysis without presenting it as a blind vote.

Normalize the decision question first. Give every voter the same stable public
context pointer and a private suffix. Voters must not read each other's output.
Collect provider, requested model, served model, exit status, and response hash;
classify failures separately from abstentions. The chair compares evidence,
records minority reasons, and may return `abstain` when the evidence is not
comparable. Evidence quotes must match the public anchors exactly. The chair
runs only after blind collection and cannot change the host tally. Preserve
malformed and failed votes, provider metadata, response hashes and the optional
human gate. Do not present a majority as truth or silently discard dissent.

Installation and runtime contracts: [plugin guide](../../docs/plugin.md).
