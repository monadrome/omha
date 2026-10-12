import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime } from '../lib/runner.mjs';
import {
  executePlan,
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
