import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { commandExists, FINAL_MARKER, hash, now, projectIdentity, stateHome } from './core.mjs';
import { atomicWrite, ensureDir, jsonRead, lockDir, safeRead } from './storage.mjs';
import { killOwnedTree } from './process.mjs';
import { backendFor } from './backends.mjs';
import { delay } from './runner.mjs';
import {
  assertNoCredentialArgs,
  assertNoSecrets,
  redact,
  environmentSecrets,
  environment,
} from './security.mjs';
import { BASE_ENV } from './profiles.mjs';
import { memoryPointer } from './memory.mjs';
import { check, choice, number, text, OmhaError } from './validation.mjs';
import { handoffPaths as paths, handoffsDir, WORKER_FINAL_STATES } from './handoff-protocol.mjs';

const FINAL_STATES = [...WORKER_FINAL_STATES, 'closed'];
function save(record) {
  atomicWrite(record.recordFile, JSON.stringify(record, null, 2), stateHome());
}
export function handoffStatus(handoffId) {
  const path = paths(handoffId),
    record = jsonRead(path.recordFile, null, path.root);
  check(
    record && record.id === handoffId && record.recordFile === path.recordFile,
    'Handoff does not exist or its record is invalid',
  );
  check(
    record.owner.uid === (process.getuid?.() ?? null),
    'Handoff belongs to a different OS user',
    'ownership',
  );
  return record;
}
export function listHandoffs() {
  const dir = handoffsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[A-Za-z0-9_-]+$/.test(name))
    .sort()
    .map((name) => handoffStatus(name));
}

export async function handoff(cwd, prompt, options = {}) {
  text(prompt, 'handoff prompt', 1000000);
  assertNoSecrets(prompt);
  const handoffId = options.id || `handoff-${randomUUID()}`;
  const path = paths(handoffId);
  const name = options.name || handoffId;
  text(name, 'handoff name', 128);
  choice(options.backend || 'auto', ['auto', 'cmux', 'tmux', 'file', 'fake'], 'handoff backend');
  let selected = options.backend || 'auto';
  check(
    process.platform !== 'win32' || ['auto', 'file', 'fake'].includes(selected),
    'Native terminal backends require POSIX',
  );
  const candidates =
    selected === 'auto'
      ? ['cmux', 'tmux', 'file'].filter(
          (name) =>
            name === 'file' ||
            (process.platform !== 'win32' && (options.backends?.[name] || commandExists(name))),
        )
      : [selected];
  selected = candidates[0];
  if (selected === 'fake')
    check(options.backendAdapter, 'Fake backend requires an injected adapter');
  const timeoutMs = number(options.timeoutMs ?? 3600000, 'handoff timeoutMs', 10, 86400000);
  const command = options.command || process.env.SHELL || '/bin/sh';
  text(command, 'handoff command', 4096);
  assertNoSecrets(command);
  const args = options.args || (options.command ? [] : ['-i']);
  check(
    Array.isArray(args) && args.every((a) => typeof a === 'string' && !a.includes('\0')),
    'handoff args must be strings',
  );
  assertNoSecrets(args);
  assertNoCredentialArgs(args);
  const envAllowlist = options.envAllowlist || BASE_ENV;
  check(
    Array.isArray(envAllowlist) &&
      envAllowlist.every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)),
    'Invalid environment allowlist',
  );
  ensureDir(handoffsDir(path.root), path.root);
  check(!existsSync(path.dir), 'Handoff id already exists');
  ensureDir(path.dir, path.root);
  const record = {
    version: 1,
    id: handoffId,
    name,
    backend: selected,
    cwd: realpathSync(cwd),
    projectId: projectIdentity(cwd).projectId,
    owner: { uid: process.getuid?.() ?? null, token: randomUUID() },
    recordFile: path.recordFile,
    promptFile: path.promptFile,
    promptHash: hash(prompt),
    startedAt: now(),
    timeoutMs,
    state: 'launching',
    ref: null,
    pid: null,
    command,
    args,
    interactive: options.interactive ?? !options.command,
    envAllowlist,
    memory: memoryPointer(cwd),
  };
  atomicWrite(record.promptFile, prompt, path.root);
  save(record);
  record.launchAttempts = [];
  for (const candidate of candidates) {
    record.backend = candidate;
    record.ref = null;
    record.pid = null;
    record.state = 'launching';
    for (const key of [
      'socket',
      'socketDir',
      'session',
      'surfaceRef',
      'backendClosed',
      'failure',
      'failureMessage',
    ])
      delete record[key];
    const backend = backendFor(record, options);
    try {
      if (options.signal?.aborted) throw new OmhaError('cancellation', 'Handoff launch cancelled');
      Object.assign(record, await backend.prepare?.(record));
      save(record);
      if (options.signal?.aborted) throw new OmhaError('cancellation', 'Handoff launch cancelled');
      Object.assign(record, await backend.start(record));
      record.state = candidate === 'file' ? 'awaiting' : 'running';
      record.launchAttempts.push({ backend: candidate, state: record.state });
      save(record);
      break;
    } catch (error) {
      record.state = error.code === 'cancellation' ? 'cancelled' : 'failed';
      record.failure = error.code || 'backend';
      record.failureMessage = redact(error.message);
      const attempt = {
        backend: candidate,
        state: record.state,
        failure: record.failure,
        ref: record.ref,
        message: record.failureMessage,
      };
      if (record.ref) {
        try {
          await backend.close(record);
          attempt.cleanedUp = true;
          record.backendClosed = true;
        } catch (cleanupError) {
          attempt.cleanupFailure = cleanupError.code || 'backend';
        }
      }
      record.launchAttempts.push(attempt);
      save(record);
      if (record.failure === 'cancellation' || record.failure === 'ownership') break;
    }
  }
  return options.json === false
    ? `${record.backend} handoff ${record.id}: ${record.ref || record.promptFile}`
    : record;
}

function validFinal(final, record) {
  check(
    final &&
      final.token === record.owner.token &&
      WORKER_FINAL_STATES.includes(final.state) &&
      Number.isInteger(final.exitCode) &&
      final.exitCode >= 0 &&
      final.exitCode <= 255,
    'Invalid handoff final marker',
    'malformed_completion',
  );
  check(
    final.state !== 'completed' || final.exitCode === 0,
    'Nonzero handoff exit cannot be successful',
    'malformed_completion',
  );
  return final;
}

export async function readHandoff(handoffId, options = {}) {
  const path = paths(handoffId),
    release = lockDir(join(path.dir, '.lock'), { root: path.root });
  try {
    const record = handoffStatus(handoffId),
      backend = backendFor(record, options);
    const secrets = environmentSecrets(environment(record.envAllowlist));
    let screen = '';
    if (record.backend !== 'file' && !record.backendClosed) {
      try {
        screen = await backend.capture(record);
      } catch (error) {
        if (error.code === 'ownership') throw error;
      }
    }
    const worker = jsonRead(path.processFile, null, path.root);
    if (worker?.token === record.owner.token) record.pid = worker.pid;
    let final = jsonRead(path.finalFile, null, path.root);
    if (!final) {
      const markers = screen.split(/\r?\n/).filter((line) => line.startsWith(FINAL_MARKER));
      if (markers.length) {
        try {
          final = JSON.parse(markers.at(-1).slice(FINAL_MARKER.length));
        } catch {
          throw new OmhaError('malformed_completion', 'Malformed handoff final JSON');
        }
      }
    }
    if (final && record.state !== 'closed') {
      validFinal(final, record);
      record.state = final.state;
      record.completion = final;
    }
    if (
      !FINAL_STATES.includes(record.state) &&
      Date.now() - Date.parse(record.startedAt) >= record.timeoutMs
    ) {
      await terminate(record, 'timed_out', backend);
      record.state = 'timed_out';
    } else if (
      !FINAL_STATES.includes(record.state) &&
      record.backend !== 'file' &&
      !(await backend.alive(record))
    ) {
      record.state = 'failed';
      record.failure = 'missing_completion';
    }
    if (record.state === 'timed_out' && !record.backendClosed) {
      try {
        await backend.close(record);
        record.backendClosed = true;
      } catch (error) {
        if (error.code === 'ownership') throw error;
      }
    }
    save(record);
    return {
      ...record,
      alive: !FINAL_STATES.includes(record.state) && record.backend !== 'file',
      output: redact(
        (screen || (existsSync(path.outputFile) ? safeRead(path.outputFile, path.root) : '')).slice(
          -262144,
        ),
        secrets,
      ),
    };
  } finally {
    release();
  }
}

export async function pollHandoff(handoffId, options = {}) {
  const waitMs = number(options.waitMs ?? 30000, 'poll waitMs', 0, 86400000);
  const start = Date.now();
  while (true) {
    const result = await readHandoff(handoffId, options);
    if (FINAL_STATES.includes(result.state) || Date.now() - start >= waitMs) return result;
    if (options.signal?.aborted) return cancelHandoff(handoffId, options);
    await delay(
      Math.min(options.intervalMs || 100, Math.max(0, waitMs - (Date.now() - start))),
      options.signal,
    ).catch(() => {});
  }
}

export async function sendHandoff(handoffId, value, options = {}) {
  text(value, 'terminal input', 1000000);
  assertNoSecrets(value);
  const record = handoffStatus(handoffId);
  check(record.state === 'running', 'Handoff is not running');
  await backendFor(record, options).send(record, value, options.enter !== false);
  return { id: record.id, sentHash: hash(value), enter: options.enter !== false };
}

async function terminate(record, state, backend) {
  await backend.verify(record);
  const path = paths(record.id),
    worker = jsonRead(path.processFile, null, path.root);
  if (worker?.token === record.owner.token) {
    killOwnedTree(worker.childPid, worker.fingerprint, 'SIGKILL');
  }
  if (record.backend !== 'file') {
    await backend.close(record);
    record.backendClosed = true;
  }
  record.state = state;
  atomicWrite(
    path.finalFile,
    JSON.stringify({
      token: record.owner.token,
      state,
      exitCode: state === 'timed_out' ? 124 : 130,
      at: now(),
    }),
    path.root,
  );
}

export async function cancelHandoff(handoffId, options = {}) {
  const path = paths(handoffId),
    release = lockDir(join(path.dir, '.lock'), { root: path.root });
  try {
    const record = handoffStatus(handoffId);
    if (FINAL_STATES.includes(record.state)) return record;
    await terminate(record, 'cancelled', backendFor(record, options));
    save(record);
    return record;
  } finally {
    release();
  }
}

export async function closeHandoff(handoffId, options = {}) {
  const current = handoffStatus(handoffId);
  if (!FINAL_STATES.includes(current.state)) await cancelHandoff(handoffId, options);
  const record = handoffStatus(handoffId);
  if (!record.backendClosed && record.backend !== 'file') {
    await backendFor(record, options).close(record);
    record.backendClosed = true;
  }
  record.previousState = record.state;
  record.state = 'closed';
  record.closedAt = now();
  save(record);
  return record;
}

export async function resumeHandoff(handoffId, prompt, options = {}) {
  const previous = handoffStatus(handoffId);
  if (previous.state === 'running') return sendHandoff(handoffId, prompt, options);
  const resumed = await handoff(
    previous.cwd,
    prompt || safeRead(previous.promptFile, stateHome()),
    {
      ...options,
      backend: options.backend || previous.backend,
      command: previous.command,
      args: previous.args,
      interactive: previous.interactive,
      timeoutMs: previous.timeoutMs,
      envAllowlist: previous.envAllowlist,
    },
  );
  resumed.resumedFrom = previous.id;
  save(resumed);
  return resumed;
}

export function completeHandoff(handoffId, exitCode = 0) {
  number(exitCode, 'exitCode', 0, 255);
  const record = handoffStatus(handoffId);
  check(
    record.backend === 'file',
    'Explicit completion is for file handoffs; terminal workers must emit a final marker',
  );
  check(!FINAL_STATES.includes(record.state), 'Handoff already finished');
  const path = paths(handoffId);
  const final = {
    token: record.owner.token,
    state: exitCode === 0 ? 'completed' : 'failed',
    exitCode,
    explicit: true,
    at: now(),
  };
  atomicWrite(path.finalFile, JSON.stringify(final), path.root);
  record.state = final.state;
  record.completion = final;
  save(record);
  return record;
}
