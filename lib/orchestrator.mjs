import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { validatePlan } from './plans.mjs';
import { check, choice, id, keys, text, OmhaError } from './validation.mjs';
import { assertNoSecrets, redactData } from './security.mjs';
import { killOwnedTree, processFingerprint } from './process.mjs';
import { initMemory } from './memory.mjs';

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
          lease.children = [{ pid, fingerprint }];
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

function runPaths(cwd, runId) {
  id(runId, 'run id');
  const root = stateHome(),
    dir = join(projectDir(cwd), 'runs', runId);
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
  const paths = runPaths(cwd, runId);
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
        attempts: 0,
        resultRef: null,
      },
    ]),
  );
  let status = 'created',
    budget;
  for (const event of readEvents(paths.events, paths.root)) {
    if (event.taskId && event.status && event.kind.startsWith('task.')) {
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
      });
    }
    if (event.kind === 'run.status') status = event.status;
    if (event.account) budget = { account: event.account, profileAccounts: event.profileAccounts };
  }
  return {
    runId,
    status,
    tasks,
    planHash: hash(JSON.stringify(plan)),
    contextHash: hash(safeRead(paths.context, paths.root)),
    budget,
    dir: paths.dir,
  };
}

export function listRuns(cwd) {
  const dir = join(projectDir(cwd), 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[A-Za-z0-9_-]+$/.test(name))
    .sort()
    .map((name) => runStatus(cwd, name));
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
  } else {
    plan = validatePlan(input, initialRuntime.config.profiles, { allowWrite: options.allowWrite });
    initMemory(cwd);
    ensureDir(join(projectDir(cwd), 'runs'), paths.root);
    check(!existsSync(paths.dir), 'Run id already exists');
    ensureDir(paths.dir, paths.root);
    const context = stablePrefix(cwd, plan.objective, plan.publicContext);
    assertNoSecrets(context);
    atomicWrite(paths.context, context, paths.root);
    const saved = {
      projectId: projectIdentity(cwd).projectId,
      worktreeId: projectIdentity(cwd).worktreeId,
      contextHash: hash(context),
      profileHash: hash(JSON.stringify(initialRuntime.config)),
      budgetLimits: initialRuntime.budget,
      plan,
    };
    atomicWrite(paths.plan, JSON.stringify(saved, null, 2), paths.root);
    appendEvent(
      paths.events,
      {
        kind: 'run.created',
        at: now(),
        contextHash: hash(context),
        planHash: hash(JSON.stringify(plan)),
      },
      paths.root,
    );
  }
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
    let status = runStatus(cwd, runId);
    if (
      ['completed', 'failed', 'cancelled'].includes(status.status) &&
      options.resume &&
      !options.retryFailed
    )
      return status;
    const runtime =
      options.runtime ||
      createRuntime(config, {
        budget: savedRun?.budgetLimits || options.budget,
        account: status.budget?.account,
        profileAccounts: status.budget?.profileAccounts,
      });
    const event = (value) =>
      appendEvent(paths.events, { ...redactData(value), at: now() }, paths.root);
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
    if (options.resume && options.retryFailed) rmSync(paths.cancel, { force: true });
    event({ kind: 'run.status', status: 'running' });
    poll = setInterval(() => {
      if (existsSync(paths.cancel)) controller.abort();
    }, 25);
    const context = safeRead(paths.context, paths.root);
    const launch = (task) => {
      states[task.id].status = 'running';
      states[task.id].attempts += 1;
      event({
        kind: 'task.started',
        taskId: task.id,
        status: 'running',
        attempts: states[task.id].attempts,
      });
      const pending = (async () => {
        const taskController = new AbortController();
        const cancelTask = () => taskController.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', cancelTask, { once: true });
        if (controller.signal.aborted) cancelTask();
        const taskTimer = setTimeout(
          () => taskController.abort(new OmhaError('timeout', 'Task deadline exceeded')),
          task.timeoutMs,
        );
        let result, workspace;
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
            onEvent: (value) => {
              const safe = { ...value, taskId: task.id };
              if (safe.attempt) {
                const { stdout, stderr, ...attempt } = safe.attempt;
                safe.attempt = attempt;
              }
              event(safe);
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
        } catch (error) {
          if (error.code === 'corrupt_state') throw error;
          result = {
            ok: false,
            failure: error.code || 'task',
            failureStage: 'host',
            stderr: error.message,
          };
        } finally {
          workspace?.release();
          clearTimeout(taskTimer);
          controller.signal.removeEventListener('abort', cancelTask);
        }
        const resultRef = taskResultRef(task.id);
        atomicWrite(
          join(paths.dir, resultRef),
          JSON.stringify(redactData(result), null, 2),
          paths.root,
        );
        states[task.id].status = result.ok
          ? 'completed'
          : result.failure === 'cancellation'
            ? 'cancelled'
            : 'failed';
        states[task.id].resultRef = resultRef;
        event({
          kind: 'task.finished',
          taskId: task.id,
          status: states[task.id].status,
          failure: result.failure,
          resultRef,
          responseHash: result.responseHash,
        });
        active.delete(task.id);
      })();
      active.set(task.id, pending);
    };
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
            task.dependsOn.some((dep) =>
              ['failed', 'blocked', 'cancelled', 'interrupted'].includes(states[dep].status),
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
          t.dependsOn.every((dep) => states[dep].status === 'completed'),
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
    const finalStatus = statuses.every((s) => s === 'completed')
      ? 'completed'
      : controller.signal.aborted
        ? 'cancelled'
        : statuses.includes('interrupted')
          ? 'interrupted'
          : 'failed';
    event({ kind: 'run.status', status: finalStatus, ...runtime.snapshot() });
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
  const validated = validatePlan(plan, runtime.config.profiles, { allowWrite: options.allowWrite });
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
