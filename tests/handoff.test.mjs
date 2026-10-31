import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp } from './helpers.mjs';
import {
  handoff,
  handoffStatus,
  readHandoff,
  pollHandoff,
  reportHandoff,
  readinessExitCode,
  sendHandoff,
  resumeHandoff,
  cancelHandoff,
  closeHandoff,
  completeHandoff,
} from '../lib/terminal.mjs';
import { atomicWrite } from '../lib/storage.mjs';
import { handoffPaths } from '../lib/handoff-protocol.mjs';
import { processFingerprint, processProbe } from '../lib/process.mjs';
import { FINAL_MARKER, hash, now, run } from '../lib/core.mjs';

const root = temp();
process.env.OMHA_HOME = join(root, 'state');
const cwd = join(root, 'project');
mkdirSync(cwd);

function backend() {
  const sessions = new Map();
  const calls = [];
  return {
    sessions,
    calls,
    async start(record) {
      assert.equal(readFileSync(record.promptFile, 'utf8'), 'Continue task');
      assert.equal(record.promptHash, hash('Continue task'));
      calls.push('start');
      sessions.set(record.id, { owner: record.owner.token, alive: true, output: 'running' });
      return { ref: `full-${record.id}`, pid: 12345 };
    },
    async verify(record) {
      assert.equal(sessions.get(record.id)?.owner, record.owner.token, 'must target owned session');
    },
    async alive(record) {
      await this.verify(record);
      return sessions.get(record.id).alive;
    },
    async capture(record) {
      await this.verify(record);
      return sessions.get(record.id).output;
    },
    async send(record, text, enter) {
      await this.verify(record);
      calls.push({ text, enter });
    },
    async close(record) {
      await this.verify(record);
      calls.push('close');
      sessions.get(record.id).alive = false;
    },
  };
}

function writeWorker(record, overrides = {}) {
  const at = now();
  const worker = {
    token: record.owner.token,
    pid: process.pid,
    childPid: process.pid,
    fingerprint: processFingerprint(process.pid),
    workerFingerprint: processFingerprint(process.pid),
    startedAt: record.startedAt,
    firstOutputAt: at,
    lastOutputAt: at,
    outputBytes: 12,
    updatedAt: at,
    ...overrides,
  };
  atomicWrite(handoffPaths(record.id).processFile, JSON.stringify(worker), process.env.OMHA_HOME);
  return worker;
}

test('real handoff worker authenticates completion through both stdout and file readers', async (t) => {
  const worker = fileURLToPath(new URL('../bin/handoff-worker.mjs', import.meta.url));
  for (const transport of ['stdout', 'file']) {
    await t.test(transport, async () => {
      const adapter = backend();
      const options =
        transport === 'stdout' ? { backend: 'fake', backendAdapter: adapter } : { backend: 'file' };
      const created = await handoff(cwd, 'Continue task', {
        ...options,
        command: process.execPath,
        args: [
          '-e',
          "process.stdin.setEncoding('utf8'); let prompt = ''; process.stdin.on('data', s => prompt += s); process.stdin.on('end', () => console.log(prompt));",
        ],
        timeoutMs: 10000,
      });
      const result = await run(process.execPath, [worker, created.recordFile], {
        cwd,
        env: { ...process.env, OMHA_HOME: process.env.OMHA_HOME },
        timeoutMs: 10000,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.timedOut, false);
      const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith(FINAL_MARKER));
      assert.ok(marker, result.stdout);
      const final = JSON.parse(marker.slice(FINAL_MARKER.length));
      assert.equal(final.token, created.owner.token);
      assert.equal(final.state, 'completed');
      assert.equal(final.exitCode, 0);
      assert.equal(final.responseHash, hash('Continue task\n'));
      const finalFile = join(process.env.OMHA_HOME, 'handoffs', created.id, 'final.json');
      assert.deepEqual(JSON.parse(readFileSync(finalFile, 'utf8')), final);
      if (transport === 'stdout') {
        // Force the reader to parse actual worker stdout instead of its completion file.
        rmSync(finalFile);
        const session = adapter.sessions.get(created.id);
        session.output = result.stdout.replace(created.owner.token, 'wrong-owner');
        await assert.rejects(readHandoff(created.id, options), { code: 'malformed_completion' });
        session.output = result.stdout;
        session.alive = false;
      }
      const completed = await pollHandoff(created.id, { ...options, waitMs: 1000 });
      assert.equal(completed.state, 'completed');
      assert.deepEqual(completed.completion, final);
      assert.equal((await readHandoff(created.id, options)).completion.token, created.owner.token);
      assert.equal(handoffStatus(created.id).state, 'completed');
      await closeHandoff(created.id, options);
    });
  }
});

test('file lifecycle persists prompt before awaiting, supports explicit completion and resume', async () => {
  const created = await handoff(cwd, 'Continue task', { backend: 'file', name: 'test-file' });
  assert.equal(created.state, 'awaiting');
  assert.equal(created.promptHash, hash('Continue task'));
  assert.equal(handoffStatus(created.id).owner.token, created.owner.token);
  completeHandoff(created.id, 0);
  assert.equal((await readHandoff(created.id)).state, 'completed');
  const resumed = await resumeHandoff(created.id, 'Continuation', { backend: 'file' });
  assert.equal(resumed.resumedFrom, created.id);
  assert.notEqual(resumed.id, created.id);
  await closeHandoff(created.id);
  assert.equal(handoffStatus(created.id).state, 'closed');
  assert.equal(handoffStatus(resumed.id).state, 'awaiting');
});

test('owned fake backend captures, sends separate enter, detects final marker and closes', async () => {
  const adapter = backend();
  const created = await handoff(cwd, 'Continue task', { backend: 'fake', backendAdapter: adapter });
  await sendHandoff(created.id, 'next', { backendAdapter: adapter, enter: true });
  assert.deepEqual(adapter.calls[1], { text: 'next', enter: true });
  adapter.sessions.get(created.id).output =
    `OMHA_FINAL:${JSON.stringify({ token: created.owner.token, state: 'completed', exitCode: 0 })}`;
  assert.equal(
    (await pollHandoff(created.id, { backendAdapter: adapter, waitMs: 30 })).state,
    'completed',
  );
  await closeHandoff(created.id, { backendAdapter: adapter });
  assert.equal(adapter.sessions.get(created.id).alive, false);
});

test('timeout and cancellation close only the owned target, with durable states', async () => {
  for (const cancel of [false, true]) {
    const adapter = backend();
    adapter.sessions.set('user-session', { owner: 'user', alive: true });
    const created = await handoff(cwd, 'Continue task', {
      backend: 'fake',
      backendAdapter: adapter,
      timeoutMs: cancel ? 3000 : 10,
    });
    const result = cancel
      ? await cancelHandoff(created.id, { backendAdapter: adapter })
      : await pollHandoff(created.id, { backendAdapter: adapter, waitMs: 100 });
    assert.equal(result.state, cancel ? 'cancelled' : 'timed_out');
    assert.equal(adapter.sessions.get(created.id).alive, false);
    assert.equal(adapter.sessions.get('user-session').alive, true);
    assert.equal(handoffStatus(created.id).backendClosed, true);
  }
});

test('wrong owner and malformed final markers are never accepted as success', async () => {
  const adapter = backend(),
    created = await handoff(cwd, 'Continue task', { backend: 'fake', backendAdapter: adapter });
  adapter.sessions.get(created.id).output = 'OMHA_FINAL:{bad}';
  await assert.rejects(readHandoff(created.id, { backendAdapter: adapter }), /Malformed/);
  adapter.sessions.get(created.id).output =
    `OMHA_FINAL:${JSON.stringify({ token: 'wrong', state: 'completed', exitCode: 0 })}`;
  await assert.rejects(readHandoff(created.id, { backendAdapter: adapter }), /Invalid/);
  adapter.sessions.get(created.id).output = '';
  adapter.sessions.get(created.id).owner = 'user-session';
  await assert.rejects(closeHandoff(created.id, { backendAdapter: adapter }), /owned session/);
});

test('liveness loss without an explicit final marker is a failure', async () => {
  const adapter = backend(),
    created = await handoff(cwd, 'Continue task', { backend: 'fake', backendAdapter: adapter });
  adapter.sessions.get(created.id).alive = false;
  const result = await readHandoff(created.id, { backendAdapter: adapter });
  assert.equal(result.state, 'failed');
  assert.equal(result.failure, 'missing_completion');
});

test('auto degradation tries both native backends and reaches file mode after launch failures', async () => {
  const calls = [];
  const broken = (name) => ({
    async start(record) {
      assert.ok(existsSync(record.promptFile));
      calls.push(name);
      throw new Error('fixture launch failed');
    },
  });
  const created = await handoff(cwd, 'Continue task', {
    backend: 'auto',
    backends: { cmux: broken('cmux'), tmux: broken('tmux') },
  });
  assert.equal(created.backend, 'file');
  assert.equal(created.state, 'awaiting');
  assert.equal(created.readiness.state, 'not_applicable');
  assert.equal(created.diagnosis, null);
  if (process.platform !== 'win32') assert.deepEqual(calls, ['cmux', 'tmux']);
  assert.equal(created.backendClosed, undefined);
  assert.equal(handoffStatus(created.id).launchAttempts.at(-1).backend, 'file');
});

test('auto prefers cmux and never starts tmux after an uncertain launch or cleanup', async () => {
  for (const failure of ['none', 'start', 'cleanup', 'ownership']) {
    const calls = [];
    const cmux = {
      async prepare() {
        calls.push('prepare');
        if (failure === 'ownership')
          throw Object.assign(new Error('owner changed'), { code: 'ownership' });
        return { ref: 'owned-target' };
      },
      async start() {
        calls.push('start');
        if (failure !== 'none') throw new Error('response lost after launch');
      },
      async close() {
        calls.push('close');
        if (failure === 'cleanup') throw new Error('cleanup uncertain');
      },
    };
    const tmux = {
      async start() {
        assert.fail('must not replay on tmux');
      },
    };
    const created = await handoff(cwd, 'Continue task', { backends: { cmux, tmux } });
    assert.equal(created.backend, 'cmux');
    assert.equal(created.launchAttempts.length, 1);
    assert.equal(
      created.state,
      failure === 'none' ? 'running' : failure === 'ownership' ? 'failed' : 'interrupted',
    );
    if (failure === 'start' || failure === 'cleanup')
      assert.equal(created.launchAttempts[0].uncertain, true);
    if (failure === 'start') {
      assert.equal((await readHandoff(created.id, { backends: { cmux } })).state, 'interrupted');
      assert.equal(
        (await pollHandoff(created.id, { backends: { cmux }, waitMs: 0 })).state,
        'interrupted',
      );
    }
  }
});

test('explicit close retries cleanup of an interrupted owned launch without replaying it', async () => {
  let closes = 0;
  let starts = 0;
  const cmux = {
    async prepare() {
      return { ref: 'owned-target' };
    },
    async start() {
      starts += 1;
      throw new Error('launch outcome uncertain');
    },
    async verify() {},
    async close() {
      closes += 1;
      if (closes === 1) throw new Error('first cleanup uncertain');
    },
  };
  const created = await handoff(cwd, 'Continue task', {
    backend: 'auto',
    backends: {
      cmux,
      tmux: {
        async start() {
          assert.fail('must not replay');
        },
      },
    },
  });
  assert.equal(created.state, 'interrupted');
  assert.equal(created.backendClosed, undefined);
  const closed = await closeHandoff(created.id, { backends: { cmux } });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.backendClosed, true);
  assert.equal(starts, 1);
  assert.equal(closes, 2);
});

test('worker heartbeat resolves readiness before completion and feeds report/poll', async () => {
  const adapter = backend();
  const created = await handoff(cwd, 'Continue task', {
    backend: 'fake',
    backendAdapter: adapter,
    interactive: true,
  });
  writeWorker(created);
  const result = await readHandoff(created.id, { backendAdapter: adapter });
  assert.equal(result.state, 'running');
  assert.equal(result.readiness.state, 'ready');
  assert.equal(result.readiness.evidence, 'worker_output');
  assert.equal(result.workerAlive, true);
  const ready = await pollHandoff(created.id, {
    backendAdapter: adapter,
    until: 'ready',
    waitMs: 100,
  });
  assert.equal(ready.readiness.state, 'ready');
  const report = await reportHandoff(created.id, { backendAdapter: adapter });
  assert.equal(report.phase, 'ready');
  assert.deepEqual(report.nextActions, ['send', 'poll', 'close']);
  assert.match(report.outputTail, /running/);
});

test(
  'a dead worker without a final marker fails at the first read',
  { skip: process.platform === 'win32' },
  async () => {
    const adapter = backend();
    const created = await handoff(cwd, 'Continue task', {
      backend: 'fake',
      backendAdapter: adapter,
    });
    const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    writeWorker(created, {
      pid: dead.pid,
      childPid: dead.pid,
      fingerprint: 'dead',
      workerFingerprint: 'dead',
      firstOutputAt: null,
      lastOutputAt: null,
      outputBytes: 0,
    });
    const result = await readHandoff(created.id, { backendAdapter: adapter });
    assert.equal(result.state, 'failed');
    assert.equal(result.failure, 'missing_completion');
    assert.equal(result.diagnosis.kind, 'worker_exited');
    assert.equal(result.readiness.state, 'failed');
    assert.equal(result.workerAlive, false);
  },
);

test('startup quota output is diagnosed without terminating a live worker', async () => {
  const adapter = backend();
  const created = await handoff(cwd, 'Continue task', {
    backend: 'fake',
    backendAdapter: adapter,
  });
  adapter.sessions.get(created.id).output = 'Claude Code\nusage limit reached\n';
  const result = await readHandoff(created.id, { backendAdapter: adapter });
  assert.equal(result.state, 'running');
  assert.equal(result.readiness.state, 'failed');
  assert.equal(result.diagnosis.kind, 'quota');
  assert.match(result.diagnosis.evidence, /usage limit/i);
  const report = await reportHandoff(created.id, { backendAdapter: adapter });
  assert.equal(report.phase, 'unready');
  assert.ok(!report.nextActions.includes('resume'));
});

test('a failed final marker records a fatal screen diagnosis', async () => {
  const adapter = backend();
  const created = await handoff(cwd, 'Continue task', {
    backend: 'fake',
    backendAdapter: adapter,
  });
  adapter.sessions.get(created.id).output = [
    'usage limit reached',
    `OMHA_FINAL:${JSON.stringify({
      token: created.owner.token,
      state: 'failed',
      exitCode: 1,
    })}`,
  ].join('\n');
  const result = await readHandoff(created.id, { backendAdapter: adapter });
  assert.equal(result.state, 'failed');
  assert.equal(result.readiness.state, 'failed');
  assert.equal(result.diagnosis.kind, 'quota');
});

test('input prompts stay non-fatal and are re-armed after input', async () => {
  const adapter = backend();
  const created = await handoff(cwd, 'Continue task', {
    backend: 'fake',
    backendAdapter: adapter,
    interactive: true,
  });
  adapter.sessions.get(created.id).output = 'Do you want to proceed?\n1. Yes\n2. No\n';
  const result = await readHandoff(created.id, { backendAdapter: adapter });
  assert.equal(result.state, 'running');
  assert.equal(result.readiness.state, 'needs_input');
  assert.equal(result.diagnosis.kind, 'permission_prompt');
  await sendHandoff(created.id, '1', { backendAdapter: adapter });
  const after = handoffStatus(created.id);
  assert.equal(after.readiness.state, 'pending');
  assert.equal(after.diagnosis, null);
  assert.ok(after.readiness.lastInputAt);
});

test('no worker output becomes unready without killing the handoff', async () => {
  const adapter = backend();
  const created = await handoff(cwd, 'Continue task', {
    backend: 'fake',
    backendAdapter: adapter,
    readyTimeoutMs: 10,
  });
  adapter.sessions.get(created.id).output = '';
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await readHandoff(created.id, { backendAdapter: adapter });
  assert.equal(result.state, 'running');
  assert.equal(result.readiness.state, 'unready');
  assert.equal(result.diagnosis.kind, 'no_output');
});

test('waitReady blocks until the worker heartbeat is ready', async () => {
  const adapter = backend();
  const start = adapter.start.bind(adapter);
  adapter.start = async (record) => {
    const result = await start(record);
    setTimeout(() => writeWorker(record), 50);
    return result;
  };
  const result = await handoff(cwd, 'Continue task', {
    backend: 'fake',
    backendAdapter: adapter,
    waitReady: true,
    readyTimeoutMs: 1000,
  });
  assert.equal(result.state, 'running');
  assert.equal(result.readiness.state, 'ready');
});

test('late worker output clears unready and no_output', async () => {
  const adapter = backend();
  const created = await handoff(cwd, 'Continue task', {
    backend: 'fake',
    backendAdapter: adapter,
    readyTimeoutMs: 10,
  });
  adapter.sessions.get(created.id).output = '';
  await new Promise((resolve) => setTimeout(resolve, 20));
  const unready = await readHandoff(created.id, { backendAdapter: adapter });
  assert.equal(unready.readiness.state, 'unready');
  assert.equal(unready.diagnosis.kind, 'no_output');
  writeWorker(created);
  const ready = await readHandoff(created.id, { backendAdapter: adapter });
  assert.equal(ready.readiness.state, 'ready');
  assert.equal(ready.diagnosis, null);
});

test('a legal final clears a stale input-wait readiness state', async () => {
  const adapter = backend();
  const created = await handoff(cwd, 'Continue task', {
    backend: 'fake',
    backendAdapter: adapter,
    interactive: true,
  });
  adapter.sessions.get(created.id).output = 'Do you want to proceed?\n1. Yes\n2. No\n';
  const waiting = await readHandoff(created.id, { backendAdapter: adapter });
  assert.equal(waiting.readiness.state, 'needs_input');
  adapter.sessions.get(created.id).output = `OMHA_FINAL:${JSON.stringify({
    token: created.owner.token,
    state: 'completed',
    exitCode: 0,
  })}`;
  const done = await readHandoff(created.id, { backendAdapter: adapter });
  assert.equal(done.state, 'completed');
  assert.equal(done.readiness.state, 'ready');
  assert.equal(done.diagnosis, null);
});

test('sendHandoff preserves a completion written concurrently with input', async () => {
  const adapter = backend();
  const created = await handoff(cwd, 'Continue task', {
    backend: 'fake',
    backendAdapter: adapter,
  });
  adapter.send = async (record) => {
    const latest = handoffStatus(record.id);
    latest.state = 'completed';
    latest.completion = {
      token: record.owner.token,
      state: 'completed',
      exitCode: 0,
      at: now(),
    };
    latest.diagnosis = { kind: 'quota', evidence: 'test', suggestion: 'test', at: now() };
    atomicWrite(latest.recordFile, JSON.stringify(latest), process.env.OMHA_HOME);
  };
  await sendHandoff(created.id, 'next', { backendAdapter: adapter });
  const after = handoffStatus(created.id);
  assert.equal(after.state, 'completed');
  assert.equal(after.completion.token, created.owner.token);
  assert.equal(after.diagnosis.kind, 'quota');
  assert.equal(after.readiness.state, 'pending');
});

test('readinessExitCode treats unresolved waits as failure', () => {
  assert.equal(readinessExitCode({ state: 'running', readiness: { state: 'ready' } }), 0);
  assert.equal(readinessExitCode({ state: 'running', readiness: { state: 'pending' } }), 1);
  assert.equal(readinessExitCode({ state: 'running', readiness: { state: 'needs_input' } }), 1);
  assert.equal(readinessExitCode({ state: 'running', readiness: { state: 'unready' } }), 1);
  assert.equal(readinessExitCode({ state: 'running', readiness: { state: 'failed' } }), 1);
  assert.equal(readinessExitCode({ state: 'awaiting', readiness: { state: 'not_applicable' } }), 0);
  assert.equal(readinessExitCode({ state: 'failed' }, true), 1);
  assert.equal(readinessExitCode({ state: 'running' }, true), 1);
  assert.equal(readinessExitCode({ state: 'awaiting' }, true), 1);
  assert.equal(readinessExitCode({ state: 'completed' }, true), 0);
  assert.equal(readinessExitCode({ state: 'running', readiness: { state: 'pending' } }, false), 0);
});

test(
  'processProbe distinguishes absent and alive workers',
  { skip: process.platform === 'win32' },
  () => {
    assert.equal(processProbe(process.pid).state, 'alive');
    const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    assert.equal(processProbe(dead.pid).state, 'absent');
    assert.equal(processProbe(999999).state, 'absent');
  },
);

test('structured spawn errors become command_not_found diagnoses', async () => {
  const worker = fileURLToPath(new URL('../bin/handoff-worker.mjs', import.meta.url));
  const created = await handoff(cwd, 'Continue task', {
    backend: 'file',
    command: '/definitely/not-an-omha-command',
    args: [],
    timeoutMs: 1000,
  });
  const result = await run(process.execPath, [worker, created.recordFile], {
    cwd,
    env: { ...process.env, OMHA_HOME: process.env.OMHA_HOME },
    timeoutMs: 5000,
  });
  assert.equal(result.code, 0, result.stderr);
  const read = await readHandoff(created.id);
  assert.equal(read.state, 'failed');
  assert.equal(read.diagnosis.kind, 'command_not_found');
  await closeHandoff(created.id);
});

test('a structured final failure overrides a stale no_output diagnosis', async () => {
  const adapter = backend();
  const created = await handoff(cwd, 'Continue task', {
    backend: 'fake',
    backendAdapter: adapter,
    readyTimeoutMs: 10,
  });
  adapter.sessions.get(created.id).output = '';
  await new Promise((resolve) => setTimeout(resolve, 20));
  const unready = await readHandoff(created.id, { backendAdapter: adapter });
  assert.equal(unready.diagnosis.kind, 'no_output');
  atomicWrite(
    handoffPaths(created.id).finalFile,
    JSON.stringify({
      token: created.owner.token,
      state: 'failed',
      exitCode: 127,
      failure: 'command_not_found',
      spawnError: 'spawn missing ENOENT',
      at: now(),
    }),
    process.env.OMHA_HOME,
  );
  const failed = await readHandoff(created.id, { backendAdapter: adapter });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure, 'command_not_found');
  assert.equal(failed.diagnosis.kind, 'command_not_found');
});

test(
  'an unknown process probe keeps the handoff running',
  { skip: process.platform === 'win32' },
  async () => {
    const adapter = backend();
    const created = await handoff(cwd, 'Continue task', {
      backend: 'fake',
      backendAdapter: adapter,
    });
    writeWorker(created);
    const fakeDir = join(root, 'fake-ps-unknown');
    mkdirSync(fakeDir, { recursive: true });
    const fakePs = join(fakeDir, 'ps');
    writeFileSync(fakePs, '#!/bin/sh\necho "ps: temporary probe failure" >&2\nexit 2\n');
    chmodSync(fakePs, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeDir}:${oldPath}`;
    try {
      assert.equal(processProbe(process.pid).state, 'unknown');
      const result = await readHandoff(created.id, { backendAdapter: adapter });
      assert.equal(result.state, 'running');
      assert.equal(result.workerAlive, null);
      assert.equal(result.alive, null);
      assert.equal(result.diagnosis, null);
    } finally {
      process.env.PATH = oldPath;
    }
  },
);
