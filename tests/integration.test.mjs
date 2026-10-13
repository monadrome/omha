import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temp } from './helpers.mjs';
import { hash, projectDir } from '../lib/core.mjs';
import { appendEvent, readEvents } from '../lib/storage.mjs';
import { killTree } from '../lib/process.mjs';

const cli = join(process.cwd(), 'bin', 'omha.mjs');
const fixture = join(process.cwd(), 'tests', 'fixtures', 'local-worker.mjs');

function start(cwd, state, args) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, OMHA_HOME: state },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}
async function until(predicate) {
  for (let i = 0; i < 150; i += 1) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Fixture did not reach expected state');
}
function profile(mode, log) {
  return {
    adapter: 'command',
    command: process.execPath,
    model: 'local',
    args: [fixture, mode, log],
    sandbox: 'external',
    sandboxCommand: '/usr/bin/env',
    sandboxArgs: ['--'],
    concurrency: 1,
    timeoutMs: 5000,
    retry: { maxRetries: 0 },
    budget: { reserveTokens: 10, reserveCostUsd: 0 },
  };
}

test(
  'actual host SIGKILL resumes a read task, kills the previous process and retains reservations',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = temp('omha-restart-'),
      cwd = join(root, 'project'),
      state = join(root, 'state');
    mkdirSync(cwd);
    const log = join(root, 'worker.log'),
      config = join(root, 'providers.json'),
      plan = join(root, 'plan.json');
    writeFileSync(
      config,
      JSON.stringify({ version: 1, profiles: { worker: profile('crash-once', log) } }),
    );
    writeFileSync(
      plan,
      JSON.stringify({
        version: 1,
        objective: 'Restart local fixture',
        tasks: [
          {
            id: 'job',
            role: 'reader',
            prompt: 'Execute fixture',
            profile: 'worker',
            timeoutMs: 5000,
          },
        ],
      }),
    );
    const host = start(cwd, state, [
      'leader',
      '--plan',
      plan,
      '--config',
      config,
      '--id',
      'restart',
    ]);
    let previousPid;
    t.after(() => {
      host.child.kill('SIGKILL');
      killTree(previousPid, 'SIGKILL');
      rmSync(root, { recursive: true, force: true });
    });
    await until(() => existsSync(join(cwd, 'first-launch')));
    previousPid = Number(readFileSync(join(cwd, 'first-launch'), 'utf8'));
    const previousHome = process.env.OMHA_HOME;
    process.env.OMHA_HOME = state;
    const processEvent = readEvents(join(projectDir(cwd), 'runs', 'restart', 'events.jsonl')).find(
      (event) => event.kind === 'task.process' && event.taskId === 'job',
    );
    process.env.OMHA_HOME = previousHome;
    assert.ok(processEvent?.fingerprint, JSON.stringify(processEvent));
    host.child.kill('SIGKILL');
    await host.done;
    const resumed = await start(cwd, state, ['leader', '--resume', 'restart', '--config', config])
      .done;
    assert.equal(resumed.code, 0, resumed.stderr);
    const result = JSON.parse(resumed.stdout);
    assert.equal(result.status, 'completed');
    assert.equal(result.tasks.job.attempts, 2);
    assert.equal(result.budget.account.requests, 2);
    assert.equal(result.budget.account.tokens, 20);
    let currentFingerprint = '';
    try {
      currentFingerprint = execFileSync('ps', ['-o', 'lstart=', '-p', String(previousPid)], {
        encoding: 'utf8',
      }).trim();
    } catch {
      /* no process */
    }
    assert.ok(
      !currentFingerprint || currentFingerprint !== processEvent?.fingerprint,
      `Interrupted worker ${previousPid} is still running`,
    );
  },
);

test(
  'independent CLI processes share provider limits and never overlap local workers',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = temp('omha-concurrency-'),
      cwd = join(root, 'project'),
      state = join(root, 'state');
    mkdirSync(cwd);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const log = join(root, 'worker.log'),
      config = join(root, 'providers.json');
    writeFileSync(
      config,
      JSON.stringify({ version: 1, profiles: { worker: profile('sleep', log) } }),
    );
    const pending = Array.from({ length: 3 }, () =>
      start(cwd, state, [
        'run',
        '--profile',
        'worker',
        '--config',
        config,
        '--prompt',
        'Local worker',
      ]),
    );
    t.after(() => pending.forEach(({ child }) => child.kill('SIGKILL')));
    const results = await Promise.all(pending.map((process) => process.done));
    assert.ok(
      results.every((result) => result.code === 0),
      JSON.stringify(results),
    );
    assert.deepEqual(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).kind),
      ['start', 'end', 'start', 'end', 'start', 'end'],
    );
    const key = hash(`worker:${process.execPath}`).slice(0, 24);
    assert.equal(JSON.parse(readFileSync(join(state, 'runtime', `${key}.json`))).active.length, 0);
  },
);

test('durable JSONL tolerates a torn final event then appends without corrupting earlier history', () => {
  const root = temp('omha-events-');
  try {
    const file = join(root, 'events.jsonl');
    appendEvent(file, { kind: 'first', value: 'supported' });
    writeFileSync(file, '{"kind":"partial', { flag: 'a' });
    assert.deepEqual(readEvents(file), [{ kind: 'first', value: 'supported' }]);
    appendEvent(file, { kind: 'second' });
    assert.deepEqual(readEvents(file), [{ kind: 'first', value: 'supported' }, { kind: 'second' }]);
    writeFileSync(file, '\nnot-json\n', { flag: 'a' });
    assert.throws(() => readEvents(file), /Invalid event/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'independent Leader runs coordinate worktree writes across distinct provider gates',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = temp('omha-worktree-gate-'),
      cwd = join(root, 'project'),
      state = join(root, 'state');
    mkdirSync(cwd);
    const log = join(root, 'workers.log'),
      config = join(root, 'providers.json');
    writeFileSync(
      config,
      JSON.stringify({
        version: 1,
        profiles: { a: profile('sleep', log), b: profile('sleep', log) },
      }),
    );
    const pending = ['a', 'b'].map((name) => {
      const plan = join(root, `${name}.json`);
      writeFileSync(
        plan,
        JSON.stringify({
          version: 1,
          objective: 'Write fixture',
          tasks: [
            { id: 'job', role: 'writer', prompt: 'Local fixture', profile: name, mode: 'write' },
          ],
        }),
      );
      return start(cwd, state, ['leader', '--plan', plan, '--config', config, '--allow-write']);
    });
    t.after(() => {
      pending.forEach(({ child }) => child.kill('SIGKILL'));
      rmSync(root, { recursive: true, force: true });
    });
    const results = await Promise.all(pending.map((value) => value.done));
    assert.ok(
      results.every((value) => value.code === 0),
      JSON.stringify(results),
    );
    assert.deepEqual(
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).kind),
      ['start', 'end', 'start', 'end'],
    );
  },
);
