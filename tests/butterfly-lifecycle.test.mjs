import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime } from '../lib/runner.mjs';
import { executePlan, runStatus } from '../lib/orchestrator.mjs';
import { bindHostPolicy, validatePlan } from '../lib/plans.mjs';
import { appendEvent, readEvents } from '../lib/storage.mjs';
import { processButterfly, validateButterfly, detectDrift } from '../lib/butterfly.mjs';
import { handoff } from '../lib/terminal.mjs';

const root = temp('omha-butterfly-lifecycle-');
process.env.OMHA_HOME = join(root, 'state');

function fixture(contents = ['bad', 'good'], butterfly) {
  const cwd = temp('omha-butterfly-worktree-');
  const file = join(cwd, 'result.txt');
  writeFileSync(file, 'original');
  const rt = createRuntime(
    config({ worker: fake('produced candidate', { sandbox: 'workspace-write' }) }),
    {
      persistent: false,
    },
  );
  const attempt = rt.attempt.bind(rt);
  let offset = 0;
  rt.attempt = (...args) => {
    writeFileSync(file, contents[Math.min(offset++, contents.length - 1)]);
    return attempt(...args);
  };
  const plan = {
    version: 1,
    objective: 'Produce the required result and preserve its constraints.',
    publicContext: 'Keep the original task scope.',
    ...(butterfly ? { butterfly } : {}),
    tasks: [
      {
        id: 'build',
        role: 'writer',
        prompt: 'Produce result.txt containing good.',
        profile: 'worker',
        mode: 'write',
        timeoutMs: 10000,
        acceptance: {
          command: process.execPath,
          args: [
            '-e',
            "process.exit(require('node:fs').readFileSync('result.txt','utf8') === 'good' ? 0 : 1)",
          ],
        },
      },
    ],
  };
  const start = () => executePlan(cwd, plan, { runtime: rt, allowWrite: true });
  const resume = (runId, extra = {}) =>
    executePlan(cwd, null, {
      runtime: rt,
      allowWrite: true,
      resume: true,
      runId,
      retryFailed: true,
      retryInterruptedWrites: true,
      ...extra,
    });
  const events = (status) => readEvents(join(status.dir, 'events.jsonl'), process.env.OMHA_HOME);
  return { cwd, file, rt, plan, start, resume, events };
}

test('automatic lifecycle collects host evidence, detects actual rework and hands off without history JSON or extra provider calls', async () => {
  const f = fixture();
  f.plan.publicContext += '\u4e2d'.repeat(40000);
  const first = await f.start();
  assert.equal(first.status, 'failed');
  assert.equal(first.metrics.butterflyDetections, 0);
  assert.equal(f.events(first).find((e) => e.kind === 'butterfly.observed').valid, true);
  assert.equal(
    f.events(first).find((e) => e.kind === 'butterfly.observed').acceptance.args,
    undefined,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(first.dir, 'plan.json'), 'utf8')).plan.butterfly,
    validateButterfly(),
  );
  const blocked = await f.resume(first.runId, { retryInterruptedWrites: false });
  assert.equal(blocked.tasks.build.status, 'interrupted');
  assert.equal(f.rt.fakeOffsets.get('worker'), 1);
  const second = await f.resume(first.runId);
  assert.equal(second.status, 'completed');
  assert.equal(second.metrics.butterflyDetections, 1);
  assert.equal(second.metrics.butterflyHandoffs, 1);
  assert.equal(second.metrics.butterflyUncertain, 0);
  assert.equal(f.rt.fakeOffsets.get('worker'), 2);
  const report = JSON.parse(readFileSync(second.tasks.build.butterfly.file, 'utf8'));
  assert.equal(report.status, 'supported');
  assert.equal(report.conversationRewound, false);
  assert.deepEqual(report.origin, { runId: first.runId, taskId: 'build' });
  assert.equal(report.decisions[0].rewindBoundary.actionId, 'action-1');
  assert.match(report.decisions[0].updatedPrompt, /original task scope/);
  assert.ok(report.decisions[0].keep.join('').includes(f.plan.publicContext));
  const handed = f.events(second).find((e) => e.kind === 'butterfly.handed_off');
  assert.equal(handed.backend, 'file');
  assert.equal(handed.state, 'awaiting');
  const resumed = await f.resume(first.runId);
  assert.equal(resumed.metrics.butterflyDetections, 1);
  assert.equal(resumed.metrics.butterflyHandoffs, 1);
  assert.equal(f.rt.fakeOffsets.get('worker'), 2);
});

test('unchanged rework, external changes, successful evolution and invalid host checks do not trigger', async () => {
  for (const scenario of [
    'identical',
    'no-production',
    'external',
    'accepted',
    'harness',
    'provider',
    'cancelled',
  ]) {
    const f = fixture(
      scenario === 'no-production'
        ? ['original', 'good']
        : scenario === 'identical'
          ? ['bad', 'bad']
          : scenario === 'accepted'
            ? ['good', 'good\n']
            : undefined,
    );
    if (scenario === 'provider')
      f.rt.config.profiles.worker.responses = [{ output: 'failed', code: 1 }, { output: 'done' }];
    if (scenario === 'cancelled')
      f.plan.tasks[0].acceptance.args = ['-e', 'setTimeout(() => {}, 5000)'];
    if (scenario === 'cancelled') f.plan.tasks[0].acceptance.timeoutMs = 20;
    const first = await f.start();
    if (scenario === 'external') writeFileSync(f.file, 'unattributed edit');
    if (scenario === 'harness') {
      const savedFile = join(first.dir, 'plan.json');
      const saved = JSON.parse(readFileSync(savedFile, 'utf8'));
      saved.acceptancePolicies.build.files[0].hash = '0'.repeat(64);
      writeFileSync(savedFile, JSON.stringify(saved));
      await assert.rejects(f.resume(first.runId), /Immutable acceptance policy/);
      continue;
    }
    if (scenario === 'accepted')
      appendEvent(
        join(first.dir, 'events.jsonl'),
        { kind: 'task.recovered', taskId: 'build', status: 'interrupted' },
        process.env.OMHA_HOME,
      );
    const second = await f.resume(first.runId);
    assert.equal(second.metrics.butterflyDetections, 0, scenario);
    assert.equal(second.metrics.butterflyHandoffs, 0, scenario);
  }
});

test('automatic policy bounds observations and handoff attempts across resumed executions', async () => {
  const f = fixture(['bad-a', 'bad-b', 'bad-c', 'bad-d'], { maxHandoffs: 1, maxObservations: 3 });
  let status = await f.start();
  for (let n = 0; n < 3; n += 1) status = await f.resume(status.runId);
  assert.equal(status.metrics.butterflyDetections, 2);
  assert.equal(status.metrics.butterflyHandoffs, 1);
  assert.equal(f.events(status).filter((e) => e.kind === 'butterfly.observed').length, 3);
  assert.equal(f.events(status).filter((e) => e.kind === 'butterfly.limit').length, 1);
});

test('acceptance of unchanged content ends a failed-version chain before ordinary evolution', async () => {
  const f = fixture(['bad', 'bad', 'good']);
  const flag = join(root, 'acceptance-flag');
  writeFileSync(flag, 'fail');
  f.plan.tasks[0].acceptance.args = [
    '-e',
    `process.exit(require('node:fs').readFileSync(${JSON.stringify(flag)},'utf8') === 'pass' ? 0 : 1)`,
  ];
  const first = await f.start();
  writeFileSync(flag, 'pass');
  const second = await f.resume(first.runId);
  assert.equal(second.status, 'completed');
  appendEvent(
    join(second.dir, 'events.jsonl'),
    { kind: 'task.recovered', taskId: 'build', status: 'interrupted' },
    process.env.OMHA_HOME,
  );
  const third = await f.resume(first.runId);
  assert.equal(third.status, 'completed');
  assert.equal(third.metrics.butterflyDetections, 0);
});

test('aborted and failed automatic handoffs preserve task outcomes and do not retry', async () => {
  const f = fixture(undefined, { handoff: false });
  const first = await f.start();
  const second = await f.resume(first.runId);
  const saved = JSON.parse(readFileSync(join(second.dir, 'plan.json'), 'utf8'));
  const paths = { root: process.env.OMHA_HOME, events: join(second.dir, 'events.jsonl') };
  const input = {
    plan: { ...saved.plan, butterfly: {} },
    paths,
    runId: second.runId,
    acceptancePolicies: saved.acceptancePolicies,
    emit: (event) => appendEvent(paths.events, event, paths.root),
  };
  const controller = new AbortController();
  controller.abort();
  await processButterfly(f.cwd, { ...input, signal: controller.signal });
  assert.equal(
    f.events(second).some((e) => e.kind === 'butterfly.handoff_requested'),
    false,
  );
  const handoffId = `handoff-${second.tasks.build.butterfly.analysisId}`;
  const existing = await handoff(f.cwd, 'Preserve the existing target', {
    id: handoffId,
    backend: 'file',
  });
  await processButterfly(f.cwd, input);
  await processButterfly(f.cwd, input);
  const status = runStatus(f.cwd, second.runId);
  assert.equal(status.status, 'completed');
  assert.equal(status.metrics.butterflyHandoffs, 0);
  assert.equal(status.metrics.butterflyUncertain, 0);
  assert.equal(f.events(status).filter((e) => e.kind === 'butterfly.handoff_failed').length, 1);
  assert.equal(readFileSync(existing.promptFile, 'utf8'), 'Preserve the existing target');
});

test('a crash after a durable handoff claim leaves visible uncertainty and never repeats the action', async () => {
  const f = fixture(undefined, { handoff: false });
  const first = await f.start();
  const second = await f.resume(first.runId);
  const paths = { root: process.env.OMHA_HOME, events: join(second.dir, 'events.jsonl') };
  const saved = JSON.parse(readFileSync(join(second.dir, 'plan.json'), 'utf8'));
  const input = {
    plan: { ...saved.plan, butterfly: {} },
    paths,
    runId: second.runId,
    acceptancePolicies: saved.acceptancePolicies,
  };
  await assert.rejects(
    processButterfly(f.cwd, {
      ...input,
      emit: (event) => {
        appendEvent(paths.events, event, paths.root);
        if (event.kind === 'butterfly.handoff_requested') throw new Error('host crash');
      },
    }),
    /host crash/,
  );
  await processButterfly(f.cwd, {
    ...input,
    emit: (event) => appendEvent(paths.events, event, paths.root),
  });
  const status = runStatus(f.cwd, second.runId);
  assert.equal(status.metrics.butterflyUncertain, 1);
  assert.equal(status.metrics.butterflyHandoffs, 0);
  const requested = f.events(status).filter((e) => e.kind === 'butterfly.handoff_requested');
  assert.equal(requested.length, 1);
  assert.equal(existsSync(join(paths.root, 'handoffs', requested[0].handoffId)), false);
});

test('butterfly policy remains host-owned, validated and optional for readonly or disabled work', async () => {
  const f = fixture(undefined, { enabled: false });
  assert.throws(
    () => bindHostPolicy({ ...f.plan, butterfly: {} }),
    /Planner cannot set host policy butterfly/,
  );
  const { butterfly, ...generated } = f.plan;
  const acceptance = generated.tasks[0].acceptance;
  generated.tasks = generated.tasks.map(({ acceptance, ...task }) => task);
  assert.equal(
    validatePlan(
      bindHostPolicy(generated, {
        butterfly: { handoff: false },
        tasks: { build: { acceptance } },
      }),
      f.rt.config.profiles,
      { allowWrite: true },
    ).butterfly.handoff,
    false,
  );
  for (const policy of [
    { maxHandoffs: 4 },
    { maxObservations: 1001 },
    { enabled: 'yes' },
    { backend: 'shell' },
    { unknown: true },
  ])
    assert.throws(() => validateButterfly(policy));
  const first = await f.start();
  const second = await f.resume(first.runId);
  assert.equal(second.metrics.butterflyDetections, 0);
  assert.equal(
    f.events(second).some((e) => e.kind.startsWith('butterfly.')),
    false,
  );
});

test('host feedback must carry original policy and artifact anchors', () => {
  const reliable = JSON.parse(
    readFileSync(new URL('./fixtures/butterfly-reliable.json', import.meta.url), 'utf8'),
  );
  const [requirement, feedback] = [reliable.transcript[1], reliable.transcript[3]];
  requirement.actor = feedback.actor = 'host';
  requirement.authority = { source: 'acceptance', policyHash: 'a'.repeat(64) };
  feedback.authority = {
    ...requirement.authority,
    artifactHash: reliable.transcript[2].hash,
    exitCode: 1,
  };
  assert.equal(detectDrift(reliable).status, 'supported');
  feedback.authority.policyHash = 'b'.repeat(64);
  assert.equal(detectDrift(reliable).status, 'no_op');
  feedback.authority.policyHash = requirement.authority.policyHash;
  feedback.authority.artifactHash = 'c'.repeat(64);
  assert.equal(detectDrift(reliable).status, 'no_op');
  delete feedback.authority;
  assert.throws(() => detectDrift(reliable), /host authority/);
});

test('oversized lifecycle history is an observable no-op without repeating skips or changing task outcomes', async () => {
  const f = fixture(undefined, { handoff: false });
  const first = await f.start();
  const second = await f.resume(first.runId);
  const saved = JSON.parse(readFileSync(join(second.dir, 'plan.json'), 'utf8'));
  saved.plan.tasks[0].acceptance.args.push('a'.repeat(100001));
  const paths = { root: process.env.OMHA_HOME, events: join(second.dir, 'events.jsonl') };
  const input = {
    plan: saved.plan,
    paths,
    runId: second.runId,
    acceptancePolicies: saved.acceptancePolicies,
    emit: (event) => appendEvent(paths.events, event, paths.root),
  };
  await processButterfly(f.cwd, input);
  await processButterfly(f.cwd, input);
  assert.equal(f.events(second).filter((event) => event.kind === 'butterfly.skipped').length, 1);
  assert.equal(runStatus(f.cwd, second.runId).status, 'completed');
});
