// Offline coverage for the advisory coordinator: proposals are validated by
// the host, invalid entries are dropped with recorded reasons, and `abort`
// only notifies. All provider calls use the fake adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime } from '../lib/runner.mjs';
import { coordinatorPolicy, leader } from '../lib/orchestrator.mjs';
import { projectIdentity } from '../lib/core.mjs';
import { readEvents } from '../lib/storage.mjs';

const root = temp('omha-coord-');
process.env.OMHA_HOME = join(root, 'state');
const cwd = join(root, 'project');
mkdirSync(cwd);

const task = (id, extra = {}) => ({
  id,
  role: 'worker',
  prompt: `Do ${id}`,
  profile: 'p',
  mode: 'readonly',
  ...extra,
});
const plan = (tasks) => ({
  version: 1,
  objective: 'Build it',
  publicContext: 'Immutable facts',
  parallelism: 2,
  tasks,
});
const profiles = (coordResponse) => ({
  p: fake('worker done'),
  coord: fake(typeof coordResponse === 'string' ? coordResponse : JSON.stringify(coordResponse)),
});
const eventsFor = (runId) =>
  readEvents(
    join(
      process.env.OMHA_HOME,
      'projects',
      projectIdentity(cwd).projectId,
      'runs',
      runId,
      'events.jsonl',
    ),
  );
const run = async (tasks, coordResponse, coordinator, options = {}) => {
  const notifications = [];
  const status = await leader(cwd, 'Build it', null, {
    plan: plan(tasks),
    runtime: createRuntime(config(profiles(coordResponse)), { persistent: false }),
    coordinator,
    onNotification: (notification) => notifications.push(notification),
    ...options,
  });
  return { status, notifications, events: eventsFor(status.runId) };
};

test('coordinator policy validation fails closed', () => {
  assert.equal(coordinatorPolicy(undefined), null);
  assert.equal(coordinatorPolicy({ profile: 'coord' }).maxConsults, 8);
  assert.throws(() => coordinatorPolicy({ profile: 'coord', extra: 1 }), /unknown field/);
  assert.throws(() => coordinatorPolicy({ profile: 'not an id' }), /simple identifier/);
  assert.throws(() => coordinatorPolicy({ profile: 'coord', maxConsults: 99 }), /maxConsults/);
});

test('a valid proposal reorders launches and delivers data-only messages', async () => {
  const { status, events } = await run(
    [task('t1'), task('t2')],
    {
      order: ['t2', 't1'],
      messages: [{ taskId: 't2', content: 'Focus on the parser' }],
      notes: 'start with the parser',
    },
    { profile: 'coord' },
  );
  assert.equal(status.status, 'completed');
  const consulted = events.filter((event) => event.kind === 'coordinator.consulted');
  assert.equal(consulted.length, 1);
  assert.equal(consulted[0].messages, 1);
  assert.deepEqual(consulted[0].order, ['t2', 't1']);
  assert.equal(consulted[0].ok, true);
  assert.equal(consulted[0].profile, 'coord');
  assert.deepEqual(consulted[0].dropped, []);
  assert.equal(
    events.some((event) => event.kind === 'message.created' && event.taskId === 't2'),
    true,
  );
});

test('invalid proposal entries are dropped with reasons and abort only notifies', async () => {
  const { status, notifications, events } = await run(
    [task('t1'), task('t2')],
    {
      order: ['t1', 'ghost'],
      messages: [
        { taskId: 't1', content: 'check imports' },
        { taskId: 'ghost', content: 'nothing' },
      ],
      abort: true,
      notes: 'risky path ahead',
    },
    { profile: 'coord' },
  );
  assert.equal(status.status, 'completed', 'an abort proposal must not cancel the run');
  const consulted = events.filter((event) => event.kind === 'coordinator.consulted');
  assert.equal(consulted.length, 1);
  assert.deepEqual(consulted[0].order, ['t1']);
  assert.equal(consulted[0].messages, 1);
  assert.equal(consulted[0].abort, true);
  const dropped = consulted[0].dropped.map((entry) => entry.taskId ?? entry.field);
  assert.deepEqual(dropped, ['ghost', 'ghost']);
  assert.equal(
    events.some((event) => event.kind === 'coordinator.abort_requested'),
    true,
  );
  assert.deepEqual(
    notifications.map((notification) => notification.kind),
    ['coordinator.abort_requested'],
  );
});

test('maxConsults zero and malformed proposals leave the run untouched', async () => {
  const skipped = await run([task('t1')], { order: ['t1'] }, { profile: 'coord', maxConsults: 0 });
  assert.equal(skipped.status.status, 'completed');
  assert.equal(
    skipped.events.some((event) => event.kind === 'coordinator.consulted'),
    false,
  );

  const malformed = await run([task('t1')], 'not json at all', { profile: 'coord' });
  assert.equal(malformed.status.status, 'completed');
  const consulted = malformed.events.filter((event) => event.kind === 'coordinator.consulted');
  assert.equal(consulted.length, 1);
  assert.equal(consulted[0].ok, true);
  assert.deepEqual(consulted[0].order, []);
  assert.deepEqual(
    consulted[0].dropped.map((entry) => entry.field),
    ['proposal'],
  );

  const unknownProfile = await run([task('t1')], { order: ['t1'] }, { profile: 'ghost' });
  assert.equal(unknownProfile.status.status, 'completed');
  const failed = unknownProfile.events.filter((event) => event.kind === 'coordinator.consulted');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].ok, false);
});
