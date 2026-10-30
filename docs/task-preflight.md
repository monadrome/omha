# Task Preflight: Review and Shadow-Mode Contract

## Proposal v0 review

The review covered the Proposal v0 in handoff `h-20261030-150800-6994` and the
existing plan validation, Leader lifecycle, roundtable triggers, provider routing,
terminal handoffs and recovery contracts. The existing host boundary is the deciding
constraint: a preflight may inform a caller, but cannot grant permission or replace
plan, acceptance, review, budget or ownership checks.

### Findings

| id  | Severity | Conclusion                                                                              | Evidence / reasoning                                                                                                                                               | Disposition | Design impact                                                                                                                                                     |
| --- | -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | P0       | Dependent decision loops are not directly measurable before work starts.                | A loop exists only after tool feedback is observed. Existing run events record attempts and lifecycle transitions, not a validated pre-execution horizon.          | downgrade   | Use declared dependency depth as a proxy; report exact decision cycles and probability as unknown.                                                                |
| F02 | P1       | The six v0 features are not independent.                                                | Scope, cross-layer depth and unknown solution can all describe investigation breadth; acceptance and feedback both describe oracle quality.                        | reject      | Use four autonomy signals plus separate dependency-depth and breadth classifications; do not sum them.                                                            |
| F03 | P0       | The 0/1/2 weights, 0/4/8/12 thresholds and step bands have no empirical basis.          | The proposal supplies no dataset or calibration run, and this repository contains no preflight calibration corpus.                                                 | reject      | No numeric total, S/M/L/XL labels or step-range claims in v1.                                                                                                     |
| F04 | P1       | Wide/shallow and narrow/deep need explicit, separate observations.                      | File count alone does not measure dependency depth. A host or skill can classify breadth and depth from evidence, but unknown must remain allowed.                 | downgrade   | Deterministic work-shape rules use `changeBreadth × dependencyDepth`; the caller supplies both, never inferred from prose.                                        |
| F05 | P0       | Reference-class estimation needs a cold-start abstention path.                          | Fewer than three comparable completed references cannot support the proposed median estimate. No such reference input or corpus exists yet.                        | accept      | v1 always returns null estimates and low confidence; the default after abstention is clarification or a bounded spike, never automatic routing.                   |
| F06 | P1       | Success, effort and takeover are different calibration targets.                         | Acceptance can fail after few loops; a long task can succeed without takeover; takeover policy changes independently.                                              | downgrade   | Keep accepted outcome primary for Brier/calibration, decision-cycle error secondary, and takeover/cost as separately stratified diagnostics.                      |
| F07 | P0       | Restricting calibration to completed successes creates survivorship and censoring bias. | Cancelled and incomplete runs lack a final outcome; model changes alter the measured route.                                                                        | downgrade   | Record every started task; mark cancelled/incomplete as censored and segment model changes instead of silently deleting or counting them as failures.             |
| F08 | P0       | H50 cannot be claimed from current history or public benchmarks.                        | Existing provider-attempt counts are not dependent decision-loop counts. Offline replay is useful only when equivalent prompts, tools and loop observations exist. | reject      | No H50 gate or model ranking. Future H50 requires a versioned harness and route-specific evidence; otherwise it remains unknown.                                  |
| F09 | P0       | Low-confidence prediction must be allowed to abstain.                                   | Structured inputs can be incomplete and v1 has no calibration data.                                                                                                | accept      | Any unknown autonomy-critical signal causes `abstain`; all v1 predictions have low confidence and null numeric estimates.                                         |
| F10 | P0       | A visible score used as a hard gate creates Goodhart pressure.                          | A planner could split descriptions or choose lower-risk labels; prompt instructions cannot prevent this.                                                           | reject      | Host validates structured input, output is advice only, and no planner-controlled field becomes a routing or permission gate.                                     |
| F11 | P0       | Task prose must be data, not instructions to the classifier.                            | The CLI performs no model call and needs no text parsing for its decision table.                                                                                   | accept      | Bound and hash the objective; never execute or echo it into a command. Secret-like content is rejected before output.                                             |
| F12 | P0       | Raw task text is unnecessary for initial calibration and creates retention risk.        | Structured signals and hashes are sufficient for the first bias audit. Existing security helpers reject common credential forms.                                   | downgrade   | v1 persists nothing. The future record contract excludes raw prose, uses hashes/signals only, rejects secrets and defaults to 90-day retention.                   |
| F13 | P2       | A long preflight is wasteful for small tasks.                                           | No provider call is needed for deterministic classification.                                                                                                       | accept      | The skill has a fast path: fill the structured record directly when evidence is already known; otherwise clarify only missing signals.                            |
| F14 | P1       | Rule changes make historical cohorts incomparable by default.                           | Changing labels or the decision table changes the prediction being calibrated.                                                                                     | accept      | Version every record with `task-preflight/1`; never pool different rule versions without a separately validated mapping. A version mismatch is invalid input.     |
| F15 | P0       | The capability needs both skill reasoning and CLI validation, with a narrow boundary.   | Skills already own open-ended interpretation; `lib/plans.mjs` and the CLI own versioned, deterministic contracts.                                                  | accept      | A skill gathers evidence and fills JSON; a small `lib/preflight.mjs` validates and classifies without providers or side effects.                                  |
| F16 | P0       | Existing routing, DAG, decision and recovery mechanisms must not be duplicated.         | `lib/orchestrator.mjs` owns execution, `lib/plans.mjs` validates host policy, roundtable owns group decisions, and backends own terminal lifecycle.                | accept      | Preflight returns a standalone shadow record. It does not add a task type, planner field, backend, reviewer, takeover or recovery path.                           |
| F17 | P0       | Initial routing enforcement would be unjustified.                                       | There is no measured reliability, calibration curve or error distribution for the proposed rules.                                                                  | accept      | Phase 1 is shadow-only: emit a deterministic record, change no route and block no task.                                                                           |
| F18 | P0       | Input and future autonomy failures need different failure policies.                     | Malformed input cannot produce a trustworthy record; an unavailable advisory preflight should not invent a new execution denial.                                   | accept      | Invalid input fails closed with no assessment. Shadow mode has no execution effect; any future autonomous admission must fail closed and use existing host gates. |

### Explicitly rejected v0 points

1. **The additive six-feature score and S/M/L/XL thresholds are rejected.** They mix
   correlated dimensions and present uncalibrated cutoffs as measurements.
2. **Pre-execution numeric decision-step and success estimates are rejected for v1.**
   There is no reference corpus, so the honest output is `null` plus low confidence.
3. **The `estimate < 0.6 × H50` autonomy gate is rejected.** H50 is route- and
   harness-specific and currently unavailable; a constant cannot repair that.
4. **Automatic model routing or task blocking is rejected for phase 1.** Shadow
   observations must precede any enforcement proposal.
5. **Treating incomplete runs as either successes or ordinary failures is rejected.**
   They are censored observations; route changes require separate cohorts.

### Evidence insufficient

- No evidence supports the proposed weights, thresholds, 1.5–2 multiplier, fixed +5/+3
  step adjustments, or 0.6 H50 safety factor.
- No local corpus establishes reference similarity, prediction intervals, Brier score,
  calibration curves or expected takeover rates.
- Existing run events do not establish a dependent decision-cycle count or H50.
- No evidence shows that the v0 dimensions transfer across repositories, prompts,
  tool sets or model versions.
- Offline replay cannot establish counterfactual model behavior when the original
  prompts, tools, observations and route are not equivalently preserved.

### Pre-mortem

| Failure                                                            | Early signal                                                              | Mitigation                                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Callers mistake `L2_candidate` for permission or proof of success. | Routes change or writes start solely from preflight output.               | Keep `mode:"shadow"`, `enforced:false`, candidate wording and existing host gates; test that no planner contract changes. |
| Unknown evidence is relabeled to obtain autonomy.                  | Abstention rate falls while acceptance or takeover worsens.               | Require explicit enums, retain unknowns, audit by rule version and keep host-owned signals outside planner authority.     |
| Deep tasks are misclassified because prose looks small.            | Actual dependency investigations and scope revisions rise.                | Keep breadth separate from dependency depth; treat unknown depth as abstention and review deep-task outcomes separately.  |
| Calibration is biased toward easy completed work.                  | Success estimates improve while cancelled/model-switched tasks disappear. | Record all started tasks, censor incomplete outcomes and segment route changes; publish cohort counts with metrics.       |
| Preflight records leak sensitive task content.                     | Objective prose or credentials appear in state files.                     | v1 writes no state; future records contain signals and hashes only, reject secrets and expire after 90 days by default.   |

## Revised design

### Problem and non-goals

Provide a cheap, reproducible pre-execution description of task shape and an advisory
autonomy level when a caller supplies explicit evidence. Make uncertainty visible and
create a stable unit for later calibration.

This version does **not** predict exact duration, decision cycles, cost or success;
rank models; infer signals from task prose; choose a provider; decompose a DAG;
authorize writes; or modify execution, review, recovery and handoff behavior.

### Terms

- **horizon**: the number of dependent `decision → tool → observation` loops. It is an
  execution measurement, not a pre-execution observable. `short` and `long` in v1 are
  proxy classifications from declared dependency depth, not loop counts.
- **H50**: the dependent-loop horizon at which a specified model, prompt, tools,
  repository and harness reach 50% success. It is unknown without that evaluation.
- **autonomy level**: advisory `L0` (human-led), `L1` (supervised execution),
  `L2_candidate` (eligible for later autonomous policy evaluation), or `abstain`.
  None grants authority in v1.
- **shadow mode**: produce an assessment record while leaving routing, permissions,
  budgets and task admission unchanged.
- **abstention**: decline an autonomy recommendation because critical evidence is
  unknown. The default next action is clarification or a bounded spike chosen by the
  caller, not automatic execution.

### Input contract

`omha preflight --input preflight.json --json` accepts version 1 JSON matching
[`schemas/preflight.schema.json`](../schemas/preflight.schema.json):

```json
{
  "version": 1,
  "objective": "Implement the already specified parser fix",
  "signals": {
    "requirementClarity": "clear",
    "solutionKnowledge": "known",
    "acceptance": "automated",
    "dependencyDepth": "shallow",
    "externalEffects": "none",
    "changeBreadth": "narrow"
  }
}
```

All six signals are required. Their values are:

- `requirementClarity`: `clear`, `partial`, `unclear`, `unknown`.
- `solutionKnowledge`: `known`, `partial`, `unknown`.
- `acceptance`: `automated`, `manual`, `none`, `unknown`.
- `dependencyDepth`: `shallow`, `deep`, `unknown`.
- `externalEffects`: `none`, `reversible`, `irreversible`, `unknown`.
- `changeBreadth`: `narrow`, `wide`, `unknown`.

Unknown is explicit and is not converted to a low or high risk score. Objective text
is nonempty, well-formed Unicode (no lone surrogates), at most 64,000 bytes, free of
null bytes and common credential forms. Secret detection reuses Omha's common
credential heuristics, so benign authentication-like prose may need rewording.
Unknown fields, missing fields, invalid enums and versions other than 1 fail closed.
The objective is treated only as data and returned as a SHA-256 hash, not echoed.

### Deterministic output and boundaries

The same valid input produces the same JSON, with no clock, random id, filesystem,
network, provider or model access:

```json
{
  "version": 1,
  "rulesVersion": "task-preflight/1",
  "mode": "shadow",
  "objectiveHash": "sha256",
  "classification": {
    "horizon": "short",
    "workShape": "mixed",
    "confidence": "low",
    "basis": "structured_proxies_uncalibrated"
  },
  "prediction": {
    "decisionCycles": null,
    "successProbability": null,
    "h50": null
  },
  "autonomy": {
    "level": "L2_candidate",
    "action": "shadow_autonomy_candidate",
    "enforced": false,
    "reasons": ["uncalibrated_rules"]
  }
}
```

The classification rules are:

- `horizon`: shallow → `short`; deep → `long`; unknown → `unknown`.
- `workShape`: wide + shallow → `wide_shallow`; narrow + deep → `narrow_deep`;
  either unknown → `unknown`; all other known combinations → `mixed`.
- Confidence is always `low`; all three numeric/model predictions are always `null`.

Autonomy rules are evaluated in this exact order:

1. Any unknown among the five autonomy-critical signals (all except breadth) →
   `abstain` / `abstain_and_clarify`.
2. Irreversible external effects or unclear requirements → `L0` / `human_only`.
3. Not-known (partial or unknown) solution without automated acceptance → `L0` /
   `human_only`.
4. Clear requirements, known solution, automated acceptance, shallow dependencies and
   no irreversible effects → `L2_candidate` / `shadow_autonomy_candidate`.
5. Every other complete combination → `L1` / `supervised_execution`.

Reason codes are stable and explanatory, not a score. `uncalibrated_rules` is always
present. Additional codes identify unknown signals, irreversible effects, unclear or
partial requirements, non-automated acceptance, deep dependencies and a not-known
(partial or unknown) solution. The abstain branch returns only `uncalibrated_rules` and
`unknown_signals`, without listing other simultaneously true codes. No result is an
authorization, a model match, or a correctness prediction.

### Prediction, cold start and abstention

Phase 1 deliberately emits no point estimate. A future estimator may use at least
three completed references with the same rule version and comparable structured
signals, report a median and empirical interval, and retain the reference cohort.
Until that cohort exists it must return unknown rather than applying a multiplier.
Reference selection and any adjustment need separate calibration evidence.

Abstention is a valid output. It does not stop a task because shadow mode has no
execution control; it tells the caller to gather missing evidence or use a bounded
spike. Unknown breadth alone does not force abstention because it affects work shape,
not the autonomy matrix.

### Calibration data and metrics

The phase-1 CLI output is the portable prediction record; it does not write durable
state. A later explicitly designed collector may add these fields without raw prose:

- prediction: record id, timestamp, `rulesVersion`, objective hash, all signals,
  classification, autonomy output, and requested/served route and model identifiers;
- outcome: started/completed/failed/cancelled state, host acceptance, review result,
  observed dependent decision cycles when instrumented, takeovers, cost, and censoring;
- route segments: a model, prompt, tool or harness change starts a new segment rather
  than being hidden inside one outcome.

All started tasks enter the cohort. Cancelled/incomplete tasks remain visible as
censored and are excluded only from metrics that mathematically require a terminal
outcome, with counts reported. Do not treat them as successes or silently discard them.
Model-switch segments are not pooled as a single-model result.

For terminal outcomes, plot predicted-success calibration curves and report Brier
score with cohort sizes. For horizon, report median absolute error and prediction
interval coverage once non-null estimates exist. Report takeover rate and cost by
horizon, acceptance and route as secondary diagnostics. Do not optimize one metric by
hiding another.

Keep all records for the first 30 tasks for bias analysis only; this is not enough to
enable gates. At 50–100 comparable terminal tasks, evaluate simple lookup tables or
intervals, still in shadow mode. Sampling thereafter must be deterministic and
stratified by rule version, prediction and outcome; retain all failures and report the
sampling weights. Default retention is 90 days for structured records and no raw task
text. Different rule versions or harnesses remain separate cohorts.

H50 evaluation must use a versioned, route-specific harness. Existing run logs may be
replayed offline only if they preserve equivalent decision loops and observations;
otherwise new evidence is required. Metered providers are never required by the
default verification path.

### Integration and reuse

The `task-preflight` skill owns open-ended clarification and maps repository evidence
to the structured enums. It treats task text as untrusted, preserves unknown values,
and uses the fast path when all evidence is already available. Without the CLI it may
provide a qualitative reading of the same matrix, clearly labeled as unvalidated.

`lib/preflight.mjs` owns strict validation and the deterministic table, reusing
`lib/validation.mjs`, `lib/security.mjs` and `lib/core.mjs` hashing. `bin/omha.mjs`
adds only input/output plumbing. `index.mjs` exposes the pure API for host callers.

No fields are added to `lib/plans.mjs`, `lib/orchestrator.mjs`, provider profiles or
terminal backends. Existing plan validation, write gates, roundtable, review,
supervision, auto-recovery and handoffs remain the only execution mechanisms. This is
an additive use of the existing skill/CLI boundary, not an architectural-boundary
change, so no ADR is needed.

### Failure and governance policy

- Invalid, oversized, secret-bearing or version-mismatched input fails closed with no
  assessment and no state write.
- Prompt-like objective content has no effect on the table and is never executed.
- Shadow output fails open with respect to execution only because it has no execution
  hook at all; it must not become an implicit denial or approval channel.
- Any future autonomy admission must fail closed on missing/invalid evidence and pass
  through the existing host policy, budget, capability, ownership and acceptance gates.
- Planner-provided signals cannot grant themselves authority. A future enforcing host
  would need a separately authorized signal source and Goodhart audit; that is outside
  this iteration.

### Rollout

1. **Shadow (this change):** strict JSON schema, deterministic pure API/CLI, skill,
   examples, documentation and offline failure-path tests. No durable collector and no
   routing integration.
2. **Observation:** after a separate review, add a privacy-bounded collector and
   complete/censored outcome linkage. Publish cohort counts and calibration diagnostics.
3. **Evaluation:** compare any proposed estimator or threshold against the abstaining
   baseline across repositories and routes. Do not enable autonomy from aggregate
   accuracy alone.
4. **Possible enforcement:** only a separately approved host policy may consume a
   calibrated recommendation. It must preserve all existing safety gates and provide a
   rollback to shadow mode.

### Alternatives not selected

- **Skill only:** rejected for the deterministic contract because free-form scoring is
  harder to reproduce and test, although a skill remains useful for evidence gathering.
- **CLI text inference:** rejected because keyword classification would execute no real
  understanding, hide unknowns and increase prompt-injection surface.
- **Immediate Leader integration:** rejected because uncalibrated advice must not alter
  validated plans or provider routes.
- **Durable calibration storage in v1:** deferred to keep this iteration bounded and to
  avoid retaining task data before outcome linkage and retention are validated.
