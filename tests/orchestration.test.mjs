import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime } from '../lib/runner.mjs';
import { projectIdentity } from '../lib/core.mjs';
import {
  executePlan,
  reviewTask,
  leader,
  runStatus,
  cancelRun,
  sendTaskMessage,
  validatePlan,
} from '../lib/orchestrator.mjs';
import { appendEvent, atomicWrite, readEvents } from '../lib/storage.mjs';
import {
  roundtable,
  autoRoundtable,
  assessRoundtableTrigger,
  decisionStatus,
  resolveDecision,
} from '../lib/roundtable.mjs';

const root = temp();
process.env.OMHA_HOME = join(root, 'state');
const cwd = join(root, 'project');
mkdirSync(cwd);
const runtime = (profiles) => createRuntime(config(profiles), { persistent: false });
const task = (id, extra = {}) => ({
  id,
  role: 'reviewer',
  prompt: `Inspect ${id}`,
  profile: 'p',
  mode: 'readonly',
  ...extra,
});
const plan = (tasks, extra = {}) => ({
  version: 1,
  objective: 'Inspect code',
  publicContext: 'Immutable facts',
  parallelism: 2,
  tasks,
  ...extra,
});

test('plan validation rejects cycles, duplicate IDs, unknown profiles and unauthorized writes', () => {
  const profiles = runtime({ p: fake(), w: fake('write', { sandbox: 'workspace-write' }) }).config
    .profiles;
  assert.throws(
    () =>
      validatePlan(
        plan([task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })]),
        profiles,
      ),
    /cycle/,
  );
  assert.throws(() => validatePlan(plan([task('a'), task('a')]), profiles), /Duplicate/);
  assert.throws(() => validatePlan(plan([task('a', { profile: 'missing' })]), profiles), /Unknown/);
  assert.throws(
    () => validatePlan(plan([task('a', { profile: 'w', mode: 'write' })]), profiles),
    /allowWrite/,
  );
  assert.throws(
    () =>
      validatePlan(
        plan([
          task('a', { profile: 'w', mode: 'write' }),
          task('b', { profile: 'w', mode: 'write' }),
        ]),
        profiles,
        { allowWrite: true },
      ),
    /dependency-ordered/,
  );
  assert.throws(
    () =>
      validatePlan(plan([task('a', { acceptance: { command: 'relative', args: [] } })]), profiles),
    /absolute/,
  );
});

test('host acceptance separates execution success from dependency-eligible success', async () => {
  const acceptance = join(root, 'acceptance.mjs');
  writeFileSync(acceptance, "process.exit(process.argv[2] === 'pass' ? 0 : 1)");
  const rt = runtime({ p: fake('implementation') });
  const accepted = await executePlan(
    cwd,
    plan([task('a', { acceptance: { command: process.execPath, args: [acceptance, 'pass'] } })]),
    { runtime: rt },
  );
  assert.equal(accepted.status, 'completed');
  const acceptedRecord = JSON.parse(readFileSync(join(accepted.dir, 'a.result.json'), 'utf8'));
  assert.equal(acceptedRecord.executionOk, true);
  assert.equal(acceptedRecord.acceptance.accepted, true);
  const failed = await executePlan(
    cwd,
    plan([
      task('a', { acceptance: { command: process.execPath, args: [acceptance, 'fail'] } }),
      task('b', { dependsOn: ['a'] }),
    ]),
    { runtime: rt },
  );
  const failedRecord = JSON.parse(readFileSync(join(failed.dir, 'a.result.json'), 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.equal(failedRecord.executionOk, true);
  assert.equal(failedRecord.ok, false);
  assert.equal(failedRecord.failure, 'acceptance');
  assert.equal(failed.tasks.b.status, 'blocked');
});

test('DAG scheduler runs ready readers together, passes dependency references and stores stable context once', async () => {
  const rt = runtime({
    p: fake('output', {
      concurrency: 4,
      responses: [
        { output: 'private-a', latencyMs: 60 },
        { output: 'private-b', latencyMs: 60 },
        { output: 'final', latencyMs: 5 },
      ],
    }),
  });
  const prompts = [];
  const original = rt.attempt.bind(rt);
  rt.attempt = async (name, prompt, options) => {
    prompts.push(prompt);
    return original(name, prompt, options);
  };
  const result = await executePlan(
    cwd,
    plan([task('a'), task('b'), task('c', { dependsOn: ['a', 'b'] })]),
    { runtime: rt },
  );
  assert.equal(result.status, 'completed');
  const events = readEvents(join(result.dir, 'events.jsonl'));
  const starts = events.filter((e) => e.kind === 'task.started');
  const finishes = events.filter((e) => e.kind === 'task.finished');
  assert.ok(events.indexOf(starts[1]) < events.indexOf(finishes[0]));
  assert.ok(events.indexOf(starts[2]) > events.indexOf(finishes[1]));
  const prefix = readFileSync(join(result.dir, 'context.md'), 'utf8');
  assert.ok(prompts.every((p) => p.startsWith(prefix)));
  assert.equal(prefix.includes('private-a'), false);
  assert.ok(prompts[2].includes('a.result.json'));
  assert.ok(prompts[2].includes('private-a'));
  assert.equal(
    events.some((event) => event.stdout || event.stderr || event.attempt?.stdout),
    false,
  );
  assert.equal(result.budget.account.requests, 3);
});

test('independent task review validates frozen diff, tests and every criterion', async () => {
  const reviewCwd = join(root, 'review-project');
  mkdirSync(reviewCwd);
  const reviewerOutput = JSON.stringify({
    assessments: [
      { id: 'tests', status: 'pass', finding: 'Offline tests passed.' },
      { id: 'scope', status: 'pass', finding: 'Diff matches the requested scope.' },
    ],
    summary: 'Independent review passed.',
  });
  const rt = runtime({ author: fake('implementation result'), reviewer: fake(reviewerOutput) });
  const execution = await executePlan(reviewCwd, plan([task('subject', { profile: 'author' })]), {
    runtime: rt,
  });
  const review = await reviewTask(reviewCwd, execution.runId, 'subject', {
    runtime: rt,
    reviewerProfile: 'reviewer',
    diff: 'diff --git a/example b/example\n+safe change',
    testEvidence: [{ name: 'offline', status: 'passed', summary: '93 tests passed' }],
    criteria: [
      { id: 'tests', description: 'The supplied tests pass.' },
      { id: 'scope', description: 'The diff matches the requested scope.' },
    ],
  });
  assert.equal(review.status, 'completed');
  assert.equal(review.approved, true);
  assert.equal(review.authorProfile, 'author');
  assert.equal(review.reviewerProfile, 'reviewer');
  assert.ok(readFileSync(join(execution.dir, review.packetRef), 'utf8').includes('safe change'));
  assert.equal(readEvents(join(execution.dir, 'events.jsonl')).at(-1).kind, 'review.recorded');
  await assert.rejects(
    () =>
      reviewTask(reviewCwd, execution.runId, 'subject', {
        runtime: rt,
        reviewerProfile: 'author',
        diff: 'safe',
        testEvidence: [{ name: 'offline', status: 'passed', summary: 'passed' }],
        criteria: [{ id: 'tests', description: 'Tests pass.' }],
      }),
    { code: 'review_authority' },
  );
  const driftRuntime = runtime({
    author: fake('implementation result'),
    reviewer: fake('changed'),
  });
  await assert.rejects(
    () =>
      reviewTask(reviewCwd, execution.runId, 'subject', {
        runtime: driftRuntime,
        reviewerProfile: 'reviewer',
        diff: 'safe',
        testEvidence: [{ name: 'offline', status: 'passed', summary: 'passed' }],
        criteria: [{ id: 'tests', description: 'Tests pass.' }],
      }),
    /configuration changed/,
  );
  const invalidCwd = join(root, 'review-invalid-project');
  mkdirSync(invalidCwd);
  const invalidRuntime = runtime({
    author: fake('implementation result'),
    reviewer: fake('{bad}'),
  });
  const invalidExecution = await executePlan(
    invalidCwd,
    plan([task('subject', { profile: 'author' })]),
    { runtime: invalidRuntime },
  );
  const invalid = await reviewTask(invalidCwd, invalidExecution.runId, 'subject', {
    runtime: invalidRuntime,
    reviewerProfile: 'reviewer',
    reviewId: 'review-invalid',
    diff: 'safe',
    testEvidence: [{ name: 'offline', status: 'passed', summary: 'passed' }],
    criteria: [{ id: 'tests', description: 'Tests pass.' }],
  });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.approved, false);
});

test('task review is part of the lifecycle and failed review blocks dependents', async () => {
  const reviewOutput = JSON.stringify({
    assessments: [
      { id: 'scope', status: 'fail', finding: 'The fixture is intentionally rejected.' },
    ],
    summary: 'Rejected by independent reviewer.',
  });
  const rt = runtime({ author: fake('implementation'), reviewer: fake(reviewOutput) });
  const result = await executePlan(
    cwd,
    plan([
      task('subject', {
        profile: 'author',
        review: {
          reviewerProfile: 'reviewer',
          diff: '+fixture',
          testEvidence: [{ name: 'offline', status: 'passed', summary: 'Passed' }],
          criteria: [{ id: 'scope', description: 'Scope is correct.' }],
        },
      }),
      task('dependent', { dependsOn: ['subject'], profile: 'author' }),
    ]),
    { runtime: rt },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.tasks.subject.status, 'completed');
  assert.equal(result.tasks.subject.reviewStatus, 'completed');
  assert.equal(result.tasks.subject.reviewApproved, false);
  assert.equal(result.tasks.dependent.status, 'blocked');
  const record = JSON.parse(readFileSync(join(result.dir, 'subject.result.json'), 'utf8'));
  assert.equal(record.executionOk, undefined);
  assert.equal(record.review.approved, false);
  assert.equal(record.review.servedReviewerProfile, 'reviewer');
  assert.equal(
    readEvents(join(result.dir, 'events.jsonl')).filter((event) => event.kind === 'review.recorded')
      .length,
    1,
  );
});

test('worktree admission excludes writes across runs while allowing independent readers and roots', async () => {
  for (const modes of [
    ['write', 'write'],
    ['write', 'readonly'],
    ['readonly', 'write'],
    ['readonly', 'readonly'],
  ]) {
    const rt = runtime({ p: fake('reader'), w: fake('writer', { sandbox: 'workspace-write' }) });
    const calls = [];
    let finishFirst, firstStarted;
    const started = new Promise((resolve) => {
      firstStarted = resolve;
    });
    const held = new Promise((resolve) => {
      finishFirst = resolve;
    });
    const original = rt.fake.bind(rt);
    rt.fake = async (...args) => {
      calls.push(args[1].mode);
      if (calls.length === 1) {
        firstStarted();
        await held;
      }
      return original(...args);
    };
    const job = (mode) =>
      executePlan(cwd, plan([task('job', { mode, profile: mode === 'write' ? 'w' : 'p' })]), {
        runtime: rt,
        allowWrite: true,
      });
    const first = job(modes[0]);
    await started;
    const second = job(modes[1]);
    const identity = projectIdentity(cwd);
    const gate = join(
      process.env.OMHA_HOME,
      'projects',
      identity.projectId,
      'worktrees',
      identity.worktreeId,
      'admission.json',
    );
    for (let i = 0; i < 100; i += 1) {
      const state = JSON.parse(readFileSync(gate, 'utf8'));
      if (state.waiters.length || calls.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(calls.length, modes.every((mode) => mode === 'readonly') ? 2 : 1);
    finishFirst();
    assert.deepEqual(
      (await Promise.all([first, second])).map((value) => value.status),
      ['completed', 'completed'],
    );
    assert.equal(JSON.parse(readFileSync(gate, 'utf8')).leases.length, 0);
  }
  const roots = [join(root, 'workspace-a'), join(root, 'workspace-b')];
  roots.forEach((directory) => mkdirSync(directory));
  const rt = runtime({ w: fake('writer', { sandbox: 'workspace-write' }) });
  let concurrent = 0,
    max = 0;
  const original = rt.fake.bind(rt);
  rt.fake = async (...args) => {
    concurrent += 1;
    max = Math.max(max, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      return await original(...args);
    } finally {
      concurrent -= 1;
    }
  };
  await Promise.all(
    roots.map((directory) =>
      executePlan(directory, plan([task('job', { mode: 'write', profile: 'w' })]), {
        runtime: rt,
        allowWrite: true,
      }),
    ),
  );
  assert.equal(max, 2);
});

test('review authority follows actual authors and excludes them from implicit reviewer fallbacks', async () => {
  const output = JSON.stringify({
    assessments: [{ id: 'scope', status: 'pass', finding: 'Independent scope check' }],
    summary: 'Review',
  });
  const input = (rt, reviewerProfile) => ({
    runtime: rt,
    reviewerProfile,
    diff: '+fixture',
    testEvidence: [{ name: 'offline', status: 'passed', summary: 'Passed' }],
    criteria: [{ id: 'scope', description: 'Scope' }],
  });
  const rt = runtime({
    primary: fake('', { responses: [{ failure: 'rate_limit' }], fallback: ['actual'] }),
    actual: fake('implementation'),
    reviewer: fake(output),
  });
  const execution = await executePlan(cwd, plan([task('subject', { profile: 'primary' })]), {
    runtime: rt,
  });
  await assert.rejects(() => reviewTask(cwd, execution.runId, 'subject', input(rt, 'actual')), {
    code: 'review_authority',
  });
  const independent = await reviewTask(cwd, execution.runId, 'subject', input(rt, 'reviewer'));
  assert.equal(independent.authorProfile, 'actual');
  assert.equal(independent.requestedAuthorProfile, 'primary');
  assert.equal(independent.servedReviewerProfile, 'reviewer');
  assert.equal(independent.approved, true);

  const fallback = runtime({
    author: fake('implementation'),
    reviewer: fake('', {
      responses: [{ failure: 'rate_limit' }],
      fallback: ['author', 'independent'],
    }),
    independent: fake(output),
  });
  const next = await executePlan(cwd, plan([task('subject', { profile: 'author' })]), {
    runtime: fallback,
  });
  const review = await reviewTask(cwd, next.runId, 'subject', input(fallback, 'reviewer'));
  assert.equal(review.approved, true);
  assert.equal(review.servedReviewerProfile, 'independent');
  assert.equal(fallback.fakeOffsets.get('author'), 1);
  assert.equal(
    review.runtime.attempts.find((attempt) => attempt.profile === 'author').failure,
    'authority',
  );

  const refused = runtime({
    author: fake('implementation'),
    reviewer: fake('', { responses: [{ failure: 'rate_limit' }], fallback: ['author'] }),
  });
  const last = await executePlan(cwd, plan([task('subject', { profile: 'author' })]), {
    runtime: refused,
  });
  const rejected = await reviewTask(cwd, last.runId, 'subject', input(refused, 'reviewer'));
  assert.equal(rejected.approved, false);
  assert.equal(rejected.status, 'failed');
  assert.equal(refused.fakeOffsets.get('author'), 1);
  assert.equal(rejected.runtime.failure, 'authority');
  assert.equal(runStatus(cwd, last.runId).tasks.subject.status, 'completed');
  refused.dispatch = async () => ({
    ok: true,
    stdout: output,
    servedProfile: 'author',
    attempts: [],
  });
  const invalid = await reviewTask(cwd, last.runId, 'subject', input(refused, 'reviewer'));
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.approved, false);
  assert.match(invalid.validationError, /author profile/);
  assert.equal(runStatus(cwd, last.runId).tasks.subject.status, 'completed');
});

test('worktree admission cancels queued tasks without provider calls and removes dead owners', async () => {
  const rt = runtime({ w: fake('writer', { sandbox: 'workspace-write' }) });
  let started, finish;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const hold = new Promise((resolve) => {
    finish = resolve;
  });
  const original = rt.fake.bind(rt);
  rt.fake = async (...args) => {
    started();
    await hold;
    return original(...args);
  };
  const input = plan([task('job', { mode: 'write', profile: 'w' })]);
  const first = executePlan(cwd, input, { runtime: rt, allowWrite: true });
  await ready;
  const cancelled = runtime({ w: fake('must not launch', { sandbox: 'workspace-write' }) });
  const controller = new AbortController();
  const second = executePlan(cwd, input, {
    runtime: cancelled,
    allowWrite: true,
    signal: controller.signal,
  });
  const identity = projectIdentity(cwd);
  const gate = join(
    process.env.OMHA_HOME,
    'projects',
    identity.projectId,
    'worktrees',
    identity.worktreeId,
    'admission.json',
  );
  for (let i = 0; i < 100 && JSON.parse(readFileSync(gate, 'utf8')).waiters.length === 0; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const result = await second;
  assert.equal(result.status, 'cancelled');
  assert.equal(cancelled.account.requests, 0);
  assert.equal(JSON.parse(readFileSync(gate, 'utf8')).waiters.length, 0);
  const expired = runtime({ w: fake('must not launch', { sandbox: 'workspace-write' }) });
  const timedOut = await executePlan(
    cwd,
    plan([task('job', { mode: 'write', profile: 'w', timeoutMs: 10 })]),
    { runtime: expired, allowWrite: true },
  );
  assert.equal(timedOut.tasks.job.failure, 'timeout');
  assert.equal(expired.account.requests, 0);
  assert.equal(JSON.parse(readFileSync(gate, 'utf8')).waiters.length, 0);
  finish();
  await first;
  atomicWrite(
    gate,
    JSON.stringify({
      version: 1,
      waiters: [],
      leases: [{ token: 'dead', pid: 2147483647, fingerprint: null, mode: 'write', children: [] }],
    }),
  );
  assert.equal(
    (await executePlan(cwd, input, { runtime: cancelled, allowWrite: true })).status,
    'completed',
  );
});

test('failure propagates through dependencies even when tasks are in reverse order', async () => {
  const result = await executePlan(
    cwd,
    plan([task('c', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] }), task('a')]),
    { runtime: runtime({ p: fake('', { responses: [{ failure: 'task' }] }) }) },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.tasks.a.status, 'failed');
  assert.equal(result.tasks.b.status, 'blocked');
  assert.equal(result.tasks.c.status, 'blocked');
});

test('completed runs resume without replay; interrupted writes require an explicit replay flag', async () => {
  const rt = runtime({ p: fake(), w: fake('write', { sandbox: 'workspace-write' }) });
  const result = await executePlan(
    cwd,
    plan([task('a', { profile: 'w', mode: 'write' }), task('b', { dependsOn: ['a'] })]),
    { runtime: rt, allowWrite: true },
  );
  const same = await executePlan(cwd, null, {
    runtime: rt,
    allowWrite: true,
    resume: true,
    runId: result.runId,
  });
  assert.equal(same.status, 'completed');
  assert.equal(rt.fakeOffsets.get('w'), 1);
  const events = join(result.dir, 'events.jsonl');
  appendEvent(events, { kind: 'task.started', taskId: 'a', status: 'running', attempts: 2 });
  appendEvent(events, { kind: 'task.recovered', taskId: 'b', status: 'pending' });
  appendEvent(events, { kind: 'run.status', status: 'running' });
  const paused = await executePlan(cwd, null, {
    runtime: rt,
    allowWrite: true,
    resume: true,
    runId: result.runId,
  });
  assert.equal(paused.status, 'interrupted');
  assert.equal(paused.tasks.a.status, 'interrupted');
  assert.equal(paused.tasks.b.status, 'blocked');
  assert.equal(rt.fakeOffsets.get('w'), 1);
  const resumed = await executePlan(cwd, null, {
    runtime: rt,
    allowWrite: true,
    resume: true,
    retryFailed: true,
    retryInterruptedWrites: true,
    runId: result.runId,
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(rt.fakeOffsets.get('w'), 2);
});

test('durable cancel command cancels active and pending tasks', async () => {
  const runId = 'cancel-test';
  const pending = executePlan(cwd, plan([task('a'), task('b', { dependsOn: ['a'] })]), {
    runId,
    runtime: runtime({ p: fake('done', { responses: [{ output: 'done', latencyMs: 200 }] }) }),
  });
  setTimeout(() => cancelRun(cwd, runId), 30);
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.tasks.a.status, 'cancelled');
  assert.equal(result.tasks.b.status, 'cancelled');
  assert.equal(runStatus(cwd, runId).status, 'cancelled');
});

test('worker messages are durable references and tampering is rejected on the next attempt', async () => {
  const rt = runtime({ p: fake('done') });
  const result = await executePlan(cwd, plan([task('a')]), { runtime: rt });
  const message = sendTaskMessage(cwd, result.runId, 'a', 'Please verify the result.', {
    sender: 'reviewer',
  });
  assert.match(message.ref, /^messages\/message-/);
  appendEvent(join(result.dir, 'events.jsonl'), {
    kind: 'task.finished',
    taskId: 'a',
    status: 'failed',
    attempts: 2,
    failure: 'task',
    resultRef: 'a.result.json',
  });
  const next = await executePlan(cwd, null, {
    runtime: rt,
    resume: true,
    runId: result.runId,
    retryFailed: true,
  });
  assert.equal(next.status, 'completed');
  const resultPath = join(result.dir, 'a.result.json');
  assert.ok(readFileSync(resultPath, 'utf8').includes('ok'));
  const event = readEvents(join(result.dir, 'events.jsonl')).find(
    (entry) => entry.kind === 'message.created',
  );
  writeFileSync(
    join(result.dir, event.ref),
    JSON.stringify({ messageId: 'tampered', taskId: 'a', content: 'changed' }),
  );
  appendEvent(join(result.dir, 'events.jsonl'), {
    kind: 'task.finished',
    taskId: 'a',
    status: 'failed',
    attempts: 3,
    failure: 'task',
    resultRef: 'a.result.json',
  });
  assert.rejects(
    executePlan(cwd, null, { runtime: rt, resume: true, runId: result.runId, retryFailed: true }),
    /Changed worker message/,
  );
});

test('leader plans via a cheap tool-free profile and rejects malformed plans', async () => {
  const publicPlan = plan([task('a')]);
  const rt = runtime({ planner: fake(JSON.stringify(publicPlan)), p: fake() });
  const result = await leader(cwd, publicPlan.objective, ['planner'], {
    runtime: rt,
    publicContext: publicPlan.publicContext,
  });
  assert.equal(result.status, 'completed');
  assert.ok(readFileSync(join(result.dir, 'planner.result.json'), 'utf8').includes('responseHash'));
  await assert.rejects(
    leader(cwd, 'objective', ['planner'], { runtime: runtime({ planner: fake('bad') }) }),
    /JSON task plan/,
  );
});

test('planner cannot authorize acceptance or replace host lifecycle policy', async () => {
  for (const field of ['acceptance', 'review', 'decision', 'supervision', 'memory']) {
    const proposed = plan([task('a')]);
    if (['acceptance', 'review'].includes(field)) proposed.tasks[0][field] = {};
    else proposed[field] = {};
    const rt = runtime({ planner: fake(JSON.stringify(proposed)), p: fake() });
    await assert.rejects(
      leader(cwd, proposed.objective, ['planner'], {
        runtime: rt,
        publicContext: proposed.publicContext,
      }),
      /Planner cannot set host policy/,
    );
    assert.equal(rt.fakeOffsets.has('p'), false);
  }
  const proposed = plan([task('a')]);
  const rt = runtime({ planner: fake(JSON.stringify(proposed)), p: fake() });
  const result = await leader(cwd, proposed.objective, ['planner'], {
    runtime: rt,
    publicContext: proposed.publicContext,
    policy: {
      tasks: { a: { acceptance: { command: process.execPath, args: ['-e', 'process.exit(0)'] } } },
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.tasks.a.acceptanceAccepted, true);
  assert.equal(result.budget.account.requests, 2);
});

test('resume completes a pending review without replaying a completed write or bypassing its dependent gate', async () => {
  const rt = runtime({
    p: fake('implementation', { sandbox: 'workspace-write' }),
    d: fake('dependent'),
    r: fake('invalid review', {
      responses: [
        { output: '{invalid}' },
        {
          output: JSON.stringify({
            summary: 'Verified',
            assessments: [{ id: 'spec', status: 'pass', finding: 'Matches' }],
          }),
        },
      ],
    }),
  });
  const input = plan([
    task('subject', {
      mode: 'write',
      review: {
        reviewerProfile: 'r',
        diff: 'Frozen change',
        testEvidence: [{ name: 'test', status: 'passed', summary: 'Host evidence' }],
        criteria: [{ id: 'spec', description: 'Match requirements' }],
      },
    }),
    task('dependent', { profile: 'd', dependsOn: ['subject'] }),
  ]);
  const first = await executePlan(cwd, input, { runtime: rt, allowWrite: true });
  assert.equal(first.tasks.subject.status, 'completed');
  assert.equal(first.tasks.dependent.status, 'blocked');
  const events = join(first.dir, 'events.jsonl');
  appendEvent(events, {
    kind: 'task.reviewed',
    taskId: 'subject',
    status: 'pending',
    approved: false,
  });
  appendEvent(events, { kind: 'task.recovered', taskId: 'dependent', status: 'pending' });
  appendEvent(events, { kind: 'run.status', status: 'running' });
  const resumed = await executePlan(cwd, null, {
    runtime: rt,
    resume: true,
    runId: first.runId,
    allowWrite: true,
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.tasks.subject.reviewApproved, true);
  assert.equal(rt.fakeOffsets.get('p'), 1);
  assert.equal(rt.fakeOffsets.get('r'), 2);
  assert.equal(rt.fakeOffsets.get('d'), 1);
  assert.ok(
    readEvents(events).some(
      (event) => event.kind === 'review.request.reserved' && event.account.requests === 2,
    ),
  );
});

const evidence = [{ id: 'source', text: 'Option A costs 3 units. Option B costs 8 units.' }];
const proposal = (recommendation, reason = 'Use the lower cost', abstention = false) => ({
  recommendation: abstention ? null : recommendation,
  evidence: abstention ? [] : [{ id: 'source', quote: 'Option A costs 3 units.' }],
  uncertainty: 0.2,
  abstention,
  reason,
});
const chair = (recommendation, minorityReasons = []) => ({
  recommendation,
  summary: 'Evidence reviewed',
  minorityReasons,
});

test('roundtable trigger is host-owned, bounded and fails closed on unknown signals', () => {
  assert.equal(assessRoundtableTrigger({ risk: 0.69, ambiguity: 0.49 }).triggered, false);
  assert.deepEqual(assessRoundtableTrigger({ writeFiles: 10 }).reasons, ['write_files']);
  assert.deepEqual(assessRoundtableTrigger({}).reasons, ['signals_unavailable']);
  assert.throws(() => assessRoundtableTrigger({ risk: 2 }), /roundtable risk/);
  assert.throws(() => assessRoundtableTrigger({ typo: 1 }), /unknown field/);
  assert.throws(() => assessRoundtableTrigger({ risk: 0.5 }, { writeBytes: -1 }), /write-byte/);
});

test('automatic roundtable skips provider calls below thresholds and records trigger evidence', async () => {
  const skipped = await autoRoundtable(cwd, 'Choose', ['a', 'b'], {
    signals: { risk: 0.1, ambiguity: 0.1, writeFiles: 1, writeBytes: 10 },
    runtime: {
      dispatch: async () => {
        throw new Error('provider must not run');
      },
    },
  });
  assert.equal(skipped.triggered, false);
  assert.equal(skipped.trigger.reasons.length, 0);

  const rt = runtime({
    a: fake(JSON.stringify(proposal('A'))),
    b: fake(JSON.stringify(proposal('A'))),
    chair: fake(JSON.stringify(chair('A'))),
  });
  const started = await autoRoundtable(cwd, 'Choose automatically', ['a', 'b'], {
    signals: { risk: 0.9 },
    runtime: rt,
    evidence,
    chairProfile: 'chair',
  });
  assert.equal(started.triggered, true);
  assert.deepEqual(started.trigger.reasons, ['risk']);
  assert.deepEqual(decisionStatus(cwd, started.decision.decisionId).trigger, started.trigger);
});

test('leader gates a high-risk plan on its durable roundtable decision and resumes after approval', async () => {
  const rt = runtime({
    p: fake('unused', {
      responses: [
        { output: JSON.stringify(proposal('A')) },
        { output: JSON.stringify(proposal('A')) },
        { output: JSON.stringify(chair('A')) },
        { output: 'implementation' },
      ],
    }),
  });
  const input = plan([task('job', { profile: 'p' })], {
    decision: {
      signals: { risk: 0.9 },
      evidence,
      voters: ['p', 'p'],
      chairProfile: 'p',
      humanGate: true,
    },
  });
  const waiting = await executePlan(cwd, input, { runtime: rt });
  assert.equal(waiting.status, 'awaiting_decision');
  assert.equal(waiting.tasks.job.status, 'pending');
  assert.equal(waiting.decision.outcome, 'decided');
  const decisionId = waiting.decision.decisionId;
  assert.equal(decisionStatus(cwd, decisionId).gate.status, 'pending');
  resolveDecision(cwd, decisionId, 'approve', 'Approved by host test gate');
  const resumed = await executePlan(cwd, null, { runtime: rt, resume: true, runId: waiting.runId });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.tasks.job.status, 'completed');
  assert.equal(rt.fakeOffsets.get('p'), 4);
});

test('blind votes share only the public prefix, preserve minority and produce an auditable gated decision', async () => {
  const rt = runtime({
    a: fake(JSON.stringify(proposal('A'))),
    b: fake(JSON.stringify(proposal('A'))),
    c: fake(JSON.stringify(proposal('B', 'Prefer B for flexibility'))),
    chair: fake(JSON.stringify(chair('A', ['Prefer B for flexibility']))),
  });
  const seen = [];
  const original = rt.attempt.bind(rt);
  rt.attempt = (name, prompt, options) => {
    seen.push({ name, prompt, cwd: options.cwd });
    return original(name, prompt, options);
  };
  const result = await roundtable(cwd, 'Choose', ['a', 'b', 'c'], {
    runtime: rt,
    evidence,
    chairProfile: 'chair',
    humanGate: true,
  });
  assert.equal(result.tally.recommendation, 'A');
  assert.equal(result.minority[0].reason, 'Prefer B for flexibility');
  const prefix = readFileSync(result.contextRef, 'utf8');
  assert.ok(seen.every((s) => s.prompt.startsWith(prefix)));
  assert.equal(seen[0].prompt.includes('Prefer B for flexibility'), false);
  assert.equal(seen[3].prompt.includes('Prefer B for flexibility'), true);
  assert.notEqual(seen[0].cwd, cwd);
  assert.notEqual(seen[0].cwd, seen[1].cwd);
  assert.ok(result.votes.every((v) => v.runtime.responseHash && v.runtime.requestId));
  assert.equal(decisionStatus(cwd, result.decisionId).gate.status, 'pending');
  assert.equal(
    resolveDecision(cwd, result.decisionId, 'approve', 'Reviewed sources').gate.status,
    'approved',
  );
});

test('split, all abstain, malformed and invalid evidence produce deterministic explicit no-decisions', async () => {
  const cases = [
    { a: proposal('A', 'a'), b: proposal('B', 'b'), outcome: 'split', minority: ['a', 'b'] },
    {
      a: proposal(null, 'insufficient', true),
      b: proposal(null, 'unknown', true),
      outcome: 'abstain',
      minority: ['insufficient', 'unknown'],
    },
    {
      a: '{bad}',
      b: { ...proposal('A'), evidence: [{ id: 'missing', quote: 'invented' }] },
      outcome: 'abstain',
      minority: [],
    },
  ];
  for (const item of cases) {
    const rt = runtime({
      a: fake(typeof item.a === 'string' ? item.a : JSON.stringify(item.a)),
      b: fake(JSON.stringify(item.b)),
      chair: fake(JSON.stringify(chair(null, item.minority))),
    });
    const result = await roundtable(cwd, 'Choose', ['a', 'b'], {
      runtime: rt,
      evidence,
      chairProfile: 'chair',
    });
    assert.equal(result.tally.outcome, item.outcome);
    assert.equal(result.tally.recommendation, null);
    assert.ok(result.chair.synthesis);
  }
});

test('weighted votes and invalid chair cannot overwrite host decision', async () => {
  const rt = runtime({
    a: fake(JSON.stringify(proposal('A'))),
    b: fake(JSON.stringify(proposal('B', 'b'))),
    chair: fake(JSON.stringify(chair('B'))),
  });
  const result = await roundtable(cwd, 'Choose', [], {
    runtime: rt,
    voters: [
      { profile: 'a', weight: 3 },
      { profile: 'b', weight: 1 },
    ],
    method: 'weighted',
    evidence,
    chairProfile: 'chair',
  });
  assert.equal(result.tally.recommendation, 'A');
  assert.equal(result.chair.synthesis, null);
  assert.match(result.chair.validationError, /host tally/);
  assert.deepEqual(decisionStatus(cwd, result.decisionId).tally, result.tally);
});

test('no vote is persisted until all voters finish, and the chair sees the collected host tally', async () => {
  const decisionId = 'blind-persistence';
  const secretReason = 'Private vote sentinel before collection';
  const rt = runtime({
    a: fake(JSON.stringify(proposal('A', secretReason))),
    b: fake(JSON.stringify(proposal('A'))),
    chair: fake(JSON.stringify(chair('B'))),
  });
  let releaseSlow, firstFinished;
  const slow = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  const first = new Promise((resolve) => {
    firstFinished = resolve;
  });
  const original = rt.attempt.bind(rt);
  rt.attempt = async (name, prompt, options) => {
    if (name === 'b') await slow;
    if (name === 'chair') {
      const persisted = decisionStatus(cwd, decisionId);
      assert.equal(persisted.status, 'collected');
      assert.equal(persisted.votes.length, 2);
      assert.equal(persisted.tally.recommendation, 'A');
    }
    const result = await original(name, prompt, options);
    if (name === 'a') firstFinished();
    return result;
  };
  const pending = roundtable(cwd, 'Choose', ['a', 'b'], {
    runtime: rt,
    evidence,
    chairProfile: 'chair',
    decisionId,
  });
  try {
    await first;
    const collecting = decisionStatus(cwd, decisionId);
    assert.equal(collecting.status, 'collecting');
    assert.deepEqual(collecting.votes, []);
    assert.equal(collecting.tally, undefined);
    assert.equal(rt.fakeOffsets.has('chair'), false);
    const contents = (dir) =>
      readdirSync(dir, { withFileTypes: true })
        .map((entry) =>
          entry.isDirectory()
            ? contents(join(dir, entry.name))
            : readFileSync(join(dir, entry.name), 'utf8'),
        )
        .join('\n');
    assert.equal(contents(process.env.OMHA_HOME).includes(secretReason), false);
  } finally {
    releaseSlow();
  }
  const result = await pending;
  assert.equal(result.tally.recommendation, 'A');
  assert.equal(result.chair.synthesis, null);
  assert.match(result.chair.validationError, /host tally/);
  assert.equal(decisionStatus(cwd, decisionId).votes[0].proposal.reason, secretReason);
});

test('majority and weighted tallies include abstentions, malformed and failed votes in a strict over-half denominator', async () => {
  for (const method of ['majority', 'weighted']) {
    for (const other of ['abstention', 'malformed', 'invalid', 'failed']) {
      const profiles = {
        a: fake(JSON.stringify(proposal('A'))),
        b:
          other === 'failed'
            ? fake('', { responses: [{ failure: 'auth' }] })
            : fake(
                other === 'malformed'
                  ? '{bad}'
                  : JSON.stringify(
                      other === 'abstention'
                        ? proposal(null, 'unknown', true)
                        : {
                            ...proposal('B'),
                            evidence: [{ id: 'source', quote: 'fabricated quote' }],
                          },
                    ),
              ),
        chair: fake(
          JSON.stringify(
            chair(
              null,
              other === 'abstention' ? ['Use the lower cost', 'unknown'] : ['Use the lower cost'],
            ),
          ),
        ),
      };
      const result = await roundtable(cwd, 'Choose', [], {
        runtime: runtime(profiles),
        evidence,
        chairProfile: 'chair',
        method,
        voters: [
          { profile: 'a', weight: 3 },
          { profile: 'b', weight: 3 },
        ],
      });
      assert.equal(result.tally.totalWeight, method === 'weighted' ? 6 : 2, other);
      assert.equal(result.tally.totals.A, method === 'weighted' ? 3 : 1);
      assert.equal(result.tally.recommendation, null);
      assert.ok(result.chair.synthesis);
    }
  }
});
