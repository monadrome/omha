import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hash, now, projectDir, projectIdentity, stablePrefix, stateHome } from './core.mjs';
import {
  appendEvent,
  atomicWrite,
  ensureDir,
  isAlive,
  jsonRead,
  lockDir,
  readEvents,
  safeRead,
} from './storage.mjs';
import { createRuntime, delay } from './runner.mjs';
import { loadConfig } from './profiles.mjs';
import { bindHostPolicy, validatePlan } from './plans.mjs';
import { check, choice, id, keys, number, text, OmhaError } from './validation.mjs';
import { assertNoSecrets, redactData } from './security.mjs';
import { killOwnedTree, processFingerprint, run } from './process.mjs';
import { initMemory, injectMemory, recordRunLesson, validateRunMemory } from './memory.mjs';
import { autoRoundtable, decisionStatus } from './roundtable.mjs';
import { listHandoffs } from './terminal.mjs';
import { git, snapshotFiles } from './arena-artifacts.mjs';
import { observeButterfly, processButterfly, validateButterfly } from './butterfly.mjs';

export {
  roundtable,
  autoRoundtable,
  assessRoundtableTrigger,
  decisionStatus,
  resolveDecision,
} from './roundtable.mjs';
export { validatePlan };

const taskResultRef = (taskId) => `${taskId}.result.json`;
const PLANNER_RESULT_REF = 'planner.result.json';

function worktreeGate(identity, root, mutate) {
  const dir = join(root, 'projects', identity.projectId, 'worktrees', identity.worktreeId);
  ensureDir(dir, root);
  const release = lockDir(join(dir, '.admission.lock'), { root, staleMs: 0 });
  try {
    const file = join(dir, 'admission.json');
    const state = jsonRead(file, { version: 1, leases: [], waiters: [] }, root);
    check(
      state.version === 1 && Array.isArray(state.leases) && Array.isArray(state.waiters),
      'Invalid worktree admission state',
      'corrupt_state',
    );
    for (const entry of [...state.leases, ...state.waiters])
      check(
        typeof entry.token === 'string' &&
          Number.isInteger(entry.pid) &&
          entry.pid > 0 &&
          ['readonly', 'write'].includes(entry.mode) &&
          (entry.fingerprint === null || typeof entry.fingerprint === 'string') &&
          Array.isArray(entry.children) &&
          entry.children.every(
            (child) =>
              Number.isInteger(child.pid) && child.pid > 0 && typeof child.fingerprint === 'string',
          ),
        'Invalid worktree lease',
        'corrupt_state',
      );
    const alive = (entry) =>
      isAlive(entry.pid) &&
      (!entry.fingerprint || processFingerprint(entry.pid) === entry.fingerprint);
    state.waiters = state.waiters.filter(alive);
    state.leases = state.leases.filter((entry) => {
      if (alive(entry)) return true;
      // A dead host cannot release a workspace while its recorded worker survives.
      const surviving = entry.children.filter(
        (child) => processFingerprint(child.pid) === child.fingerprint,
      );
      surviving.forEach((child) => killOwnedTree(child.pid, child.fingerprint, 'SIGKILL'));
      return surviving.length > 0;
    });
    const result = mutate(state);
    atomicWrite(file, JSON.stringify(state), root);
    return result;
  } finally {
    release();
  }
}

async function acquireWorktree(identity, root, mode, options) {
  const entry = {
    token: randomUUID(),
    pid: process.pid,
    fingerprint: processFingerprint(process.pid),
    mode,
    runId: options.runId,
    taskId: options.taskId,
    children: [],
  };
  let acquired = false;
  try {
    while (true) {
      if (options.signal.aborted)
        throw options.signal.reason instanceof OmhaError
          ? options.signal.reason
          : new OmhaError('cancellation', 'Worktree admission cancelled');
      acquired = worktreeGate(identity, root, (state) => {
        if (!state.waiters.some((waiting) => waiting.token === entry.token))
          state.waiters.push(entry);
        const position = state.waiters.findIndex((waiting) => waiting.token === entry.token);
        const eligible =
          mode === 'write'
            ? position === 0 && state.leases.length === 0
            : !state.leases.some((lease) => lease.mode === 'write') &&
              !state.waiters.slice(0, position).some((waiting) => waiting.mode === 'write');
        if (!eligible) return false;
        state.waiters.splice(position, 1);
        state.leases.push(entry);
        return true;
      });
      if (acquired) break;
      await delay(20, options.signal);
    }
    return {
      recordProcess(pid, fingerprint) {
        check(fingerprint, 'Cannot establish worktree worker ownership', 'ownership');
        worktreeGate(identity, root, (state) => {
          const lease = state.leases.find((item) => item.token === entry.token);
          check(lease, 'Worktree lease disappeared', 'ownership');
          lease.children = [
            ...lease.children.filter((child) => child.pid !== pid),
            { pid, fingerprint },
          ];
        });
      },
      release() {
        worktreeGate(identity, root, (state) => {
          state.leases = state.leases.filter((item) => item.token !== entry.token);
        });
      },
    };
  } finally {
    if (!acquired)
      worktreeGate(identity, root, (state) => {
        state.waiters = state.waiters.filter((item) => item.token !== entry.token);
      });
  }
}

function runPaths(cwd, runId, identity = projectIdentity(cwd)) {
  id(runId, 'run id');
  const root = stateHome(),
    dir = join(root, 'projects', identity.projectId, 'runs', runId);
  return {
    root,
    dir,
    plan: join(dir, 'plan.json'),
    context: join(dir, 'context.md'),
    events: join(dir, 'events.jsonl'),
    cancel: join(dir, 'cancel.json'),
  };
}

export function runStatus(cwd, runId) {
  return statusAt(runPaths(cwd, runId), runId);
}

function statusAt(paths, runId) {
  const saved = jsonRead(paths.plan, null, paths.root);
  check(
    saved?.plan && Array.isArray(saved.plan.tasks),
    'Run does not exist or its plan is invalid',
  );
  const plan = saved.plan;
  const tasks = Object.fromEntries(
    plan.tasks.map((task) => [
      task.id,
      {
        id: task.id,
        role: task.role,
        mode: task.mode,
        status: 'pending',
        reviewStatus: task.review ? 'pending' : null,
        reviewApproved: null,
        attempts: 0,
        resultRef: null,
        executionOk: null,
        acceptanceAccepted: null,
        lastProgressAt: null,
        inputWait: false,
      },
    ]),
  );
  let status = 'created',
    budget,
    decision,
    createdAt,
    updatedAt;
  const metrics = {
    workerAttempts: 0,
    workerFailures: 0,
    retries: 0,
    fallbacks: 0,
    takeovers: 0,
    escalations: 0,
    providerLatencyMs: 0,
    memoryRecorded: 0,
    butterflyDetections: 0,
    butterflyHandoffs: 0,
    butterflyUncertain: 0,
  };
  const previousProfiles = new Map();
  for (const event of readEvents(paths.events, paths.root)) {
    updatedAt = event.at || updatedAt;
    if (event.kind === 'run.created') createdAt = event.at;
    if (event.kind === 'request.finished' && event.attempt) {
      metrics.workerAttempts += 1;
      metrics.workerFailures += event.attempt.ok ? 0 : 1;
      metrics.retries += event.attempt.retry > 0 ? 1 : 0;
      metrics.providerLatencyMs += event.attempt.latencyMs || 0;
      if (
        previousProfiles.has(event.taskId) &&
        previousProfiles.get(event.taskId) !== event.attempt.profile
      )
        metrics.fallbacks += 1;
      previousProfiles.set(event.taskId, event.attempt.profile);
    }
    if (event.kind === 'task.started') previousProfiles.delete(event.taskId);
    if (event.kind === 'task.takeover') metrics.takeovers += 1;
    if (event.kind === 'task.escalated') metrics.escalations += 1;
    if (event.kind === 'memory.recorded') metrics.memoryRecorded += 1;
    if (event.kind === 'butterfly.detected') {
      metrics.butterflyDetections += 1;
      tasks[event.taskId].butterfly = {
        analysisId: event.analysisId,
        file: event.file,
        rewindBoundary: event.rewindBoundary,
      };
    }
    if (event.kind === 'butterfly.handoff_requested') {
      metrics.butterflyUncertain += 1;
      Object.assign(tasks[event.taskId].butterfly, {
        handoffId: event.handoffId,
        handoffStatus: 'requested',
      });
    }
    if (['butterfly.handed_off', 'butterfly.handoff_failed'].includes(event.kind)) {
      metrics.butterflyUncertain -= 1;
      if (event.kind === 'butterfly.handed_off') metrics.butterflyHandoffs += 1;
      Object.assign(tasks[event.taskId].butterfly, {
        handoffId: event.handoffId,
        handoffStatus: event.kind,
      });
    }
    if (['task.progress', 'task.input_wait', 'task.escalated'].includes(event.kind)) {
      check(tasks[event.taskId], 'Unknown progress task', 'corrupt_state');
      Object.assign(
        tasks[event.taskId],
        event.kind === 'task.escalated'
          ? { escalation: { reason: event.reason, profile: event.profile, at: event.at } }
          : { lastProgressAt: event.at, inputWait: event.kind === 'task.input_wait' },
      );
    }
    if (
      event.taskId &&
      event.status &&
      ['task.started', 'task.finished', 'task.blocked', 'task.recovered'].includes(event.kind)
    ) {
      check(tasks[event.taskId], 'Event references an unknown task', 'corrupt_state');
      check(
        !event.resultRef || event.resultRef === taskResultRef(event.taskId),
        'Invalid task result reference',
        'corrupt_state',
      );
      Object.assign(tasks[event.taskId], {
        status: event.status,
        attempts: event.attempts ?? tasks[event.taskId].attempts,
        resultRef: event.resultRef || tasks[event.taskId].resultRef,
        failure: event.failure || null,
        ...(event.kind === 'task.finished'
          ? {
              executionOk: event.executionOk ?? null,
              acceptanceAccepted: event.acceptanceAccepted ?? null,
              inputWait: false,
            }
          : {}),
      });
      if (event.kind === 'task.started') {
        const configured = plan.tasks.find((task) => task.id === event.taskId);
        Object.assign(tasks[event.taskId], {
          reviewStatus: configured.review ? 'pending' : null,
          reviewApproved: null,
          executionOk: null,
          acceptanceAccepted: null,
          lastProgressAt: null,
          inputWait: false,
          escalation: null,
        });
      }
    }
    if (['review.recorded', 'task.reviewed'].includes(event.kind)) {
      check(tasks[event.taskId], 'Event references an unknown review task', 'corrupt_state');
      tasks[event.taskId].reviewStatus = event.status;
      tasks[event.taskId].reviewApproved = Boolean(event.approved);
    }
    if (event.kind === 'decision.completed' && event.triggered)
      decision = {
        decisionId: event.decisionId,
        status: event.status,
        outcome: event.outcome,
      };
    if (event.kind === 'run.status') status = event.status;
    if (event.account) budget = { account: event.account, profileAccounts: event.profileAccounts };
  }
  const values = Object.values(tasks);
  Object.assign(metrics, {
    tasks: values.length,
    completed: values.filter((task) => task.status === 'completed').length,
    failed: values.filter((task) => task.status === 'failed').length,
    interrupted: values.filter((task) => task.status === 'interrupted').length,
    accepted: values.filter((task) => task.acceptanceAccepted === true).length,
    acceptanceFailed: values.filter((task) => task.acceptanceAccepted === false).length,
    reviewApproved: values.filter((task) => task.reviewApproved === true).length,
    reviewRejected: values.filter((task) => task.reviewApproved === false).length,
  });
  return {
    runId,
    status,
    tasks,
    planHash: hash(JSON.stringify(plan)),
    contextHash: hash(safeRead(paths.context, paths.root)),
    budget,
    decision,
    metrics,
    createdAt,
    updatedAt,
    dir: paths.dir,
  };
}

export function listRuns(cwd) {
  return runsAt(cwd, projectIdentity(cwd));
}
function runsAt(cwd, identity) {
  const dir = join(stateHome(), 'projects', identity.projectId, 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[A-Za-z0-9_-]+$/.test(name))
    .sort()
    .map((name) => statusAt(runPaths(cwd, name, identity), name));
}

export function projectStatus(cwd) {
  const identity = projectIdentity(cwd),
    root = stateHome();
  const runs = runsAt(cwd, identity);
  const decisionsDir = join(root, 'projects', identity.projectId, 'decisions');
  const decisions = (existsSync(decisionsDir) ? readdirSync(decisionsDir) : [])
    .filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name))
    .sort()
    .map((name) => {
      const record = jsonRead(join(decisionsDir, name), null, root);
      check(record?.decisionId && record?.gate, 'Invalid decision record', 'corrupt_state');
      return {
        decisionId: record.decisionId,
        status: record.status,
        outcome: record.tally?.outcome,
        recommendation: record.tally?.recommendation,
        gate: record.gate,
      };
    });
  const handoffs = listHandoffs()
    .filter((record) => record.projectId === identity.projectId)
    .map((record) => ({
      id: record.id,
      state: record.state,
      backend: record.backend,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
  const metrics = {};
  for (const run of runs)
    for (const [name, value] of Object.entries(run.metrics))
      metrics[name] = (metrics[name] || 0) + value;
  return {
    projectId: identity.projectId,
    worktreeId: identity.worktreeId,
    runs,
    decisions,
    handoffs,
    metrics,
  };
}

export async function* watchStatus(cwd, options = {}) {
  const intervalMs = number(options.intervalMs ?? 1000, 'watch intervalMs', 10, 60000);
  const durationMs = number(options.durationMs ?? 30000, 'watch durationMs', 10, 86400000);
  const deadline = performance.now() + durationMs;
  let previous;
  while (!options.signal?.aborted) {
    const snapshot = projectStatus(cwd),
      digest = hash(JSON.stringify(snapshot));
    if (digest !== previous) {
      previous = digest;
      yield snapshot;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    try {
      await delay(Math.min(intervalMs, remaining), options.signal);
    } catch (error) {
      if (error.code !== 'cancellation') throw error;
      break;
    }
  }
}

export function cancelRun(cwd, runId) {
  const paths = runPaths(cwd, runId);
  check(existsSync(paths.plan), 'Run does not exist');
  atomicWrite(paths.cancel, JSON.stringify({ requestedAt: now() }), paths.root);
  appendEvent(paths.events, { kind: 'run.cancel_requested', at: now() }, paths.root);
  return { runId, cancellationRequested: true };
}

export function sendTaskMessage(cwd, runId, taskId, content, options = {}) {
  id(taskId, 'task id');
  text(content, 'worker message', 64000);
  assertNoSecrets(content);
  const paths = runPaths(cwd, runId),
    status = runStatus(cwd, runId);
  check(status.tasks[taskId], 'Unknown message target task');
  const messageId = `message-${randomUUID()}`,
    ref = `messages/${messageId}.json`;
  const message = {
    messageId,
    taskId,
    sender: id(options.sender || 'host', 'message sender'),
    content,
    responseHash: hash(content),
  };
  atomicWrite(join(paths.dir, ref), JSON.stringify(message, null, 2), paths.root);
  appendEvent(
    paths.events,
    {
      kind: 'message.created',
      at: now(),
      messageId,
      taskId,
      ref,
      responseHash: message.responseHash,
    },
    paths.root,
  );
  return { runId, taskId, messageId, ref, delivery: 'next_attempt' };
}

function reviewEvidence(input) {
  keys(input, ['name', 'status', 'summary'], 'test evidence');
  id(input.name, 'test evidence name');
  choice(input.status, ['passed', 'failed', 'unknown'], 'test evidence status');
  text(input.summary, 'test evidence summary', 10000);
  assertNoSecrets(input);
  return { ...input };
}

function reviewCriteria(input) {
  keys(input, ['id', 'description'], 'review criterion');
  id(input.id, 'review criterion id');
  text(input.description, 'review criterion description', 10000);
  assertNoSecrets(input);
  return { ...input };
}

function reviewRuntime(result) {
  const { stdout, stderr, attempts, ...safe } = result;
  safe.attempts = attempts?.map(
    ({ stdout: attemptStdout, stderr: attemptStderr, ...attempt }) => attempt,
  );
  return redactData(safe);
}

function acceptancePolicy(cwd, spec) {
  const argumentFiles = spec.args
    .map((arg) => resolve(cwd, arg))
    .filter((file) => {
      try {
        return lstatSync(file).isFile();
      } catch {
        return false;
      }
    });
  const files = [
    spec.command,
    ...argumentFiles,
    ...(spec.harnessFiles || []).map((file) => resolve(cwd, file)),
  ];
  return {
    command: spec.command,
    args: spec.args,
    timeoutMs: spec.timeoutMs,
    maxOutputBytes: spec.maxOutputBytes,
    files: [...new Set(files)].map((file) => {
      const canonical = realpathSync(file),
        stat = lstatSync(canonical);
      check(
        stat.isFile() && stat.size <= 256 * 1024 * 1024,
        'Invalid or oversized acceptance harness file',
        'acceptance_policy',
      );
      return { file, canonical, hash: hash(readFileSync(canonical)), mode: stat.mode & 0o777 };
    }),
  };
}

function artifactSnapshot(identity) {
  const relativeState = relative(identity.root, stateHome());
  check(
    relativeState !== '',
    'State home cannot be the accepted worktree root',
    'acceptance_policy',
  );
  const excludePaths =
    !isAbsolute(relativeState) && !relativeState.startsWith(`..${sep}`) && relativeState !== '..'
      ? [relativeState.split(sep).join('/')]
      : [];
  const paths =
    identity.kind === 'git'
      ? [
          ...new Set(
            git(identity.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
              .split('\0')
              .filter(Boolean),
          ),
        ]
      : undefined;
  return snapshotFiles(identity.root, { metadataOnly: true, paths, excludePaths });
}

async function acceptTask(cwd, task, policy, identity, signal, onSpawn) {
  if (!task.acceptance) return null;
  const spec = task.acceptance;
  let artifactBefore, beforePolicy;
  try {
    beforePolicy = acceptancePolicy(cwd, spec);
    check(
      policy && hash(JSON.stringify(beforePolicy)) === hash(JSON.stringify(policy)),
      'Acceptance harness changed since run creation',
      'acceptance_policy',
    );
    artifactBefore = artifactSnapshot(identity);
  } catch (error) {
    return {
      accepted: false,
      failure: error.code || 'acceptance_policy',
      policyHash: policy ? hash(JSON.stringify(policy)) : null,
    };
  }
  const result = await run(spec.command, spec.args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: 'C',
    },
    signal,
    timeoutMs: spec.timeoutMs,
    maxOutputBytes: spec.maxOutputBytes,
    onSpawn,
  });
  const accepted =
    result.code === 0 &&
    !result.signal &&
    !result.timedOut &&
    !result.cancelled &&
    !result.outputLimited &&
    !result.spawnError &&
    !result.callbackError;
  let artifactAfter,
    unchanged = false,
    policyUnchanged = false,
    failure = null;
  try {
    artifactAfter = artifactSnapshot(identity);
    unchanged = hash(JSON.stringify(artifactBefore)) === hash(JSON.stringify(artifactAfter));
    policyUnchanged =
      hash(JSON.stringify(policy)) === hash(JSON.stringify(acceptancePolicy(cwd, spec)));
  } catch (error) {
    failure = error.code || 'acceptance_policy';
  }
  return {
    accepted: accepted && unchanged && policyUnchanged,
    failure,
    policyHash: hash(JSON.stringify(policy)),
    policyUnchanged,
    artifactHash: hash(JSON.stringify(artifactBefore)),
    afterArtifactHash: artifactAfter ? hash(JSON.stringify(artifactAfter)) : null,
    artifactUnchanged: unchanged,
    command: spec.command,
    args: spec.args,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    outputLimited: result.outputLimited,
    spawnError: result.spawnError?.code || null,
    callbackError: result.callbackError ? 'callback' : null,
    stdoutHash: hash(result.stdout),
    stderrHash: hash(result.stderr),
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    latencyMs: result.latencyMs,
  };
}

export async function reviewTask(cwd, runId, taskId, options = {}) {
  id(runId, 'run id');
  id(taskId, 'task id');
  const paths = runPaths(cwd, runId);
  const root = paths.root;
  const saved = jsonRead(paths.plan, null, root);
  check(
    saved?.plan && Array.isArray(saved.plan.tasks),
    'Run does not exist or its plan is invalid',
  );
  const task = saved.plan.tasks.find((candidate) => candidate.id === taskId);
  check(task, 'Unknown review task');
  const status = runStatus(cwd, runId);
  check(status.tasks[taskId]?.status === 'completed', 'Only completed tasks can be reviewed');
  const resultRef = status.tasks[taskId].resultRef;
  check(resultRef === taskResultRef(taskId), 'Invalid task result reference', 'corrupt_state');
  const subject = jsonRead(join(paths.dir, resultRef), null, root);
  check(subject?.ok, 'Only successful task results can be reviewed');
  text(subject.stdout, 'task result output', 1000000);
  assertNoSecrets(subject);
  const reviewerProfile = options.reviewerProfile;
  id(reviewerProfile, 'reviewer profile');
  const authorProfile = subject.servedProfile || subject.profile;
  id(authorProfile, 'actual author profile');
  const authorProfiles = [
    ...new Set([
      task.profile,
      authorProfile,
      ...(subject.attempts || []).map((attempt) => attempt.profile),
    ]),
  ];
  authorProfiles.forEach((name) => id(name, 'author attempt profile'));
  check(
    !authorProfiles.includes(reviewerProfile),
    'The task author cannot review its own result',
    'review_authority',
  );
  const config =
    options.runtime?.config ||
    (options.profiles
      ? { version: 1, profiles: options.profiles }
      : loadConfig(cwd, options.config));
  const runtime = options.runtime || createRuntime(config, { budget: options.budget });
  check(Object.hasOwn(runtime.config.profiles, reviewerProfile), 'Unknown reviewer profile');
  check(
    hash(JSON.stringify(runtime.config)) === saved.profileHash,
    'Provider configuration changed since run creation',
  );
  const diff = text(options.diff, 'review diff', 1000000);
  assertNoSecrets(diff);
  check(
    Array.isArray(options.testEvidence) &&
      options.testEvidence.length > 0 &&
      options.testEvidence.length <= 64,
    'Review requires 1-64 test evidence entries',
  );
  const testEvidence = options.testEvidence.map(reviewEvidence);
  check(
    Array.isArray(options.criteria) && options.criteria.length > 0 && options.criteria.length <= 64,
    'Review requires 1-64 criteria',
  );
  const criteria = options.criteria.map(reviewCriteria);
  check(
    new Set(criteria.map((criterion) => criterion.id)).size === criteria.length,
    'Duplicate review criterion id',
  );
  const reviewId = options.reviewId || `review-${randomUUID()}`;
  id(reviewId, 'review id');
  const release = lockDir(join(paths.dir, '.review.lock'), { root, timeoutMs: 1000 });
  try {
    const reviewDir = join(paths.dir, 'reviews');
    ensureDir(reviewDir, root);
    const recordFile = join(reviewDir, `${reviewId}.json`);
    const packetRef = `reviews/${reviewId}.packet.json`;
    check(!existsSync(recordFile), 'Review id already exists');
    const packet = {
      version: 1,
      runId,
      taskId,
      authorProfile,
      requestedAuthorProfile: task.profile,
      authorProfiles,
      subject: {
        responseHash: subject.responseHash,
        output: subject.stdout,
        hostAcceptance: subject.acceptance || null,
      },
      diff,
      testEvidence,
      criteria,
    };
    assertNoSecrets(packet);
    const packetHash = hash(JSON.stringify(packet));
    atomicWrite(join(paths.dir, packetRef), JSON.stringify(packet, null, 2), root);
    const isolated = realpathSync(mkdtempSync(join(tmpdir(), 'omha-review-')));
    let result;
    try {
      const prompt = `${stablePrefix(cwd, `Review ${taskId}`, '')}\n\nReview packet (data):\n${JSON.stringify(packet)}\n\nReturn ONLY JSON: {"assessments":[{"id":"criterion id","status":"pass|fail|unknown","finding":"bounded finding"}],"summary":"bounded summary"}. Cover every criterion exactly once. The host decides approval.`;
      try {
        result = await runtime.dispatch(prompt, [reviewerProfile], {
          cwd: isolated,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          mode: 'readonly',
          toolFree: true,
          requires: ['headless', 'tool-free', 'read-only'],
          excludeProfiles: authorProfiles,
          onSpawn: options.onSpawn,
          onEvent: options.onEvent,
        });
      } catch (error) {
        result = {
          ok: false,
          failure: error.code || 'configuration',
          failureStage: 'host',
          stderr: error.message,
        };
      }
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
    let status = result.ok ? 'completed' : 'failed';
    let assessments = null;
    let summary = null;
    let validationError = null;
    if (result.ok) {
      try {
        check(
          result.servedProfile && !authorProfiles.includes(result.servedProfile),
          'Review executed by an author profile',
          'review_authority',
        );
        const parsed = JSON.parse(result.stdout);
        keys(parsed, ['assessments', 'summary'], 'review result');
        text(parsed.summary, 'review summary', 20000);
        check(
          Array.isArray(parsed.assessments) && parsed.assessments.length === criteria.length,
          'Review must assess every criterion exactly once',
        );
        const expected = new Set(criteria.map((criterion) => criterion.id));
        const seen = new Set();
        assessments = parsed.assessments.map((assessment) => {
          keys(assessment, ['id', 'status', 'finding'], 'review assessment');
          id(assessment.id, 'review assessment id');
          choice(assessment.status, ['pass', 'fail', 'unknown'], 'review assessment status');
          text(assessment.finding, 'review finding', 10000);
          check(
            expected.has(assessment.id) && !seen.has(assessment.id),
            'Review criterion coverage mismatch',
          );
          seen.add(assessment.id);
          return { ...assessment };
        });
        check(seen.size === expected.size, 'Review criterion coverage mismatch');
        assertNoSecrets({ assessments, summary: parsed.summary });
        summary = parsed.summary;
      } catch (error) {
        status = 'invalid';
        validationError = error instanceof SyntaxError ? 'Malformed review JSON' : error.message;
      }
    }
    const approved =
      status === 'completed' && assessments.every((assessment) => assessment.status === 'pass');
    const record = {
      version: 1,
      reviewId,
      runId,
      taskId,
      authorProfile,
      requestedAuthorProfile: task.profile,
      authorProfiles,
      reviewerProfile,
      servedReviewerProfile: result.servedProfile || null,
      packetRef,
      packetHash,
      subjectHash: subject.responseHash,
      diffHash: hash(diff),
      testEvidenceHash: hash(JSON.stringify(testEvidence)),
      criteriaHash: hash(JSON.stringify(criteria)),
      status,
      approved,
      assessments,
      summary,
      validationError,
      runtime: reviewRuntime(result),
      createdAt: now(),
      completedAt: now(),
    };
    atomicWrite(recordFile, JSON.stringify(redactData(record), null, 2), root);
    appendEvent(
      paths.events,
      {
        kind: 'review.recorded',
        reviewId,
        taskId,
        status,
        approved,
        packetRef,
        packetHash,
        subjectHash: subject.responseHash,
      },
      root,
    );
    return { ...record, file: recordFile };
  } finally {
    release();
  }
}

export async function executePlan(cwd, input, options = {}) {
  const identity = projectIdentity(cwd);
  const config =
    options.runtime?.config ||
    (options.profiles
      ? { version: 1, profiles: options.profiles }
      : loadConfig(cwd, options.config));
  const initialRuntime = options.runtime || createRuntime(config, { budget: options.budget });
  const runId = options.runId || `run-${randomUUID()}`;
  const paths = runPaths(cwd, runId);
  let plan, savedRun;
  if (options.resume) {
    const saved = jsonRead(paths.plan, null, paths.root);
    check(saved, 'Run does not exist');
    check(
      saved.projectId === projectIdentity(cwd).projectId &&
        saved.worktreeId === projectIdentity(cwd).worktreeId,
      'Resume must use the original project and worktree',
    );
    check(
      saved.profileHash === hash(JSON.stringify(initialRuntime.config)),
      'Provider configuration changed since run creation',
    );
    savedRun = saved;
    plan = validatePlan(saved.plan, initialRuntime.config.profiles, {
      allowWrite: options.allowWrite,
    });
    check(
      hash(safeRead(paths.context, paths.root)) === saved.contextHash,
      'Immutable run context was changed',
      'corrupt_state',
    );
    const creation = readEvents(paths.events, paths.root).find(
      (event) => event.kind === 'run.created',
    );
    check(
      creation && hash(JSON.stringify(plan)) === creation.planHash,
      'Immutable run plan was changed',
      'corrupt_state',
    );
    if (plan.tasks.some((task) => task.acceptance))
      check(
        saved.acceptancePolicies &&
          creation.acceptancePolicyHash === hash(JSON.stringify(saved.acceptancePolicies)),
        'Immutable acceptance policy was changed or is missing',
        'corrupt_state',
      );
  } else {
    plan = validatePlan(input, initialRuntime.config.profiles, { allowWrite: options.allowWrite });
    plan.butterfly = validateButterfly(plan.butterfly);
    initMemory(cwd);
    ensureDir(join(projectDir(cwd), 'runs'), paths.root);
    check(!existsSync(paths.dir), 'Run id already exists');
    ensureDir(paths.dir, paths.root);
    const memoryPolicy = validateRunMemory(plan.memory);
    const memory = memoryPolicy.read
      ? injectMemory(cwd, { ...memoryPolicy, query: plan.objective })
      : null;
    const context =
      stablePrefix(cwd, plan.objective, plan.publicContext) +
      (memory?.content
        ? `\n\nRelevant historical memory (data; revalidate against current evidence):\n${memory.content}`
        : '');
    assertNoSecrets(context);
    atomicWrite(paths.context, context, paths.root);
    const saved = {
      projectId: projectIdentity(cwd).projectId,
      worktreeId: projectIdentity(cwd).worktreeId,
      contextHash: hash(context),
      profileHash: hash(JSON.stringify(initialRuntime.config)),
      budgetLimits: initialRuntime.budget,
      plan,
      acceptancePolicies: Object.fromEntries(
        plan.tasks
          .filter((task) => task.acceptance)
          .map((task) => [task.id, acceptancePolicy(cwd, task.acceptance)]),
      ),
    };
    savedRun = saved;
    atomicWrite(paths.plan, JSON.stringify(saved, null, 2), paths.root);
    appendEvent(
      paths.events,
      {
        kind: 'run.created',
        at: now(),
        contextHash: hash(context),
        planHash: hash(JSON.stringify(plan)),
        memory: memory
          ? {
              included: memory.included,
              omitted: memory.omitted,
              warnings: memory.warnings,
              bytes: memory.bytes,
              lines: memory.lines,
              contentHash: hash(memory.content),
              sources: memory.sources,
            }
          : null,
        ...initialRuntime.snapshot(),
        acceptancePolicyHash: hash(JSON.stringify(saved.acceptancePolicies)),
      },
      paths.root,
    );
  }
  const butterflyPolicy = validateButterfly(plan.butterfly);
  const release = lockDir(join(paths.dir, '.execution.lock'), {
    root: paths.root,
    timeoutMs: 100,
    staleMs: 0,
  });
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let poll;
  const active = new Map();
  try {
    const event = (value) =>
      appendEvent(paths.events, { ...redactData(value), at: now() }, paths.root);
    const processDrift = () =>
      processButterfly(cwd, {
        plan,
        paths,
        runId,
        emit: event,
        signal: controller.signal,
        acceptancePolicies: savedRun.acceptancePolicies,
      });
    await processDrift();
    let status = runStatus(cwd, runId);
    if (
      ['completed', 'failed', 'cancelled'].includes(status.status) &&
      options.resume &&
      !options.retryFailed &&
      !Object.values(status.tasks).some(
        (task) => task.status === 'completed' && task.reviewStatus === 'pending',
      )
    )
      return status;
    const runtime =
      options.runtime ||
      createRuntime(config, {
        budget: savedRun?.budgetLimits || options.budget,
        account: status.budget?.account,
        profileAccounts: status.budget?.profileAccounts,
      });
    const lifecycleEvent = (phase, value, taskId) => {
      const { attempt, ...metadata } = value;
      event({
        ...metadata,
        kind: `${phase}.${value.kind}`,
        ...(taskId ? { taskId } : {}),
        ...(attempt ? { attempt: reviewRuntime(attempt) } : {}),
      });
    };
    if (options.resume && options.retryFailed) rmSync(paths.cancel, { force: true });
    poll = setInterval(() => {
      if (existsSync(paths.cancel)) controller.abort();
    }, 25);
    const decisionEvent = readEvents(paths.events, paths.root).find(
      (entry) => entry.kind === 'decision.completed',
    );
    if (plan.decision && !decisionEvent) {
      const decision = await autoRoundtable(cwd, plan.objective, plan.decision.voters, {
        runtime,
        signal: controller.signal,
        timeoutMs: options.timeoutMs,
        signals: plan.decision.signals,
        thresholds: plan.decision.thresholds,
        evidence: plan.decision.evidence,
        voters: plan.decision.voters,
        chairProfile: plan.decision.chairProfile,
        method: plan.decision.method,
        humanGate: plan.decision.humanGate,
        onEvent: (value) => lifecycleEvent('decision', value),
      });
      if (!decision.triggered)
        event({ kind: 'decision.completed', triggered: false, trigger: decision.trigger });
      else
        event({
          kind: 'decision.completed',
          triggered: true,
          decisionId: decision.decision.decisionId,
          status: decision.decision.status,
          outcome: decision.decision.tally?.outcome || null,
        });
    }
    const currentDecision = readEvents(paths.events, paths.root).find(
      (entry) => entry.kind === 'decision.completed',
    );
    if (controller.signal.aborted) {
      event({ kind: 'run.status', status: 'cancelled', ...runtime.snapshot() });
      return runStatus(cwd, runId);
    }
    if (plan.decision && currentDecision?.triggered) {
      const decision = decisionStatus(cwd, currentDecision.decisionId);
      const approved =
        decision.status === 'completed' &&
        decision.chair?.runtime?.ok &&
        Boolean(decision.chair.synthesis) &&
        decision.tally?.outcome === 'decided' &&
        (!decision.gate.required || decision.gate.status === 'approved');
      if (!approved) {
        event({ kind: 'run.status', status: 'awaiting_decision', decisionId: decision.decisionId });
        return runStatus(cwd, runId);
      }
    }
    const states = status.tasks;
    for (const task of plan.tasks) {
      if (
        states[task.id].status === 'running' ||
        (options.retryFailed && ['failed', 'cancelled'].includes(states[task.id].status))
      ) {
        const previousProcess = readEvents(paths.events, paths.root)
          .filter((entry) => entry.kind === 'task.process' && entry.taskId === task.id)
          .at(-1);
        if (previousProcess?.fingerprint) {
          killOwnedTree(previousProcess.pid, previousProcess.fingerprint, 'SIGKILL');
        }
        const uncertainWrite = task.mode === 'write' && !options.retryInterruptedWrites;
        states[task.id].status = uncertainWrite ? 'interrupted' : 'pending';
        event({ kind: 'task.recovered', taskId: task.id, status: states[task.id].status });
      } else if (states[task.id].status === 'interrupted' && options.retryInterruptedWrites) {
        states[task.id].status = 'pending';
        event({ kind: 'task.recovered', taskId: task.id, status: 'pending' });
      } else if (states[task.id].status === 'blocked' && options.retryFailed) {
        states[task.id].status = 'pending';
        event({ kind: 'task.recovered', taskId: task.id, status: 'pending' });
      }
    }
    event({ kind: 'run.status', status: 'running' });
    const context = safeRead(paths.context, paths.root);
    const launch = (task, reviewOnly = false) => {
      if (reviewOnly) event({ kind: 'task.review_resumed', taskId: task.id });
      else {
        states[task.id].status = 'running';
        states[task.id].reviewStatus = task.review ? 'pending' : null;
        states[task.id].reviewApproved = null;
        states[task.id].attempts += 1;
        event({
          kind: 'task.started',
          taskId: task.id,
          status: 'running',
          attempts: states[task.id].attempts,
        });
      }
      const pending = (async () => {
        const taskController = new AbortController();
        const cancelTask = () => taskController.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', cancelTask, { once: true });
        if (controller.signal.aborted) cancelTask();
        const taskTimer = setTimeout(
          () => taskController.abort(new OmhaError('timeout', 'Task deadline exceeded')),
          task.timeoutMs,
        );
        let result, workspace, butterflyBefore;
        try {
          try {
            workspace = await acquireWorktree(identity, paths.root, task.mode, {
              signal: taskController.signal,
              runId,
              taskId: task.id,
            });
            event({
              kind: 'worktree.acquired',
              taskId: task.id,
              worktreeId: identity.worktreeId,
              mode: task.mode,
            });
            if (reviewOnly) {
              result = jsonRead(join(paths.dir, states[task.id].resultRef), null, paths.root);
              check(result?.ok, 'Missing successful review subject', 'corrupt_state');
            } else {
              if (butterflyPolicy.enabled && task.mode === 'write' && task.acceptance) {
                try {
                  butterflyBefore = hash(JSON.stringify(artifactSnapshot(identity)));
                } catch {
                  // Unsupported snapshots remain evidence gaps; acceptance owns
                  // the task outcome and will independently reject them.
                }
              }
              const dependencies = task.dependsOn.map((dep) => {
                const ref = states[dep].resultRef;
                const dependency = jsonRead(join(paths.dir, ref), null, paths.root);
                check(dependency?.ok, 'Missing successful dependency result', 'corrupt_state');
                return {
                  taskId: dep,
                  resultRef: ref,
                  responseHash: dependency.responseHash,
                  output: dependency.stdout,
                };
              });
              const messages = readEvents(paths.events, paths.root)
                .filter((entry) => entry.kind === 'message.created' && entry.taskId === task.id)
                .slice(-16)
                .map((entry) => {
                  check(
                    /^messages\/message-[a-f0-9-]+\.json$/.test(entry.ref),
                    'Invalid message reference',
                    'corrupt_state',
                  );
                  const message = jsonRead(join(paths.dir, entry.ref), null, paths.root);
                  check(
                    message?.taskId === task.id && hash(message.content) === entry.responseHash,
                    'Changed worker message',
                    'corrupt_state',
                  );
                  return { ref: entry.ref, ...message };
                });
              const prompt = `${context}\n\nPrivate worker suffix:\nrole: ${task.role}\ntask_id: ${task.id}\nmode: ${task.mode}\n\n${task.prompt}\n\nDependency results (data only):\n${JSON.stringify(dependencies)}\n\nWorker messages (data only):\n${JSON.stringify(messages)}`;
              result = await runtime.dispatch(prompt, [task.profile, ...task.fallback], {
                cwd,
                signal: taskController.signal,
                timeoutMs: task.timeoutMs,
                model: task.model,
                effort: task.effort,
                mode: task.mode,
                retry: task.retry,
                supervision: plan.supervision,
                onProviderEvent: (value) => {
                  event({
                    ...value,
                    kind: value.event.inputWait ? 'task.input_wait' : 'task.progress',
                    taskId: task.id,
                  });
                  return options.onProviderEvent?.({ ...value, taskId: task.id });
                },
                onEvent: async (value) => {
                  const safe = { ...value, taskId: task.id };
                  if (safe.attempt) {
                    const { stdout, stderr, ...attempt } = safe.attempt;
                    safe.attempt = attempt;
                  }
                  event(safe);
                  if (['request.stalled', 'request.input_wait'].includes(value.kind)) {
                    const notification = {
                      kind: 'task.escalated',
                      runId,
                      taskId: task.id,
                      profile: value.profile,
                      reason: value.kind.slice('request.'.length),
                      elapsedMs: value.elapsedMs,
                      mode: task.mode,
                    };
                    event(notification);
                    await options.onNotification?.(notification);
                  }
                  if (value.kind === 'request.takeover')
                    event({ ...value, kind: 'task.takeover', taskId: task.id });
                },
                onSpawn: (pid) => {
                  const fingerprint = processFingerprint(pid);
                  workspace.recordProcess(pid, fingerprint);
                  event({
                    kind: 'task.process',
                    taskId: task.id,
                    pid,
                    fingerprint,
                  });
                },
              });
            }
          } catch (error) {
            if (reviewOnly || error.code === 'corrupt_state') throw error;
            result = {
              ok: false,
              failure: error.code || 'task',
              failureStage: 'host',
              stderr: error.message,
            };
          }
          if (!reviewOnly && result.ok && task.acceptance) {
            const acceptance = await acceptTask(
              cwd,
              task,
              savedRun?.acceptancePolicies?.[task.id],
              identity,
              taskController.signal,
              (pid) => {
                const fingerprint = processFingerprint(pid);
                if (fingerprint) workspace.recordProcess(pid, fingerprint);
                event({
                  kind: 'task.acceptance_process',
                  taskId: task.id,
                  pid,
                  fingerprint,
                });
              },
            );
            result = {
              ...result,
              executionOk: true,
              acceptance,
              ok: acceptance.accepted,
              failure: acceptance.accepted
                ? null
                : acceptance.cancelled
                  ? 'cancellation'
                  : acceptance.timedOut
                    ? 'timeout'
                    : 'acceptance',
              failureStage: acceptance.accepted ? null : 'acceptance',
            };
          }
          const resultRef = taskResultRef(task.id);
          atomicWrite(
            join(paths.dir, resultRef),
            JSON.stringify(redactData(result), null, 2),
            paths.root,
          );
          states[task.id].status = result.ok
            ? 'completed'
            : task.mode === 'write' &&
                (result.interrupted || ['stalled', 'input_wait'].includes(result.failure))
              ? 'interrupted'
              : result.failure === 'cancellation'
                ? 'cancelled'
                : 'failed';
          states[task.id].resultRef = resultRef;
          if (!reviewOnly && butterflyPolicy.enabled && task.mode === 'write' && task.acceptance)
            observeButterfly({
              task,
              result,
              beforeHash: butterflyBefore,
              attempt: states[task.id].attempts,
              policyHash: savedRun.acceptancePolicies[task.id]
                ? hash(JSON.stringify(savedRun.acceptancePolicies[task.id]))
                : null,
              events: readEvents(paths.events, paths.root),
              emit: event,
              policy: butterflyPolicy,
            });
          if (!reviewOnly)
            event({
              kind: 'task.finished',
              taskId: task.id,
              status: states[task.id].status,
              failure: result.failure,
              resultRef,
              responseHash: result.responseHash,
              executionOk: result.executionOk ?? result.ok,
              acceptanceAccepted: result.acceptance?.accepted ?? null,
            });
          if (result.ok && task.review) {
            let review;
            try {
              review = await reviewTask(cwd, runId, task.id, {
                runtime,
                signal: taskController.signal,
                reviewerProfile: task.review.reviewerProfile,
                diff: task.review.diff,
                testEvidence: task.review.testEvidence,
                criteria: task.review.criteria,
                onEvent: (value) => lifecycleEvent('review', value, task.id),
                onSpawn: (pid) => {
                  const fingerprint = processFingerprint(pid);
                  if (fingerprint) workspace.recordProcess(pid, fingerprint);
                  event({ kind: 'task.review_process', taskId: task.id, pid, fingerprint });
                },
              });
            } catch (error) {
              review = {
                status: 'failed',
                approved: false,
                reviewerProfile: task.review.reviewerProfile,
                validationError: error.message,
              };
            }
            result.review = {
              status: review.status,
              approved: review.approved,
              reviewId: review.reviewId || null,
              reviewerProfile: review.reviewerProfile,
              servedReviewerProfile: review.servedReviewerProfile || null,
              validationError: review.validationError || null,
            };
            states[task.id].reviewStatus = review.status;
            states[task.id].reviewApproved = Boolean(review.approved);
            atomicWrite(
              join(paths.dir, resultRef),
              JSON.stringify(redactData(result), null, 2),
              paths.root,
            );
            event({
              kind: 'task.reviewed',
              taskId: task.id,
              status: review.status,
              approved: Boolean(review.approved),
              reviewId: review.reviewId || null,
            });
          }
          if (validateRunMemory(plan.memory).write) {
            try {
              const lesson = recordRunLesson(
                cwd,
                { runId, taskId: task.id, role: task.role, result },
                validateRunMemory(plan.memory),
              );
              if (lesson)
                event({
                  kind: 'memory.recorded',
                  taskId: task.id,
                  name: lesson.name,
                  hash: lesson.hash,
                  scope: lesson.scope,
                });
            } catch (error) {
              event({ kind: 'memory.rejected', taskId: task.id, failure: error.code || 'memory' });
            }
          }
        } finally {
          workspace?.release();
          clearTimeout(taskTimer);
          controller.signal.removeEventListener('abort', cancelTask);
          active.delete(task.id);
        }
      })();
      active.set(task.id, pending);
    };
    for (const task of plan.tasks) {
      const state = states[task.id];
      if (
        state.status === 'completed' &&
        task.review &&
        state.reviewApproved !== true &&
        (state.reviewStatus === 'pending' || options.retryFailed)
      ) {
        if (active.size >= Math.min(plan.parallelism, options.parallelism || plan.parallelism))
          await Promise.race(active.values());
        launch(task, true);
      }
    }
    while (true) {
      if (existsSync(paths.cancel)) controller.abort();
      let changed;
      do {
        changed = false;
        for (const task of plan.tasks.filter((t) => states[t.id].status === 'pending')) {
          if (controller.signal.aborted) {
            states[task.id].status = 'cancelled';
            event({
              kind: 'task.finished',
              taskId: task.id,
              status: 'cancelled',
              failure: 'cancellation',
            });
            changed = true;
            continue;
          }
          if (
            task.dependsOn.some(
              (dep) =>
                ['failed', 'blocked', 'cancelled', 'interrupted'].includes(states[dep].status) ||
                (states[dep].status === 'completed' &&
                  !active.has(dep) &&
                  states[dep].reviewStatus &&
                  states[dep].reviewApproved !== true),
            )
          ) {
            states[task.id].status = 'blocked';
            event({
              kind: 'task.blocked',
              taskId: task.id,
              status: 'blocked',
              failure: 'dependency',
            });
            changed = true;
          }
        }
      } while (changed);
      const ready = plan.tasks.filter(
        (t) =>
          states[t.id].status === 'pending' &&
          t.dependsOn.every(
            (dep) =>
              states[dep].status === 'completed' &&
              !active.has(dep) &&
              (!states[dep].reviewStatus || states[dep].reviewApproved === true),
          ),
      );
      for (const task of ready) {
        if (active.size >= Math.min(plan.parallelism, options.parallelism || plan.parallelism))
          break;
        const writeActive = [...active.keys()].some(
          (key) => plan.tasks.find((t) => t.id === key).mode === 'write',
        );
        if (writeActive || (task.mode === 'write' && active.size > 0)) continue;
        launch(task);
      }
      if (!active.size) break;
      await Promise.race(active.values());
    }
    const statuses = Object.values(states).map((task) => task.status);
    const reviewFailed = Object.values(states).some(
      (task) => task.reviewStatus && task.reviewApproved !== true,
    );
    const finalStatus =
      statuses.every((s) => s === 'completed') && !reviewFailed
        ? 'completed'
        : controller.signal.aborted
          ? 'cancelled'
          : statuses.includes('interrupted')
            ? 'interrupted'
            : 'failed';
    event({ kind: 'run.status', status: finalStatus, ...runtime.snapshot() });
    await processDrift();
    return runStatus(cwd, runId);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(active.values());
    throw error;
  } finally {
    clearInterval(poll);
    options.signal?.removeEventListener('abort', abort);
    release();
  }
}

export async function leader(cwd, objective, providers, options = {}) {
  check(
    !options.policy || (!options.plan && !options.resume),
    'Host policy binding requires a generated plan',
  );
  if (options.plan) return executePlan(cwd, options.plan, options);
  if (options.resume) return executePlan(cwd, null, options);
  text(objective, 'leader objective', 100000);
  const runtime =
    options.runtime ||
    createRuntime(
      options.profiles
        ? { version: 1, profiles: options.profiles }
        : loadConfig(cwd, options.config),
      { budget: options.budget },
    );
  const selected = options.plannerProfile || providers?.[0] || 'claude';
  const available = Object.values(runtime.config.profiles).map((p) => ({
    profile: p.name,
    model: p.model,
    sandbox: p.sandbox,
  }));
  const prompt = `${stablePrefix(cwd, objective, options.publicContext || '')}\n\nRole: planner. Return ONLY a JSON object with version:1, objective, publicContext, parallelism (1-16), tasks. Each task needs id, role, prompt, dependsOn, profile, mode (readonly or write), timeoutMs, fallback. Produce a DAG using only the configured profiles below. Plan at lowest configured effort. Host write authorization: ${Boolean(options.allowWrite)}. Never execute tools.\n${JSON.stringify(available)}`;
  assertNoSecrets(prompt);
  const planning = await runtime.dispatch(prompt, [selected], {
    cwd,
    mode: 'readonly',
    toolFree: true,
    requires: ['headless', 'tool-free', 'read-only'],
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    effort: 'low',
  });
  check(planning.ok, `Planner failed: ${planning.failure}`, planning.failure || 'task');
  let plan;
  try {
    plan = JSON.parse(planning.stdout);
  } catch {
    throw new OmhaError('malformed_plan', 'Planner must return a JSON task plan');
  }
  const validated = validatePlan(bindHostPolicy(plan, options.policy), runtime.config.profiles, {
    allowWrite: options.allowWrite,
  });
  check(
    validated.objective === objective && validated.publicContext === (options.publicContext || ''),
    'Planner changed the public objective/context',
    'malformed_plan',
  );
  const result = await executePlan(cwd, validated, { ...options, runtime });
  const paths = runPaths(cwd, result.runId);
  atomicWrite(join(paths.dir, PLANNER_RESULT_REF), JSON.stringify(planning, null, 2), paths.root);
  appendEvent(
    paths.events,
    {
      kind: 'planner.result',
      resultRef: PLANNER_RESULT_REF,
      responseHash: planning.responseHash,
      at: now(),
    },
    paths.root,
  );
  return result;
}
