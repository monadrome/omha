import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stateHome } from './core.mjs';
import { safeRead } from './storage.mjs';
import { assertNoCredentialArgs, assertNoSecrets } from './security.mjs';
import { check, choice, id, keys, number, text, OmhaError } from './validation.mjs';

export const BASE_ENV = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SYSTEMROOT',
];
export const DEFAULT_PROFILES = {
  claude: { adapter: 'claude', command: 'claude', model: 'sonnet', effort: 'low' },
  codex: { adapter: 'codex', command: 'codex', model: 'gpt-5', effort: 'low' },
  kimi: { adapter: 'kimi', command: 'kimi', model: 'kimi-k2.5', sandbox: 'workspace-write' },
  fake: {
    adapter: 'fake',
    command: 'fake',
    model: 'local',
    responses: [{ output: 'Offline fixture completed.' }],
  },
};
export const CAPABILITIES = ['interactive', 'headless', 'tool-free', 'read-only'];

export function validateCapabilities(input = [], label = 'capabilities') {
  check(Array.isArray(input), `${label} must be an array`);
  check(new Set(input).size === input.length, `${label} must not contain duplicates`);
  input.forEach((value) => choice(value, CAPABILITIES, `${label} entry`));
  return [...input];
}

export function validateRetry(input = {}) {
  keys(input, ['maxRetries', 'baseMs', 'maxMs', 'jitter'], 'retry');
  const retry = { maxRetries: 1, baseMs: 500, maxMs: 30000, jitter: 0.2, ...input };
  number(retry.maxRetries, 'retry.maxRetries', 0, 10);
  number(retry.baseMs, 'retry.baseMs', 0, 60000);
  number(retry.maxMs, 'retry.maxMs', retry.baseMs, 3600000);
  number(retry.jitter, 'retry.jitter', 0, 1, false);
  return retry;
}

export function validateBudget(input = {}) {
  keys(
    input,
    ['maxRequests', 'maxTokens', 'maxCostUsd', 'reserveTokens', 'reserveCostUsd'],
    'budget',
  );
  const budget = {
    maxRequests: 100,
    maxTokens: 1000000,
    maxCostUsd: 10,
    reserveTokens: 4096,
    reserveCostUsd: 0.1,
    ...input,
  };
  number(budget.maxRequests, 'budget.maxRequests', 1, 100000);
  number(budget.maxTokens, 'budget.maxTokens', 0, 1000000000);
  number(budget.maxCostUsd, 'budget.maxCostUsd', 0, 1000000, false);
  number(budget.reserveTokens, 'budget.reserveTokens', 0, budget.maxTokens);
  number(budget.reserveCostUsd, 'budget.reserveCostUsd', 0, budget.maxCostUsd, false);
  return budget;
}

export function validateProfile(name, input) {
  id(name, 'profile name');
  keys(
    input,
    [
      'name',
      'adapter',
      'command',
      'args',
      'sandboxCommand',
      'sandboxArgs',
      'sandboxWrite',
      'model',
      'effort',
      'sandbox',
      'timeoutMs',
      'concurrency',
      'budget',
      'envAllowlist',
      'fallback',
      'retry',
      'circuit',
      'outputFormat',
      'capabilities',
      'responses',
      'maxOutputBytes',
    ],
    `profile ${name}`,
  );
  if (input.name !== undefined) check(input.name === name, 'Profile name does not match its key');
  const inferred = DEFAULT_PROFILES[name] || { adapter: input.adapter || 'command' };
  const profile = {
    sandbox: 'read-only',
    timeoutMs: 120000,
    concurrency: 2,
    envAllowlist: BASE_ENV,
    fallback: [],
    outputFormat: 'text',
    maxOutputBytes: 4194304,
    ...inferred,
    ...input,
    name,
  };
  choice(profile.adapter, ['claude', 'codex', 'kimi', 'command', 'fake'], 'adapter');
  text(profile.command, 'command', 4096);
  text(profile.model, 'model', 256);
  assertNoSecrets({
    command: profile.command,
    args: profile.args,
    sandboxCommand: profile.sandboxCommand,
    sandboxArgs: profile.sandboxArgs,
    model: profile.model,
  });
  choice(profile.sandbox, ['read-only', 'workspace-write', 'external'], 'sandbox');
  if (profile.effort !== undefined)
    choice(profile.effort, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'effort');
  number(profile.timeoutMs, 'timeoutMs', 10, 86400000);
  number(profile.concurrency, 'concurrency', 1, 64);
  number(profile.maxOutputBytes, 'maxOutputBytes', 256, 67108864);
  choice(profile.outputFormat, ['text', 'json', 'jsonl'], 'outputFormat');
  const inferredCapabilities = new Set();
  if (
    ['claude', 'codex', 'kimi', 'fake'].includes(profile.adapter) ||
    profile.outputFormat !== 'text'
  )
    inferredCapabilities.add('headless');
  if (['claude', 'codex', 'fake'].includes(profile.adapter)) inferredCapabilities.add('tool-free');
  if (profile.sandbox === 'read-only') inferredCapabilities.add('read-only');
  const declaredCapabilities = validateCapabilities(
    input.capabilities ?? [...inferredCapabilities],
    `profile ${name} capabilities`,
  );
  if (declaredCapabilities.includes('headless'))
    check(inferredCapabilities.has('headless'), `Profile ${name} cannot enforce headless output`);
  if (declaredCapabilities.includes('tool-free'))
    check(
      ['claude', 'codex', 'fake'].includes(profile.adapter),
      `Profile ${name} cannot enforce tool-free execution`,
    );
  if (declaredCapabilities.includes('read-only'))
    check(profile.sandbox === 'read-only', `Profile ${name} cannot enforce read-only execution`);
  profile.capabilities = declaredCapabilities;
  check(
    Array.isArray(profile.envAllowlist) &&
      profile.envAllowlist.every(
        (x) => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x),
      ),
    'envAllowlist must contain environment variable names',
  );
  check(Array.isArray(profile.fallback), 'fallback must be an array');
  profile.fallback.forEach((x) => id(x, 'fallback profile'));
  if (profile.args !== undefined)
    check(
      Array.isArray(profile.args) &&
        profile.args.every((x) => typeof x === 'string' && !x.includes('\0')),
      'args must be a string array',
    );
  if (profile.sandboxCommand !== undefined) text(profile.sandboxCommand, 'sandboxCommand', 4096);
  if (profile.sandboxWrite !== undefined)
    check(
      typeof profile.sandboxWrite === 'boolean' &&
        (!profile.sandboxWrite || (profile.sandbox === 'external' && profile.sandboxCommand)),
      'sandboxWrite requires an external sandboxCommand',
    );
  if (profile.sandboxArgs !== undefined)
    check(
      Array.isArray(profile.sandboxArgs) &&
        profile.sandboxArgs.every((x) => typeof x === 'string' && !x.includes('\0')),
      'sandboxArgs must be a string array',
    );
  assertNoCredentialArgs(profile.args);
  assertNoCredentialArgs(profile.sandboxArgs);
  if (profile.adapter === 'command')
    check(Array.isArray(profile.args), 'command adapter requires args');
  if (profile.responses !== undefined)
    check(
      profile.adapter === 'fake' &&
        Array.isArray(profile.responses) &&
        profile.responses.length > 0,
      'responses are only valid for the fake adapter',
    );
  profile.retry = validateRetry(profile.retry);
  profile.budget = validateBudget(profile.budget);
  keys(profile.circuit || {}, ['threshold', 'cooldownMs'], 'circuit');
  profile.circuit = { threshold: 3, cooldownMs: 30000, ...profile.circuit };
  number(profile.circuit.threshold, 'circuit.threshold', 1, 100);
  number(profile.circuit.cooldownMs, 'circuit.cooldownMs', 10, 3600000);
  return profile;
}

export function validateProfiles(config) {
  keys(config, ['version', 'profiles', 'fallbackOrder'], 'provider config');
  check(config.version === 1, 'Provider config version must be 1');
  keys(config.profiles, Object.keys(config.profiles || {}), 'profiles');
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([name, input]) => [name, validateProfile(name, input)]),
  );
  check(Object.keys(profiles).length > 0, 'At least one provider profile is required');
  const fallbackOrder = config.fallbackOrder || [];
  check(Array.isArray(fallbackOrder), 'fallbackOrder must be an array');
  for (const name of [...fallbackOrder, ...Object.values(profiles).flatMap((p) => p.fallback)])
    check(Object.hasOwn(profiles, name), `Unknown fallback profile: ${name}`);
  check(new Set(fallbackOrder).size === fallbackOrder.length, 'Duplicate fallback profile');
  const visit = (name, path = []) => {
    check(!path.includes(name), `Fallback cycle: ${[...path, name].join(' -> ')}`);
    for (const next of profiles[name].fallback) visit(next, [...path, name]);
  };
  Object.keys(profiles).forEach((name) => visit(name));
  return { version: 1, profiles, fallbackOrder };
}

export function loadConfig(cwd = process.cwd(), file) {
  const candidates = file
    ? [resolve(cwd, file)]
    : [join(cwd, '.omha', 'providers.json'), join(stateHome(), 'providers.json')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let parsed;
    try {
      parsed = JSON.parse(safeRead(path));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new OmhaError('configuration', `Malformed provider JSON: ${path}`);
      throw error;
    }
    return validateProfiles(parsed);
  }
  if (file) throw new OmhaError('configuration', 'Provider configuration file does not exist');
  return validateProfiles({ version: 1, profiles: DEFAULT_PROFILES });
}

export function loadProfiles(cwd, file) {
  return loadConfig(cwd, file).profiles;
}
