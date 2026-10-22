import { join } from 'node:path';
import { commandExists, hash, now, stateHome } from './core.mjs';
import { cmuxJsonCommand, runCmux } from './backends.mjs';
import { delay } from './runner.mjs';
import { appendEvent, atomicWrite, jsonRead, lockDir, readEvents } from './storage.mjs';
import { assertNoSecrets, environmentSecrets, redact } from './security.mjs';
import { check, number, OmhaError, text } from './validation.mjs';

const STATE_VERSION = 1;
const DEFAULTS = {
  intervalMs: 20 * 60 * 1000,
  cooldownMs: 10 * 60 * 1000,
  maxAttempts: 6,
  screenLines: 80,
  errorWindow: 12,
  verifyMs: 1500,
  sendDelayMs: 250,
  message: 'go on',
};

// Ordered by specificity. A bottom-most matching line wins; a later "retrying"
// line means the client still owns the retry and we must not inject input.
const FAILURE_PATTERNS = [
  {
    category: 'retrying',
    reason: 'client retrying',
    re: /\b(?:retrying(?: in|\.\.\.)|reconnecting|will retry|retry in \d)/i,
  },
  {
    category: 'auth',
    reason: 'authentication failure',
    re: /\b(?:401 Unauthorized|403 Forbidden|invalid api key|authentication_error|permission denied|unauthorized)\b/i,
  },
  {
    category: 'quota',
    reason: 'quota or billing block',
    re: /\b(?:insufficient_quota|quota exceeded|credit balance|billing (?:error|issue)|out of credits|payment required)\b|余额不足|额度不足|欠费/i,
  },
  {
    category: 'rate_limit',
    reason: 'rate limited',
    re: /\b(?:429 Too Many Requests|HTTP 429|too many requests|rate[ _-]?limit(?:ed|ing)?)\b/i,
  },
  {
    category: 'connection',
    reason: 'stream disconnected',
    re: /stream disconnected before completion/i,
  },
  {
    category: 'connection',
    reason: 'provider overloaded',
    re: /(?:servers? are currently overloaded|overloaded_error|"type"\s*:\s*"overloaded_error")/i,
  },
  {
    category: 'connection',
    reason: 'provider 5xx',
    re: /\bAPI Error:\s*(?:5\d\d|429)\b/i,
  },
  {
    category: 'connection',
    reason: 'upstream 5xx',
    re: /\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout|520 Web Server Returned an Unknown Error|521 Web Server Is Down|522 Connection Timed Out|523 Origin Is Unreachable|524 A Timeout Occurred|525 SSL Handshake Failed)\b/i,
  },
  {
    category: 'connection',
    reason: 'network failure',
    re: /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|connection reset by peer|connection refused)\b/i,
  },
  {
    category: 'connection',
    reason: 'network failure',
    re: /\b(?:fetch failed|network error|connection error|connection closed|transport error)\b|网络异常|连接中断|连接超时|服务器繁忙|请稍后重试/i,
  },
  {
    category: 'connection',
    reason: 'stream error',
    re: /\bstream (?:error|interrupted|closed|aborted)\b|\b(?:request|response) timed out\b|\bupstream (?:connect error|request timeout|error|unavailable)\b/i,
  },
  {
    category: 'connection',
    reason: 'server error',
    re: /\b(?:500 Internal Server Error|server error|service unavailable|bad gateway|gateway timeout)\b/i,
  },
  {
    category: 'connection',
    reason: 'request aborted',
    re: /\b(?:operation|request) was aborted\b/i,
  },
];

const root = () => join(stateHome(), 'auto-recover');
const stateFile = () => join(root(), 'state.json');
const eventsFile = () => join(root(), 'events.jsonl');
const lockPath = () => join(root(), 'auto-recover.lock');

const defaultCmux = {
  current: (cwd) => cmuxJsonCommand(cwd, ['--json', 'current']),
  surfaces: (cwd) => cmuxJsonCommand(cwd, ['--json', 'surface', 'ls']),
  readScreen: (cwd, tab, lines) =>
    runCmux(cwd, [
      'read-screen',
      '--workspace',
      tab.workspaceId,
      '--surface',
      tab.surfaceId,
      '--lines',
      String(lines),
    ]),
  send: (cwd, tab, value) =>
    runCmux(cwd, ['send', '--workspace', tab.workspaceId, '--surface', tab.surfaceId, value]),
  sendKey: (cwd, tab, key) =>
    runCmux(cwd, ['send-key', '--workspace', tab.workspaceId, '--surface', tab.surfaceId, key]),
};

function integer(value, fallback, label, min, max) {
  return value === undefined ? fallback : number(value, label, min, max);
}

function optionsWithDefaults(options) {
  const message = options.message ?? DEFAULTS.message;
  text(message, 'recovery message', 1024);
  check(
    !/[\r\n\0]/.test(message) && !message.startsWith('-'),
    'Recovery message must be one line and must not start with "-"',
  );
  assertNoSecrets(message);
  return {
    ...options,
    message,
    intervalMs: integer(options.intervalMs, DEFAULTS.intervalMs, 'intervalMs', 60000, 86400000),
    cooldownMs: integer(options.cooldownMs, DEFAULTS.cooldownMs, 'cooldownMs', 0, 86400000),
    maxAttempts: integer(options.maxAttempts, DEFAULTS.maxAttempts, 'maxAttempts', 1, 100),
    screenLines: integer(options.screenLines, DEFAULTS.screenLines, 'screenLines', 10, 500),
    errorWindow: integer(options.errorWindow, DEFAULTS.errorWindow, 'errorWindow', 1, 100),
    verifyMs: integer(options.verifyMs, DEFAULTS.verifyMs, 'verifyMs', 0, 30000),
    sendDelayMs: integer(options.sendDelayMs, DEFAULTS.sendDelayMs, 'sendDelayMs', 0, 5000),
  };
}

function adapter(options) {
  if (options.cmux) return options.cmux;
  check(commandExists('cmux'), 'cmux is required for tab recovery', 'backend');
  return defaultCmux;
}

function redacted(value) {
  return redact(String(value ?? ''), environmentSecrets(process.env));
}

function safeLabel(value, fallback) {
  const label = redacted(value).trim();
  return (label || fallback).slice(0, 200);
}

export async function discoverTabs(cwd, options = {}) {
  check(process.platform !== 'win32', 'Tab recovery requires POSIX');
  const cmux = adapter(options);
  const [current, catalog] = await Promise.all([cmux.current(cwd), cmux.surfaces(cwd)]);
  check(
    current && typeof current === 'object' && Array.isArray(current.items),
    'cmux current projection is invalid',
    'backend',
  );
  check(
    catalog && Array.isArray(catalog.projections),
    'cmux surface catalog is invalid',
    'backend',
  );
  const observed = new Map();
  for (const item of current.items) {
    if (typeof item?.durable_surface_id === 'string') observed.set(item.durable_surface_id, item);
  }
  const seen = new Set();
  const tabs = [];
  for (const projection of catalog.projections) {
    if (typeof projection?.resource !== 'string') continue;
    if (!projection.resource.startsWith('local/terminal/')) continue;
    if (
      typeof projection.surface_id !== 'string' ||
      typeof projection.workspace_id !== 'string' ||
      typeof projection.stable_surface_id !== 'string'
    )
      continue;
    const key = projection.surface_id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const item = observed.get(projection.stable_surface_id) || null;
    const agents = Array.isArray(item?.agents)
      ? item.agents.filter((agent) => agent && typeof agent.kind === 'string')
      : [];
    tabs.push({
      workspaceId: projection.workspace_id,
      surfaceId: projection.surface_id,
      stableSurfaceId: projection.stable_surface_id,
      label: safeLabel(item?.label, projection.resource),
      cwd: typeof item?.cwd === 'string' ? item.cwd : null,
      lifecycle: typeof item?.lifecycle === 'string' ? item.lifecycle : 'unknown',
      agents: agents.map((agent) => ({
        kind: agent.kind,
        state: typeof agent.state === 'string' ? agent.state : 'unknown',
        lastActivityAt: agent.last_activity_at ?? null,
      })),
      hasAgent: agents.length > 0,
    });
  }
  tabs.sort((a, b) => a.label.localeCompare(b.label) || a.surfaceId.localeCompare(b.surfaceId));
  return tabs;
}

function screenTail(screen, windowSize) {
  return String(screen)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(-windowSize);
}

function detectFailure(screen, windowSize) {
  const tail = screenTail(screen, windowSize);
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    for (const pattern of FAILURE_PATTERNS) {
      if (pattern.re.test(tail[index]))
        return {
          category: pattern.category,
          reason: pattern.reason,
          line: redacted(tail[index]).trim().slice(0, 300),
          digest: hash(tail.join('\n')),
        };
    }
  }
  return null;
}

function activeAgents(tab) {
  return tab.agents.filter((agent) => agent.state !== 'ended');
}

function saveState(state) {
  atomicWrite(stateFile(), JSON.stringify(state, null, 2), stateHome());
}

async function record(event) {
  appendEvent(eventsFile(), event, stateHome());
}

const ERROR_STATUSES = new Set([
  'recoverable',
  'recovered',
  'sent_unverified',
  'cooldown',
  'stalled',
  'blocked',
  'retrying',
  'send_failed',
  'enter_failed',
]);

async function processTab(cwd, tab, cmux, options, state, checkedAt) {
  const surface = state.surfaces[tab.surfaceId] || {
    attempts: 0,
    stalled: false,
    lastReason: null,
  };
  const previousStatus = surface.lastStatus || null;
  const wasError = ERROR_STATUSES.has(previousStatus);
  const changedFrom = (status) => previousStatus !== status;
  const result = {
    workspaceId: tab.workspaceId,
    surfaceId: tab.surfaceId,
    label: tab.label,
    agents: tab.agents,
    status: 'ok',
  };
  const identifyOnly = !tab.hasAgent || !activeAgents(tab).length;
  if (identifyOnly) {
    // A missing agent registration is not proof of a plain shell. Inspect the
    // tab so it is still reported, but never type into an unverified target.
    let screen = null;
    try {
      screen = await cmux.readScreen(cwd, tab, options.screenLines);
    } catch {
      screen = null;
    }
    const failure = screen === null ? null : detectFailure(screen, options.errorWindow);
    result.status = failure ? 'detected' : 'skipped';
    result.reason = failure ? failure.reason : tab.hasAgent ? 'agent ended' : 'no agent session';
    if (failure)
      result.match = {
        category: failure.category,
        reason: failure.reason,
        line: failure.line,
      };
    if (
      (failure && changedFrom('detected')) ||
      (!failure && (wasError || previousStatus === 'detected'))
    )
      await record({
        kind: failure ? 'auto_recover.detected_unregistered' : 'auto_recover.recovered',
        at: checkedAt,
        surfaceId: tab.surfaceId,
        workspaceId: tab.workspaceId,
        label: tab.label,
        reason: result.reason,
        category: failure?.category,
      });
    surface.lastStatus = result.status;
    surface.lastSeenAt = checkedAt;
    if (failure) surface.lastErrorAt = checkedAt;
    state.surfaces[tab.surfaceId] = surface;
    return result;
  }
  if (activeAgents(tab).some((agent) => agent.state === 'working')) {
    result.status = 'busy';
    result.reason = 'agent is working';
    surface.lastStatus = result.status;
    surface.lastSeenAt = checkedAt;
    surface.attempts = 0;
    surface.stalled = false;
    delete surface.lastReason;
    state.surfaces[tab.surfaceId] = surface;
    return result;
  }

  let screen;
  try {
    screen = await cmux.readScreen(cwd, tab, options.screenLines);
  } catch (error) {
    result.status = 'unreadable';
    result.reason = 'screen capture failed';
    result.error = redacted(error.message).slice(0, 300);
    surface.lastStatus = result.status;
    surface.lastSeenAt = checkedAt;
    state.surfaces[tab.surfaceId] = surface;
    return result;
  }
  const failure = detectFailure(screen, options.errorWindow);
  if (!failure) {
    if (wasError)
      await record({
        kind: 'auto_recover.recovered',
        at: checkedAt,
        surfaceId: tab.surfaceId,
        workspaceId: tab.workspaceId,
        label: tab.label,
      });
    surface.attempts = 0;
    surface.stalled = false;
    delete surface.lastReason;
    delete surface.lastErrorDigest;
    surface.lastStatus = 'ok';
    surface.lastSeenAt = checkedAt;
    surface.lastOkAt = checkedAt;
    state.surfaces[tab.surfaceId] = surface;
    return result;
  }

  result.match = {
    category: failure.category,
    reason: failure.reason,
    line: failure.line,
  };
  if (surface.lastReason !== failure.reason) {
    surface.attempts = 0;
    surface.stalled = false;
  }
  surface.lastReason = failure.reason;
  surface.lastSeenAt = checkedAt;
  surface.lastErrorAt = checkedAt;
  surface.lastErrorDigest = failure.digest;

  if (failure.category === 'auth' || failure.category === 'quota') {
    result.status = 'blocked';
    result.reason = failure.reason;
    if (changedFrom(result.status))
      await record({
        kind: 'auto_recover.blocked',
        at: checkedAt,
        surfaceId: tab.surfaceId,
        workspaceId: tab.workspaceId,
        label: tab.label,
        category: failure.category,
        reason: failure.reason,
        error: failure.line,
      });
    surface.lastStatus = result.status;
    state.surfaces[tab.surfaceId] = surface;
    return result;
  }
  if (failure.category === 'retrying') {
    result.status = 'retrying';
    result.reason = failure.reason;
    surface.lastStatus = result.status;
    state.surfaces[tab.surfaceId] = surface;
    return result;
  }

  if (!options.allowSend) {
    result.status = 'recoverable';
    result.reason = failure.reason;
    result.action = { sent: false, message: options.message };
    if (changedFrom('recoverable'))
      await record({
        kind: 'auto_recover.detected',
        at: checkedAt,
        surfaceId: tab.surfaceId,
        workspaceId: tab.workspaceId,
        label: tab.label,
        category: failure.category,
        reason: failure.reason,
      });
    surface.lastStatus = result.status;
    state.surfaces[tab.surfaceId] = surface;
    return result;
  }

  const nowMs = options.now();
  const lastSentMs = surface.lastSentAt ? Date.parse(surface.lastSentAt) : null;
  if (Number.isFinite(lastSentMs) && nowMs - lastSentMs < options.cooldownMs) {
    result.status = 'cooldown';
    result.reason = failure.reason;
    result.retryAt = new Date(lastSentMs + options.cooldownMs).toISOString();
    if (changedFrom('cooldown'))
      await record({
        kind: 'auto_recover.cooldown',
        at: checkedAt,
        surfaceId: tab.surfaceId,
        workspaceId: tab.workspaceId,
        label: tab.label,
        reason: failure.reason,
        retryAt: result.retryAt,
      });
    surface.lastStatus = result.status;
    state.surfaces[tab.surfaceId] = surface;
    return result;
  }
  if (surface.stalled || surface.attempts >= options.maxAttempts) {
    result.status = 'stalled';
    result.reason = `recovery attempts exhausted after ${surface.attempts}`;
    surface.stalled = true;
    if (changedFrom('stalled'))
      await record({
        kind: 'auto_recover.stalled',
        at: checkedAt,
        surfaceId: tab.surfaceId,
        workspaceId: tab.workspaceId,
        label: tab.label,
        attempts: surface.attempts,
        reason: failure.reason,
      });
    surface.lastStatus = result.status;
    state.surfaces[tab.surfaceId] = surface;
    return result;
  }

  surface.attempts += 1;
  surface.lastSentAt = new Date(nowMs).toISOString();
  surface.lastSentDigest = failure.digest;
  try {
    await cmux.send(cwd, tab, options.message);
  } catch (error) {
    result.status = 'send_failed';
    result.reason = failure.reason;
    result.action = {
      sent: false,
      message: options.message,
      verified: false,
      error: redacted(error.message).slice(0, 300),
    };
    surface.lastStatus = result.status;
    state.surfaces[tab.surfaceId] = surface;
    await record({
      kind: 'auto_recover.uncertain',
      at: checkedAt,
      surfaceId: tab.surfaceId,
      workspaceId: tab.workspaceId,
      label: tab.label,
      status: result.status,
      reason: failure.reason,
      error: result.action.error,
    });
    return result;
  }
  try {
    await delay(options.sendDelayMs, options.signal);
    await cmux.sendKey(cwd, tab, 'Enter');
  } catch (error) {
    // Text may already be sitting in the input box. Never retype it.
    result.status = 'enter_failed';
    result.reason = failure.reason;
    result.action = {
      sent: true,
      submitted: false,
      message: options.message,
      verified: false,
      error: redacted(error.message).slice(0, 300),
    };
    // The text may sit in the input box. Stop retrying this surface until the
    // error clears; a later pass must not type the message a second time.
    surface.stalled = true;
    surface.lastStatus = result.status;
    state.surfaces[tab.surfaceId] = surface;
    await record({
      kind: 'auto_recover.uncertain',
      at: checkedAt,
      surfaceId: tab.surfaceId,
      workspaceId: tab.workspaceId,
      label: tab.label,
      status: result.status,
      reason: failure.reason,
      error: result.action.error,
    });
    return result;
  }

  await delay(options.verifyMs, options.signal);
  let after = null;
  try {
    after = await cmux.readScreen(cwd, tab, options.screenLines);
  } catch {
    after = null;
  }
  const changed = after !== null && after !== screen;
  const echoed =
    after !== null &&
    screenTail(after, options.errorWindow + 10)
      .join('\n')
      .toLowerCase()
      .includes(options.message.toLowerCase());
  const verified = changed && echoed;
  result.status = verified ? 'recovered' : 'sent_unverified';
  result.reason = failure.reason;
  result.action = { sent: true, submitted: true, message: options.message, verified };
  surface.lastStatus = result.status;
  surface.lastVerifiedAt = verified ? new Date(options.now()).toISOString() : undefined;
  if (surface.attempts >= options.maxAttempts) surface.stalled = true;
  state.surfaces[tab.surfaceId] = surface;
  await record({
    kind: verified ? 'auto_recover.sent' : 'auto_recover.uncertain',
    at: checkedAt,
    surfaceId: tab.surfaceId,
    workspaceId: tab.workspaceId,
    label: tab.label,
    message: options.message,
    category: failure.category,
    reason: failure.reason,
    attempts: surface.attempts,
    changed,
    echoed,
    verified,
  });
  return result;
}

function summarize(results) {
  const summary = {
    checked: results.length,
    agents: results.filter((result) => result.agents.length > 0).length,
    ok: 0,
    recoverable: 0,
    recovered: 0,
    sent_unverified: 0,
    cooldown: 0,
    stalled: 0,
    blocked: 0,
    retrying: 0,
    busy: 0,
    skipped: 0,
    unreadable: 0,
    send_failed: 0,
    enter_failed: 0,
  };
  for (const result of results) summary[result.status] = (summary[result.status] || 0) + 1;
  summary.sent = results.filter((result) => result.action?.sent).length;
  summary.verified = results.filter((result) => result.action?.verified).length;
  return summary;
}

async function recoveryPass(cwd, rawOptions = {}) {
  const options = optionsWithDefaults(rawOptions);
  options.now = rawOptions.now || Date.now;
  options.signal = rawOptions.signal;
  const cmux = adapter(options);
  const checkedAt = now();
  const tabs = await discoverTabs(cwd, { cmux });
  const state = jsonRead(stateFile(), null, stateHome()) || {
    version: STATE_VERSION,
    surfaces: {},
  };
  check(state.version === STATE_VERSION, 'Tab recovery state version is unsupported');
  if (!state.surfaces || typeof state.surfaces !== 'object') state.surfaces = {};
  const retained = new Set(tabs.map((tab) => tab.surfaceId));
  for (const surfaceId of Object.keys(state.surfaces))
    if (!retained.has(surfaceId)) delete state.surfaces[surfaceId];
  const results = [];
  for (const tab of tabs) results.push(await processTab(cwd, tab, cmux, options, state, checkedAt));
  const report = {
    version: STATE_VERSION,
    checkedAt,
    message: options.message,
    summary: summarize(results),
    tabs: results,
  };
  state.version = STATE_VERSION;
  state.updatedAt = checkedAt;
  state.lastPass = report.summary;
  saveState(state);
  await record({
    kind: 'auto_recover.pass',
    at: checkedAt,
    summary: report.summary,
  });
  return report;
}

export async function recoverTabs(cwd, options = {}) {
  const release = lockDir(lockPath(), {
    root: stateHome(),
    timeoutMs: options.lockTimeoutMs ?? 100,
  });
  try {
    return await recoveryPass(cwd, options);
  } finally {
    release();
  }
}

export async function watchTabRecovery(cwd, options = {}) {
  const settings = optionsWithDefaults(options);
  const release = lockDir(lockPath(), {
    root: stateHome(),
    timeoutMs: options.lockTimeoutMs ?? 0,
  });
  try {
    while (!options.signal?.aborted) {
      try {
        options.onReport?.(await recoveryPass(cwd, options));
      } catch (error) {
        if (options.signal?.aborted) break;
        const code = error.code || 'backend';
        // Only retry failures that can heal without operator action. Bad
        // options, corrupt state and unsafe paths must stop the watcher.
        if (!['backend', 'timeout', 'lock_timeout'].includes(code)) throw error;
        options.onReport?.({
          checkedAt: now(),
          error: {
            code,
            message: redacted(error.message).slice(0, 500),
          },
        });
      }
      try {
        await delay(settings.intervalMs, options.signal);
      } catch {
        break;
      }
    }
    return { stopped: true, checkedAt: now() };
  } finally {
    release();
  }
}

export function tabRecoveryStatus() {
  const state = jsonRead(stateFile(), null, stateHome());
  let events = [];
  try {
    events = readEvents(eventsFile(), stateHome()).slice(-50);
  } catch {
    events = [];
  }
  return {
    version: STATE_VERSION,
    state,
    recentEvents: events,
  };
}
