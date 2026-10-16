import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { temp, fake, config } from './helpers.mjs';
import { createRuntime } from '../lib/runner.mjs';
import { executePlan, validatePlan } from '../lib/orchestrator.mjs';
import { injectMemory, listMemory, readMemory, writeMemory } from '../lib/memory.mjs';
import { readEvents } from '../lib/storage.mjs';

const root = temp('omha-auto-memory-');
process.env.OMHA_HOME = join(root, 'state');
const project = () => {
  const cwd = temp('omha-memory-project-');
  return cwd;
};
const plan = (extra = {}, task = {}) => ({
  version: 1,
  objective: 'Verify formatter',
  tasks: [
    {
      id: 'job',
      role: 'formatter',
      profile: 'p',
      prompt: 'Inspect',
      mode: 'readonly',
      acceptance: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
      ...task,
    },
  ],
  ...extra,
});

test('verified task acceptance flows into scoped memory and the next immutable run context', async () => {
  const cwd = project();
  const rt = createRuntime(config({ p: fake('Private output sentinel') }), { persistent: false });
  const first = await executePlan(cwd, plan(), { runtime: rt });
  assert.equal(first.status, 'completed');
  const records = listMemory(cwd, { scope: 'worktree' });
  assert.equal(records.length, 1);
  assert.equal(records[0].metadata.provenance.source, 'host-acceptance');
  assert.match(
    records[0].metadata.provenance.reference,
    new RegExp(`runs/${first.runId}/job.result.json#sha256=`),
  );
  const lesson = readMemory(cwd, records[0].name, { scope: 'worktree' });
  assert.equal(lesson.includes('Private output sentinel'), false);
  assert.ok(lesson.includes(process.execPath));
  assert.equal(listMemory(cwd).length, 0);
  const second = await executePlan(cwd, plan({}, { acceptance: undefined }), { runtime: rt });
  assert.ok(readFileSync(join(second.dir, 'context.md'), 'utf8').includes(records[0].name));
  const creation = readEvents(join(second.dir, 'events.jsonl'), process.env.OMHA_HOME)[0];
  assert.equal(creation.memory.sources[0].hash, records[0].hash);
  assert.equal(creation.memory.sources[0].scope, 'worktree');
  assert.equal(listMemory(project(), { scope: 'worktree' }).length, 0);
  assert.deepEqual(
    (await executePlan(cwd, null, { runtime: rt, resume: true, runId: second.runId })).status,
    'completed',
  );
});

test('failed acceptance, missing acceptance, and rejected review never produce verified lessons', async () => {
  for (const kind of ['failure', 'absent', 'review']) {
    const cwd = project();
    const rt = createRuntime(
      config({
        p: fake(),
        r: fake(
          JSON.stringify({
            summary: 'Rejected',
            assessments: [{ id: 'criterion', status: 'fail', finding: 'Missing evidence' }],
          }),
        ),
      }),
      { persistent: false },
    );
    const input = plan(
      {},
      kind === 'absent'
        ? { acceptance: undefined }
        : kind === 'failure'
          ? {
              acceptance: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
            }
          : {
              review: {
                reviewerProfile: 'r',
                diff: 'Frozen difference',
                testEvidence: [{ name: 'check', status: 'passed', summary: 'Host test' }],
                criteria: [{ id: 'criterion', description: 'Match spec' }],
              },
            },
    );
    await executePlan(cwd, input, { runtime: rt });
    assert.equal(listMemory(cwd, { scope: 'worktree' }).length, 0, kind);
  }
});

test('automatic selection excludes stale, unrelated and private topics and enforces aggregate caps', () => {
  const cwd = project();
  writeMemory(cwd, {
    name: 'fresh',
    description: 'Formatter recipe',
    content: 'formatter current evidence',
  });
  writeMemory(cwd, { name: 'unrelated', content: 'database rotation' });
  writeMemory(cwd, { name: 'stale', content: 'formatter stale sentinel', ttlDays: 0 });
  writeMemory(cwd, { name: 'private', content: 'formatter private sentinel' }, { scope: 'user' });
  writeMemory(
    cwd,
    { name: 'worktree', content: 'formatter local evidence' },
    { scope: 'worktree' },
  );
  const selected = injectMemory(cwd, {
    query: 'formatter',
    scopes: ['worktree', 'project'],
    maxTopics: 1,
  });
  assert.equal(selected.sources.length, 1);
  assert.equal(selected.sources[0].scope, 'worktree');
  const all = injectMemory(cwd, { query: 'formatter', scopes: ['worktree', 'project'] });
  assert.equal(all.content.includes('stale sentinel'), false);
  assert.equal(all.content.includes('private sentinel'), false);
  assert.equal(all.content.includes('database'), false);
  assert.equal(all.sources.length, 2);
  assert.ok(all.warnings.some((warning) => warning.includes('stale')));
  writeMemory(cwd, {
    name: 'fresh',
    description: 'Formatter recipe',
    content: `formatter ${'evidence '.repeat(100)}`,
  });
  const capped = injectMemory(cwd, { query: 'formatter', maxBytes: 256, maxLines: 5 });
  assert.ok(capped.bytes <= 256 && capped.lines <= 5);
  assert.equal(capped.sources.length, 0);
});

test('run memory policy refuses private scopes and can disable both directions', async () => {
  const cwd = project();
  const rt = createRuntime(config({ p: fake() }), { persistent: false });
  assert.throws(
    () => validatePlan(plan({ memory: { scopes: ['user'] } }), rt.config.profiles),
    /project\/worktree/,
  );
  assert.throws(() => validatePlan(plan({ memory: { maxBytes: 16001 } }), rt.config.profiles));
  writeMemory(cwd, { name: 'existing', content: 'formatter historical evidence' });
  const status = await executePlan(cwd, plan({ memory: { read: false, write: false } }), {
    runtime: rt,
  });
  assert.equal(
    readFileSync(join(status.dir, 'context.md'), 'utf8').includes('historical evidence'),
    false,
  );
  assert.equal(listMemory(cwd, { scope: 'worktree' }).length, 0);
});
