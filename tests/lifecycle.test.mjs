import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionScope,
  TaskHandle,
  TASK_OUTCOMES,
  TASK_PHASES,
  normalizeCancellationReason,
} from '../lib/lifecycle.mjs';

test('child scopes inherit the tighter deadline and parent cancellation reason', () => {
  let now = 100;
  const clock = () => now;
  const parent = new ExecutionScope({ id: 'parent', deadlineMs: 100, clock });
  const child = parent.child({ id: 'child', deadlineMs: 200 });

  assert.equal(parent.deadlineAt(), 200);
  assert.equal(child.deadlineAt(), 200);
  assert.equal(child.remainingMs(), 100);

  assert.equal(parent.cancel({ code: 'shutdown', source: 'host' }), true);
  assert.equal(child.cancelled(), true);
  assert.deepEqual(child.reason(), {
    code: 'shutdown',
    source: 'parent',
    message: 'Execution scope shutdown',
  });
  assert.equal(child.signal().reason.code, 'shutdown');
});

test('cancelled parents cannot be bypassed through the public constructor', () => {
  const parent = new ExecutionScope({ id: 'parent' });
  parent.cancel('shutdown');
  assert.throws(() => new ExecutionScope({ id: 'child', parent }), /scope parent is not open/);
});

test('pre-aborted external signals cancel without retaining a listener', () => {
  const controller = new AbortController();
  controller.abort({ code: 'timeout', source: 'deadline', message: 'deadline reached' });
  const scope = new ExecutionScope({ id: 'scope', signal: controller.signal });

  assert.equal(scope.reason().code, 'timeout');
  assert.equal(scope.reason().source, 'external');
  controller.abort('later');
  assert.equal(scope.reason().message, 'deadline reached');
});

test('parent cancellation preserves timeout attribution through nested scopes', () => {
  const parent = new ExecutionScope({ id: 'parent' });
  const child = parent.child({ id: 'child' });
  const grandchild = child.child({ id: 'grandchild' });

  parent.cancel({ code: 'timeout', source: 'deadline' });
  assert.equal(child.reason().code, 'timeout');
  assert.equal(grandchild.reason().code, 'timeout');
  assert.equal(grandchild.reason().source, 'parent');
});

test('invalid fallback cancellation codes are normalized', () => {
  assert.equal(normalizeCancellationReason({}, 'INVALID CODE').code, 'cancelled');
});

test('deadline uses the monotonic clock and wins only once', () => {
  let now = 0;
  const timers = [];
  const scope = new ExecutionScope({
    id: 'deadline',
    deadlineMs: 10,
    clock: () => now,
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout: () => {},
  });

  assert.equal(timers[0].delay, 10);
  now = 11;
  timers[0].callback();
  assert.equal(scope.cancelled(), true);
  assert.equal(scope.reason().code, 'timeout');
  assert.equal(scope.cancel({ code: 'shutdown' }), false);
  assert.equal(scope.reason().code, 'timeout');
});

test('close rejects new children without cancelling existing work', () => {
  const scope = new ExecutionScope({ id: 'root' });
  const child = scope.child({ id: 'child' });

  assert.equal(scope.close(), true);
  assert.equal(scope.closed(), true);
  assert.equal(child.open(), true);
  assert.throws(() => scope.child({ id: 'late' }), /scope is closed/);
});

test('closing a scope keeps its deadline active for existing work', () => {
  let now = 0;
  const timers = [];
  const scope = new ExecutionScope({
    id: 'root',
    deadlineMs: 10,
    clock: () => now,
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => {},
  });
  const task = new TaskHandle('task-a', scope);

  scope.close();
  now = 11;
  timers[0]();
  assert.equal(scope.cancelled(), true);
  assert.equal(task.cancelReason().code, 'timeout');
});

test('task handles expose ordered phases and a frozen terminal completion', () => {
  const scope = new ExecutionScope({ id: 'run' });
  const task = new TaskHandle('task-a', scope, { kind: 'provider' });

  assert.deepEqual(TASK_PHASES, [
    'prepared',
    'admitted',
    'queued',
    'running',
    'cancel_requested',
    'exited',
    'skipped',
    'settled',
  ]);
  assert.deepEqual(TASK_OUTCOMES, [
    'success',
    'user_failure',
    'submission_failure',
    'cancelled',
    'fail_fast',
    'timeout',
    'interrupted',
  ]);

  task.transition('admitted').transition('queued').transition('running').exit();
  const completion = task.settle('success');
  assert.equal(task.phase(), 'settled');
  assert.equal(completion.outcome, 'success');
  assert.equal(Object.isFrozen(completion), true);
  assert.equal(task.requestCancel({ code: 'shutdown' }), false);
  assert.throws(() => task.transition('running'), /cannot transition/);
});

test('scope cancellation marks an unstarted task and preserves its attribution', () => {
  const scope = new ExecutionScope({ id: 'run' });
  const task = new TaskHandle('task-a', scope);

  scope.cancel({ code: 'timeout', source: 'deadline' });
  assert.equal(task.phase(), 'cancel_requested');
  assert.equal(task.cancelReason().code, 'timeout');

  const completion = task.skip('timeout');
  assert.equal(completion.outcome, 'timeout');
  assert.equal(completion.startedAt, null);
  assert.equal(completion.cancelReason.source, 'deadline');
});

test('task lifecycle rejects settling before body exit', () => {
  const scope = new ExecutionScope({ id: 'run' });
  const task = new TaskHandle('task-a', scope);

  assert.throws(() => task.settle('success'), /cannot settle/);
  task.transition('admitted').transition('running').exit();
  assert.equal(task.settle('user_failure', 'provider failed').failure, 'provider failed');
});
