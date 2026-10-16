import { isAbsolute } from 'node:path';
import { check, choice, id, keys, number, text } from './validation.mjs';
import { assertNoSecrets } from './security.mjs';
import { validateRetry } from './profiles.mjs';
import { invocation } from './adapters.mjs';
import { validateSupervision } from './runner.mjs';
import { validateRunMemory } from './memory.mjs';

export function validatePlan(input, profiles, options = {}) {
  keys(
    input,
    [
      'version',
      'objective',
      'publicContext',
      'parallelism',
      'tasks',
      'decision',
      'supervision',
      'memory',
    ],
    'plan',
  );
  check(input.version === 1, 'Plan version must be 1');
  text(input.objective, 'objective', 100000);
  check(typeof (input.publicContext || '') === 'string', 'publicContext must be text');
  check(
    Buffer.byteLength(input.publicContext || '') <= 1000000 &&
      !(input.publicContext || '').includes('\0'),
    'Invalid publicContext',
  );
  const parallelism = number(input.parallelism ?? 2, 'parallelism', 1, 16);
  check(
    Array.isArray(input.tasks) && input.tasks.length > 0 && input.tasks.length <= 256,
    'Plan requires 1-256 tasks',
  );
  const seen = new Set();
  const tasks = input.tasks.map((inputTask) => {
    keys(
      inputTask,
      [
        'id',
        'role',
        'prompt',
        'dependsOn',
        'profile',
        'model',
        'effort',
        'timeoutMs',
        'retry',
        'fallback',
        'mode',
        'acceptance',
        'review',
      ],
      'task',
    );
    const task = { dependsOn: [], fallback: [], mode: 'readonly', timeoutMs: 120000, ...inputTask };
    id(task.id, 'task id');
    check(!seen.has(task.id), `Duplicate task id ${task.id}`);
    seen.add(task.id);
    text(task.role, 'task role', 128);
    text(task.prompt, 'task prompt', 100000);
    id(task.profile, 'task profile');
    check(Object.hasOwn(profiles, task.profile), `Unknown task profile ${task.profile}`);
    check(
      Array.isArray(task.dependsOn) && new Set(task.dependsOn).size === task.dependsOn.length,
      'Task dependencies must be a unique array',
    );
    task.dependsOn.forEach((x) => id(x, 'dependency'));
    check(
      Array.isArray(task.fallback) && new Set(task.fallback).size === task.fallback.length,
      'Task fallback must be a unique array',
    );
    task.fallback.forEach((x) => check(Object.hasOwn(profiles, x), `Unknown task fallback ${x}`));
    choice(task.mode, ['readonly', 'write'], 'task mode');
    check(
      task.mode !== 'write' || options.allowWrite === true,
      'Write tasks require allowWrite on the host',
    );
    number(task.timeoutMs, 'task timeoutMs', 10, 86400000);
    if (task.model !== undefined) text(task.model, 'task model', 256);
    if (task.effort !== undefined)
      choice(task.effort, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'task effort');
    task.retry = validateRetry(task.retry || profiles[task.profile].retry);
    if (task.acceptance !== undefined) {
      keys(task.acceptance, ['command', 'args', 'timeoutMs', 'maxOutputBytes'], 'task acceptance');
      check(isAbsolute(task.acceptance.command), 'Task acceptance command must be absolute');
      text(task.acceptance.command, 'task acceptance command', 4096);
      check(
        Array.isArray(task.acceptance.args) &&
          task.acceptance.args.every((arg) => typeof arg === 'string' && !arg.includes('\0')),
        'Task acceptance args must be a string array',
      );
      number(
        task.acceptance.timeoutMs ?? task.timeoutMs,
        'acceptance timeoutMs',
        10,
        task.timeoutMs,
      );
      number(task.acceptance.maxOutputBytes ?? 1048576, 'acceptance maxOutputBytes', 256, 16777216);
      task.acceptance = {
        timeoutMs: task.timeoutMs,
        maxOutputBytes: 1048576,
        ...task.acceptance,
      };
    }
    if (task.review !== undefined) {
      keys(task.review, ['reviewerProfile', 'diff', 'testEvidence', 'criteria'], 'task review');
      id(task.review.reviewerProfile, 'reviewer profile');
      check(Object.hasOwn(profiles, task.review.reviewerProfile), 'Unknown reviewer profile');
      text(task.review.diff, 'review diff', 1000000);
      check(
        Array.isArray(task.review.testEvidence) &&
          task.review.testEvidence.length > 0 &&
          task.review.testEvidence.length <= 64,
        'Review requires 1-64 test evidence entries',
      );
      check(
        Array.isArray(task.review.criteria) &&
          task.review.criteria.length > 0 &&
          task.review.criteria.length <= 64,
        'Review requires 1-64 criteria',
      );
      task.review.testEvidence.forEach((evidence) => {
        keys(evidence, ['name', 'status', 'summary'], 'test evidence');
        id(evidence.name, 'test evidence name');
        choice(evidence.status, ['passed', 'failed', 'unknown'], 'test evidence status');
        text(evidence.summary, 'test evidence summary', 10000);
      });
      task.review.criteria.forEach((criterion) => {
        keys(criterion, ['id', 'description'], 'review criterion');
        id(criterion.id, 'review criterion id');
        text(criterion.description, 'review criterion description', 10000);
      });
      check(
        new Set(task.review.criteria.map((criterion) => criterion.id)).size ===
          task.review.criteria.length,
        'Duplicate review criterion id',
      );
      assertNoSecrets(task.review);
    }
    for (const name of [task.profile, ...task.fallback])
      invocation(profiles[name], 'validation', {
        mode: task.mode,
        model: task.model,
        effort: task.effort,
      });
    return task;
  });
  for (const task of tasks)
    for (const dep of task.dependsOn)
      check(seen.has(dep) && dep !== task.id, `Invalid dependency ${dep} on ${task.id}`);
  const visited = new Set();
  const visit = (taskId, stack = []) => {
    check(!stack.includes(taskId), `Task dependency cycle: ${[...stack, taskId].join(' -> ')}`);
    if (visited.has(taskId)) return;
    const task = tasks.find((t) => t.id === taskId);
    task.dependsOn.forEach((dep) => visit(dep, [...stack, taskId]));
    visited.add(taskId);
  };
  tasks.forEach((task) => visit(task.id));
  // Shared working trees serialize writes; independent read tasks may run together.
  const writeTasks = tasks.filter((task) => task.mode === 'write');
  for (let i = 0; i < writeTasks.length; i += 1)
    for (let j = i + 1; j < writeTasks.length; j += 1) {
      const depends = (a, b) =>
        a.dependsOn.includes(b.id) ||
        a.dependsOn.some((dep) =>
          depends(
            tasks.find((t) => t.id === dep),
            b,
          ),
        );
      check(
        depends(writeTasks[i], writeTasks[j]) || depends(writeTasks[j], writeTasks[i]),
        'Write tasks in one worktree must be dependency-ordered',
      );
    }
  const plan = {
    version: 1,
    objective: input.objective,
    publicContext: input.publicContext || '',
    parallelism,
    tasks,
  };
  if (input.decision !== undefined) {
    keys(
      input.decision,
      ['signals', 'thresholds', 'evidence', 'voters', 'chairProfile', 'method', 'humanGate'],
      'plan decision',
    );
    keys(
      input.decision.signals || {},
      ['risk', 'ambiguity', 'writeFiles', 'writeBytes'],
      'decision signals',
    );
    keys(
      input.decision.thresholds || {},
      ['risk', 'ambiguity', 'writeFiles', 'writeBytes'],
      'decision thresholds',
    );
    check(Array.isArray(input.decision.evidence), 'Decision evidence must be an array');
    check(
      Array.isArray(input.decision.voters) &&
        input.decision.voters.length >= 2 &&
        input.decision.voters.length <= 3,
      'Decision requires 2-3 voters',
    );
    input.decision.voters.forEach((voter) => {
      const profile = typeof voter === 'string' ? voter : voter.profile;
      id(profile, 'decision voter profile');
      check(Object.hasOwn(profiles, profile), `Unknown decision voter profile ${profile}`);
    });
    if (input.decision.chairProfile !== undefined) {
      id(input.decision.chairProfile, 'decision chair profile');
      check(Object.hasOwn(profiles, input.decision.chairProfile), 'Unknown decision chair profile');
    }
    choice(input.decision.method || 'majority', ['majority', 'weighted'], 'decision method');
    check(
      input.decision.humanGate === undefined || typeof input.decision.humanGate === 'boolean',
      'decision humanGate must be boolean',
    );
    assertNoSecrets(input.decision);
    plan.decision = structuredClone(input.decision);
  }
  if (input.supervision !== undefined) {
    plan.supervision = validateSupervision(input.supervision);
  }
  if (input.memory !== undefined) plan.memory = validateRunMemory(input.memory);
  assertNoSecrets(plan);
  return plan;
}
