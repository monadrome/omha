// Agent launch specs shared by multi-review and named handoffs, plus the global
// agent registry. A spec is a command, its argv template and optional model
// selection; it never carries credentials. The registry lives in the Omha state
// directory so the same named agents are available from every project.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandExists, stateHome } from './core.mjs';
import { atomicWrite, lockDir, safeRead } from './storage.mjs';
import { BASE_ENV } from './profiles.mjs';
import { assertNoCredentialArgs, assertNoSecrets } from './security.mjs';
import { check, choice, id, keys, object, text, OmhaError } from './validation.mjs';

export const AGENT_ENV = [
  ...BASE_ENV,
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'COLORTERM',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'KIRO_HOME',
];

// Built-in launch specs. A missing executable or model skips the reviewer;
// `.omha/review.json` can override, disable or add reviewers, and registry
// agents may start from one of them through `base`.
export const DEFAULT_REVIEWERS = {
  claude: {
    command: 'claude',
    args: ['--add-dir', '{run}', '--permission-mode', 'plan', '{model_args}', '-p'],
    modelArgs: ['--model', '{model}'],
  },
  codex: {
    command: 'codex',
    args: [
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-C',
      '{worktree}',
      '-o',
      '{last}',
      '{model_args}',
      '-',
    ],
    modelArgs: ['-m', '{model}'],
  },
  kimi: {
    command: 'kimi',
    models: ['kimi-code/k3.1', 'kimi-code/k3.1-pro'],
    modelCatalog: 'kimi',
    args: ['--add-dir', '{run}', '{model_args}', '-p', '{prompt}'],
    modelArgs: ['-m', '{model}'],
  },
  kiro: {
    command: 'kiro-cli',
    args: ['chat', '--no-interactive', '--trust-all-tools', '{model_args}'],
    modelArgs: ['--model', '{model}'],
  },
  ocr: {
    command: 'ocr',
    role: 'static',
    args: [
      'review',
      '--repo',
      '{worktree}',
      '{range_args}',
      '--format',
      'json',
      '--audience',
      'agent',
      '--color',
      'never',
      '--background-file',
      '{context}',
      '-o',
      '{out}',
    ],
  },
};

export function stringArray(value, label) {
  check(
    Array.isArray(value) && value.every((x) => typeof x === 'string' && !x.includes('\0')),
    `${label} must be a string array`,
  );
  return value;
}

export function validateReviewer(name, input, base = {}) {
  id(name, 'reviewer name');
  keys(
    input,
    [
      'enabled',
      'command',
      'args',
      'model',
      'models',
      'modelArgs',
      'modelCatalog',
      'role',
      'env',
      'envAllowlist',
      'vote',
    ],
    `reviewer ${name}`,
  );
  const spec = { role: 'reviewer', vote: true, modelCatalog: 'none', ...base, ...input, name };
  if (spec.enabled === false) return { name, enabled: false };
  text(spec.command, `reviewer ${name} command`, 4096);
  stringArray(spec.args, `reviewer ${name} args`);
  check(
    input.model === undefined || input.models === undefined,
    `reviewer ${name} accepts model or models, not both`,
  );
  // A configured model or preference list replaces the built-in one.
  if (input.model !== undefined) delete spec.models;
  if (input.models !== undefined) delete spec.model;
  if (spec.model !== undefined) text(spec.model, `reviewer ${name} model`, 256);
  if (spec.models !== undefined) {
    stringArray(spec.models, `reviewer ${name} models`);
    check(spec.models.length > 0, `reviewer ${name} models must not be empty`);
    spec.models.forEach((model) => text(model, `reviewer ${name} model`, 256));
  }
  if (spec.modelArgs !== undefined) stringArray(spec.modelArgs, `reviewer ${name} modelArgs`);
  choice(spec.role, ['reviewer', 'static'], `reviewer ${name} role`);
  choice(spec.modelCatalog, ['none', 'kimi'], `reviewer ${name} modelCatalog`);
  check(typeof spec.vote === 'boolean', `reviewer ${name} vote must be boolean`);
  const env = object(spec.env || {}, `reviewer ${name} env`);
  for (const [key, value] of Object.entries(env)) {
    check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key), `reviewer ${name} env name is invalid`);
    check(
      !/key|token|secret|password|credential|auth/i.test(key),
      `reviewer ${name} env must not carry credentials; use envAllowlist`,
      'sensitive_content',
    );
    text(value, `reviewer ${name} env ${key}`, 4096);
  }
  spec.env = env;
  spec.envAllowlist = stringArray(spec.envAllowlist || [], `reviewer ${name} envAllowlist`);
  check(
    spec.envAllowlist.every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)),
    `reviewer ${name} envAllowlist must contain environment variable names`,
  );
  assertNoSecrets({
    command: spec.command,
    args: spec.args,
    model: spec.model,
    models: spec.models,
    env: spec.env,
  });
  assertNoCredentialArgs(spec.args);
  spec.enabled = true;
  return spec;
}

function kimiModels() {
  const path = join(homedir(), '.kimi-code', 'config.toml');
  if (!existsSync(path)) return null;
  const aliases = [];
  for (const match of safeRead(path).matchAll(/^\s*\[models\."([^"]+)"\]\s*$/gm))
    aliases.push(match[1]);
  return aliases;
}

export function detectReviewers(config, options = {}) {
  const exists = options.commandExists || commandExists;
  let catalog, catalogError;
  return Object.values(config.reviewers).map((spec) => {
    if (!spec.enabled) return { name: spec.name, available: false, reason: 'disabled' };
    const wanted = spec.models || (spec.model ? [spec.model] : []);
    const entry = {
      name: spec.name,
      role: spec.role,
      command: spec.command,
      model: wanted[0] ?? null,
      available: true,
    };
    if (!exists(spec.command)) return { ...entry, available: false, reason: 'command not found' };
    if (spec.modelCatalog === 'kimi' && wanted.length) {
      if (catalog === undefined) {
        try {
          catalog = (options.kimiModels || kimiModels)();
        } catch (error) {
          catalog = null;
          catalogError = error.message;
        }
      }
      // Without a readable catalog the first preference is used and Kimi decides.
      if (catalogError) entry.note = `Kimi model catalog unreadable: ${catalogError}`;
      if (catalog) {
        const model = wanted.find((name) => catalog.includes(name));
        if (!model)
          return {
            ...entry,
            available: false,
            reason: `none of ${wanted.join(', ')} is configured for Kimi Code`,
            configuredModels: catalog,
          };
        entry.model = model;
      }
    }
    return entry;
  });
}

export const fill = (template, values) =>
  template.replace(/\{([a-z_]+)\}/g, (all, key) =>
    Object.hasOwn(values, key) ? values[key] : all,
  );

function expandArgs(spec, values) {
  const args = [];
  for (const arg of spec.args) {
    if (arg === '{model_args}') {
      if (spec.model) args.push(...(spec.modelArgs || []).map((x) => fill(x, values)));
    } else if (arg === '{range_args}') args.push(...values.range_args);
    else args.push(fill(arg, values));
  }
  return args;
}

export function launchCommand(spec, values) {
  let command = spec.command;
  let args = expandArgs(spec, values);
  const env = Object.entries(spec.env || {});
  if (env.length) {
    args = [...env.map(([key, value]) => `${key}=${value}`), command, ...args];
    command = 'env';
  }
  return { command, args };
}

// ---------------------------------------------------------------- registry
export const AGENT_ROLES = ['reviewer', 'static', 'worker'];
export const AGENT_DESCRIPTION_BYTES = 1000;
const AGENT_KEYS = [
  'description',
  'role',
  'base',
  'command',
  'args',
  'model',
  'models',
  'modelArgs',
  'modelCatalog',
  'env',
  'envAllowlist',
  'vote',
];
const HANDOFF_VALUES = ['name', 'model', 'model_args', 'prompt', 'prompt_file', 'run', 'worktree'];

export function agentsFile(root = stateHome()) {
  return join(root, 'agents.json');
}

export function validateAgent(name, input) {
  id(name, 'agent name');
  check(
    !Object.hasOwn(DEFAULT_REVIEWERS, name),
    `Agent name ${name} is a built-in reviewer; choose another name or override it in review.json`,
  );
  object(input, `agent ${name}`);
  keys(input, AGENT_KEYS, `agent ${name}`);
  const { description, role = 'worker', base, ...launch } = input;
  text(description, `agent ${name} description`, AGENT_DESCRIPTION_BYTES);
  assertNoSecrets(description);
  choice(role, AGENT_ROLES, `agent ${name} role`);
  if (base !== undefined)
    check(
      typeof base === 'string' && Object.hasOwn(DEFAULT_REVIEWERS, base),
      `agent ${name} base must be one of: ${Object.keys(DEFAULT_REVIEWERS).join(', ')}`,
    );
  check(
    role !== 'worker' || launch.vote === undefined,
    `agent ${name} vote requires the reviewer role`,
  );
  const spec = validateReviewer(
    name,
    { ...launch, role: role === 'worker' ? 'reviewer' : role },
    base === undefined ? {} : DEFAULT_REVIEWERS[base],
  );
  return {
    ...spec,
    role,
    ...(role === 'worker' ? { vote: false } : {}),
    description,
    base: base ?? null,
  };
}

export function validateAgentRegistry(input) {
  object(input, 'agent registry');
  keys(input, ['version', 'agents'], 'agent registry');
  check(input.version === 1, 'Agent registry version must be 1');
  const agents = object(input.agents ?? {}, 'agent registry agents');
  return {
    version: 1,
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, entry]) => [name, validateAgent(name, entry)]),
    ),
  };
}

function readRegistry(root) {
  const path = agentsFile(root);
  if (!existsSync(path)) return { path, exists: false, raw: { version: 1, agents: {} } };
  let raw;
  try {
    raw = JSON.parse(safeRead(path, root));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new OmhaError('configuration', `Malformed agent registry JSON: ${path}`);
    throw error;
  }
  return { path, exists: true, raw, registry: validateAgentRegistry(raw) };
}

export function loadAgents(root = stateHome()) {
  const { path, exists, registry } = readRegistry(root);
  return { source: exists ? path : null, agents: registry?.agents ?? {} };
}

export function reviewAgents(root = stateHome()) {
  return Object.fromEntries(
    Object.entries(loadAgents(root).agents).filter(([, agent]) => agent.role !== 'worker'),
  );
}

function agentView(agent, detected) {
  return {
    name: agent.name,
    description: agent.description,
    role: agent.role,
    base: agent.base,
    command: agent.command,
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.models !== undefined ? { models: agent.models } : {}),
    ...(detected
      ? {
          available: detected.available,
          resolvedModel: detected.model ?? null,
          ...(detected.reason ? { reason: detected.reason } : {}),
          ...(detected.note ? { note: detected.note } : {}),
        }
      : {}),
  };
}

export function listAgents(options = {}) {
  const root = options.root || stateHome();
  const { source, agents } = loadAgents(root);
  const detected = detectReviewers({ reviewers: agents }, options);
  return {
    source: source ?? agentsFile(root),
    exists: source !== null,
    agents: detected.map((entry) => agentView(agents[entry.name], entry)),
  };
}

function registeredAgent(agents, name) {
  id(name, 'agent name');
  const agent = agents[name];
  check(agent, `Unknown agent: ${name}; run omha agents list`, 'not_found');
  return agent;
}

export function showAgent(name, options = {}) {
  const root = options.root || stateHome();
  const { raw, registry } = readRegistry(root);
  const agent = registeredAgent(registry?.agents ?? {}, name);
  const [detected] = detectReviewers({ reviewers: { [name]: agent } }, options);
  return { ...agentView(agent, detected), entry: raw.agents[name], args: agent.args };
}

function writeRegistry(root, update) {
  const release = lockDir(join(root, '.agents.lock'), { root });
  try {
    const { path, raw } = readRegistry(root);
    const next = update(raw);
    validateAgentRegistry(next);
    atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`, root);
    return path;
  } finally {
    release();
  }
}

export function addAgent(name, input, options = {}) {
  const root = options.root || stateHome();
  const agent = validateAgent(name, input);
  let replaced = false;
  const source = writeRegistry(root, (raw) => {
    replaced = Object.hasOwn(raw.agents ?? {}, name);
    check(!replaced || options.force, `Agent ${name} already exists; pass --force to replace it`);
    return { version: 1, agents: { ...raw.agents, [name]: input } };
  });
  return { source, replaced, agent: agentView(agent) };
}

export function removeAgent(name, options = {}) {
  const root = options.root || stateHome();
  id(name, 'agent name');
  const source = writeRegistry(root, (raw) => {
    check(Object.hasOwn(raw.agents ?? {}, name), `Unknown agent: ${name}`, 'not_found');
    const agents = { ...raw.agents };
    delete agents[name];
    return { version: 1, agents };
  });
  return { source, removed: name };
}

// A named handoff launches a registry agent the way a manual `--command` would,
// so ownership, final markers and backend fallback stay those of `handoff`.
export function agentHandoffLaunch(name, context, options = {}) {
  const root = options.root || stateHome();
  const agent = registeredAgent(loadAgents(root).agents, name);
  const placeholders = [...agent.args, ...(agent.modelArgs || [])].flatMap((arg) =>
    [...arg.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]),
  );
  const unsupported = [...new Set(placeholders.filter((key) => !HANDOFF_VALUES.includes(key)))];
  check(
    unsupported.length === 0,
    `Agent ${name} uses placeholders a handoff cannot fill: ${unsupported.map((key) => `{${key}}`).join(', ')}; override args in the registry entry`,
  );
  const [detected] = detectReviewers({ reviewers: { [name]: agent } }, options);
  check(detected.available, `Agent ${name} is unavailable: ${detected.reason}`);
  const spec = { ...agent, model: detected.model ?? undefined };
  const { command, args } = launchCommand(spec, {
    name,
    model: spec.model || '',
    prompt: context.prompt,
    prompt_file: context.promptFile,
    run: context.dir,
    worktree: context.cwd,
  });
  return {
    command,
    args,
    envAllowlist: [...new Set([...AGENT_ENV, ...agent.envAllowlist])],
    agent: {
      name,
      role: agent.role,
      command: agent.command,
      requestedModel: spec.model ?? null,
      ...(detected.note ? { note: detected.note } : {}),
    },
  };
}
