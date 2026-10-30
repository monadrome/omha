import { hash } from './core.mjs';
import { assertNoSecrets } from './security.mjs';
import { check, choice, keys, text } from './validation.mjs';

const RULES_VERSION = 'task-preflight/1';
const SIGNALS = {
  requirementClarity: ['clear', 'partial', 'unclear', 'unknown'],
  solutionKnowledge: ['known', 'partial', 'unknown'],
  acceptance: ['automated', 'manual', 'none', 'unknown'],
  dependencyDepth: ['shallow', 'deep', 'unknown'],
  externalEffects: ['none', 'reversible', 'irreversible', 'unknown'],
  changeBreadth: ['narrow', 'wide', 'unknown'],
};
const AUTONOMY_CRITICAL = [
  'requirementClarity',
  'solutionKnowledge',
  'acceptance',
  'dependencyDepth',
  'externalEffects',
];

export function validatePreflight(input) {
  keys(input, ['version', 'objective', 'signals'], 'preflight input');
  check(input.version === 1, 'Preflight input version must be 1');
  text(input.objective, 'preflight objective', 64000);
  check(input.objective.isWellFormed(), 'Preflight objective must be well-formed Unicode');
  assertNoSecrets(input.objective);
  assertNoSecrets(input);
  keys(input.signals, Object.keys(SIGNALS), 'preflight signals');
  const signals = {};
  for (const [name, values] of Object.entries(SIGNALS))
    signals[name] = choice(input.signals[name], values, `preflight signal ${name}`);
  return { version: 1, objective: input.objective, signals };
}

function workShape(changeBreadth, dependencyDepth) {
  if (changeBreadth === 'unknown' || dependencyDepth === 'unknown') return 'unknown';
  if (changeBreadth === 'wide' && dependencyDepth === 'shallow') return 'wide_shallow';
  if (changeBreadth === 'narrow' && dependencyDepth === 'deep') return 'narrow_deep';
  return 'mixed';
}

function autonomy(signals) {
  if (AUTONOMY_CRITICAL.some((name) => signals[name] === 'unknown'))
    return {
      level: 'abstain',
      action: 'abstain_and_clarify',
      enforced: false,
      reasons: ['uncalibrated_rules', 'unknown_signals'],
    };
  const reasons = ['uncalibrated_rules'];
  if (signals.externalEffects === 'irreversible') reasons.push('irreversible_effects');
  if (signals.requirementClarity === 'unclear') reasons.push('unclear_requirements');
  if (signals.requirementClarity === 'partial') reasons.push('partial_requirements');
  if (signals.acceptance !== 'automated') reasons.push('non_automated_acceptance');
  if (signals.dependencyDepth === 'deep') reasons.push('deep_dependency_chain');
  if (signals.solutionKnowledge !== 'known') reasons.push('unknown_solution');
  if (signals.externalEffects === 'irreversible' || signals.requirementClarity === 'unclear')
    return { level: 'L0', action: 'human_only', enforced: false, reasons };
  if (signals.solutionKnowledge !== 'known' && signals.acceptance !== 'automated')
    return { level: 'L0', action: 'human_only', enforced: false, reasons };
  if (
    signals.requirementClarity === 'clear' &&
    signals.solutionKnowledge === 'known' &&
    signals.acceptance === 'automated' &&
    signals.dependencyDepth === 'shallow' &&
    signals.externalEffects !== 'irreversible'
  )
    return { level: 'L2_candidate', action: 'shadow_autonomy_candidate', enforced: false, reasons };
  return { level: 'L1', action: 'supervised_execution', enforced: false, reasons };
}

export function assessPreflight(input) {
  const { objective, signals } = validatePreflight(input);
  return {
    version: 1,
    rulesVersion: RULES_VERSION,
    mode: 'shadow',
    objectiveHash: hash(objective),
    classification: {
      horizon:
        signals.dependencyDepth === 'shallow'
          ? 'short'
          : signals.dependencyDepth === 'deep'
            ? 'long'
            : 'unknown',
      workShape: workShape(signals.changeBreadth, signals.dependencyDepth),
      confidence: 'low',
      basis: 'structured_proxies_uncalibrated',
    },
    prediction: { decisionCycles: null, successProbability: null, h50: null },
    autonomy: autonomy(signals),
  };
}
