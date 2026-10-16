import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime, delay } from '../lib/runner.mjs';
import { executePlan, validatePlan } from '../lib/orchestrator.mjs';
import { readEvents } from '../lib/storage.mjs';

const root = temp('omha-supervision-');
process.env.OMHA_HOME = join(root, 'state');
const cwd = join(root, 'project');
mkdirSync(cwd);
const supervision = { stallMs: 1000, inputWaitMs: 500, maxTakeovers: 1 };
const task = (extra = {}) => ({
  id: 'job',
  role: 'inspect',
  prompt: 'Inspect',
  profile: 'p',
  mode: 'readonly',
  timeoutMs: 10000,
  ...extra,
});
const plan = (tasks, extra = {}) => ({
  version: 1,
  objective: 'Inspect',
  tasks,
  supervision,
  ...extra,
});
const stream = (code, extra = {}) => ({
  adapter: 'command',
  command: process.execPath,
  model: 'local',
  sandbox: 'external',
  sandboxCommand: '/usr/bin/env',
  sandboxArgs: ['{command}', '{args}'],
  outputFormat: 'jsonl',
  args: ['-e', code],
  retry: { maxRetries: 0 },
  ...extra,
});
const waiting = (type = 'progress', extra = {}) =>
  stream(
    `process.stdout.write(JSON.stringify({type:${JSON.stringify(type)}})+'\\n');setInterval(()=>{},1000)`,
    extra,
  );
const resultOf = (status) => JSON.parse(readFileSync(join(status.dir, 'job.result.json'), 'utf8'));
const eventsOf = (status) => readEvents(join(status.dir, 'events.jsonl'), process.env.OMHA_HOME);

test('supervision validates bounded host policy before launching providers', () => {
  const rt = createRuntime(config({ p: fake() }), { persistent: false });
  for (const invalid of [
    { stallMs: -1 },
    { maxTakeovers: 4 },
    { inputWaitMs: 1.5 },
    { unknown: 1 },
  ])
    assert.throws(() => validatePlan(plan([task()], { supervision: invalid }), rt.config.profiles));
});

test('live progress refreshes the watchdog and completes before process cleanup', async () => {
  const next = join(root, 'next');
  const done = join(root, 'done');
  const code = `const fs=require('node:fs');const emit=(e)=>process.stdout.write(JSON.stringify({status:'success',output:'progress',...e})+'\\n');emit({type:'progress'});const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(next)})){emit({type:'heartbeat'});fs.unlinkSync(${JSON.stringify(next)})}if(fs.existsSync(${JSON.stringify(done)})){clearInterval(poll);emit({type:'result',status:'success',output:'verified output'})}},5)`;
  let clock = 0;
  const rt = createRuntime(config({ p: stream(code) }), { persistent: false, clock: () => clock });
  const seen = [];
  const status = await executePlan(cwd, plan([task()]), {
    runtime: rt,
    onProviderEvent(value) {
      assert.equal(value.realtime, true);
      seen.push(value.event.type);
      if (value.event.type === 'progress') {
        clock = 900;
        writeFileSync(next, 'continue');
      } else if (value.event.type === 'heartbeat') {
        clock = 1500;
        writeFileSync(done, 'finish');
      }
    },
  });
  assert.equal(status.status, 'completed', JSON.stringify(resultOf(status)));
  assert.deepEqual(seen, ['progress', 'heartbeat', 'result']);
  assert.equal(resultOf(status).stdout, 'verified output');
  assert.equal(
    eventsOf(status).some((event) => event.kind === 'task.escalated'),
    false,
  );
});

test('stalled readonly requests notify and take over only configured fallbacks with retained budget', async () => {
  let clock = 0;
  const rt = createRuntime(
    config({ p: waiting('progress', { fallback: ['q'] }), q: fake('recovered') }),
    {
      persistent: false,
      clock: () => clock,
    },
  );
  const notifications = [];
  const status = await executePlan(cwd, plan([task()]), {
    runtime: rt,
    onProviderEvent: () => {
      clock += 1000;
    },
    onNotification: (value) => notifications.push(value),
  });
  assert.equal(status.status, 'completed');
  const result = resultOf(status);
  assert.equal(result.requestedProfile, 'p');
  assert.equal(result.servedProfile, 'q');
  assert.equal(result.takeovers, 1);
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.failure),
    ['stalled', null],
  );
  assert.equal(result.attempts[0].stream.delivered, 1);
  assert.equal(result.attempts[0].eventCount, 1);
  assert.equal(status.budget.account.requests, 2);
  assert.equal(notifications[0].reason, 'stalled');
  assert.equal(eventsOf(status).filter((event) => event.kind === 'task.takeover').length, 1);
});

test('input wait uses its own deadline, preserves evidence, and stops at takeover limit', async () => {
  let clock = 0;
  const rt = createRuntime(
    config({
      p: waiting('input_required', { fallback: ['q'] }),
      q: waiting('input_required', { fallback: ['r'] }),
      r: fake('must not execute'),
    }),
    { persistent: false, clock: () => clock },
  );
  const status = await executePlan(cwd, plan([task()]), {
    runtime: rt,
    onProviderEvent: () => {
      clock += 500;
    },
  });
  assert.equal(status.status, 'failed');
  const result = resultOf(status);
  assert.equal(result.failure, 'input_wait');
  assert.equal(result.takeovers, 1);
  assert.equal(result.attempts.length, 2);
  assert.ok(result.attempts.every((attempt) => attempt.inputWait));
  assert.equal(rt.fakeOffsets.has('r'), false);
  assert.equal(eventsOf(status).filter((event) => event.kind === 'task.input_wait').length, 2);
});

test('uncertain supervised writes become interrupted and never replay on retry-failed', async () => {
  let clock = 0;
  const rt = createRuntime(
    config({
      p: waiting('progress', { sandbox: 'workspace-write', fallback: ['q'] }),
      q: fake('must not execute', { sandbox: 'workspace-write' }),
    }),
    { persistent: false, clock: () => clock },
  );
  const status = await executePlan(cwd, plan([task({ mode: 'write' })]), {
    runtime: rt,
    allowWrite: true,
    onProviderEvent: () => {
      clock += 1000;
    },
  });
  assert.equal(status.status, 'interrupted');
  assert.equal(status.tasks.job.status, 'interrupted');
  assert.equal(resultOf(status).attempts.length, 1);
  assert.equal(rt.fakeOffsets.has('q'), false);
  const resumed = await executePlan(cwd, null, {
    runtime: rt,
    runId: status.runId,
    resume: true,
    retryFailed: true,
    allowWrite: true,
  });
  assert.equal(resumed.tasks.job.status, 'interrupted');
  assert.equal(resumed.budget.account.requests, 1);
});

test('host notification failures and caller cancellation cannot trigger takeover', async () => {
  for (const cancel of [false, true]) {
    let clock = 0;
    const controller = new AbortController();
    const rt = createRuntime(config({ p: waiting('progress', { fallback: ['q'] }), q: fake() }), {
      persistent: false,
      clock: () => clock,
    });
    const status = await executePlan(cwd, plan([task()]), {
      runtime: rt,
      signal: controller.signal,
      onProviderEvent: () => {
        if (cancel) controller.abort();
        else clock += 1000;
      },
      onNotification: async () => {
        throw new Error('Offline notification failure');
      },
    });
    assert.equal(status.status, cancel ? 'cancelled' : 'failed');
    assert.equal(resultOf(status).failure, cancel ? 'cancellation' : 'task');
    assert.equal(rt.fakeOffsets.has('q'), false);
  }
});

test('host acceptance keeps the worktree lease and remains cancellable', async () => {
  const marker = join(root, 'acceptance-ready');
  const controller = new AbortController();
  const rt = createRuntime(config({ p: fake('executed', { sandbox: 'workspace-write' }) }), {
    persistent: false,
  });
  const pending = executePlan(
    cwd,
    plan([
      task({
        mode: 'write',
        acceptance: {
          command: process.execPath,
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`,
          ],
        },
      }),
    ]),
    { runtime: rt, allowWrite: true, signal: controller.signal },
  );
  const deadline = Date.now() + 10000;
  while (!existsSync(marker) && Date.now() < deadline) await delay(10);
  let next;
  try {
    assert.ok(existsSync(marker), 'acceptance process became ready');
    next = executePlan(cwd, plan([task({ mode: 'write' })]), { runtime: rt, allowWrite: true });
    await delay(50);
    assert.equal(rt.fakeOffsets.get('p'), 1, 'another writer cannot run during acceptance');
  } finally {
    controller.abort();
    await pending;
  }
  const first = await pending;
  assert.equal(first.status, 'cancelled');
  assert.equal(resultOf(first).executionOk, true);
  assert.equal(resultOf(first).acceptance.cancelled, true);
  assert.equal((await next).status, 'completed');
});
