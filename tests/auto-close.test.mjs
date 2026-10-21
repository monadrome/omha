import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime } from '../lib/runner.mjs';
import { executePlan } from '../lib/orchestrator.mjs';
import { resolveDecision } from '../lib/roundtable.mjs';
import { cmuxBackend } from '../lib/backends.mjs';
import { appendEvent, atomicWrite, readEvents } from '../lib/storage.mjs';
import {
  adoptHandoff,
  autoCloseHandoff,
  closeHandoff,
  finishAutoClose,
  handoffStatus,
} from '../lib/terminal.mjs';

const bin = temp('omha-auto-close-bin-');
copyFileSync(new URL('./fixtures/cmux.mjs', import.meta.url), join(bin, 'cmux'));
chmodSync(join(bin, 'cmux'), 0o700);
process.env.PATH = `${bin}:${process.env.PATH}`;
const cli = fileURLToPath(new URL('../bin/omha.mjs', import.meta.url));
const nativeTest = (name, fn) => test(name, { skip: process.platform === 'win32' }, fn);

function fixture(agent = 'codex') {
  const cwd = temp('omha-auto-close-project-');
  const home = temp('omha-auto-close-state-');
  process.env.OMHA_HOME = home;
  const ref = randomUUID(),
    surfaceRef = randomUUID(),
    other = randomUUID();
  process.env.CMUX_WORKSPACE_ID = ref;
  process.env.CMUX_SURFACE_ID = surfaceRef;
  const file = join(home, 'cmux-fixture.json');
  writeFileSync(
    file,
    JSON.stringify({
      cwd,
      agent,
      calls: [],
      forks: [],
      messages: [],
      closed: [],
      owners: {},
      surfaces: {
        [surfaceRef]: { ref, agent, sessionId: randomUUID(), source: true },
        [other]: { ref, agent, sessionId: randomUUID(), source: true },
      },
    }),
  );
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const update = (fn) => {
    const state = read();
    fn(state);
    writeFileSync(file, JSON.stringify(state));
  };
  const invoke = (args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, ...args], {
        cwd,
        env: process.env,
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  return { cwd, home, ref, surfaceRef, other, read, update, invoke };
}

async function settled(record) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = handoffStatus(record.id);
    if (['closed', 'uncertain'].includes(result.autoClose.state)) {
      const events = readEvents(
        join(process.env.OMHA_HOME, 'handoffs', record.id, 'events.jsonl'),
        process.env.OMHA_HOME,
      );
      if (events.at(-1)?.kind === `auto_close.${result.autoClose.state}`) return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Detached auto-close worker did not finish');
}

const request = {
  completed: true,
  reason: '/goal achieved; acceptance checks passed',
  delayMs: 100,
};

nativeTest('completion hook closes only its own surface after persisting completion', async () => {
  for (const agent of ['codex', 'claude']) {
    const f = fixture(agent);
    const record = f.invoke([
      'auto-close',
      '--completed',
      '--reason',
      request.reason,
      '--delay-ms',
      '100',
    ]);
    assert.equal(record.autoClose.state, 'scheduled');
    assert.equal(record.autoClose.completion.source, 'caller-reported');
    assert.equal(record.completion.explicit, true);
    assert.notEqual(record.autoClose.workerPid, process.pid);
    const final = await settled(record);
    assert.equal(final.state, 'closed');
    assert.equal(final.previousState, 'completed');
    assert.equal(final.backendClosed, true);
    assert.deepEqual(f.read().closed, [f.surfaceRef]);
    assert.ok(f.read().surfaces[f.other]);
    const calls = f.read().calls;
    assert.ok(calls.find((args) => args[0] === 'close-surface').includes('--force'));
    assert.equal(
      calls.some((args) =>
        ['close-workspace', 'read-screen', 'send', 'send-key'].includes(args[0]),
      ),
      false,
    );
    const events = readEvents(join(f.home, 'handoffs', record.id, 'events.jsonl'), f.home);
    assert.deepEqual(
      events.slice(-3).map((event) => event.kind),
      ['auto_close.requested', 'auto_close.closing', 'auto_close.closed'],
    );
  }
});

nativeTest(
  'auto-close rejects missing completion, invalid input and generic turn hook payloads',
  async () => {
    const f = fixture();
    await assert.rejects(autoCloseHandoff(f.cwd, { reason: 'Idle' }), { code: 'authority' });
    await assert.rejects(autoCloseHandoff(f.cwd, { ...request, reason: '' }));
    await assert.rejects(autoCloseHandoff(f.cwd, { ...request, delayMs: 10001 }));
    assert.throws(() =>
      f.invoke(['auto-close', '--completed', '--reason', 'Idle', '{"type":"agent-turn-complete"}']),
    );
    assert.throws(() => f.invoke(['auto-close', '--completed', 'false', '--reason', 'Idle']));
    assert.throws(() =>
      f.invoke(['auto-close', '--completed', '--reason', 'Idle', '--backend', 'file']),
    );
    assert.equal(f.read().calls.length, 0);
    assert.equal(f.read().closed.length, 0);
  },
);

nativeTest(
  'another caller, another worktree and active self-cancel retain the terminal',
  async () => {
    const f = fixture();
    const source = await adoptHandoff(f.cwd);
    await assert.rejects(closeHandoff(source.id), /self-retirement/);
    process.env.CMUX_SURFACE_ID = f.other;
    await assert.rejects(autoCloseHandoff(f.cwd, { ...request, id: source.id }), {
      code: 'ownership',
    });
    process.env.CMUX_SURFACE_ID = f.surfaceRef;
    await assert.rejects(autoCloseHandoff(temp(), { ...request, id: source.id }), {
      code: 'ownership',
    });
    await assert.rejects(autoCloseHandoff(f.cwd, { ...request, signal: AbortSignal.abort() }), {
      code: 'cancellation',
    });
    f.update((state) => {
      state.fail = 'binding';
    });
    await assert.rejects(autoCloseHandoff(f.cwd, { ...request, id: source.id }));
    assert.equal(handoffStatus(source.id).autoClose, undefined);
    assert.equal(f.read().closed.length, 0);
  },
);

nativeTest(
  'duplicate completion hooks reuse one durable claim and one detached worker',
  async () => {
    const f = fixture();
    const record = await autoCloseHandoff(f.cwd, { ...request, delayMs: 5000 });
    const again = await autoCloseHandoff(f.cwd, { ...request, delayMs: 5000 });
    assert.equal(again.autoClose.requestId, record.autoClose.requestId);
    assert.equal(again.autoClose.workerPid, record.autoClose.workerPid);
    await assert.rejects(
      autoCloseHandoff(f.cwd, { ...request, reason: 'A different task' }),
      /changed/,
    );
    await assert.rejects(closeHandoff(record.id), /auto-close claim/);
    assert.equal((await settled(record)).autoClose.state, 'closed');
    await finishAutoClose(record.id, record.autoClose.requestId);
    assert.equal(f.read().closed.length, 1);
  },
);

nativeTest('changed owner or native session during the delay prevents closure', async () => {
  for (const change of ['owner', 'session']) {
    const f = fixture();
    const record = await autoCloseHandoff(f.cwd, { ...request, delayMs: 500 });
    f.update((state) => {
      if (change === 'owner') state.owners[f.ref] = {};
      else state.surfaces[f.surfaceRef].sessionId = randomUUID();
    });
    const result = await settled(record);
    assert.equal(result.autoClose.state, 'uncertain');
    assert.equal(result.autoClose.failure, 'ownership');
    assert.equal(result.backendClosed, undefined);
    assert.equal(f.read().closed.length, 0);
  }
});

nativeTest('failed or ambiguous closes never replay automatically', async () => {
  for (const failure of ['close', 'close-response']) {
    const f = fixture();
    f.update((state) => {
      state.fail = failure;
    });
    const record = await autoCloseHandoff(f.cwd, request);
    const result = await settled(record);
    assert.equal(result.autoClose.state, 'uncertain');
    f.update((state) => {
      delete state.fail;
    });
    await assert.rejects(autoCloseHandoff(f.cwd, { ...request, id: record.id }), /uncertain/);
    await finishAutoClose(record.id, record.autoClose.requestId);
    assert.equal(f.read().calls.filter((args) => args[0] === 'close-surface').length, 1);
  }
});

async function completedRun(f, { acceptanceExitCode = 0, reviewStatus = 'pass' } = {}) {
  const runtime = createRuntime(
    config({
      worker: fake(),
      reviewer: fake(
        JSON.stringify({
          assessments: [
            { id: 'scope', status: reviewStatus, finding: 'Offline scope assessment.' },
          ],
          summary: 'Independent offline review.',
        }),
      ),
    }),
    { persistent: false },
  );
  return executePlan(
    f.cwd,
    {
      version: 1,
      objective: 'Offline completion gate',
      tasks: [
        {
          id: 'task',
          role: 'worker',
          prompt: 'Inspect locally',
          profile: 'worker',
          mode: 'readonly',
          acceptance: {
            command: process.execPath,
            args: ['-e', `process.exit(${acceptanceExitCode})`],
          },
          review: {
            reviewerProfile: 'reviewer',
            diff: '+fixture',
            testEvidence: [{ name: 'offline', status: 'passed', summary: 'Local fixture' }],
            criteria: [{ id: 'scope', description: 'Scope is correct.' }],
          },
        },
      ],
    },
    { runtime },
  );
}

nativeTest('host run completion is verified and bound before closing', async () => {
  const f = fixture();
  const run = await completedRun(f);
  assert.equal(run.status, 'completed');
  assert.equal(run.tasks.task.acceptanceAccepted, true);
  assert.equal(run.tasks.task.reviewApproved, true);
  const record = await autoCloseHandoff(f.cwd, { ...request, runId: run.runId });
  assert.equal(record.autoClose.completion.source, 'host-run');
  assert.equal((await settled(record)).autoClose.state, 'closed');
});

nativeTest('incomplete runs and changed host evidence leave the surface open', async () => {
  for (const phase of ['before', 'after']) {
    const f = fixture();
    const run = await completedRun(f);
    let record;
    if (phase === 'after')
      record = await autoCloseHandoff(f.cwd, { ...request, runId: run.runId, delayMs: 500 });
    appendEvent(
      join(run.dir, 'events.jsonl'),
      { kind: 'run.status', status: 'interrupted' },
      f.home,
    );
    if (phase === 'before')
      await assert.rejects(autoCloseHandoff(f.cwd, { ...request, runId: run.runId }), {
        code: 'authority',
      });
    else assert.equal((await settled(record)).autoClose.state, 'uncertain');
    assert.equal(f.read().closed.length, 0);
  }
});

nativeTest(
  'failed host acceptance and independent review cannot be bypassed by completion claims',
  async () => {
    for (const policy of [{ acceptanceExitCode: 1 }, { reviewStatus: 'fail' }]) {
      const f = fixture();
      const run = await completedRun(f, policy);
      assert.equal(run.status, 'failed');
      await assert.rejects(autoCloseHandoff(f.cwd, { ...request, runId: run.runId }), {
        code: 'authority',
      });
      appendEvent(
        join(run.dir, 'events.jsonl'),
        { kind: 'run.status', status: 'completed' },
        f.home,
      );
      await assert.rejects(autoCloseHandoff(f.cwd, { ...request, runId: run.runId }), {
        code: 'authority',
      });
      assert.equal(f.read().calls.length, 0);
    }
  },
);

nativeTest('host decision gate must be approved before completion cleanup', async () => {
  const f = fixture();
  const proposal = {
    recommendation: 'A',
    evidence: [{ id: 'source', quote: 'Option A passes.' }],
    uncertainty: 0.1,
    abstention: false,
    reason: 'Verified local evidence.',
  };
  const runtime = createRuntime(
    config({
      p: fake('unused', {
        responses: [
          { output: JSON.stringify(proposal) },
          { output: JSON.stringify(proposal) },
          {
            output: JSON.stringify({
              recommendation: 'A',
              summary: 'Verified',
              minorityReasons: [],
            }),
          },
          { output: 'Local task completed.' },
        ],
      }),
    }),
    { persistent: false },
  );
  const run = await executePlan(
    f.cwd,
    {
      version: 1,
      objective: 'Host decision cleanup gate',
      tasks: [
        {
          id: 'task',
          role: 'worker',
          prompt: 'Inspect locally',
          profile: 'p',
          mode: 'readonly',
        },
      ],
      decision: {
        signals: { risk: 0.9 },
        evidence: [{ id: 'source', text: 'Option A passes.' }],
        voters: ['p', 'p'],
        chairProfile: 'p',
        humanGate: true,
      },
    },
    { runtime },
  );
  assert.equal(run.status, 'awaiting_decision');
  await assert.rejects(autoCloseHandoff(f.cwd, { ...request, runId: run.runId }), {
    code: 'authority',
  });
  resolveDecision(f.cwd, run.decision.decisionId, 'approve', 'Offline human approval fixture');
  const complete = await executePlan(f.cwd, null, { runtime, resume: true, runId: run.runId });
  assert.equal(complete.status, 'completed');
  const record = await autoCloseHandoff(f.cwd, { ...request, runId: run.runId });
  assert.equal((await settled(record)).autoClose.state, 'closed');
});

nativeTest('unaccepted forks cannot report task completion', async () => {
  const f = fixture();
  const record = await adoptHandoff(f.cwd);
  record.fork = { state: 'awaiting_acceptance' };
  atomicWrite(record.recordFile, JSON.stringify(record), f.home);
  await assert.rejects(autoCloseHandoff(f.cwd, { ...request, id: record.id }), /Accept/);
  record.fork = { state: 'accepted', closeSource: true, sourceClose: 'uncertain' };
  atomicWrite(record.recordFile, JSON.stringify(record), f.home);
  await assert.rejects(autoCloseHandoff(f.cwd, { ...request, id: record.id }), /Accept/);
  assert.equal(f.read().closed.length, 0);
});

nativeTest('expired and already claimed workers cannot replay a close', async () => {
  const f = fixture();
  const record = await adoptHandoff(f.cwd);
  record.autoClose = {
    requestId: randomUUID(),
    state: 'scheduled',
    closeAfter: new Date(Date.now() - 11000).toISOString(),
  };
  atomicWrite(record.recordFile, JSON.stringify(record), f.home);
  await assert.rejects(finishAutoClose(record.id), /request id/);
  await assert.rejects(finishAutoClose(record.id, randomUUID()), { code: 'ownership' });
  await assert.rejects(finishAutoClose(record.id, record.autoClose.requestId), /expired/);
  record.autoClose.state = 'closing';
  record.autoClose.closeAfter = new Date().toISOString();
  atomicWrite(record.recordFile, JSON.stringify(record), f.home);
  assert.equal(
    (await finishAutoClose(record.id, record.autoClose.requestId)).autoClose.state,
    'closing',
  );
  record.state = 'completed';
  record.autoClose.closeAfter = new Date(Date.now() - 11000).toISOString();
  await assert.rejects(cmuxBackend.close(record, { completed: true }), /expired/);
  assert.equal(f.read().closed.length, 0);
});
