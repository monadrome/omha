import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandExists, FINAL_MARKER, hash, now, projectIdentity, stateHome } from './core.mjs';
import { appendEvent, atomicWrite, ensureDir, jsonRead, lockDir, safeRead } from './storage.mjs';
import { killOwnedTree, processFingerprint, isProcessDescendant } from './process.mjs';
import { backendFor, shellQuote } from './backends.mjs';
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
import { check, choice, id, keys, number, text, OmhaError } from './validation.mjs';
import { handoffPaths as paths, handoffsDir, WORKER_FINAL_STATES } from './handoff-protocol.mjs';
import { compactCapabilities, prepareCompact } from './compact.mjs';
import { run } from './process.mjs';

export {
  compactRpc,
  compactStatus,
  observeCompactBridge,
  compactBridgeCommand,
  compactCapabilities,
  compactActivation,
  prepareCompact,
} from './compact.mjs';

export async function startCompactSession(cwd, options = {}) {
  check(process.platform !== 'win32', 'Interactive compact activation requires POSIX');
  const args = options.args || [];
  check(
    Array.isArray(args) && args.every((arg) => typeof arg === 'string' && !arg.includes('\0')),
    'Claude arguments must be strings',
  );
  assertNoCredentialArgs(args);
  assertNoSecrets(args);
  check(
    !args.some((arg) =>
      ['--settings', '--print', '-p', '--plugin-dir'].some(
        (flag) => arg === flag || arg.startsWith(`${flag}=`),
      ),
    ),
    'Use compact --input for settings; print and plugin-dir overrides are not supported',
  );
  const version = await run('claude', ['--version'], {
    cwd,
    timeoutMs: 5000,
    env: environment(BASE_ENV),
  });
  check(
    version.code === 0 && compactCapabilities(version.stdout.trim()).supported,
    'Auto compact requires Claude Code 2.1.290+; existing skills remain available',
    'capability',
  );
  let statusLine;
  for (const file of [
    join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
    join(cwd, '.claude', 'settings.json'),
    join(cwd, '.claude', 'settings.local.json'),
  ]) {
    if (existsSync(file)) {
      const settings = JSON.parse(safeRead(file));
      if (settings.statusLine !== undefined) statusLine = settings.statusLine;
    }
  }
  const prepared = prepareCompact(cwd, {
    ...options,
    settings: { ...(statusLine ? { statusLine } : {}), ...options.settings },
  });
  const child = spawn(prepared.command, [...prepared.args, ...args], { cwd, stdio: 'inherit' });
  const abort = () => child.kill('SIGTERM');
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        resolve({ activationId: prepared.activationId, exitCode: code ?? 1, signal }),
      );
    });
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

const FINAL_STATES = [...WORKER_FINAL_STATES, 'closed', 'interrupted'];
const STOPPED_STATES = [...WORKER_FINAL_STATES, 'closed'];
const cliCommand = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL('../bin/omha.mjs', import.meta.url)))}`;
const sameRef = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
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

export function handoffWorkerIdentity(record) {
  const worker = jsonRead(paths(record.id).processFile, null, stateHome());
  check(
    worker?.token === record.owner.token &&
      worker.fingerprint &&
      worker.workerFingerprint &&
      processFingerprint(worker.childPid) === worker.fingerprint &&
      processFingerprint(worker.pid) === worker.workerFingerprint,
    'Handoff worker identity changed or ended',
    'ownership',
  );
  return {
    pid: worker.pid,
    childPid: worker.childPid,
    fingerprint: worker.fingerprint,
    workerFingerprint: worker.workerFingerprint,
  };
}

async function callingTmuxHandoff(record, options) {
  check(
    record.backend === 'tmux' && !record.native && !record.backendClosed,
    'An owned tmux worker is required',
    'ownership',
  );
  const backend = backendFor(record, options);
  await backend.caller(record);
  const worker = handoffWorkerIdentity(record);
  check(
    isProcessDescendant(process.pid, worker.childPid),
    'Only a process inside the handoff worker can report its activity or completion',
    'ownership',
  );
  return worker;
}

export async function reportHandoffActivity(handoffId, input, options = {}) {
  keys(input, ['agent', 'state'], 'handoff activity');
  choice(input.agent, ['claude', 'codex', 'kimi'], 'activity agent');
  choice(input.state, ['idle', 'working', 'waiting', 'ended'], 'activity state');
  const path = paths(handoffId);
  const release = lockDir(join(path.dir, '.lock'), { root: path.root });
  try {
    const record = handoffStatus(handoffId);
    check(record.state === 'running', 'Handoff is not running');
    const worker = await callingTmuxHandoff(record, options);
    const activity = {
      ...input,
      source: 'caller-reported',
      at: now(),
      worker,
      ownerToken: record.owner.token,
    };
    atomicWrite(path.activityFile, JSON.stringify(activity), path.root);
    terminalEvent(record, 'activity.reported', {
      agent: input.agent,
      state: input.state,
      source: activity.source,
      at: activity.at,
    });
    return {
      id: record.id,
      agent: input.agent,
      state: input.state,
      source: activity.source,
      at: activity.at,
    };
  } finally {
    release();
  }
}

function terminalEvent(record, kind, data = {}) {
  appendEvent(
    join(paths(record.id).dir, 'events.jsonl'),
    { kind, at: now(), ...data },
    stateHome(),
  );
}

async function nativeSession(record, options) {
  check(
    !options.backend || ['auto', 'cmux'].includes(options.backend),
    'Native history and agent messages require verified cmux capabilities',
    'capability',
  );
  check(process.platform !== 'win32', 'Native cmux sessions require POSIX');
  check(
    record.backend === 'cmux' &&
      record.native &&
      record.state === 'running' &&
      !record.backendClosed,
    'An active owned cmux agent session is required',
  );
  const backend = backendFor(record, options);
  await backend.verify(record);
  const session = await backend.session(record);
  check(
    session.agent === record.native.agent && session.sessionId === record.native.sessionId,
    'cmux agent session changed',
    'ownership',
  );
  return { backend, session };
}

export async function adoptHandoff(cwd, options = {}) {
  check(
    !options.backend || ['auto', 'cmux'].includes(options.backend),
    'Native history adoption requires verified cmux capabilities',
    'capability',
  );
  check(process.platform !== 'win32', 'Native cmux sessions require POSIX');
  const base = { cwd: realpathSync(cwd), backend: 'cmux' };
  const backend = backendFor(base, options);
  const caller = await backend.caller(base);
  const session = await backend.session({ ...base, ...caller });
  ensureDir(handoffsDir(), stateHome());
  const release = lockDir(join(handoffsDir(), `.adopt-${hash(JSON.stringify(caller))}.lock`), {
    root: stateHome(),
    timeoutMs: 100,
  });
  try {
    const existing = listHandoffs().find(
      (record) =>
        record.native &&
        sameRef(record.ref, caller.ref) &&
        sameRef(record.surfaceRef, caller.surfaceRef) &&
        !record.backendClosed,
    );
    if (existing) {
      await nativeSession(existing, options);
      return existing;
    }
    const handoffId = `handoff-${randomUUID()}`;
    const path = paths(handoffId);
    ensureDir(path.dir, path.root);
    const prompt = 'Native cmux session registered for historical continuation.';
    const record = {
      version: 1,
      id: handoffId,
      name: handoffId,
      ...base,
      ...caller,
      projectId: projectIdentity(cwd).projectId,
      owner: { uid: process.getuid?.() ?? null, token: randomUUID() },
      recordFile: path.recordFile,
      promptFile: path.promptFile,
      promptHash: hash(prompt),
      startedAt: now(),
      timeoutMs: 86400000,
      state: 'launching',
      native: { agent: session.agent, sessionId: session.sessionId },
      forkDepth: 0,
      envAllowlist: BASE_ENV,
    };
    atomicWrite(record.promptFile, prompt, path.root);
    save(record);
    await backend.claim(record);
    record.state = 'running';
    save(record);
    terminalEvent(record, 'session.adopted', {
      native: record.native,
      ref: record.ref,
      surfaceRef: record.surfaceRef,
    });
    return record;
  } finally {
    release();
  }
}

export async function handoffCheckpoints(handoffId, options = {}) {
  const record = handoffStatus(handoffId);
  const { backend } = await nativeSession(record, options);
  return { id: record.id, ...record.native, checkpoints: await backend.checkpoints(record) };
}

export function validateFork(input) {
  keys(input, ['sourceHandoffId', 'actionId', 'checkpoint', 'turn', 'closeSource'], 'cmux fork');
  id(input.sourceHandoffId, 'fork source handoff');
  if (input.actionId !== undefined) id(input.actionId, 'fork action id');
  check(
    (input.checkpoint !== undefined) !== (input.turn !== undefined),
    'Fork requires exactly one checkpoint or turn',
  );
  if (input.checkpoint !== undefined) text(input.checkpoint, 'fork checkpoint', 256);
  if (input.turn !== undefined) number(input.turn, 'fork turn', 1, 1000000);
  check(
    input.closeSource === undefined || typeof input.closeSource === 'boolean',
    'fork closeSource must be boolean',
  );
  return {
    sourceHandoffId: input.sourceHandoffId,
    ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
    ...(input.checkpoint !== undefined ? { checkpoint: input.checkpoint } : { turn: input.turn }),
    closeSource: input.closeSource ?? false,
  };
}

export async function messageHandoff(handoffId, value, options = {}) {
  text(value, 'agent message', 32768);
  check(Buffer.byteLength(value) <= 32768, 'Agent message exceeds 32 KiB');
  assertNoSecrets(value);
  const record = handoffStatus(handoffId);
  const { backend } = await nativeSession(record, options);
  terminalEvent(record, 'message.requested', { sentHash: hash(value) });
  const receipt = await backend.message(record, value);
  terminalEvent(record, 'message.sent', { sentHash: hash(value), ...receipt });
  return { handoffId: record.id, sentHash: hash(value), ...receipt };
}

export async function forkHandoff(cwd, prompt, input, options = {}) {
  const ensureActive = () => {
    if (options.signal?.aborted) throw new OmhaError('cancellation', 'Fork cancelled');
  };
  const spec = validateFork(input);
  check(
    options.allowWrite === true,
    'Historical continuation requires --allow-write on the host',
    'authority',
  );
  text(prompt, 'fork continuation prompt', 1000000);
  assertNoSecrets(prompt);
  const source = handoffStatus(spec.sourceHandoffId);
  check(source.cwd === realpathSync(cwd), 'Fork source belongs to another worktree', 'ownership');
  const handoffId =
    options.id || `handoff-fork-${hash(JSON.stringify([spec, hash(prompt)])).slice(0, 32)}`;
  const path = paths(handoffId);
  const release = lockDir(join(paths(source.id).dir, '.fork.lock'), {
    root: path.root,
    timeoutMs: 100,
  });
  try {
    if (existsSync(path.recordFile)) {
      const previous = handoffStatus(handoffId);
      check(
        previous.fork?.sourceHandoffId === source.id &&
          previous.promptHash === hash(prompt) &&
          JSON.stringify(previous.fork.request) === JSON.stringify(spec),
        'Fork id is bound to a different continuation',
        'ownership',
      );
      return previous;
    }
    const { backend, session } = await nativeSession(source, options);
    check((source.forkDepth || 0) < 3, 'Historical fork depth limit reached');
    check(
      listHandoffs().filter((item) => item.fork?.sourceHandoffId === source.id).length < 3,
      'Historical fork attempt limit reached',
    );
    const checkpoints = await backend.checkpoints(source);
    const checkpoint = checkpoints.find((item) =>
      spec.checkpoint !== undefined
        ? item.id === spec.checkpoint
        : item.source === 'turn' && item.turn === spec.turn,
    );
    check(
      checkpoint && typeof checkpoint.id === 'string',
      'Fork history location is not in the cmux timeline',
    );
    assertNoSecrets(session.args);
    assertNoCredentialArgs(session.args);
    assertNoSecrets(session.environment);
    ensureDir(path.dir, path.root);
    const record = {
      version: 1,
      id: handoffId,
      name: handoffId,
      backend: 'cmux',
      cwd: source.cwd,
      projectId: source.projectId,
      owner: { uid: process.getuid?.() ?? null, token: randomUUID() },
      recordFile: path.recordFile,
      promptFile: path.promptFile,
      promptHash: hash(prompt),
      startedAt: now(),
      timeoutMs: source.timeoutMs,
      state: 'forking',
      ref: null,
      native: { agent: session.agent, sessionId: null },
      forkDepth: (source.forkDepth || 0) + 1,
      fork: {
        sourceHandoffId: source.id,
        sourceSessionId: session.sessionId,
        sourceLaunchHash: hash(
          JSON.stringify({ args: session.args, environment: session.environment }),
        ),
        checkpoint: { id: checkpoint.id, turn: checkpoint.turn, anchor: checkpoint.anchor },
        closeSource: spec.closeSource,
        actionId: spec.actionId,
        request: spec,
        state: 'requested',
      },
      envAllowlist: BASE_ENV,
    };
    atomicWrite(record.promptFile, prompt, path.root);
    save(record);
    terminalEvent(record, 'fork.requested', { fork: record.fork, promptHash: record.promptHash });
    try {
      ensureActive();
      record.native.sessionId = await backend.forkSession(source, checkpoint);
      record.fork.state = 'created';
      save(record);
      terminalEvent(record, 'fork.created', { native: record.native });
      ensureActive();
      Object.assign(record, await backend.prepare(record));
      save(record);
      const args = session.args.map((arg) =>
        arg === session.sessionId ? record.native.sessionId : arg,
      );
      const bootstrap = `Omha native takeover ${record.id}. First poll ${cliCommand} handoff status --id ${record.id} until fork.state is awaiting_acceptance. If it is uncertain or interrupted, stop. Then run ${cliCommand} handoff accept --id ${record.id}. Only after successful acceptance, read ${JSON.stringify(record.promptFile)}, verify SHA-256 ${record.promptHash}, and execute that continuation. Do not perform task actions before acceptance. Current files have not been restored by the history fork.`;
      args.push('--', bootstrap);
      const launchEnvironment = { ...session.environment, OMHA_HOME: stateHome() };
      record.launch = {
        command: args[0],
        executable: session.executable,
        args: args.slice(1),
        environmentKeys: Object.keys(launchEnvironment),
      };
      record.fork.state = 'launch_requested';
      save(record);
      ensureActive();
      await backend.startSession(record, { ...session, args, environment: launchEnvironment });
      const deadline = Date.now() + number(options.waitMs ?? 30000, 'fork waitMs', 10, 60000);
      while (true) {
        ensureActive();
        try {
          const active = await backend.session(record);
          check(
            active.agent === record.native.agent && active.sessionId === record.native.sessionId,
            'Fork successor bound to another session',
            'ownership',
          );
          break;
        } catch (error) {
          if (error.code === 'ownership' || Date.now() >= deadline) throw error;
          await delay(Math.min(100, Math.max(0, deadline - Date.now())), options.signal);
        }
      }
      record.state = 'running';
      record.fork.state = 'message_requested';
      save(record);
      const message = `Read the complete continuation in ${JSON.stringify(record.promptFile)} (SHA-256 ${record.promptHash}). Before any task actions, run: ${cliCommand} handoff accept --id ${record.id}. Then execute the continuation and its acceptance checks. The fork changes conversation history only; inspect current files before writing. Do not infer that files were restored.`;
      ensureActive();
      record.fork.message = await messageHandoff(record.id, message, options);
      ensureActive();
      record.fork.state = 'awaiting_acceptance';
      save(record);
      terminalEvent(record, 'fork.ready', { messageId: record.fork.message.id });
    } catch (error) {
      const cancelled = options.signal?.aborted || error.code === 'cancellation';
      record.state = cancelled ? 'cancelled' : 'interrupted';
      record.fork.state = 'uncertain';
      record.failure = error.code || 'backend';
      record.failureMessage = redact(error.message);
      if (cancelled && record.ref) {
        try {
          await backend.close(record);
          record.backendClosed = true;
        } catch (cleanupError) {
          record.cleanupFailure = cleanupError.code || 'backend';
        }
      }
      save(record);
      terminalEvent(record, 'fork.uncertain', { failure: record.failure });
    }
    return record;
  } finally {
    release();
  }
}

export async function acceptHandoff(handoffId, options = {}) {
  const path = paths(handoffId);
  const release = lockDir(join(path.dir, '.fork.lock'), { root: path.root, timeoutMs: 100 });
  try {
    const record = handoffStatus(handoffId);
    check(
      record.fork && ['awaiting_acceptance', 'accepted'].includes(record.fork.state),
      'Fork is not ready for acceptance',
    );
    const { backend } = await nativeSession(record, options);
    const caller = await backend.caller(record);
    check(
      sameRef(caller.ref, record.ref) && sameRef(caller.surfaceRef, record.surfaceRef),
      'Only the fork successor can accept this handoff',
      'ownership',
    );
    check(
      hash(safeRead(record.promptFile, stateHome())) === record.promptHash,
      'Continuation prompt changed',
      'ownership',
    );
    if (record.fork.state === 'accepted') {
      check(
        !record.fork.closeSource || record.fork.sourceClose === 'closed',
        'Source closure remains uncertain; inspect native resources before continuing',
        'backend',
      );
      return record;
    }
    const source = handoffStatus(record.fork.sourceHandoffId);
    await nativeSession(source, options);
    record.fork.state = 'accepted';
    record.fork.acceptedAt = now();
    if (record.fork.closeSource) record.fork.sourceClose = 'requested';
    save(record);
    terminalEvent(record, 'fork.accepted');
    if (record.fork.closeSource) {
      // Claim durably before closing: the source may contain the requesting agent.
      terminalEvent(record, 'source.close_requested', { sourceHandoffId: source.id });
      try {
        await closeHandoff(source.id, options);
      } catch (error) {
        record.fork.sourceClose = 'uncertain';
        record.fork.sourceCloseFailure = error.code || 'backend';
        save(record);
        terminalEvent(record, 'source.close_uncertain', {
          failure: record.fork.sourceCloseFailure,
        });
        throw error;
      }
      record.fork.sourceClose = 'closed';
      save(record);
      terminalEvent(record, 'source.closed', { sourceHandoffId: source.id });
    }
    return record;
  } finally {
    release();
  }
}

async function closeRunEvidence(cwd, runId) {
  if (runId === undefined) return null;
  id(runId, 'completion run id');
  const { runStatus } = await import('./orchestrator.mjs');
  const status = runStatus(cwd, runId);
  const saved = jsonRead(join(status.dir, 'plan.json'), null, stateHome());
  check(
    saved.worktreeId === projectIdentity(cwd).worktreeId,
    'Completion run belongs to another worktree',
    'ownership',
  );
  check(
    status.status === 'completed' &&
      saved.plan.tasks.every((task) => {
        const state = status.tasks[task.id];
        return (
          state.status === 'completed' &&
          (!task.acceptance || state.acceptanceAccepted === true) &&
          (!task.review || state.reviewApproved === true)
        );
      }),
    'Auto-close requires a completed run with all acceptance and review gates passed',
    'authority',
  );
  let decision = null;
  if (status.decision) {
    const { decisionStatus } = await import('./roundtable.mjs');
    decision = decisionStatus(cwd, status.decision.decisionId);
    check(
      decision.status === 'completed' &&
        decision.chair?.runtime?.ok &&
        Boolean(decision.chair.synthesis) &&
        decision.tally?.outcome === 'decided' &&
        (!decision.gate.required || decision.gate.status === 'approved'),
      'Auto-close requires an approved host decision',
      'authority',
    );
  }
  return { runId, evidenceHash: hash(JSON.stringify({ status, decision })) };
}

export async function autoCloseHandoff(cwd, options = {}) {
  check(options.completed === true, 'Auto-close requires explicit --completed', 'authority');
  text(options.reason, 'completion reason', 4096);
  assertNoSecrets(options.reason);
  const delayMs = number(options.delayMs ?? 1500, 'auto-close delayMs', 100, 10000);
  const run = await closeRunEvidence(cwd, options.runId);
  let current;
  if (options.id) current = handoffStatus(options.id);
  else if (process.env.OMHA_HANDOFF_ID && process.env.TMUX) {
    current = handoffStatus(process.env.OMHA_HANDOFF_ID);
  } else {
    const base = { cwd: realpathSync(cwd), backend: 'cmux' };
    const caller = await backendFor(base, options).caller(base);
    current =
      listHandoffs().find(
        (record) =>
          record.native &&
          !record.backendClosed &&
          sameRef(record.ref, caller.ref) &&
          sameRef(record.surfaceRef, caller.surfaceRef),
      ) || (await adoptHandoff(cwd, options));
  }
  const path = paths(current.id);
  const release = lockDir(join(path.dir, '.lock'), { root: path.root, staleMs: 0 });
  try {
    const record = handoffStatus(current.id);
    check(
      record.cwd === realpathSync(cwd) &&
        ((record.backend === 'cmux' && record.native) ||
          (record.backend === 'tmux' && !record.native)),
      'Auto-close requires an owned cmux session or tmux worker in this worktree',
      'ownership',
    );
    const backend = backendFor(record, options);
    const caller = await backend.caller(record);
    check(
      sameRef(caller.ref, record.ref) && sameRef(caller.surfaceRef, record.surfaceRef),
      'Auto-close can only close the calling terminal',
      'ownership',
    );
    const requestHash = hash(JSON.stringify({ reason: options.reason, run }));
    if (record.autoClose) {
      check(
        record.autoClose.requestHash === requestHash,
        'Auto-close request changed',
        'authority',
      );
      check(
        ['scheduled', 'closed'].includes(record.autoClose.state),
        'Auto-close remains uncertain; inspect handoff status before manual cleanup',
        'backend',
      );
      return record;
    }
    const worker =
      record.backend === 'tmux'
        ? await callingTmuxHandoff(record, options)
        : (await nativeSession(record, options), null);
    check(
      !record.fork ||
        (record.fork.state === 'accepted' &&
          (!record.fork.closeSource || record.fork.sourceClose === 'closed')),
      'Accept the continuation before reporting completion',
      'authority',
    );
    check(!options.signal?.aborted, 'Auto-close cancelled', 'cancellation');
    record.autoClose = {
      state: 'scheduled',
      requestId: randomUUID(),
      requestHash,
      requestedAt: now(),
      closeAfter: new Date(Date.now() + delayMs).toISOString(),
      completion: { source: run ? 'host-run' : 'caller-reported', reason: options.reason, run },
      ...(worker ? { worker } : {}),
    };
    record.completion = {
      token: record.owner.token,
      state: 'completed',
      exitCode: 0,
      explicit: true,
      source: record.autoClose.completion.source,
      at: now(),
    };
    record.state = 'completed';
    save(record);
    terminalEvent(record, 'auto_close.requested', { autoClose: record.autoClose });
    try {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../bin/auto-close-worker.mjs', import.meta.url)),
          record.id,
          record.autoClose.requestId,
        ],
        {
          cwd: record.cwd,
          env: {
            ...environment([
              ...BASE_ENV,
              'CMUX_SOCKET_PATH',
              'CMUX_SOCKET_PASSWORD',
              'CMUX_WORKSPACE_ID',
              'CMUX_SURFACE_ID',
              'TMUX',
              'TMUX_PANE',
            ]),
            OMHA_HOME: stateHome(),
          },
          detached: true,
          stdio: 'ignore',
        },
      );
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
      });
      child.unref();
      record.autoClose.workerPid = child.pid;
      save(record);
    } catch (error) {
      record.autoClose.state = 'uncertain';
      record.autoClose.failure = error.code || 'backend';
      save(record);
      terminalEvent(record, 'auto_close.uncertain', { failure: record.autoClose.failure });
      throw error;
    }
    return record;
  } finally {
    release();
  }
}

// Run outside the terminal's process group so self-close cannot kill its recorder.
export async function finishAutoClose(handoffId, requestId, options = {}) {
  id(requestId, 'auto-close request id');
  const scheduled = handoffStatus(handoffId);
  check(scheduled.autoClose?.requestId === requestId, 'Auto-close claim changed', 'ownership');
  if (scheduled.autoClose.state !== 'scheduled') return scheduled;
  const remaining = Date.parse(scheduled.autoClose.closeAfter) - Date.now();
  check(
    Number.isFinite(remaining) && remaining <= 10000 && remaining >= -10000,
    'Invalid or expired auto-close deadline',
  );
  if (remaining > 0) await delay(remaining);
  const path = paths(handoffId);
  const release = lockDir(join(path.dir, '.lock'), { root: path.root, staleMs: 0 });
  try {
    const record = handoffStatus(handoffId);
    check(record.autoClose?.requestId === requestId, 'Auto-close claim changed', 'ownership');
    if (record.autoClose.state !== 'scheduled') return record;
    try {
      check(
        record.state === 'completed' &&
          !record.backendClosed &&
          ((record.native && record.backend === 'cmux') ||
            (!record.native && record.backend === 'tmux')),
        'Auto-close no longer has a completed owned session',
        'authority',
      );
      validFinal(record.completion, record);
      check(
        record.completion.state === 'completed',
        'Auto-close completion is not successful',
        'authority',
      );
      const run = await closeRunEvidence(record.cwd, record.autoClose.completion.run?.runId);
      check(
        record.autoClose.requestHash ===
          hash(JSON.stringify({ reason: record.autoClose.completion.reason, run })),
        'Auto-close completion evidence changed',
        'authority',
      );
      if (record.backend === 'tmux') {
        const backend = backendFor(record, options);
        const pane = await backend.paneState(record);
        check(
          (pane.dead && pane.pid === null) || pane.pid === record.autoClose.worker.pid,
          'Auto-close pane process changed',
          'ownership',
        );
        if (!pane.dead)
          check(
            JSON.stringify(handoffWorkerIdentity(record)) ===
              JSON.stringify(record.autoClose.worker),
            'Auto-close worker identity changed',
            'ownership',
          );
      }
      record.autoClose.state = 'closing';
      save(record);
      terminalEvent(record, 'auto_close.closing');
      const backend = backendFor(record, options);
      await backend.verify(record);
      check(
        Date.now() <= Date.parse(record.autoClose.closeAfter) + 10000,
        'Auto-close deadline expired before cleanup',
        'authority',
      );
      if (record.backend === 'tmux') {
        killOwnedTree(
          record.autoClose.worker.childPid,
          record.autoClose.worker.fingerprint,
          'SIGKILL',
        );
      }
      await backend.close(record, { completed: true });
      record.backendClosed = true;
      record.previousState = record.state;
      record.state = 'closed';
      record.closedAt = now();
      record.autoClose.state = 'closed';
      save(record);
      terminalEvent(record, 'auto_close.closed');
    } catch (error) {
      record.autoClose.state = 'uncertain';
      record.autoClose.failure = error.code || 'backend';
      record.autoClose.failureMessage = redact(error.message, environmentSecrets(process.env));
      save(record);
      terminalEvent(record, 'auto_close.uncertain', { failure: record.autoClose.failure });
    }
    return record;
  } finally {
    release();
  }
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
    requestedBackend: options.backend || 'auto',
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
    let startRequested = false;
    try {
      if (options.signal?.aborted) throw new OmhaError('cancellation', 'Handoff launch cancelled');
      Object.assign(record, await backend.prepare?.(record));
      save(record);
      if (options.signal?.aborted) throw new OmhaError('cancellation', 'Handoff launch cancelled');
      startRequested = true;
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
      const safePrelaunchFailure =
        error.details?.launchNotStarted === true && error.details?.cleanedUp === true;
      if (safePrelaunchFailure) {
        attempt.launchNotStarted = true;
        attempt.cleanedUp = true;
        record.backendClosed = true;
      } else if (record.ref) {
        try {
          await backend.close(record);
          attempt.cleanedUp = true;
          record.backendClosed = true;
        } catch (cleanupError) {
          attempt.cleanupFailure = cleanupError.code || 'backend';
        }
      }
      record.launchAttempts.push(attempt);
      if (
        record.ref &&
        startRequested &&
        !safePrelaunchFailure &&
        record.failure !== 'cancellation'
      ) {
        record.state = 'interrupted';
        attempt.uncertain = true;
      }
      save(record);
      if (
        attempt.uncertain ||
        attempt.cleanupFailure ||
        record.failure === 'cancellation' ||
        record.failure === 'ownership'
      )
        break;
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
    if (!final && !record.native) {
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
  if (record.native) return messageHandoff(handoffId, value, options);
  check(record.state === 'running', 'Handoff is not running');
  await backendFor(record, options).send(record, value, options.enter !== false);
  return { id: record.id, sentHash: hash(value), enter: options.enter !== false };
}

async function terminate(record, state, backend) {
  await backend.verify(record);
  if (record.native) {
    const caller = await backend.caller(record);
    check(
      !sameRef(caller.ref, record.ref) || !sameRef(caller.surfaceRef, record.surfaceRef),
      'Request self-retirement with fork --close-source; the successor must confirm takeover first',
      'ownership',
    );
  }
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
    if (STOPPED_STATES.includes(record.state)) return record;
    if (record.state === 'interrupted' && record.backendClosed) return record;
    await terminate(record, 'cancelled', backendFor(record, options));
    save(record);
    return record;
  } finally {
    release();
  }
}

export async function closeHandoff(handoffId, options = {}) {
  const current = handoffStatus(handoffId);
  if (
    current.backend === 'tmux' &&
    !current.backendClosed &&
    (current.state === 'interrupted' || current.autoClose || STOPPED_STATES.includes(current.state))
  ) {
    const path = paths(handoffId);
    const release = lockDir(join(path.dir, '.lock'), { root: path.root });
    try {
      const record = handoffStatus(handoffId);
      if (record.autoClose)
        check(
          record.autoClose.state === 'uncertain',
          'Inspect the auto-close claim before cleanup',
        );
      const backend = backendFor(record, options);
      const absent = await backend.absent(record);
      if (!absent) {
        await backend.verify(record);
        if (record.autoClose) {
          const pane = await backend.paneState(record);
          check(
            (pane.dead && pane.pid === null) || pane.pid === record.autoClose.worker.pid,
            'Auto-close pane process changed',
            'ownership',
          );
          if (!pane.dead)
            check(
              JSON.stringify(handoffWorkerIdentity(record)) ===
                JSON.stringify(record.autoClose.worker),
              'Auto-close worker identity changed',
              'ownership',
            );
        }
      }
      const worker = jsonRead(path.processFile, null, path.root);
      if (worker?.token === record.owner.token)
        killOwnedTree(worker.childPid, worker.fingerprint, 'SIGKILL');
      if (!absent) await backend.close(record, { paneOnly: Boolean(record.autoClose) });
      record.backendClosed = true;
      record.previousState = record.state;
      record.state = 'closed';
      record.closedAt = now();
      if (record.autoClose) record.autoClose.state = 'closed';
      save(record);
      terminalEvent(record, 'handoff.manually_closed', { resourceAbsent: absent });
      return record;
    } finally {
      release();
    }
  }
  check(!current.autoClose || current.backendClosed, 'Inspect the auto-close claim before cleanup');
  if (!STOPPED_STATES.includes(current.state) && !current.backendClosed)
    await cancelHandoff(handoffId, options);
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
  check(
    !previous.native,
    'An ended native cmux session must be registered again before historical continuation',
  );
  const resumed = await handoff(
    previous.cwd,
    prompt || safeRead(previous.promptFile, stateHome()),
    {
      ...options,
      backend: options.backend || 'auto',
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
