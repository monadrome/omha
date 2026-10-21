import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, projectIdentity, stateHome } from './core.mjs';
import { appendEvent, atomicWrite, ensureDir, lockDir, readEvents, safeRead } from './storage.mjs';
import { loadConfig, validateAutoCompact } from './profiles.mjs';
import { processFingerprint } from './process.mjs';
import { reserveBudget, settleBudget } from './runner.mjs';
import { assertNoSecrets } from './security.mjs';
import { shellQuote } from './backends.mjs';
import { check, choice, id, keys, number, text } from './validation.mjs';

const MAX_LOG_BYTES = 32 * 1024 * 1024;
const MAX_EVENTS = 10000;
const account = () => ({ requests: 0, tokens: 0, costUsd: 0, estimatedRequests: 0 });
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../bin/omha.mjs', import.meta.url));
const fingerprint = (pid) => processFingerprint(pid);
const digest = (value) => hash(JSON.stringify(value));

export function compactCapabilities(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?: \(Claude Code\))?$/.exec(version || '');
  const supported = Boolean(
    match &&
    (Number(match[1]) > 2 ||
      (Number(match[1]) === 2 &&
        (Number(match[2]) > 1 || (Number(match[2]) === 1 && Number(match[3]) >= 290)))),
  );
  return {
    version: version || null,
    minimumVersion: '2.1.290',
    supported,
    reason: supported ? null : 'mods_unsupported_by_version',
  };
}

function paths() {
  const root = stateHome();
  const dir = join(root, 'compact');
  return { root, dir, events: join(dir, 'events.jsonl'), lock: join(dir, '.lock') };
}

function loadLedger() {
  const p = paths();
  if (existsSync(p.events))
    check(lstatSync(p.events).size <= MAX_LOG_BYTES, 'Compact audit limit exceeded', 'budget');
  const events = readEvents(p.events, p.root);
  check(events.length <= MAX_EVENTS, 'Compact event limit exceeded', 'budget');
  let previous = null;
  for (const event of events) {
    check(
      event.previous === previous &&
        event.hash ===
          digest({
            previous: event.previous,
            kind: event.kind,
            at: event.at,
            state: event.state,
          }),
      'Compact audit integrity failure',
      'corrupt_state',
    );
    previous = event.hash;
  }
  const state = events.at(-1)?.state || { version: 1, activations: {}, sessions: {}, accounts: {} };
  check(
    state.version === 1 && state.activations && state.sessions && state.accounts,
    'Invalid compact ledger',
    'corrupt_state',
  );
  return { state, previous, count: events.length };
}

function commitLedger(ledger, kind, at) {
  const p = paths();
  const event = { previous: ledger.previous, kind, at, state: ledger.state };
  event.hash = digest(event);
  const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
  const size = existsSync(p.events) ? lstatSync(p.events).size : 0;
  check(
    ledger.count < MAX_EVENTS && size + bytes <= MAX_LOG_BYTES,
    'Compact audit storage is full; no further maintenance admitted',
    'budget',
  );
  appendEvent(p.events, event, p.root);
}

function transaction(kind, options, mutate) {
  const p = paths();
  ensureDir(p.dir, p.root);
  const release = lockDir(p.lock, { root: p.root, staleMs: 0, timeoutMs: 1000 });
  try {
    const ledger = loadLedger();
    const before = digest(ledger.state);
    const now = (options.clock || Date.now)();
    number(now, 'compact host time', 0, Number.MAX_SAFE_INTEGER);
    const result = mutate(ledger.state, now);
    if (before !== digest(ledger.state)) commitLedger(ledger, kind, now);
    return result;
  } finally {
    release();
  }
}

function currentPolicy(cwd, configFile) {
  const config = loadConfig(cwd, configFile);
  const policy = validateAutoCompact(config.maintenance?.autoCompact);
  return {
    config,
    policy,
    policyHash: digest({ policy, profile: config.profiles[policy.profile] || null }),
  };
}

export function prepareCompact(cwd, options = {}) {
  const realCwd = realpathSync(cwd);
  const configFile = options.config ? resolve(realCwd, options.config) : undefined;
  const { config, policy, policyHash } = currentPolicy(realCwd, configFile);
  check(policy.enabled, 'Enable maintenance.autoCompact in provider configuration first');
  check(
    config.profiles[policy.profile].command === 'claude',
    'Native auto compact requires the configured bare claude command',
  );
  check(policy.bridgeStatusLine, 'Auto compact requires explicit bridgeStatusLine:true');
  const settings = options.settings || {};
  check(
    settings && typeof settings === 'object' && !Array.isArray(settings),
    'Invalid Claude settings',
  );
  assertNoSecrets(settings);
  if (settings.statusLine !== undefined) {
    keys(
      settings.statusLine,
      ['type', 'command', 'padding', 'refreshInterval'],
      'existing statusLine',
    );
    check(settings.statusLine.type === 'command', 'Only command status lines can be preserved');
    text(settings.statusLine.command, 'statusLine command', 8192);
    check(
      !settings.statusLine.command.includes('compact bridge'),
      'Status line is already bridged',
    );
  }
  const activationId = `compact-${randomUUID()}`;
  const p = paths();
  const settingsFile = join(p.dir, `${activationId}.json`);
  const bridge = [
    process.execPath,
    cli,
    'compact',
    'bridge',
    '--cwd',
    realCwd,
    '--id',
    activationId,
  ]
    .map(shellQuote)
    .join(' ');
  const generated = {
    ...settings,
    idleCompaction: false,
    env: { ...settings.env, OMHA_COMPACT_ACTIVATION: activationId },
    statusLine: { ...settings.statusLine, type: 'command', command: bridge },
  };
  const bytes = JSON.stringify(generated, null, 2);
  return transaction('compact.prepared', options, (state, now) => {
    check(
      Object.keys(state.activations).length < 32,
      'Compact activation limit exceeded',
      'budget',
    );
    atomicWrite(settingsFile, bytes, p.root);
    state.activations[activationId] = {
      id: activationId,
      cwd: realCwd,
      projectId: projectIdentity(realCwd).projectId,
      configFile: configFile || null,
      policyHash,
      settingsFile,
      settingsHash: hash(bytes),
      originalStatusLine: settings.statusLine?.command || null,
      profile: policy.profile,
      requestedModel: null,
      createdAt: now,
    };
    return {
      version: 1,
      activationId,
      settingsFile,
      policy,
      command: 'claude',
      args: ['--plugin-dir', pluginRoot, '--settings', settingsFile],
    };
  });
}

function activationAt(state, activationId, cwd) {
  id(activationId, 'compact activation');
  const activation = state.activations[activationId];
  check(
    activation && activation.cwd === realpathSync(cwd),
    'Compact activation does not match worktree',
    'ownership',
  );
  check(
    hash(safeRead(activation.settingsFile, stateHome())) === activation.settingsHash,
    'Compact session settings changed',
    'integrity',
  );
  const current = currentPolicy(cwd, activation.configFile);
  check(
    current.policy.enabled && current.policyHash === activation.policyHash,
    'Compact policy changed or disabled; activate a new session',
    'authority',
  );
  return { activation, ...current };
}

function clearPrepared(session) {
  if (session.operation?.status === 'prepared') session.operation = null;
}

function invalidate(session) {
  session.cache = null;
  session.context = null;
  clearPrepared(session);
}

function view(session, policy, now) {
  let reason = null;
  const op = session.operation;
  const cache = session.cache;
  const dueAt = cache ? cache.expiresAt - (3600 - policy.afterMinutes * 60) * 1000 : null;
  const latestStartAt = cache ? cache.expiresAt - policy.minRemainingSeconds * 1000 : null;
  if (session.closed) reason = 'session_closed';
  else if (session.blocked) reason = session.blocked;
  else if (op && ['intent', 'unknown'].includes(op.status)) reason = 'execution_unknown';
  else if (session.externalCompact) reason = 'compact_in_progress';
  else if (session.workRevision <= session.lastCompactedWorkRevision) reason = 'no_new_business';
  else if (session.attemptedRevision === session.workRevision) reason = 'already_attempted';
  else if (session.busy || session.pendingInput) reason = 'busy_or_pending_input';
  else if (!cache) reason = 'cache_observation_unavailable';
  else if (cache.ttl !== '1h' || !cache.warm) reason = 'cache_not_warm_one_hour';
  else if (now >= latestStartAt) reason = 'expired';
  else if (!session.context) reason = 'context_unknown';
  else if (session.context.tokens * 100 < policy.minContextPercent * session.context.window)
    reason = 'context_below_threshold';
  else if (session.precomputedRevision === session.workRevision) reason = 'summary_precomputed';
  else if (
    session.lastCompactAt !== null &&
    now < session.lastCompactAt + policy.minIntervalMinutes * 60000
  )
    reason = 'cooldown';
  else if (session.account.requests >= policy.maxCompactionsPerSession) reason = 'session_limit';
  else if (now < dueAt) reason = 'scheduled';
  return {
    id: session.id,
    sessionId: session.nativeId,
    projectId: session.projectId,
    state: reason === null ? 'due' : reason === 'scheduled' ? 'armed' : 'observing',
    reason,
    policy,
    inputRevision: session.inputRevision,
    workRevision: session.workRevision,
    lastCompactedWorkRevision: session.lastCompactedWorkRevision,
    dueAt: session.pendingInput ? null : dueAt,
    expiresAt: cache?.expiresAt || null,
    latestStartAt,
    context: session.context,
    account: session.account,
    operation: op ? { id: op.id, status: op.status, accounting: op.accounting } : null,
    requestedProfile: session.profile,
    requestedModel: session.requestedModel,
    observedModel: session.model,
    servedModel: null,
  };
}

function epochs(session) {
  return digest({
    input: session.inputRevision,
    work: session.workRevision,
    cache: session.cache,
    model: session.model,
    boundary: session.boundary,
  });
}

function applyBridge(session, snapshot, now) {
  const request = session.request;
  if (
    !request?.completed ||
    !request.cacheObserved ||
    session.pendingInput ||
    request.inputRevision !== session.inputRevision ||
    snapshot.requests <= request.baselineRequests ||
    snapshot.refreshedAt < request.startedAt - 1000 ||
    snapshot.refreshedAt > now + 1000 ||
    (session.bridge && snapshot.requests < session.bridge.requests)
  )
    return;
  session.bridge = snapshot;
  session.context = snapshot.context;
  session.cache = {
    ttl: snapshot.ttl,
    warm: snapshot.warm,
    expiresAt: snapshot.expiresAt,
    requestId: request.id,
    requests: snapshot.requests,
  };
}

export function observeCompactBridge(cwd, activationId, input, options = {}) {
  const cache = input.prompt_cache;
  const context = input.context_window;
  id(input.session_id, 'native session');
  number(cache?.requests, 'cache requests', 1, 1000000000);
  choice(cache.ttl, ['5m', '1h'], 'cache TTL');
  check(
    typeof cache.warm === 'boolean' && cache.caching_observed === true,
    'No observed prompt cache',
  );
  number(cache.expires_at, 'cache expires_at', 1, 100000000000);
  const usage = context?.current_usage;
  const tokens = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .map((key) => number(usage?.[key], `context ${key}`, 0, 1000000000))
    .reduce((a, b) => a + b, 0);
  const window = number(context.context_window_size, 'context window', 1, 1000000000);
  return transaction('compact.cache_observed', options, (state, now) => {
    activationAt(state, activationId, cwd);
    const session = state.sessions[digest(input.session_id).slice(0, 32)];
    if (!session || session.activationId !== activationId || session.closed)
      return { accepted: false };
    const snapshot = {
      requests: cache.requests,
      ttl: cache.ttl,
      warm: cache.warm,
      expiresAt: cache.expires_at * 1000,
      refreshedAt: (cache.expires_at - (cache.ttl === '1h' ? 3600 : 300)) * 1000,
      context: { tokens, window },
      observedAt: now,
    };
    if (session.bridge && snapshot.requests < session.bridge.requests) return { accepted: false };
    if (
      session.latestBridge &&
      digest({ ...session.latestBridge, observedAt: 0 }) === digest({ ...snapshot, observedAt: 0 })
    ) {
      applyBridge(session, session.latestBridge, now);
      return { accepted: true };
    }
    session.latestBridge = snapshot;
    applyBridge(session, snapshot, now);
    return { accepted: true };
  });
}

export function compactBridgeCommand(cwd, activationId) {
  const state = loadLedger().state;
  id(activationId, 'compact activation');
  const activation = state.activations[activationId];
  check(activation?.cwd === realpathSync(cwd), 'Status line activation changed', 'ownership');
  return activation.originalStatusLine;
}

export function compactActivation(cwd, activationId) {
  const { activation, policy } = activationAt(loadLedger().state, activationId, cwd);
  return { cwd: activation.cwd, profile: activation.profile, policy };
}

export function compactRpc(cwd, input, options = {}) {
  keys(input, ['action', 'activationId', 'sessionId', 'ownerToken', 'data'], 'compact request');
  const action = choice(
    input.action,
    [
      'register',
      'input',
      'request_start',
      'request_complete',
      'idle',
      'refresh',
      'external_start',
      'external_finish',
      'claim',
      'consume',
      'cancel',
      'finish',
      'close',
    ],
    'compact action',
  );
  const data = input.data || {};
  const allowed = {
    register: ['version', 'model', 'idleCompaction', 'interactive', 'runtimeId'],
    input: ['id', 'revision'],
    request_start: ['id', 'revision', 'startedAt'],
    request_complete: ['id', 'cacheObserved'],
    idle: ['revision', 'model', 'idleCompaction', 'safe'],
    external_start: ['id'],
    external_finish: ['id', 'result', 'precompute'],
    claim: [],
    refresh: [],
    consume: ['operationId'],
    cancel: ['operationId'],
    finish: ['operationId', 'result', 'boundary', 'usage'],
    close: [],
  };
  keys(data, allowed[action], `compact ${action}`);
  assertNoSecrets({ model: data.model });
  return transaction(`compact.${action}`, options, (state, now) => {
    const { activation, policy, config } = activationAt(state, input.activationId, cwd);
    const profile = config.profiles[policy.profile];
    let session;
    if (action === 'register') {
      text(data.version, 'Claude version', 100);
      check(
        compactCapabilities(data.version).supported,
        'Claude Mod requires 2.1.290+',
        'capability',
      );
      check(
        data.interactive === true && data.idleCompaction === false,
        'Interactive session with idleCompaction:false required',
        'capability',
      );
      text(data.model, 'native model', 256);
      id(data.runtimeId, 'Mod runtime');
      id(input.sessionId, 'native session');
      const sessionKey = digest(input.sessionId).slice(0, 32);
      session = state.sessions[sessionKey];
      const pid = options.ownerPid || process.ppid;
      const identify = options.fingerprint || fingerprint;
      const processHash = identify(pid);
      check(processHash, 'Cannot verify compact host process', 'ownership');
      if (session) {
        check(session.cwd === realpathSync(cwd), 'Session moved worktree', 'ownership');
        check(
          (session.owner.pid === pid && session.owner.fingerprint === processHash) ||
            identify(session.owner.pid) !== session.owner.fingerprint,
          'Native session already owned by a live process',
          'ownership',
        );
        if (session.runtimeId !== data.runtimeId || session.activationId !== input.activationId) {
          invalidate(session);
          session.request = null;
          session.bridge = null;
          session.latestBridge = null;
          session.pendingInput = true;
          session.externalCompact = session.externalCompact ? 'unknown' : null;
          if (session.operation?.status === 'intent') session.operation.status = 'unknown';
        }
      } else {
        check(Object.keys(state.sessions).length < 32, 'Compact session limit exceeded', 'budget');
        session = state.sessions[sessionKey] = {
          id: sessionKey,
          nativeId: input.sessionId,
          cwd: realpathSync(cwd),
          projectId: activation.projectId,
          account: account(),
          inputRevision: 0,
          workRevision: 0,
          lastCompactedWorkRevision: 0,
          attemptedRevision: null,
          lastCompactAt: null,
          context: null,
          cache: null,
          request: null,
          operation: null,
          boundary: null,
          externalCompact: null,
          pendingInput: true,
          busy: true,
          bridge: null,
          latestBridge: null,
          inputIds: [],
        };
      }
      session.owner = {
        uid: process.getuid?.() ?? null,
        pid,
        fingerprint: processHash,
        token: randomUUID(),
      };
      session.activationId = input.activationId;
      session.runtimeId = data.runtimeId;
      session.profile = policy.profile;
      session.requestedModel = null;
      session.model = data.model;
      session.closed = false;
      return { ...view(session, policy, now), ownerToken: session.owner.token };
    }
    id(input.sessionId, 'native session');
    session = state.sessions[digest(input.sessionId).slice(0, 32)];
    check(
      session &&
        session.activationId === input.activationId &&
        session.owner.token === input.ownerToken &&
        session.owner.uid === (process.getuid?.() ?? null) &&
        session.owner.pid === (options.ownerPid || process.ppid) &&
        (options.fingerprint || fingerprint)(session.owner.pid) === session.owner.fingerprint,
      'Compact session ownership changed',
      'ownership',
    );
    check(!session.closed, 'Compact session is closed', 'ownership');
    if (action === 'input') {
      id(data.id, 'input id');
      number(data.revision, 'input revision', 1, 1000000000);
      if (!session.inputIds.includes(data.id)) {
        check(
          data.revision === session.inputRevision + 1,
          'Input revision out of order',
          'integrity',
        );
        session.inputRevision = data.revision;
        session.inputIds = [...session.inputIds.slice(-63), data.id];
        session.pendingInput = true;
        session.busy = true;
        invalidate(session);
      }
    } else if (action === 'request_start') {
      id(data.id, 'request id');
      number(data.startedAt, 'request start', 0, now + 1000);
      check(data.revision === session.inputRevision, 'Stale request input revision', 'integrity');
      if (session.request?.id !== data.id) {
        session.request = {
          id: data.id,
          inputRevision: data.revision,
          startedAt: data.startedAt,
          baselineRequests: session.latestBridge?.requests || 0,
          completed: false,
          cacheObserved: false,
        };
        session.pendingInput = true;
        session.busy = true;
        invalidate(session);
      }
    } else if (action === 'request_complete') {
      check(session.request?.id === data.id, 'Stale request completion', 'integrity');
      check(typeof data.cacheObserved === 'boolean', 'cacheObserved must be boolean');
      if (!session.request.completed) {
        session.request.completed = true;
        session.request.cacheObserved = data.cacheObserved;
        session.workRevision += 1;
        session.pendingInput = session.request.inputRevision !== session.inputRevision;
        if (session.latestBridge) applyBridge(session, session.latestBridge, now);
      }
    } else if (action === 'idle') {
      check(data.revision === session.inputRevision, 'Stale idle input revision', 'integrity');
      check(typeof data.safe === 'boolean', 'safe must be boolean');
      text(data.model, 'observed model', 256);
      session.busy = !data.safe;
      if (data.model !== session.model || data.idleCompaction !== false) {
        session.model = data.model;
        invalidate(session);
        session.blocked = 'native_settings_or_model_changed';
      }
    } else if (action === 'external_start') {
      id(data.id, 'compact boundary');
      session.externalCompact = { id: data.id, workRevision: session.workRevision };
      invalidate(session);
    } else if (action === 'external_finish') {
      check(session.externalCompact?.id === data.id, 'Unmatched compact completion', 'integrity');
      const coveredRevision = session.externalCompact.workRevision;
      choice(data.result, ['applied', 'skipped', 'unknown'], 'external result');
      check(typeof data.precompute === 'boolean', 'precompute must be boolean');
      if (data.result !== 'unknown') session.externalCompact = null;
      if (data.result === 'applied' && data.precompute)
        session.precomputedRevision = session.workRevision;
      else if (data.result === 'applied') confirm(session, data.id, now, coveredRevision);
    } else if (action === 'claim') {
      const status = view(session, policy, now);
      if (status.reason) return status;
      if (
        session.operation?.status !== 'prepared' ||
        session.operation.expiresAt <= now ||
        session.operation.epoch !== epochs(session)
      ) {
        session.operation = {
          id: `op-${randomUUID()}`,
          status: 'prepared',
          epoch: epochs(session),
          expiresAt: Math.min(now + 2000, status.latestStartAt),
          accounting: 'unreserved',
        };
      }
      return { ...view(session, policy, now), operationId: session.operation.id };
    } else if (action === 'cancel') {
      check(session.operation?.id === data.operationId, 'Unknown compact operation', 'ownership');
      clearPrepared(session);
    } else if (action === 'consume') {
      const op = session.operation;
      check(
        op?.id === data.operationId &&
          op.status === 'prepared' &&
          op.epoch === epochs(session) &&
          now < op.expiresAt,
        'Compact claim is stale or already consumed',
        'authority',
      );
      const status = view(session, policy, now);
      check(!status.reason, `Compact admission refused: ${status.reason}`, 'authority');
      if (!Object.hasOwn(state.accounts, policy.profile))
        Object.defineProperty(state.accounts, policy.profile, {
          value: account(),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      const shared = state.accounts[policy.profile];
      check(
        Object.values(state.sessions).filter(
          (entry) =>
            entry.operation?.profile === policy.profile &&
            ['intent', 'unknown'].includes(entry.operation?.status),
        ).length < profile.concurrency,
        'Compact profile concurrency unavailable',
        'budget',
      );
      reserveBudget(
        [
          [session.account, profile.budget],
          [shared, profile.budget],
        ],
        profile.budget,
      );
      op.status = 'intent';
      op.accounting = 'reserved';
      op.startedAt = now;
      op.profile = policy.profile;
      op.reservation = profile.budget;
      op.workRevision = session.workRevision;
      session.attemptedRevision = session.workRevision;
    } else if (action === 'finish') {
      const op = session.operation;
      check(
        op?.id === data.operationId && ['intent', 'unknown'].includes(op.status),
        'No matching compact invocation intent',
        'ownership',
      );
      choice(data.result, ['applied', 'skipped', 'failed', 'unknown'], 'compact result');
      op.status = data.result;
      op.accounting = 'usage_unknown';
      if (data.result === 'applied') {
        id(data.boundary, 'compact boundary');
        confirm(session, data.boundary, now, op.workRevision);
      }
      if (data.usage !== undefined) {
        keys(data.usage, ['tokens', 'costUsd'], 'compact usage');
        number(data.usage.tokens, 'compact tokens', 0, 1000000000);
        number(data.usage.costUsd, 'compact cost', 0, 1000000, false);
        try {
          settleBudget(
            [
              [session.account, op.reservation],
              [state.accounts[op.profile], op.reservation],
            ],
            op.reservation,
            { ...data.usage, estimated: false },
          );
          op.accounting = 'settled';
        } catch (error) {
          if (error.code !== 'budget') throw error;
          op.accounting = 'settled';
          session.blocked = 'budget_exceeded';
        }
      }
      invalidate(session);
    } else if (action === 'close') {
      session.closed = true;
      invalidate(session);
      if (session.operation?.status === 'intent') session.operation.status = 'unknown';
    }
    return view(session, policy, now);
  });
}

function confirm(session, boundary, now, coveredRevision) {
  session.lastCompactedWorkRevision = Math.max(session.lastCompactedWorkRevision, coveredRevision);
  session.lastCompactAt = now;
  session.boundary = boundary;
  session.precomputedRevision = null;
  session.request = null;
  session.latestBridge = null;
  invalidate(session);
}

export function compactStatus(cwd) {
  const projectId = projectIdentity(cwd).projectId;
  const state = loadLedger().state;
  return Object.values(state.sessions)
    .filter((session) => session.projectId === projectId)
    .map((session) => {
      try {
        const { policy } = activationAt(state, session.activationId, session.cwd);
        return view(session, policy, Date.now());
      } catch (error) {
        return {
          id: session.id,
          sessionId: session.nativeId,
          state: 'unavailable',
          reason: error.code,
        };
      }
    });
}
