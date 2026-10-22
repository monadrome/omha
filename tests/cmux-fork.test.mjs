import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime } from '../lib/runner.mjs';
import { hash } from '../lib/core.mjs';
import { executePlan } from '../lib/orchestrator.mjs';
import { cmuxBackend } from '../lib/backends.mjs';
import {
  adoptHandoff,
  handoffCheckpoints,
  forkHandoff,
  messageHandoff,
  acceptHandoff,
  handoffStatus,
  listHandoffs,
  readHandoff,
  closeHandoff,
  validateFork,
} from '../lib/terminal.mjs';
import { autoButterfly, validateButterfly } from '../lib/butterfly.mjs';

const root = temp('omha-cmux-fork-');
const originalPath = process.env.PATH;
const bin = join(root, 'bin');
mkdirSync(bin);
copyFileSync(new URL('./fixtures/cmux.mjs', import.meta.url), join(bin, 'cmux'));
chmodSync(join(bin, 'cmux'), 0o700);
process.env.PATH = `${bin}:${originalPath}`;
const cli = fileURLToPath(new URL('../bin/omha.mjs', import.meta.url));
const reliable = JSON.parse(
  readFileSync(new URL('./fixtures/butterfly-reliable.json', import.meta.url), 'utf8'),
);
const nativeTest = (name, fn) => test(name, { skip: process.platform === 'win32' }, fn);

function fixture(agent = 'codex') {
  const cwd = temp('omha-cmux-project-');
  process.env.OMHA_HOME = temp('omha-cmux-state-');
  const ref = randomUUID(),
    surfaceRef = randomUUID(),
    sessionId = randomUUID();
  process.env.CMUX_WORKSPACE_ID = ref;
  process.env.CMUX_SURFACE_ID = surfaceRef;
  const file = join(process.env.OMHA_HOME, 'cmux-fixture.json');
  const state = {
    cwd,
    agent,
    calls: [],
    forks: [],
    messages: [],
    closed: [],
    owners: {},
    checkpoints: [
      { id: 'turn:ordinal:8', turn: 1, source: 'turn', anchor: 'ordinal:8' },
      { id: 'turn:ordinal:36', turn: 2, source: 'turn', anchor: 'ordinal:36' },
    ],
    surfaces: { [surfaceRef]: { ref, agent, sessionId, source: true } },
  };
  writeFileSync(file, JSON.stringify(state));
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const update = (change) => {
    const value = read();
    change(value);
    writeFileSync(file, JSON.stringify(value));
  };
  const caller = (record) => {
    process.env.CMUX_WORKSPACE_ID = record.ref;
    process.env.CMUX_SURFACE_ID = record.surfaceRef;
  };
  return { cwd, ref, surfaceRef, read, update, caller };
}

nativeTest(
  'native cmux registration, exact turn fork, structured messages and successor-confirmed source close',
  async () => {
    for (const agent of ['claude', 'codex']) {
      const f = fixture(agent);
      const source = await adoptHandoff(f.cwd);
      assert.equal((await adoptHandoff(f.cwd)).id, source.id);
      assert.equal(source.native.agent, agent);
      assert.equal((await handoffCheckpoints(source.id)).checkpoints[0].turn, 1);
      const spec = { sourceHandoffId: source.id, turn: 1, closeSource: true };
      const fork = await forkHandoff(f.cwd, 'Continue the verified task.', spec, {
        allowWrite: true,
      });
      assert.equal(fork.fork.state, 'awaiting_acceptance');
      assert.equal(fork.native.agent, agent);
      assert.notEqual(fork.native.sessionId, source.native.sessionId);
      assert.equal(fork.fork.checkpoint.id, 'turn:ordinal:8');
      assert.equal(readFileSync(fork.promptFile, 'utf8'), 'Continue the verified task.');
      const calls = f.read().calls;
      assert.deepEqual(JSON.parse(calls.find((args) => args[1] === 'vault.fork')[2]), {
        agent,
        session: source.native.sessionId,
        checkpoint: 'turn:ordinal:8',
      });
      const launch = calls.find((args) => args[0] === 'respawn-pane').at(-1);
      assert.ok(
        launch.includes(
          agent === 'codex'
            ? `'codex' 'resume' '${fork.native.sessionId}' '--sandbox' 'workspace-write'`
            : `'claude' '--resume' '${fork.native.sessionId}' '--permission-mode' 'acceptEdits'`,
        ),
      );
      assert.equal(launch.includes('--dangerously'), false);
      assert.ok(
        launch.includes(`CMUX_CUSTOM_${agent.toUpperCase()}_PATH=/native-fixture/bin/${agent}`),
      );
      assert.ok(launch.includes(`'--' 'Omha native takeover ${fork.id}`));
      assert.ok(launch.includes(`OMHA_HOME=${process.env.OMHA_HOME}`));
      if (agent === 'claude') {
        assert.ok(launch.includes('CMUX_PRESERVE_CLAUDE_AUTH_SELECTION_ENV=1'));
        assert.ok(
          launch.includes('CMUX_PRESERVE_CLAUDE_AUTH_SELECTION_ENV_KEYS=ANTHROPIC_BASE_URL'),
        );
      }
      assert.equal(
        calls.some((args) => ['send', 'send-key'].includes(args[0])),
        false,
      );
      assert.equal(f.read().closed.length, 0);
      await messageHandoff(fork.id, 'Additional verified context.');
      await assert.rejects(acceptHandoff(fork.id), { code: 'ownership' });
      f.caller(fork);
      const accepted = await acceptHandoff(fork.id);
      assert.equal(accepted.fork.sourceClose, 'closed');
      assert.equal(handoffStatus(source.id).state, 'closed');
      assert.deepEqual(f.read().closed, [source.surfaceRef]);
      assert.equal((await readHandoff(fork.id)).state, 'running');
      await acceptHandoff(fork.id);
      const replay = await forkHandoff(f.cwd, 'Continue the verified task.', spec, {
        allowWrite: true,
      });
      assert.equal(replay.id, fork.id);
      assert.equal(
        (
          await forkHandoff(
            f.cwd,
            'Continue the verified task.',
            { closeSource: true, turn: 1, sourceHandoffId: source.id },
            { allowWrite: true },
          )
        ).id,
        fork.id,
      );
      assert.equal(f.read().forks.length, 1);
    }
  },
);

nativeTest(
  'fork authority, historical selectors, changed sessions and changed ownership fail closed',
  async () => {
    const f = fixture();
    const source = await adoptHandoff(f.cwd);
    const spec = { sourceHandoffId: source.id, turn: 1 };
    await assert.rejects(closeHandoff(source.id), /self-retirement/);
    await assert.rejects(forkHandoff(f.cwd, 'Continue.', spec), { code: 'authority' });
    await assert.rejects(
      forkHandoff(f.cwd, 'Continue.', { ...spec, turn: 999 }, { allowWrite: true }),
      /not in/,
    );
    assert.throws(() => validateFork({ ...spec, checkpoint: 'turn:ordinal:8' }), /exactly one/);
    assert.throws(() => validateFork({ ...spec, turn: 1.2 }), /integer/);
    await assert.rejects(forkHandoff(temp(), 'Continue.', spec, { allowWrite: true }), {
      code: 'ownership',
    });
    f.update((state) => {
      state.surfaces[source.surfaceRef].sessionId = randomUUID();
    });
    await assert.rejects(forkHandoff(f.cwd, 'Continue.', spec, { allowWrite: true }), {
      code: 'ownership',
    });
    await assert.rejects(closeHandoff(source.id), { code: 'ownership' });
    assert.equal(f.read().forks.length, 0);
    assert.equal(f.read().closed.length, 0);
  },
);

nativeTest(
  'fork, launch, readiness and message failures retain the source and never replay uncertain actions',
  async () => {
    for (const failure of [
      'fork',
      'fork-response',
      'launch',
      'ready',
      'message',
      'receipt',
      'cancelled',
    ]) {
      const f = fixture();
      const source = await adoptHandoff(f.cwd);
      f.update((state) => {
        state.fail = failure;
      });
      const spec = { sourceHandoffId: source.id, checkpoint: 'turn:ordinal:8', closeSource: true };
      const result = await forkHandoff(f.cwd, 'Continue.', spec, {
        allowWrite: true,
        waitMs: 10,
        ...(failure === 'cancelled' ? { signal: AbortSignal.abort() } : {}),
      });
      assert.equal(result.fork.state, 'uncertain', failure);
      assert.equal(result.state, failure === 'cancelled' ? 'cancelled' : 'interrupted', failure);
      const count = f.read().forks.length;
      f.update((state) => {
        delete state.fail;
      });
      const replay = await forkHandoff(f.cwd, 'Continue.', spec, { allowWrite: true });
      assert.equal(replay.id, result.id);
      assert.equal(f.read().forks.length, count);
      assert.equal(f.read().closed.length, 0);
      assert.equal(handoffStatus(source.id).state, 'running');
      await assert.rejects(acceptHandoff(result.id), /not ready/);
    }
  },
);

nativeTest(
  'continuation prompt tampering, source owner changes and close uncertainty cannot silently complete takeover',
  async () => {
    for (const failure of ['prompt', 'owner', 'close']) {
      const f = fixture();
      const source = await adoptHandoff(f.cwd);
      const fork = await forkHandoff(
        f.cwd,
        'Continue.',
        { sourceHandoffId: source.id, turn: 1, closeSource: true },
        { allowWrite: true },
      );
      f.caller(fork);
      if (failure === 'prompt') writeFileSync(fork.promptFile, 'Changed continuation.');
      if (failure === 'owner')
        f.update((state) => {
          state.owners[source.ref] = {};
        });
      if (failure === 'close')
        f.update((state) => {
          state.fail = 'close';
        });
      await assert.rejects(acceptHandoff(fork.id));
      assert.equal(f.read().closed.length, 0);
      if (failure === 'close') {
        assert.equal(handoffStatus(fork.id).fork.sourceClose, 'uncertain');
        f.update((state) => {
          delete state.fail;
        });
        await assert.rejects(acceptHandoff(fork.id), /remains uncertain/);
        assert.equal(f.read().closed.length, 0);
      }
    }
  },
);

nativeTest('historical forks remain bounded and do not require source close', async () => {
  const f = fixture();
  const source = await adoptHandoff(f.cwd);
  for (let i = 0; i < 3; i++) {
    const fork = await forkHandoff(
      f.cwd,
      `Continue ${i}.`,
      { sourceHandoffId: source.id, turn: 1 },
      { allowWrite: true },
    );
    f.caller(fork);
    await acceptHandoff(fork.id);
    f.caller(source);
  }
  await assert.rejects(
    forkHandoff(
      f.cwd,
      'Continue 4.',
      { sourceHandoffId: source.id, turn: 1 },
      { allowWrite: true },
    ),
    /attempt limit/,
  );
  writeFileSync(source.recordFile, JSON.stringify({ ...handoffStatus(source.id), forkDepth: 3 }));
  await assert.rejects(
    forkHandoff(
      f.cwd,
      'Continue depth.',
      { sourceHandoffId: source.id, turn: 1 },
      { allowWrite: true },
    ),
    /depth limit/,
  );
  assert.equal(f.read().closed.length, 0);
});

nativeTest('incomplete or unsupported cmux timelines cannot start a historical fork', async () => {
  const f = fixture();
  const source = await adoptHandoff(f.cwd);
  for (const failure of ['unsupported', 'truncated']) {
    f.update((state) => {
      state.fail = failure;
    });
    await assert.rejects(
      forkHandoff(
        f.cwd,
        'Continue.',
        { sourceHandoffId: source.id, turn: 1 },
        { allowWrite: true },
      ),
      /complete forkable/,
    );
  }
  assert.equal(f.read().forks.length, 0);
});

nativeTest(
  'cancelling a launched native fork cleans only its verified successor surface',
  async () => {
    const f = fixture();
    const source = await adoptHandoff(f.cwd);
    const controller = new AbortController();
    const backend = {
      ...cmuxBackend,
      async startSession(record, session) {
        await cmuxBackend.startSession.call(this, record, session);
        controller.abort();
      },
    };
    const result = await forkHandoff(
      f.cwd,
      'Continue.',
      { sourceHandoffId: source.id, turn: 1, closeSource: true },
      { allowWrite: true, signal: controller.signal, backends: { cmux: backend } },
    );
    assert.equal(result.state, 'cancelled');
    assert.equal(result.backendClosed, true);
    assert.equal(handoffStatus(source.id).state, 'running');
    assert.deepEqual(f.read().closed, [result.surfaceRef]);
  },
);

nativeTest(
  'auto butterfly forks only the evidence-supported action and remains no-op for insufficient evidence',
  async () => {
    const f = fixture();
    const source = await adoptHandoff(f.cwd);
    const fork = {
      sourceHandoffId: source.id,
      actionId: 'draft',
      checkpoint: 'turn:ordinal:8',
      closeSource: true,
    };
    await assert.rejects(autoButterfly(f.cwd, reliable, { fork }), { code: 'authority' });
    await assert.rejects(
      autoButterfly(f.cwd, reliable, { fork: { ...fork, actionId: 'other' }, allowWrite: true }),
      /causal boundary/,
    );
    const noop = await autoButterfly(
      f.cwd,
      { ...reliable, transcript: [] },
      { fork, allowWrite: true },
    );
    assert.equal(noop.status, 'no_op');
    assert.equal(f.read().forks.length, 0);
    const result = await autoButterfly(f.cwd, reliable, { fork, allowWrite: true });
    assert.equal(result.handoffs[0].fork.state, 'awaiting_acceptance');
    assert.equal(result.conversationRewound, false);
    assert.equal(f.read().forks.length, 1);
    assert.throws(
      () => validateButterfly({ forks: { build: { sourceHandoffId: source.id, turn: 1 } } }),
      /action/,
    );
    assert.throws(() => validateButterfly({ forks: null }), /must be an object/);
  },
);

nativeTest(
  'CLI exposes native registration, checkpoints, fork, messages and acceptance using only local fixtures',
  () => {
    const f = fixture();
    const invoke = (args) =>
      JSON.parse(
        execFileSync(process.execPath, [cli, args[0], '--cwd', f.cwd, ...args.slice(1)], {
          encoding: 'utf8',
        }),
      );
    const source = invoke(['handoff', 'adopt']);
    assert.equal(invoke(['handoff', 'checkpoints', '--id', source.id]).checkpoints.length, 2);
    const fork = invoke([
      'handoff',
      'fork',
      '--id',
      source.id,
      '--turn',
      '1',
      '--prompt',
      'Continue.',
      '--allow-write',
      '--close-source',
    ]);
    assert.equal(fork.fork.state, 'awaiting_acceptance');
    assert.equal(
      invoke(['handoff', 'message', '--id', fork.id, '--prompt', 'Follow-up.']).state,
      'queued',
    );
    f.caller(fork);
    assert.equal(invoke(['handoff', 'accept', '--id', fork.id]).fork.sourceClose, 'closed');
  },
);

nativeTest(
  'Leader native fork waits for successful host gates and binds the actual lifecycle rewind action',
  async () => {
    const f = fixture();
    const source = await adoptHandoff(f.cwd);
    const file = join(f.cwd, 'result.txt');
    writeFileSync(file, 'original');
    const runtime = createRuntime(
      config({ worker: fake('produced candidate', { sandbox: 'workspace-write' }) }),
      { persistent: false },
    );
    const attempt = runtime.attempt.bind(runtime);
    let count = 0;
    runtime.attempt = (...args) => {
      writeFileSync(file, ['bad-a', 'bad-b', 'good'][count++]);
      return attempt(...args);
    };
    const plan = {
      version: 1,
      objective: 'Produce the required result.',
      butterfly: {
        forks: {
          build: { sourceHandoffId: source.id, actionId: 'action-1', turn: 1, closeSource: true },
        },
      },
      tasks: [
        {
          id: 'build',
          role: 'writer',
          profile: 'worker',
          mode: 'write',
          prompt: 'Produce result.txt containing good.',
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
    const first = await executePlan(f.cwd, plan, { runtime, allowWrite: true });
    const resume = (runId) =>
      executePlan(f.cwd, null, {
        runtime,
        allowWrite: true,
        resume: true,
        runId,
        retryFailed: true,
        retryInterruptedWrites: true,
      });
    const second = await resume(first.runId);
    assert.equal(second.status, 'failed');
    assert.equal(second.metrics.butterflyDetections, 1);
    assert.equal(f.read().forks.length, 0);
    const third = await resume(first.runId);
    assert.equal(third.status, 'completed');
    assert.equal(third.metrics.butterflyHandoffs, 1);
    assert.equal(f.read().forks.length, 1);
    assert.equal(f.read().closed.length, 0);
    const fourth = await resume(first.runId);
    assert.equal(fourth.metrics.butterflyHandoffs, 1);
    assert.equal(f.read().forks.length, 1);
  },
);

const eventKinds = (record) =>
  readFileSync(join(dirname(record.recordFile), 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).kind);
const callIndex = (calls, predicate) => calls.findIndex(predicate);
const controllerSurface = () => {
  // Lifecycle commands run from a controller surface, not from the source agent.
  process.env.CMUX_SURFACE_ID = randomUUID();
};

nativeTest(
  'lifecycle runs compact source, checkpoint revalidation, fork, renames, continuation, accept, then close',
  async () => {
    const f = fixture('claude');
    const source = await adoptHandoff(f.cwd);
    controllerSurface();
    const spec = {
      sourceHandoffId: source.id,
      turn: 2,
      closeSource: true,
      compact: 'source',
      renameTarget: 'Successor session',
      renameSource: 'Continued elsewhere',
    };
    const fork = await forkHandoff(f.cwd, 'Continue compacted.', spec, { allowWrite: true });
    assert.equal(fork.fork.state, 'awaiting_acceptance');
    const lifecycle = fork.fork.lifecycle;
    assert.deepEqual(lifecycle.order, [
      'compact_source',
      'checkpoint_revalidated',
      'fork',
      'rename_target',
      'rename_source',
      'continuation',
      'accept',
      'close_source',
    ]);
    assert.equal(lifecycle.compact.state, 'completed');
    assert.equal(lifecycle.compact.signal, 'structured');
    assert.ok(lifecycle.compact.completedSeq > lifecycle.compact.startedSeq);
    assert.equal(typeof lifecycle.compact.waitedMs, 'number');
    assert.equal(lifecycle.checkpointResolution.state, 'verified');
    assert.equal(lifecycle.checkpointResolution.requested.id, 'turn:ordinal:36');
    assert.equal(lifecycle.checkpointResolution.resolved.id, 'turn:ordinal:200');
    assert.equal(fork.fork.checkpoint.id, 'turn:ordinal:200');
    assert.equal(lifecycle.renameTarget.state, 'renamed');
    assert.equal(lifecycle.renameTarget.scope, 'workspace');
    assert.equal(lifecycle.renameSource.state, 'renamed');
    assert.equal(lifecycle.renameSource.scope, 'tab');
    const calls = f.read().calls;
    const compactAt = callIndex(
      calls,
      (args) =>
        args[0] === 'send' && args.at(-1) === '/compact' && args.includes(source.surfaceRef),
    );
    const forkAt = callIndex(calls, (args) => args[1] === 'vault.fork');
    const renameTargetAt = callIndex(calls, (args) => args[0] === 'rename-workspace');
    const renameSourceAt = callIndex(calls, (args) => args[0] === 'rename-tab');
    const messageAt = callIndex(calls, (args) => args[1] === 'agent.message.send');
    assert.ok(compactAt >= 0 && compactAt < forkAt, 'compact before fork');
    assert.ok(forkAt < renameTargetAt && renameTargetAt < renameSourceAt);
    assert.ok(renameSourceAt < messageAt, 'renames before continuation');
    assert.equal(JSON.parse(calls[forkAt][2]).checkpoint, 'turn:ordinal:200');
    assert.deepEqual(f.read().renames, [
      { scope: 'workspace', workspace: fork.ref, title: 'Successor session' },
      {
        scope: 'tab',
        workspace: source.ref,
        surface: source.surfaceRef,
        title: 'Continued elsewhere',
      },
    ]);
    assert.equal(f.read().closed.length, 0);
    const replay = await forkHandoff(f.cwd, 'Continue compacted.', spec, { allowWrite: true });
    assert.equal(replay.id, fork.id);
    assert.equal(
      f.read().calls.filter((args) => args[0] === 'send' && args.at(-1) === '/compact').length,
      1,
    );
    f.caller(fork);
    const accepted = await acceptHandoff(fork.id);
    assert.equal(accepted.fork.sourceClose, 'closed');
    assert.equal(accepted.fork.lifecycle.close.afterAcceptance, true);
    assert.ok(accepted.fork.lifecycle.close.closedAt >= accepted.fork.acceptedAt);
    assert.deepEqual(f.read().closed, [source.surfaceRef]);
    assert.deepEqual(eventKinds(fork), [
      'fork.requested',
      'compact.requested',
      'compact.completed',
      'fork.checkpoint_resolved',
      'fork.created',
      'rename.requested',
      'rename.completed',
      'rename.requested',
      'rename.completed',
      'message.requested',
      'message.sent',
      'fork.ready',
      'fork.accepted',
      'source.close_requested',
      'source.closed',
    ]);
  },
);

nativeTest(
  'compact target forks first, compacts only the successor and submits the protocol line afterwards',
  async () => {
    const f = fixture('claude');
    const source = await adoptHandoff(f.cwd);
    const fork = await forkHandoff(
      f.cwd,
      'Continue.',
      { sourceHandoffId: source.id, turn: 1, closeSource: true, compact: 'target' },
      { allowWrite: true },
    );
    assert.equal(fork.fork.state, 'awaiting_acceptance');
    assert.equal(fork.fork.lifecycle.compact.state, 'completed');
    assert.equal(fork.fork.lifecycle.bootstrap.delivery, 'submitted_after_compaction');
    assert.equal(fork.fork.checkpoint.id, 'turn:ordinal:8');
    const calls = f.read().calls;
    const launch = calls.find((args) => args[0] === 'respawn-pane').at(-1);
    assert.equal(launch.includes('Omha native takeover'), false);
    const respawnAt = callIndex(calls, (args) => args[0] === 'respawn-pane');
    const compactAt = callIndex(
      calls,
      (args) => args[0] === 'send' && args.at(-1) === '/compact' && args.includes(fork.surfaceRef),
    );
    const bootstrapAt = callIndex(
      calls,
      (args) => args[0] === 'send' && args.at(-1).startsWith(`Omha native takeover ${fork.id}`),
    );
    const messageAt = callIndex(calls, (args) => args[1] === 'agent.message.send');
    assert.ok(respawnAt < compactAt && compactAt < bootstrapAt && bootstrapAt < messageAt);
    assert.equal(
      calls.some((args) => args[0] === 'send' && args.includes(source.surfaceRef)),
      false,
    );
    assert.equal(f.read().closed.length, 0);
    f.caller(fork);
    await acceptHandoff(fork.id);
    assert.deepEqual(f.read().closed, [source.surfaceRef]);
  },
);

nativeTest(
  'compact timeout, missing structured signal or a rewritten timeline never fork, rename or close',
  async () => {
    for (const failure of ['compact-timeout', 'events', 'compact-rewrite']) {
      const f = fixture('claude');
      const source = await adoptHandoff(f.cwd);
      controllerSurface();
      f.update((state) => {
        state.fail = failure;
      });
      const spec = {
        sourceHandoffId: source.id,
        turn: 2,
        closeSource: true,
        compact: 'source',
        renameTarget: 'Successor',
        renameSource: 'Retired',
      };
      const result = await forkHandoff(f.cwd, 'Continue.', spec, {
        allowWrite: true,
        compactWaitMs: failure === 'compact-timeout' ? 50 : 10000,
      });
      assert.equal(result.state, 'interrupted', failure);
      assert.equal(result.fork.state, 'uncertain', failure);
      assert.equal(
        result.fork.lifecycle.compact.state,
        {
          'compact-timeout': 'timed_out',
          events: 'signal_unavailable',
          'compact-rewrite': 'completed',
        }[failure],
      );
      if (failure === 'compact-rewrite')
        assert.equal(result.fork.lifecycle.checkpointResolution.state, 'mismatch');
      if (failure === 'events')
        assert.equal(
          f.read().calls.some((args) => args[0] === 'send'),
          false,
          'no compact without a structured completion channel',
        );
      const calls = f.read().calls;
      assert.equal(f.read().forks.length, 0, failure);
      assert.equal(
        calls.some((args) => ['rename-workspace', 'rename-tab'].includes(args[0])),
        false,
      );
      assert.equal(f.read().closed.length, 0);
      assert.ok(eventKinds(result).includes('fork.uncertain'));
      f.update((state) => {
        delete state.fail;
      });
      const sends = f.read().calls.filter((args) => args[0] === 'send').length;
      assert.equal(
        (await forkHandoff(f.cwd, 'Continue.', spec, { allowWrite: true })).id,
        result.id,
      );
      assert.equal(f.read().calls.filter((args) => args[0] === 'send').length, sends);
      await assert.rejects(acceptHandoff(result.id), /not ready/);
      assert.equal(handoffStatus(source.id).state, 'running');
    }
  },
);

nativeTest(
  'unsupported providers, the calling surface and non-tail checkpoints refuse compaction',
  async () => {
    const codex = fixture('codex');
    const source = await adoptHandoff(codex.cwd);
    controllerSurface();
    for (const compact of ['source', 'target'])
      await assert.rejects(
        forkHandoff(
          codex.cwd,
          'Continue.',
          { sourceHandoffId: source.id, turn: 2, compact },
          { allowWrite: true },
        ),
        /not supported for codex/,
      );
    assert.equal(codex.read().forks.length, 0);
    assert.equal(
      codex.read().calls.some((args) => args[0] === 'send'),
      false,
    );
    assert.equal(listHandoffs().length, 1);
    assert.ok(eventKinds(source).includes('fork.compact_refused'));
    const claude = fixture('claude');
    const own = await adoptHandoff(claude.cwd);
    await assert.rejects(
      forkHandoff(
        claude.cwd,
        'Continue.',
        { sourceHandoffId: own.id, turn: 2, compact: 'source' },
        { allowWrite: true },
      ),
      /calling surface/,
    );
    controllerSurface();
    await assert.rejects(
      forkHandoff(
        claude.cwd,
        'Continue.',
        { sourceHandoffId: own.id, turn: 1, compact: 'source' },
        { allowWrite: true },
      ),
      /latest timeline entry/,
    );
    assert.equal(claude.read().forks.length, 0);
    assert.throws(
      () => validateFork({ sourceHandoffId: own.id, turn: 1, compact: 'yes' }),
      /one of/,
    );
    assert.throws(
      () => validateFork({ sourceHandoffId: own.id, turn: 1, renameTarget: '--evil' }),
      /single-line title/,
    );
    assert.throws(
      () => validateFork({ sourceHandoffId: own.id, turn: 1, renameSource: 'a\nb' }),
      /single-line title/,
    );
  },
);

nativeTest('rename failures stop before continuation and never close the source', async () => {
  for (const failure of ['rename-target', 'rename-source']) {
    const f = fixture('claude');
    const source = await adoptHandoff(f.cwd);
    f.update((state) => {
      state.fail = failure;
    });
    const result = await forkHandoff(
      f.cwd,
      'Continue.',
      {
        sourceHandoffId: source.id,
        turn: 1,
        closeSource: true,
        renameTarget: 'Successor',
        renameSource: 'Retired',
      },
      { allowWrite: true },
    );
    assert.equal(result.state, 'interrupted', failure);
    assert.equal(result.fork.state, 'uncertain');
    const lifecycle = result.fork.lifecycle;
    assert.equal(lifecycle.renameTarget.state, failure === 'rename-target' ? 'failed' : 'renamed');
    assert.equal(lifecycle.renameSource.state, failure === 'rename-target' ? 'pending' : 'failed');
    assert.ok(eventKinds(result).includes('rename.failed'));
    assert.equal(f.read().messages.length, 0);
    assert.equal(f.read().closed.length, 0, 'successor and source both remain for inspection');
    f.update((state) => {
      delete state.fail;
    });
    f.caller(result);
    await assert.rejects(acceptHandoff(result.id), /not ready/);
    assert.equal(f.read().closed.length, 0);
    assert.equal(handoffStatus(source.id).state, 'running');
  }
});

nativeTest('incomplete lifecycle records cannot be accepted into a source close', async () => {
  const f = fixture('claude');
  const source = await adoptHandoff(f.cwd);
  const fork = await forkHandoff(
    f.cwd,
    'Continue.',
    { sourceHandoffId: source.id, turn: 1, closeSource: true, renameTarget: 'Successor' },
    { allowWrite: true },
  );
  const tampered = handoffStatus(fork.id);
  tampered.fork.lifecycle.renameTarget.state = 'failed';
  writeFileSync(fork.recordFile, JSON.stringify(tampered));
  f.caller(fork);
  await assert.rejects(acceptHandoff(fork.id), /lifecycle steps/);
  assert.equal(f.read().closed.length, 0);
});

nativeTest('default fork requests are unchanged by the lifecycle options', async () => {
  const f = fixture('claude');
  const source = await adoptHandoff(f.cwd);
  const spec = { sourceHandoffId: source.id, turn: 1, closeSource: true };
  assert.deepEqual(validateFork({ ...spec, compact: 'none' }), validateFork(spec));
  assert.deepEqual(Object.keys(validateFork(spec)), ['sourceHandoffId', 'turn', 'closeSource']);
  const fork = await forkHandoff(f.cwd, 'Continue.', spec, { allowWrite: true });
  assert.equal(
    fork.id,
    `handoff-fork-${hash(JSON.stringify([validateFork(spec), hash('Continue.')])).slice(0, 32)}`,
  );
  assert.equal(
    (await forkHandoff(f.cwd, 'Continue.', { ...spec, compact: 'none' }, { allowWrite: true })).id,
    fork.id,
  );
  assert.deepEqual(Object.keys(handoffStatus(fork.id).fork), [
    'sourceHandoffId',
    'sourceSessionId',
    'sourceLaunchHash',
    'checkpoint',
    'closeSource',
    'request',
    'state',
    'message',
  ]);
  const calls = f.read().calls;
  assert.equal(
    calls.some((args) =>
      ['events', 'send', 'send-key', 'rename-workspace', 'rename-tab'].includes(args[0]),
    ),
    false,
  );
  assert.ok(
    calls
      .find((args) => args[0] === 'respawn-pane')
      .at(-1)
      .includes(`'--' 'Omha native takeover ${fork.id}`),
  );
  assert.deepEqual(eventKinds(fork), [
    'fork.requested',
    'fork.created',
    'message.requested',
    'message.sent',
    'fork.ready',
  ]);
  f.caller(fork);
  const accepted = await acceptHandoff(fork.id);
  assert.equal(accepted.fork.lifecycle, undefined);
});

nativeTest('CLI and butterfly bindings accept explicit lifecycle options', () => {
  const f = fixture('claude');
  const invoke = (args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, args[0], '--cwd', f.cwd, ...args.slice(1)], {
        encoding: 'utf8',
      }),
    );
  const source = invoke(['handoff', 'adopt']);
  const fork = invoke([
    'handoff',
    'fork',
    '--id',
    source.id,
    '--turn',
    '1',
    '--prompt',
    'Continue.',
    '--allow-write',
    '--compact',
    'target',
    '--compact-wait-ms',
    '5000',
    '--rename-target',
    'Successor',
    '--rename-source',
    'Retired',
  ]);
  assert.equal(fork.fork.state, 'awaiting_acceptance');
  assert.deepEqual(fork.fork.request, {
    sourceHandoffId: source.id,
    turn: 1,
    closeSource: false,
    compact: 'target',
    renameTarget: 'Successor',
    renameSource: 'Retired',
  });
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          cli,
          'handoff',
          '--cwd',
          f.cwd,
          'fork',
          '--id',
          source.id,
          '--turn',
          '1',
          '--prompt',
          'x',
          '--allow-write',
          '--compact',
          'later',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
    /compact must be one of/,
  );
  assert.doesNotThrow(() =>
    validateButterfly({
      forks: {
        build: {
          sourceHandoffId: source.id,
          actionId: 'action-1',
          turn: 1,
          compact: 'source',
          renameSource: 'Retired',
        },
      },
    }),
  );
  assert.throws(
    () =>
      validateButterfly({
        forks: { build: { sourceHandoffId: source.id, actionId: 'a', turn: 1, compact: 1 } },
      }),
    /compact must be one of/,
  );
});
